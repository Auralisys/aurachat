//! Authenticated Firestore companion transport. Requests are claimed with a
//! document-version precondition; an interrupted request is never replayed.
use crate::{AppState, config::FirestoreAuth, data::{self, Conversation}};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::{Arc, Mutex}, time::Duration};
use tauri::{Emitter, Listener, Manager};
use tauri_plugin_notification::NotificationExt;

pub fn notification_preview(text: &str, limit: usize) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview: String = compact.chars().take(limit).collect();
    if compact.chars().count() > limit { preview.push('…'); }
    preview
}

fn device_identity_id(platform:&str,computer:&str,user:&str)->String {
    // Preserve existing Windows IDs; Unix user names are case-sensitive.
    let identity=format!("{}/{}",computer.trim(),user.trim());
    let identity=if platform=="windows" {identity.to_lowercase()} else {identity};
    format!("{platform}-{:x}",Sha256::digest(identity.as_bytes()))
}

fn system_name(program:&str,args:&[&str])->Option<String> {
    let mut command=std::process::Command::new(program);
    command.args(args);
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    command.output().ok().filter(|result|result.status.success())
        .and_then(|result|String::from_utf8(result.stdout).ok())
        .map(|name|name.trim().to_string()).filter(|name|!name.is_empty())
}

pub fn identity() -> (String, String) {
    static IDENTITY:std::sync::OnceLock<(String,String)>=std::sync::OnceLock::new();
    IDENTITY.get_or_init(|| {
    #[cfg(windows)]
    let computer = std::env::var("COMPUTERNAME").ok().filter(|name|!name.trim().is_empty()).or_else(|| {
        let root=std::env::var("SystemRoot").unwrap_or_else(|_|"C:\\Windows".into());
        system_name(&std::path::Path::new(&root).join("System32/hostname.exe").to_string_lossy(),&[])
    }).unwrap_or_else(||"PC".into());
    #[cfg(target_os="macos")]
    let computer=system_name("/usr/sbin/scutil",&["--get","ComputerName"])
        .or_else(||system_name("/bin/hostname",&[])).unwrap_or_else(||"Mac".into());
    #[cfg(not(any(windows,target_os="macos")))]
    let computer=system_name("/bin/hostname",&[]).unwrap_or_else(||"PC".into());
    let user = std::env::var(if cfg!(windows) {"USERNAME"} else {"USER"})
        .ok().filter(|name|!name.trim().is_empty())
        .unwrap_or_else(||if cfg!(windows) {"Windows".into()} else {"Account".into()});
    let id = device_identity_id(std::env::consts::OS,&computer,&user);
    (id, format!("{user} · {computer}"))
    }).clone()
}

// Live turn relay: transient documents the phone follows while the desktop is
// working. Volume is bounded by truncation and by the 1 MiB document limit.
const LIVE_HEARTBEAT_MS: u64 = 5_000;
const LIVE_RETENTION_MS: u64 = 60_000;
const LIVE_MAX_CONTENT: usize = 100_000;
const LIVE_MAX_REASONING: usize = 50_000;
const LIVE_MAX_ACTIVITY: usize = 40;
const LIVE_MAX_FIELD: usize = 4_000;

#[derive(Clone, Default)]
struct LiveTurn {
    uid: Option<String>,
    turn_id: String,
    status: String,
    user_content: String,
    user_message: Option<Value>,
    keep_count: Option<usize>,
    title: Option<String>,
    title_state: Option<String>,
    content: String,
    reasoning: String,
    activity: Vec<Value>,
    segments: Vec<Value>,
    started_at: u64,
    finished_at: Option<u64>,
    updated_at: u64,
    revision: u64,
    published_revision: u64,
}

impl LiveTurn {
    fn running(now: u64, uid: Option<String>, turn_id: &str, user_content: &str) -> Self {
        Self { uid, turn_id: turn_id.into(), status: "running".into(), user_content: truncate_chars(user_content, LIVE_MAX_FIELD), started_at: now, updated_at: now, revision: 1, ..Default::default() }
    }
    fn touch(&mut self, now: u64) {
        self.updated_at = now;
        self.revision += 1;
    }
    fn finish(&mut self, status: &str, now: u64) {
        self.status = status.into();
        self.finished_at = Some(now);
        self.touch(now);
    }
    fn apply_progress(&mut self, kind: &str, text: &str, now: u64) {
        match kind {
            "__steering" | "__question_summary" => {
                let Ok(message)=serde_json::from_str::<Value>(text) else {return};
                if message["role"]!="user" || !message["content"].is_string(){return;}
                if !self.content.is_empty() || !self.activity.is_empty() {
                    self.segments.push(json!({"role":"assistant","content":std::mem::take(&mut self.content),"reasoning":std::mem::take(&mut self.reasoning),"activity":std::mem::take(&mut self.activity)}));
                }
                self.segments.push(message);
            },
            "__delta" => self.content.push_str(text),
            "__reasoning" => {
                self.reasoning.push_str(text);
                let offset=self.content.encode_utf16().count();
                if self.activity.last().is_none_or(|event| event["kind"]!="reasoning" || event["offset"].as_u64()!=Some(offset as u64)) {
                    self.activity.push(json!({"kind":"reasoning","text":"","offset":offset,"at":now}));
                }
                let event=self.activity.last_mut().unwrap();
                let mut value=event["text"].as_str().unwrap_or("").to_string();value.push_str(text);event["text"]=value.into();
            },
            "__activity" => {
                let Ok(mut event) = serde_json::from_str::<Value>(text) else { return };
                if event["kind"].as_str() != Some("tool") || event["id"].as_str().is_none() { return; }
                event["offset"] = serde_json::json!(self.content.encode_utf16().count());
                upsert_activity(&mut self.activity, event);
            }
            _ => return,
        }
        self.touch(now);
    }
    fn apply_agent(&mut self, mut agent: Value, now: u64) {
        if agent["id"].as_str().is_none() { return; }
        agent["kind"] = serde_json::json!("agent");
        agent["offset"] = serde_json::json!(self.content.encode_utf16().count());
        upsert_activity(&mut self.activity, agent);
        self.touch(now);
    }
    fn document(&self, conversation: &str) -> Value {
        let mut document=serde_json::json!({
            "conversation_id": conversation,
            "turn_id": self.turn_id,
            "status": self.status,
            "user_content": self.user_content,
            "user_message": self.user_message.as_ref().map(|message|json!({
                "role":"user","content":truncate_chars(message["content"].as_str().unwrap_or(""),LIVE_MAX_FIELD),"attachments":[]
            })),
            "keep_count": self.keep_count,
            "title": self.title,
            "title_state": self.title_state,
            "content": truncate_chars(&self.content, LIVE_MAX_CONTENT),
            "reasoning": truncate_chars(&self.reasoning, LIVE_MAX_REASONING),
            "activity": self.activity.iter().rev().take(LIVE_MAX_ACTIVITY).rev().map(sanitize_activity).collect::<Vec<_>>(),
            "segments": self.segments.iter().rev().take(32).rev().map(|segment| {
                let events=segment["activity"].as_array();
                json!({"role":segment["role"],"content":truncate_chars(segment["content"].as_str().unwrap_or(""),LIVE_MAX_CONTENT),
                    "reasoning":truncate_chars(segment["reasoning"].as_str().unwrap_or(""),LIVE_MAX_REASONING),
                    "activity":events.map(|events| events.iter().rev().take(LIVE_MAX_ACTIVITY).rev().map(sanitize_activity).collect::<Vec<_>>()).unwrap_or_default(),
                    "truncated":segment["content"].as_str().unwrap_or("").chars().count()>LIVE_MAX_CONTENT || events.is_some_and(|events|events.len()>LIVE_MAX_ACTIVITY)})
            }).collect::<Vec<_>>(),
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "updated_at": self.updated_at,
            "truncated": self.segments.len()>32 || self.activity.len()>LIVE_MAX_ACTIVITY || self.content.chars().count()>LIVE_MAX_CONTENT || self.reasoning.chars().count()>LIVE_MAX_REASONING,
        });
        // Firestore limits bytes, including escaped JSON and nested agent details.
        while serde_json::to_vec(&document).map_or(usize::MAX,|bytes|bytes.len())>750_000 {
            document["truncated"]=json!(true);
            let segments=document["segments"].as_array_mut().unwrap();
            if !segments.is_empty(){segments.remove(0);continue;}
            let activity=document["activity"].as_array_mut().unwrap();
            if !activity.is_empty(){activity.remove(0);continue;}
            for key in ["content","reasoning"] {
                let text=document[key].as_str().unwrap_or("");
                document[key]=json!(truncate_chars(text,text.chars().count()/2));
            }
        }
        document
    }
}

fn upsert_activity(list: &mut Vec<Value>, event: Value) {
    if let Some(previous) = list.iter_mut().rev().find(|entry| entry["kind"] == event["kind"] && entry["id"] == event["id"]) {
        *previous = event;
    } else {
        list.push(event);
    }
}

fn update_shell_activity(list:&mut [Value],snapshot:&Value)->bool {
    if snapshot["id"].as_str().is_none(){return false;}
    let mut changed=false;
    for event in list {
        if !event.is_object(){continue;}
        let result=event["output"].as_str().and_then(|text|serde_json::from_str::<Value>(text).ok());
        if event["kind"]=="tool" && matches!(event["action"].as_str(),Some("execute_project_command"|"inspect_project_command"))
            && (event["shell_id"]==snapshot["id"] || result.as_ref().is_some_and(|value|value["id"]==snapshot["id"])) {
            event["status"]=snapshot["status"].clone();event["output"]=json!(snapshot.to_string());changed=true;
        }
        if let Some(nested)=event["activity"].as_array_mut() {changed|=update_shell_activity(nested,snapshot);}
    }
    changed
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max { return text.to_string(); }
    let mut value: String = text.chars().take(max).collect();
    value.push('…');
    value
}

/// Keeps the live document small: only fields the phone displays.
fn sanitize_activity(event: &Value) -> Value {
    const KEYS: &[&str] = &["kind", "id", "action", "path", "title", "status", "summary", "task", "model", "text", "content", "reasoning_content", "offset", "at", "reason", "reviewer", "output", "exit_code", "shell_id", "command", "cwd"];
    let mut value = serde_json::Map::new();
    for key in KEYS {
        match event.get(*key) {
            Some(Value::String(text)) => { value.insert((*key).into(), serde_json::json!(truncate_chars(text, LIVE_MAX_FIELD))); }
            Some(item @ (Value::Bool(_) | Value::Number(_))) => { value.insert((*key).into(), item.clone()); }
            _ => {}
        }
    }
    if let Some(arguments)=event.get("arguments") {
        let text=arguments.to_string();
        value.insert("arguments".into(),if text.chars().count()<=LIVE_MAX_FIELD {arguments.clone()} else {json!(truncate_chars(&text,LIVE_MAX_FIELD))});
    }
    if let Some(activity)=event["activity"].as_array() {
        // Child tools do not contain further subagents.
        value.insert("activity".into(),Value::Array(activity.iter().rev().take(8).rev().map(|item| {
            let mut item=item.clone();item.as_object_mut().map(|map|map.remove("activity"));sanitize_activity(&item)
        }).collect()));
    }
    // Shell commands carry the executed program only inside `arguments`.
    if let Some(arguments) = event["arguments"].as_object() {
        if let Some(program) = arguments.get("program").and_then(Value::as_str) {
            let args = arguments.get("arguments").and_then(Value::as_array)
                .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            value.insert("command".into(), serde_json::json!(truncate_chars(format!("{program} {args}").trim(), LIVE_MAX_FIELD)));
        }
    }
    Value::Object(value)
}

fn viewing_match(viewing: Option<&str>, focused: bool, conversation: &str) -> bool {
    focused && viewing == Some(conversation)
}

/// A local completion toast is redundant only while the user is looking at that chat
/// in the focused window. A background window, minimize or tray still notifies.
pub fn chat_visible(app: &tauri::AppHandle, state: &AppState, conversation: &str) -> bool {
    let focused = app.get_webview_window("main").and_then(|window| window.is_focused().ok()).unwrap_or(false);
    viewing_match(state.viewing_chat.lock().unwrap().as_deref(), focused, conversation)
}

pub fn notify(app: &tauri::AppHandle, kind: &str, id: &str, conversation: &str, title: &str, body: &str) {
    let state=app.state::<AppState>();
    let Some(uid)=state.firestore.uid() else { return; };
    let auth=match crate::firebase_auth(&state) {Ok(a)=>a,Err(_)=>return};
    // Desktop attention only controls the local toast; phones have their own visibility.
    if kind != "chat" || !chat_visible(app,&state,conversation) {
        if let Err(e)=app.notification().builder().title(title).body(body).extra("conversation_id",conversation).show() { eprintln!("Desktop notification: {e}"); }
    }
    let (device_id, device_name)=identity();
    let event_id=format!("{:x}", Sha256::digest(format!("{uid}/{device_id}/{kind}/{id}").as_bytes()));
    let value=json!({"kind":kind,"title":title,"body":body,"conversation_id":conversation,
        "device_id":device_id,"device_name":device_name,"created_at":data::now_millis()});
    let outbox=state.config_dir.join("notification-outbox").join(&uid);
    let pending=outbox.join(format!("{event_id}.json"));
    let queued=(||->Result<(),String>{
        std::fs::create_dir_all(&outbox).map_err(|e|e.to_string())?;
        let temporary=outbox.join(format!("{event_id}.tmp"));
        std::fs::write(&temporary,serde_json::to_vec(&value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        std::fs::rename(temporary,&pending).map_err(|e|e.to_string())
    })();
    if let Err(e)=queued {eprintln!("Notification outbox: {e}");}
    let app=app.clone();
    tauri::async_runtime::spawn(async move {
        for attempt in 0..3 {
            let state=app.state::<AppState>();
            if state.firestore.uid().as_deref()!=Some(&uid) { return; }
            match state.firestore.relay_put(&auth,&format!("users/{uid}/notifications/{event_id}"),&value,None).await {
                Ok(())=>{let _=std::fs::remove_file(&pending);return;},
                Err(e) if e.contains("ALREADY_EXISTS")=>{let _=std::fs::remove_file(&pending);return;},
                Err(e)=>{eprintln!("Completion notification publication failed (attempt {}): {}",attempt+1,e);}
            }
            tauri::async_runtime::spawn_blocking(move ||std::thread::sleep(Duration::from_secs(2u64.pow(attempt)))).await.ok();
        }
        let _=app.emit("companion-warning","Impossibile inviare la notifica push. Controlla la connessione.");
    });
}

pub fn start(app: &tauri::AppHandle) {
    let process_started=data::now_millis();
    #[cfg(debug_assertions)]
    if std::env::var("AURACHAT_NOTIFICATION_SMOKE").as_deref()==Ok("1") {
        let app=app.clone();
        tauri::async_runtime::spawn(async move {
            pause(5).await;
            if session(&app).await.ok().flatten().is_some() {
                notify(&app,"notification-smoke",&process_started.to_string(),"","AuraChat — test completato","Notifica Windows reale: attività terminata in background.");
                eprintln!("NOTIFICATION_SMOKE_SUBMITTED");
            }
        });
    }
    let approvals_app=app.clone();
    app.listen("approval-activity",move |event| {
        let Ok(value)=serde_json::from_str::<Value>(event.payload()) else{return};
        let handle=approvals_app.clone();
        tauri::async_runtime::spawn(async move {
            let state=handle.state::<AppState>();let Some(uid)=state.firestore.uid() else{return};
            let Ok(auth)=crate::firebase_auth(&state) else{return};let (device,_)=identity();
            let Some(id)=value["id"].as_str() else{return};
            if let Err(e)=state.firestore.relay_revisioned(&auth,&format!("users/{uid}/devices/{device}/approvals/{id}"),&value).await {eprintln!("Approval publication failed: {e}");}
            if value["status"]=="pending" {
                notify(&handle,"approval-requested",&format!("{process_started}/{id}"),value["conversation_id"].as_str().unwrap_or(""),"È richiesta la tua approvazione","Apri AuraChat per consentire o rifiutare l’operazione del desktop.");
            }
        });
    });
    // Interactive questions are published as transient documents so the phone can
    // answer while the turn is paused; resolution/cancel retracts the document.
    let questions_app=app.clone();
    app.listen("question-activity",move |event| {
        let Ok(value)=serde_json::from_str::<Value>(event.payload()) else{return};
        let handle=questions_app.clone();
        tauri::async_runtime::spawn(async move {
            let state=handle.state::<AppState>();let Some(uid)=state.firestore.uid() else{return};
            let Ok(auth)=crate::firebase_auth(&state) else{return};let (device,_)=identity();
            let Some(id)=value["id"].as_str().map(str::to_owned) else{return};
            let conversation=value["conversation_id"].as_str().unwrap_or("");
            let path=format!("users/{uid}/devices/{device}/questions/{id}");
            match value["status"].as_str() {
                Some("pending") => {
                    if let Err(e)=state.firestore.relay_upsert(&auth,&path,&value).await {eprintln!("Question publication failed: {e}");}
                    notify(&handle,"question-requested",&format!("{process_started}/{id}"),conversation,"Una domanda attende la tua risposta","Apri AuraChat per rispondere dal telefono o dal PC.");
                },
                Some("answered") | Some("cancelled") => {
                    let _=state.firestore.relay_delete(&auth,&path).await;
                },
                _ => {}
            }
        });
    });
    // Intermediate work (tools, subagents, shell commands) stays in the app.
    // Only events that need the user are pushed: approval requests here, plus
    // one notification per chat turn and blocking errors from run_chat.
    let live:Arc<Mutex<HashMap<String,LiveTurn>>>=Arc::new(Mutex::new(HashMap::new()));
    {
        let live=live.clone();let handle=app.clone();
        app.listen("live-turn",move |event| {
            let Ok(value)=serde_json::from_str::<Value>(event.payload()) else{return};
            let Some(id)=value["conversation_id"].as_str() else{return};
            let status=value["status"].as_str().unwrap_or("running");
            let turn_id=value["turn_id"].as_str().unwrap_or("");
            let now=data::now_millis();
            let uid=handle.state::<AppState>().firestore.uid();
            let mut turns=live.lock().unwrap();
            // A rejected second start must not erase the progress of the turn that
            // is actually running, and only that turn may end its live state.
            if status=="running" {
                let conflict=turns.get(id).is_some_and(|turn|turn.status=="running" && turn.turn_id!=turn_id);
                if !conflict {turns.insert(id.into(),LiveTurn::running(now,uid,turn_id,value["user_content"].as_str().unwrap_or("")));}
            }
            else if status=="context" {
                if let Some(turn)=turns.get_mut(id) {
                    turn.keep_count=value["keep_count"].as_u64().map(|count|count as usize);
                    turn.user_message=value.get("user_message").cloned();
                    turn.touch(now);
                }
            }
            else if let Some(turn)=turns.get_mut(id) {
                if turn.turn_id==turn_id {turn.finish(status,now);}
            }
        });
    }
    {
        let live=live.clone();
        app.listen("chat-progress",move |event| {
            let Ok(value)=serde_json::from_str::<Value>(event.payload()) else{return};
            let Some(id)=value["conversation_id"].as_str() else{return};
            let Some(kind)=value["kind"].as_str() else{return};
            let text=value["text"].as_str().unwrap_or("");
            if let Some(turn)=live.lock().unwrap().get_mut(id) {turn.apply_progress(kind,text,data::now_millis());}
        });
    }
    {
        let live=live.clone();
        app.listen("agent-activity",move |event| {
            let Ok(value)=serde_json::from_str::<Value>(event.payload()) else{return};
            let Some(id)=value["conversation_id"].as_str() else{return};
            if let Some(turn)=live.lock().unwrap().get_mut(id) {turn.apply_agent(value,data::now_millis());}
        });
    }
    {
        let live=live.clone();
        app.listen("approval-activity",move |event| {
            let Ok(mut value)=serde_json::from_str::<Value>(event.payload()) else{return};
            let Some(id)=value["conversation_id"].as_str().map(str::to_owned) else{return};
            if let Some(turn)=live.lock().unwrap().get_mut(&id) {
                value["kind"]=json!("approval");value["offset"]=json!(turn.content.encode_utf16().count());
                upsert_activity(&mut turn.activity,value);turn.touch(data::now_millis());
            }
        });
    }
    {
        let live=live.clone();
        app.listen("shell-activity",move |event| {
            let Ok(snapshot)=serde_json::from_str::<Value>(event.payload()) else{return};
            let Some(id)=snapshot["conversation_id"].as_str() else{return};
            if let Some(turn)=live.lock().unwrap().get_mut(id) {
                if update_shell_activity(&mut turn.activity,&snapshot){turn.touch(data::now_millis());}
            }
        });
    }
    {
        let live=live.clone();
        app.listen("conversation-title-updated",move |event| {
            let Ok(value)=serde_json::from_str::<Value>(event.payload()) else{return};
            let Some(id)=value["conversation_id"].as_str() else{return};
            if let Some(turn)=live.lock().unwrap().get_mut(id) {
                if turn.uid.as_deref()!=value["owner"].as_str() {return;}
                turn.title=value["title"].as_str().map(String::from);
                turn.title_state=value["title_state"].as_str().map(String::from);
                turn.touch(data::now_millis());
            }
        });
    }
    let live_publisher=app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            pause(1).await;
            publish_live(&live_publisher,&live).await;
        }
    });
    let heartbeat=app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e)=heartbeat_once(&heartbeat).await {eprintln!("Companion heartbeat: {e}");}
            pause(15).await;
        }
    });
    let app=app.clone();
    let boot_time=data::now_millis();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e)=poll(&app,boot_time).await {eprintln!("Companion relay: {e}");}
            pause(2).await;
        }
    });
}

async fn pause(seconds:u64) {let _=tauri::async_runtime::spawn_blocking(move||std::thread::sleep(Duration::from_secs(seconds))).await;}

#[tauri::command(rename_all = "snake_case")]
pub async fn remote_chat_snapshot(state:tauri::State<'_,AppState>,conversation_id:String,device_id:Option<String>)->Result<Option<Value>,String> {
    data::valid_id(&conversation_id)?;
    if let Some(device)=&device_id {data::valid_id(device)?;}
    let _account=state.account_lock.lock().await;
    let auth=crate::firebase_auth(&state)?;
    let uid=crate::ensure_uid(&state,&auth).await?;
    if state.running_chats.lock().unwrap().contains(&conversation_id) {return Ok(None);}
    let (local,_)=identity();
    let now=data::now_millis();
    let mut latest:Option<Value>=None;
    for (device,info) in state.firestore.relay_devices(&auth,&uid).await? {
        if device_id.as_ref().is_some_and(|preferred|preferred!=&device) {continue;}
        if device==local || now.saturating_sub(info["last_seen"].as_u64().unwrap_or(0))>60_000 {continue;}
        let Some(mut turn)=state.firestore.relay_get(&auth,&format!("users/{uid}/devices/{device}/live_turns/{conversation_id}")).await? else {continue};
        if turn["conversation_id"].as_str()!=Some(&conversation_id) {continue;}
        if latest.as_ref().is_some_and(|previous|previous["started_at"].as_u64()>=turn["started_at"].as_u64()) {continue;}
        turn["device_name"]=info["name"].clone();
        turn["device_id"]=json!(device);
        turn["remote_enabled"]=info["remote_enabled"].clone();
        latest=Some(turn);
    }
    Ok(latest)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn remote_chat_request(state:tauri::State<'_,AppState>,device_id:String,conversation_id:String,
    action:String,arguments:Value)->Result<String,String> {
    data::valid_id(&device_id)?;data::valid_id(&conversation_id)?;
    let _account=state.account_lock.lock().await;
    let auth=crate::firebase_auth(&state)?;
    let uid=crate::ensure_uid(&state,&auth).await?;
    if device_id==identity().0 {return Err("invalid_remote_device".into());}
    let device=state.firestore.relay_fields(&auth,&format!("users/{uid}/devices/{device_id}"),&["last_seen","remote_enabled","protocol"]).await?
        .ok_or("remote_device_offline")?;
    if data::now_millis().saturating_sub(device["last_seen"].as_u64().unwrap_or(0))>60_000 {return Err("remote_device_offline".into());}
    if device["remote_enabled"]!=true {return Err("remote_disabled".into());}
    let needs_update=arguments["retry"]==true || arguments.get("edit_index").is_some_and(|index|!index.is_null())
        || arguments["attachments"].as_array().is_some_and(|files|!files.is_empty());
    if needs_update && device["protocol"].as_u64().unwrap_or(0)<6 {return Err("remote_update_required".into());}
    if !matches!(action.as_str(),"chat"|"steer"|"stop"|"approve"|"answer_question"|"stop_agent"|"stop_shell"|"chat_recap") {
        return Err("unsupported_remote_action".into());
    }
    let mut request=arguments.as_object().cloned().ok_or("invalid_remote_arguments")?;
    request.insert("conversation_id".into(),json!(conversation_id));
    request.insert("action".into(),json!(action));
    request.insert("created_at".into(),json!(data::now_millis()));
    request.insert("status".into(),json!("pending"));
    request.insert("new_conversation".into(),json!(false));
    let request=Value::Object(request);
    if serde_json::to_vec(&request).map_err(|e|e.to_string())?.len()>750_000 {return Err("invalid_message_size".into());}
    static SEQUENCE:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
    let id=format!("desktop-{}-{}-{}",identity().0,data::now_millis(),SEQUENCE.fetch_add(1,std::sync::atomic::Ordering::Relaxed));
    state.firestore.relay_put(&auth,&format!("users/{uid}/devices/{device_id}/requests/{id}"),&request,None).await?;
    Ok(id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn remote_chat_receipt(state:tauri::State<'_,AppState>,device_id:String,request_id:String)->Result<Value,String> {
    data::valid_id(&device_id)?;data::valid_id(&request_id)?;
    let auth=crate::firebase_auth(&state)?;
    let uid=crate::ensure_uid(&state,&auth).await?;
    let receipt=state.firestore.relay_fields(&auth,&format!("users/{uid}/devices/{device_id}/requests/{request_id}"),
        &["status","error","created_at","result"]).await?
        .ok_or("remote_request_missing")?;
    if matches!(receipt["status"].as_str(),Some("pending"|"running")) {
        let device=state.firestore.relay_fields(&auth,&format!("users/{uid}/devices/{device_id}"),&["last_seen"]).await?
            .ok_or("remote_device_offline")?;
        if data::now_millis().saturating_sub(device["last_seen"].as_u64().unwrap_or(0))>60_000 {
            return Err("remote_request_unconfirmed".into());
        }
    }
    Ok(receipt)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn remote_chat_inbox(state:tauri::State<'_,AppState>,device_id:String,conversation_id:String)->Result<Value,String> {
    data::valid_id(&device_id)?;data::valid_id(&conversation_id)?;
    let auth=crate::firebase_auth(&state)?;
    let uid=crate::ensure_uid(&state,&auth).await?;
    let mut inbox=json!({});
    for collection in ["approvals","questions"] {
        let items=state.firestore.relay_items(&auth,&format!("users/{uid}/devices/{device_id}/{collection}")).await?;
        inbox[collection]=json!(items.into_iter().filter(|item|item["conversation_id"].as_str()==Some(conversation_id.as_str())).collect::<Vec<_>>());
    }
    Ok(inbox)
}

async fn publish_live(app:&tauri::AppHandle,turns:&Arc<Mutex<HashMap<String,LiveTurn>>>) {
    let now=data::now_millis();
    let (jobs,expired)={
        let turns=turns.lock().unwrap();
        let jobs:Vec<(String,LiveTurn,Value)>=turns.iter().filter_map(|(id,turn)| {
            let due=turn.revision!=turn.published_revision
                || (turn.status=="running" && now.saturating_sub(turn.updated_at)>=LIVE_HEARTBEAT_MS);
            due.then(||(id.clone(),turn.clone(),turn.document(id)))
        }).collect();
        let expired:Vec<String>=turns.iter()
            .filter(|(_,turn)|turn.finished_at.is_some_and(|finished|now.saturating_sub(finished)>LIVE_RETENTION_MS))
            .map(|(id,_)|id.clone()).collect();
        (jobs,expired)
    };
    if jobs.is_empty() && expired.is_empty() {return;}
    let state=app.state::<AppState>();
    let Some(uid)=state.firestore.uid() else{return};
    let jobs:Vec<_>=jobs.into_iter().filter(|(_,turn,_)|turn.uid.as_deref().is_none_or(|turn_uid|turn_uid==uid)).collect();
    let Ok(auth)=crate::firebase_auth(&state) else{return};
    let (device,_)=identity();
    for (id,snapshot,value) in jobs {
        let path=format!("users/{uid}/devices/{device}/live_turns/{id}");
        if state.firestore.relay_upsert(&auth,&path,&value).await.is_ok() {
            if let Some(turn)=turns.lock().unwrap().get_mut(&id) {
                if turn.revision==snapshot.revision {turn.published_revision=turn.revision;}
            }
        }
    }
    for id in expired {
        let path=format!("users/{uid}/devices/{device}/live_turns/{id}");
        if state.firestore.relay_delete(&auth,&path).await.is_ok() {turns.lock().unwrap().remove(&id);}
    }
}

async fn session(app:&tauri::AppHandle)->Result<Option<(FirestoreAuth,String)>,String>{
    if !app.state::<crate::updates::Updates>().ready.load(std::sync::atomic::Ordering::SeqCst) {return Ok(None);}
    let state=app.state::<AppState>();
    if state.config.lock().unwrap().refresh_token.is_empty(){return Ok(None);}
    let auth=crate::firebase_auth(&state)?;
    let uid=crate::ensure_uid(&state,&auth).await?;
    Ok(Some((auth,uid)))
}

async fn heartbeat_once(app:&tauri::AppHandle)->Result<(),String>{
    let state=app.state::<AppState>();let _account=state.account_lock.lock().await;
    let Some((auth,uid))=session(app).await? else{return Ok(())};
    let (id,name)=identity();
    let state=app.state::<AppState>();
    let user=crate::load_user_cached(&state,&auth,&uid).await?;
    let models:Vec<Value>=user.models.iter().map(|(id,m)|json!({"id":id,"name":m.model})).collect();
    if !state.data_loaded.load(std::sync::atomic::Ordering::SeqCst){crate::get_data(app.state::<AppState>()).await?;}
    let project_ids:Vec<String>=state.data.lock().unwrap().projects.iter().map(|p|p.id.clone()).collect();
    let project_permissions:serde_json::Map<String,Value>={
        let permissions=state.permissions.lock().unwrap();
        project_ids.iter().map(|id|{let mode=permissions.get(&uid,id);(id.clone(),json!(mode))}).collect()
    };
    let isolated=state.firestore.companion_isolated(&auth).await?;
    let mut skills=serde_json::Map::new();
    let mut global_skills=json!({"skills":[],"truncated":false});
    if isolated {
        global_skills=crate::skill_context(app,&uid,None)?.catalog(false)?;
        if let Some(items)=global_skills["skills"].as_array_mut() {
            if items.len()>50 {items.truncate(50);global_skills["truncated"]=json!(true);}
        }
        for project in &project_ids {
            let mut catalog=crate::project_skill_catalog(app,&uid,project).await?;
            if let Some(items)=catalog["skills"].as_array_mut() {
                if items.len()>50 {items.truncate(50);catalog["truncated"]=json!(true);}
            }
            skills.insert(project.clone(),catalog);
        }
    }
    let speech=state.speech.status();
    state.firestore.relay_upsert(&auth,&format!("users/{uid}/devices/{id}"),
        &json!({"name":name,"platform":std::env::consts::OS,"identity_version":2,"last_seen":data::now_millis(),"protocol":6,"remote_enabled":isolated,"models":models,"active_model":user.active_model,"speech":{"ready":speech.ready,"busy":speech.busy,"loading":speech.loading},"project_permissions":project_permissions,"project_skills":skills,"global_skills":global_skills})).await?;
    let tree=state.data.lock().unwrap().storage_tree()?;
    state.firestore.relay_upsert(&auth,&format!("users/{uid}/companion/state"),&json!({"tree":tree})).await?;
    let outbox=state.config_dir.join("notification-outbox").join(&uid);
    if let Ok(entries)=std::fs::read_dir(outbox) {
        for entry in entries.flatten().filter(|e|e.path().extension().is_some_and(|ext|ext=="json")).take(10) {
            let path=entry.path();let Some(id)=path.file_stem().and_then(|s|s.to_str()) else{continue};
            if id.len()!=64 || !id.bytes().all(|b|b.is_ascii_hexdigit()){continue;}
            let value:Value=match std::fs::read(&path).ok().and_then(|bytes|serde_json::from_slice(&bytes).ok()){Some(v)=>v,None=>continue};
            match state.firestore.relay_put(&auth,&format!("users/{uid}/notifications/{id}"),&value,None).await {
                Ok(())=>{let _=std::fs::remove_file(path);},
                Err(e) if e.contains("ALREADY_EXISTS")=>{let _=std::fs::remove_file(path);},
                Err(e)=>return Err(e),
            }
        }
    }
    Ok(())
}

async fn poll(app:&tauri::AppHandle,boot_time:u64)->Result<(),String>{
    let account_state=app.state::<AppState>();let _account=account_state.account_lock.lock().await;
    let Some((auth,uid))=session(app).await? else{return Ok(())};
    let state=app.state::<AppState>();let (device,_)=identity();
    if !state.firestore.companion_isolated(&auth).await? {return Ok(());}
    let path=format!("users/{uid}/devices/{device}");
    for (path,revision,mut request) in state.firestore.relay_requests(&auth,&path,"running").await? {
        if request["started_at"].as_u64().unwrap_or(0)<boot_time {
            request["status"]=json!("failed");request["error"]=json!("desktop_restarted");request["finished_at"]=json!(data::now_millis());
            let _=state.firestore.relay_put(&auth,&path,&request,Some(&revision)).await;
        }
    }
    for (path,revision,mut request) in state.firestore.relay_requests(&auth,&path,"pending").await? {
        if state.firestore.uid().as_deref()!=Some(&uid){return Ok(());}
        request["status"]=json!("running");request["started_at"]=json!(data::now_millis());
        if state.firestore.relay_put(&auth,&path,&request,Some(&revision)).await.is_err(){continue;}
        // A claimed request is processed once. Ambiguous outcomes require a new user action.
        let app=app.clone();let uid=uid.clone();let auth=auth.clone();
        tauri::async_runtime::spawn(async move {
            let result=execute(&app,&uid,&auth,&request).await;
            request["finished_at"]=json!(data::now_millis());
            match result {
                Ok(value)=>{request["status"]=json!("completed");if !value.is_null(){request["result"]=value;}},
                Err(e)=>{request["status"]=json!("failed");request["error"]=json!(e);}
            }
            let state=app.state::<AppState>();
            if state.firestore.uid().as_deref()!=Some(&uid){return;}
            if let Err(e)=state.firestore.relay_upsert(&auth,&path,&request).await {eprintln!("Relay result publication failed: {e}");}
            let _=heartbeat_once(&app).await;
            if request["action"].as_str().unwrap_or("chat")=="chat" {
                let _=app.emit("companion-updated",json!({"conversation_id":request["conversation_id"]}));
            }
        });
    }
    Ok(())
}

async fn execute(app:&tauri::AppHandle,uid:&str,auth:&FirestoreAuth,request:&Value)->Result<Value,String>{
    let account_state=app.state::<AppState>();let account=account_state.account_lock.lock().await;
    if account_state.firestore.uid().as_deref()!=Some(uid){return Err("login_required".into());}
    let id=request["conversation_id"].as_str().ok_or("invalid_conversation_id")?;data::valid_id(id)?;
    let state=app.state::<AppState>();
    let created=request["created_at"].as_u64().ok_or("invalid_request_time")?;
    if data::now_millis().saturating_sub(created)>300_000{return Err("request_expired".into());}
    match request["action"].as_str().unwrap_or("chat") {
        "project_git"=>{
            let operation=remote_git_operation(request)?;
            let project={
                let tree=state.data.lock().unwrap();
                tree.projects.iter().find(|p|p.conversations.iter().any(|c|c.id==id)).map(|p|p.id.clone()).ok_or("project_not_found")?
            };
            let paths=request["paths"].as_array().map(|paths|paths.iter().map(|p|p.as_str().map(String::from).ok_or("invalid_git_path")).collect::<Result<Vec<_>,_>>()).transpose()?;
            drop(account);
            return crate::project_git_for_owner(app.state::<AppState>(),project,
                request["root"].as_str().unwrap_or("").into(),operation.into(),paths,
                request["revision"].as_str().map(String::from),request["message"].as_str().map(String::from),
                Some(id.into()),Some(uid.into())).await;
        },
        "chat_recap"=>{
            if state.data.lock().unwrap().find_conversation(id).is_none() {return Err("conversation_not_found".into());}
            return Ok(shell_recap(app.state::<Arc<crate::managed_shells::Shells>>().list(uid,id)));
        },
        "stop"=>return state.chat_runs.stop(uid,id).map(|_|Value::Null),
        "steer"=>return crate::steer_chat(app.state::<AppState>(),id.into(),request["content"].as_str().ok_or("empty_message")?.into(),
            request.get("attachments").cloned().map(serde_json::from_value).transpose().map_err(|e|e.to_string())?).map(|_|Value::Null),
        "stop_agent"=>return crate::stop_subagent(app.state::<AppState>(),app.state::<crate::agent_runs::AgentRuns>(),app.state::<Arc<crate::managed_shells::Shells>>(),id.into(),request["agent_id"].as_str().ok_or("invalid_agent")?.into()).await.map(|_|Value::Null),
        "stop_shell"=>return crate::stop_shell(app.state::<AppState>(),app.state::<Arc<crate::managed_shells::Shells>>(),id.into(),request["shell_id"].as_str().ok_or("invalid_shell")?.into()).await
            .and_then(|snapshot|serde_json::to_value(snapshot).map_err(|e|e.to_string())),
        "approve"=>return app.state::<crate::approvals::Approvals>().resolve(uid,id,request["approval_id"].as_str().ok_or("invalid_approval")?,request["allow"].as_bool().ok_or("invalid_decision")?).map(|_|Value::Null),
        "answer_question"=>{
            let question_id=request["question_id"].as_str().ok_or("invalid_question")?;
            let answer:crate::questions::Answer=serde_json::from_value(request["answer"].clone()).map_err(|_|"invalid_question_answer".to_string())?;
            let snapshot=app.state::<crate::questions::Questions>().resolve(uid,id,question_id,answer)?;
            let _=app.emit("question-activity",snapshot);
            return Ok(Value::Null);
        },
        "model"=>return crate::set_conversation_model(app.state::<AppState>(),id.into(),request["model"].as_str().ok_or("invalid_model")?.into()).await.map(|_|Value::Null),
        "skills_catalog"=>{
            let context=crate::skill_context(app,uid,request["project_id"].as_str())?;
            drop(account);
            return tauri::async_runtime::spawn_blocking(move||context.catalog(true)).await.map_err(|e|e.to_string())?;
        },
        "skill_enabled"=>{
            let context=crate::skill_context(app,uid,request["project_id"].as_str())?;
            context.set_enabled(request["id"].as_str().ok_or("invalid_skill")?,request["enabled"].as_bool().ok_or("invalid_decision")?)?;
            let _=app.emit("companion-permissions",json!({"project_id":request["project_id"]}));
            return Ok(Value::Null);
        },
        "skills_search"=>{
            let query=request["query"].as_str().ok_or("invalid_skill_query")?;
            drop(account);
            return crate::skills::search(query).await;
        },
        "skill_install"=>{
            if request["confirm_install"]!=true {return Err("skill_install_confirmation_required".into());}
            let source=request["source"].as_str().ok_or("invalid_skill_source")?.to_string();
            let name=request["name"].as_str().ok_or("invalid_skill_name")?.to_string();
            drop(account);
            crate::install_skill(app.clone(),app.state::<AppState>(),source,name).await?;
            let _=app.emit("companion-permissions",json!({}));
            return Ok(Value::Null);
        },
        "rename_chat"|"delete_chat"=>{
            let _save=state.history_save_lock.lock().await;
            if state.running_chats.lock().unwrap().contains(id) {return Err("chat_in_progress".into());}
            let local=state.data.lock().unwrap().clone();
            let mut tree=state.firestore.refresh_tree_preserving_history(uid,auth,&local).await?;
            change_chat(&mut tree,id,request)?;
            state.firestore.save_tree(uid,auth,&tree).await?;
            *state.data.lock().unwrap()=state.firestore.cached_tree(uid).unwrap_or(tree);
            let _=app.emit("companion-updated",json!({"conversation_id":id}));
            return Ok(Value::Null);
        },
        "permission"=>{
            let mode=remote_permission_mode(request)?;
            let project=request["project_id"].as_str().ok_or("project_not_found")?;
            crate::project_permission_mode(app.state::<AppState>(),project.into(),Some(mode)).await?;
            let _=app.emit("companion-permissions",json!({"project_id":project}));
            return Ok(Value::Null);
        },
        "transcribe"=>{
            let language=request["language"].as_str().unwrap_or("en").to_string();
            let parts:Vec<&str>=request["audio_parts"].as_array().ok_or("invalid_audio")?.iter().filter_map(Value::as_str).collect();
            if parts.is_empty()||parts.len()>8{return Err("invalid_audio".into());}
            let (device,_)=identity();
            let mut bytes=Vec::new();
            for part in parts {
                data::valid_id(part)?;
                let path=format!("users/{uid}/devices/{device}/requests/{part}");
                let Some(doc)=state.firestore.relay_get(auth,&path).await? else{return Err("audio_missing".into());};
                let audio=doc["audio"].as_str().ok_or("invalid_audio")?;
                let decoded=BASE64.decode(audio).map_err(|_|"invalid_audio".to_string())?;
                if bytes.len()+decoded.len()>4_000_000{return Err("speech_invalid_audio".into());}
                bytes.extend_from_slice(&decoded);
            }
            drop(account);
            let speech=state.speech.clone();
            let text=tauri::async_runtime::spawn_blocking(move||speech.transcribe_wav(bytes,&language)).await.map_err(|e|e.to_string())??;
            return Ok(json!({"text":text}));
        },
        "chat"=>(),
        _=>return Err("unsupported_remote_action".into())
    }
    let content=request["content"].as_str().ok_or("empty_message")?;
    let attachments:Vec<crate::llm::Attachment>=request.get("attachments").cloned()
        .map(serde_json::from_value).transpose().map_err(|e|e.to_string())?.unwrap_or_default();
    crate::llm::validate_attachments(&attachments)?;
    let retry=request["retry"].as_bool().unwrap_or(false);
    let edit_index=request.get("edit_index").filter(|v|!v.is_null()).map(|index|
        index.as_u64().and_then(|index|usize::try_from(index).ok()).ok_or("invalid_message_index")).transpose()?;
    if (!retry && content.trim().is_empty() && attachments.is_empty()) || content.len()>100_000 {return Err("invalid_message_size".into());}
    {
        let _save=state.history_save_lock.lock().await;
        if state.running_chats.lock().unwrap().contains(id){return Err("chat_in_progress".into());}
        let local=state.data.lock().unwrap().clone();
        let mut tree=state.firestore.refresh_tree_preserving_history(uid,auth,&local).await?;
        if tree.find_conversation(id).is_none(){
            if request["new_conversation"]!=true{return Err("conversation_not_found".into());}
            let now=data::now_millis();
            let model=request["model"].as_str().map(str::to_string);
            if let Some(model)=&model {if !crate::load_user_cached(&state,auth,uid).await?.models.contains_key(model){return Err("model_not_found".into());}}
            let conversation=Conversation{id:id.into(),title:crate::truncate_title(content),title_state:None,model,messages:vec![],created_at:now,updated_at:now,context_tokens:0,messages_loaded:true,revision:None};
            if let Some(project)=request["project_id"].as_str().filter(|p|!p.is_empty()) {
                tree.projects.iter_mut().find(|p|p.id==project).ok_or("project_not_found")?.conversations.push(conversation);
            }else{tree.conversations.push(conversation);}
            state.firestore.save_tree(uid,auth,&tree).await?;
        } else {
            // A different PC may have added messages since this gateway last loaded the chat.
            state.firestore.load_conversation(uid,auth,id).await?;
        }
        *state.data.lock().unwrap()=state.firestore.cached_tree(uid).unwrap_or(tree);
        state.data_loaded.store(true,std::sync::atomic::Ordering::SeqCst);
    }
    let (user_message,keep_count)={
        let tree=state.data.lock().unwrap();
        let conversation=tree.find_conversation(id).ok_or("conversation_not_found")?;
        let (_,message,keep)=crate::llm::prepare_turn(&conversation.messages,content.into(),attachments.clone(),retry,edit_index)?;
        (message,keep)
    };
    let _=app.emit("companion-started",json!({"conversation_id":id,"content":user_message.content,
        "message":user_message,"keep_count":keep_count}));
    drop(account);
    crate::run_chat(app.clone(),app.state::<AppState>(),id.into(),content.into(),Some(attachments),Some(retry),edit_index,Some(uid.into())).await
        .map(|reply|json!({"cancelled":reply.cancelled}))
}

fn shell_recap(mut shells:Vec<crate::managed_shells::Snapshot>)->Value {
    shells.retain(|s|s.status=="running" || s.finished_at.unwrap_or(s.started_at).saturating_sub(s.started_at)>=15_000);
    shells.sort_by_key(|s|std::cmp::Reverse((s.status=="running",s.started_at)));
    let truncated=shells.len()>20;
    shells.truncate(20);
    // Bound every large field so the relay stays below Firestore's document limit.
    for shell in &mut shells {
        shell.output=truncate_chars(&shell.output,3000);
        shell.command=truncate_chars(&shell.command,2000);
        shell.cwd=truncate_chars(&shell.cwd,1000);
        shell.title=truncate_chars(&shell.title,100);
    }
    json!({"shells":shells,"truncated":truncated})
}

fn remote_git_operation(request:&Value)->Result<&str,String>{
    let operation=request["operation"].as_str().ok_or("invalid_git_operation")?;
    if !matches!(operation,"discover"|"status"|"stage"|"unstage"|"preview"|"generate"|"commit"|"push_preview"|"push") {
        return Err("unsupported_remote_git_operation".into());
    }
    if matches!(operation,"commit"|"push") && request["confirmed"]!=true {
        return Err("git_confirmation_required".into());
    }
    Ok(operation)
}

fn change_chat(tree:&mut data::ChatData,id:&str,request:&Value)->Result<(),String>{
    let conversation=tree.find_conversation(id).ok_or("conversation_not_found")?;
    if request["expected_updated_at"].as_u64()!=Some(conversation.updated_at) || request["expected_title"].as_str()!=Some(&conversation.title) {
        return Err("conversation_changed".into());
    }
    match request["action"].as_str() {
        Some("rename_chat")=>{
            let title=request["title"].as_str().map(str::trim).filter(|s|!s.is_empty() && s.chars().count()<=160 && !s.chars().any(char::is_control)).ok_or("invalid_chat_title")?;
            let conversation=tree.find_conversation_mut(id).ok_or("conversation_not_found")?;
            conversation.title=title.into();conversation.title_state=Some("manual".into());
        },
        Some("delete_chat")=>{
            if request["confirm_delete"]!=true {return Err("chat_delete_confirmation_required".into());}
            tree.conversations.retain(|c|c.id!=id);
            for project in &mut tree.projects {project.conversations.retain(|c|c.id!=id);}
        },
        _=>return Err("unsupported_remote_action".into()),
    }
    Ok(())
}

fn remote_permission_mode(request:&Value)->Result<crate::permissions::Mode,String>{
    let mode:crate::permissions::Mode=serde_json::from_value(request["mode"].clone()).map_err(|_|"invalid_permission_mode")?;
    if mode==crate::permissions::Mode::Full && request["confirm_full_access"]!=true {return Err("full_access_confirmation_required".into());}
    Ok(mode)
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]
    fn recap_filters_short_shells_prioritizes_running_and_bounds_relay_bytes() {
        let mut shell=crate::managed_shells::Snapshot {
            id:"shell".into(),conversation_id:"chat".into(),agent_id:None,
            title:"title".into(),command:"command".into(),cwd:"cwd".into(),
            status:"completed".into(),output:"output".into(),exit_code:Some(0),
            revision:1,started_at:100,finished_at:Some(15_099),
        };
        assert_eq!(shell_recap(vec![shell.clone()])["shells"],json!([]));
        shell.finished_at=Some(15_100);
        assert_eq!(shell_recap(vec![shell.clone()])["shells"].as_array().unwrap().len(),1);
        shell.status="running".into();shell.finished_at=None;
        shell.output="\0".repeat(20_000);shell.command=shell.output.clone();
        shell.title=shell.output.clone();shell.cwd=shell.output.clone();
        let mut entries=vec![shell;30];
        entries[0].status="completed".into();entries[0].finished_at=Some(30_000);
        let recap=shell_recap(entries);
        assert_eq!(recap["shells"].as_array().unwrap().len(),20);
        assert_eq!(recap["truncated"],true);
        assert_eq!(recap["shells"][0]["status"],"running");
        assert!(serde_json::to_vec(&recap).unwrap().len()<750_000);
    }
    #[test]
    fn remote_git_requires_confirmation_and_rejects_unsupported_operations() {
        for operation in ["discover","status","stage","unstage","preview","generate","push_preview"] {
            assert_eq!(remote_git_operation(&json!({"operation":operation})).unwrap(),operation);
        }
        for operation in ["commit","push"] {
            assert_eq!(remote_git_operation(&json!({"operation":operation})).unwrap_err(),"git_confirmation_required");
            assert!(remote_git_operation(&json!({"operation":operation,"confirmed":"true"})).is_err());
            assert_eq!(remote_git_operation(&json!({"operation":operation,"confirmed":true})).unwrap(),operation);
        }
        for operation in ["discard","reset","execute_project_command",""] {
            assert_eq!(remote_git_operation(&json!({"operation":operation,"confirmed":true})).unwrap_err(),"unsupported_remote_git_operation");
        }
        assert!(remote_git_operation(&json!({})).is_err());
    }
    #[test]
    fn remote_chat_changes_are_scoped_confirmed_and_revision_checked() {
        let chat=json!({"id":"chat","title":"Original","created_at":1,"updated_at":2,"context_tokens":0,"messages":[]});
        let mut tree:data::ChatData=serde_json::from_value(json!({"projects":[{"id":"project","name":"Project","conversations":[chat]}],"conversations":[{"id":"other","title":"Other","created_at":1,"updated_at":2,"context_tokens":0}]})).unwrap();
        let mut request=json!({"action":"rename_chat","expected_title":"Original","expected_updated_at":2,"title":" Renamed "});
        change_chat(&mut tree,"chat",&request).unwrap();
        assert_eq!(tree.find_conversation("chat").unwrap().title,"Renamed");
        assert!(change_chat(&mut tree,"chat",&request).unwrap_err().contains("conversation_changed"));
        request["expected_title"]="Renamed".into();request["title"]="   ".into();
        assert!(change_chat(&mut tree,"chat",&request).is_err());
        request["action"]="delete_chat".into();
        assert!(change_chat(&mut tree,"chat",&request).unwrap_err().contains("confirmation"));
        assert!(tree.find_conversation("chat").is_some());
        request["confirm_delete"]=true.into();request["expected_updated_at"]=1.into();
        assert!(change_chat(&mut tree,"chat",&request).is_err());
        request["expected_updated_at"]=2.into();
        change_chat(&mut tree,"chat",&request).unwrap();
        assert!(tree.find_conversation("chat").is_none());assert!(tree.find_conversation("other").is_some());
        assert_eq!(tree.projects.len(),1);
    }
    #[test]fn remote_permissions_require_explicit_full_access_confirmation(){
        use crate::permissions::Mode;
        assert_eq!(remote_permission_mode(&json!({"mode":"ask"})).unwrap(),Mode::Ask);
        assert_eq!(remote_permission_mode(&json!({"mode":"auto"})).unwrap(),Mode::Auto);
        assert!(remote_permission_mode(&json!({"mode":"full"})).is_err());
        assert!(remote_permission_mode(&json!({"mode":"invalid"})).is_err());
        assert_eq!(remote_permission_mode(&json!({"mode":"full","confirm_full_access":true})).unwrap(),Mode::Full);
    }
    #[test]fn notification_preview_keeps_the_beginning_and_unicode(){
        assert_eq!(notification_preview("  Prima\nriga  seconda ", 10), "Prima riga…");
        assert_eq!(notification_preview("Ciao 🌍!", 6), "Ciao 🌍…");
        assert_eq!(notification_preview("Breve", 200), "Breve");
    }
    #[test]fn identity_stays_stable(){let (id,name)=identity();assert!(data::valid_id(&id).is_ok());assert!(!name.is_empty());assert_eq!(identity().0,id);}
    #[test]fn windows_identity_is_independent_of_launch_environment_case(){
        assert_eq!(device_identity_id("windows","Ridney","lofio"),device_identity_id("windows","RIDNEY","LOFIO"));
        assert_eq!(device_identity_id("windows","Ridney","lofio"),format!("windows-{:x}",Sha256::digest(b"ridney/lofio")));
        assert_ne!(device_identity_id("windows","Ridney","lofio"),device_identity_id("windows","other","lofio"));
    }
    #[test]fn device_identity_separates_platforms_and_unix_users(){
        assert_ne!(device_identity_id("macos","Mac","lorenzo"),device_identity_id("windows","Mac","lorenzo"));
        assert_ne!(device_identity_id("macos","Mac","lorenzo"),device_identity_id("macos","Mac","Lorenzo"));
        assert!(identity().0.starts_with(&format!("{}-",std::env::consts::OS)));
    }
    #[cfg(target_os="macos")]
    #[test]fn mac_identity_uses_the_system_computer_name(){
        let name=system_name("/usr/sbin/scutil",&["--get","ComputerName"]).unwrap();
        assert!(identity().1.ends_with(&format!(" · {name}")));
    }
    #[test]fn completion_notice_skips_only_the_focused_open_chat(){
        assert!(viewing_match(Some("c"),true,"c"));
        assert!(!viewing_match(Some("c"),false,"c"));
        assert!(!viewing_match(Some("other"),true,"c"));
        assert!(!viewing_match(None,true,"c"));
    }
    #[test]fn live_turn_tracks_streams_and_upserts_activity(){
        let mut turn=LiveTurn::running(1,Some("u".into()),"t1","Domanda");
        turn.apply_progress("__delta","Ciao",2);
        turn.apply_progress("__reasoning","Penso",3);
        turn.apply_progress("__activity",r#"{"kind":"tool","id":"t1","action":"read_project_file","path":"a.txt","status":"running"}"#,4);
        turn.apply_progress("__activity",r#"{"kind":"tool","id":"t1","action":"read_project_file","path":"a.txt","status":"completed"}"#,5);
        turn.apply_agent(serde_json::json!({"id":"a1","title":"Sub","status":"running","content":"x"}),6);
        turn.apply_agent(serde_json::json!({"id":"a1","title":"Sub","status":"completed","content":"y"}),7);
        assert_eq!(turn.content,"Ciao");assert_eq!(turn.reasoning,"Penso");
        assert_eq!(turn.activity.len(),3);assert_eq!(turn.activity[0]["kind"],"reasoning");assert_eq!(turn.activity[1]["status"],"completed");assert_eq!(turn.activity[2]["kind"],"agent");
        let live=turn.document("c");
        assert_eq!(live["user_content"],"Domanda");assert_eq!(live["status"],"running");assert_eq!(live["activity"].as_array().unwrap().len(),3);
        turn.finish("completed",8);assert_eq!(turn.document("c")["status"],"completed");assert_eq!(turn.finished_at,Some(8));
    }
    #[test]fn live_details_preserve_utf16_offsets_and_nested_tools(){
        let mut turn=LiveTurn::running(1,Some("u".into()),"t","Q");
        turn.apply_progress("__delta","🌍",2);
        turn.apply_progress("__reasoning","Check",3);
        turn.apply_agent(json!({"id":"a","activity":[{"id":"cmd","kind":"tool","arguments":{"program":"git","arguments":["status"]},"output":"clean"}]}),4);
        let value=turn.document("c");
        assert_eq!(value["activity"][0]["offset"],2);
        assert_eq!(value["activity"][1]["activity"][0]["output"],"clean");
        assert_eq!(value["activity"][1]["activity"][0]["arguments"]["program"],"git");
        assert!(serde_json::to_vec(&value).unwrap().len()<750_000);
    }
    #[test]fn live_guidance_splits_chronology_and_resets_offsets(){
        let mut turn=LiveTurn::running(1,Some("u".into()),"t","Original");
        turn.apply_progress("__delta","Before",2);
        turn.apply_progress("__reasoning","Check",3);
        turn.apply_progress("__steering",r#"{"role":"user","content":"Change direction","attachments":[]}"#,4);
        turn.apply_progress("__reasoning","New plan",5);
        turn.apply_progress("__delta","After",6);
        let document=turn.document("c");
        assert_eq!(document["user_content"],"Original");
        assert_eq!(document["segments"][0]["content"],"Before");
        assert_eq!(document["segments"][1]["role"],"user");
        assert_eq!(document["segments"][1]["content"],"Change direction");
        assert_eq!(document["content"],"After");
        assert_eq!(document["activity"][0]["offset"],0);
        turn.apply_progress("__steering","malformed",7);
        assert_eq!(turn.document("c")["segments"].as_array().unwrap().len(),2);
        turn.apply_progress("__question_summary",r#"{"role":"user","content":"T1\nA","attachments":[]}"#,8);
        let document=turn.document("c");
        assert_eq!(document["segments"][2]["content"],"After");
        assert_eq!(document["segments"][3]["content"],"T1\nA");
        assert_eq!(document["content"],"");
    }
}
