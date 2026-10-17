//! Authenticated Firestore companion transport. Requests are claimed with a
//! document-version precondition; an interrupted request is never replayed.
use crate::{AppState, config::FirestoreAuth, data::{self, Conversation}};
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

pub fn identity() -> (String, String) {
    static IDENTITY:std::sync::OnceLock<(String,String)>=std::sync::OnceLock::new();
    IDENTITY.get_or_init(|| {
    let computer = std::env::var("COMPUTERNAME").ok().filter(|name|!name.is_empty()).unwrap_or_else(|| {
        let root=std::env::var("SystemRoot").unwrap_or_else(|_|"C:\\Windows".into());
        let mut command=std::process::Command::new(std::path::Path::new(&root).join("System32/hostname.exe"));
        #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
        command.output().ok().filter(|result|result.status.success()).and_then(|result|String::from_utf8(result.stdout).ok()).map(|name|name.trim().to_string()).filter(|name|!name.is_empty()).unwrap_or_else(||"PC".into())
    });
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "Windows".into());
    let id = format!("windows-{:x}", Sha256::digest(format!("{computer}/{user}").as_bytes()));
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
    content: String,
    reasoning: String,
    activity: Vec<Value>,
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
            "__delta" => self.content.push_str(text),
            "__reasoning" => self.reasoning.push_str(text),
            "__activity" => {
                let Ok(mut event) = serde_json::from_str::<Value>(text) else { return };
                if event["kind"].as_str() != Some("tool") || event["id"].as_str().is_none() { return; }
                event["offset"] = serde_json::json!(self.content.chars().count());
                upsert_activity(&mut self.activity, event);
            }
            _ => return,
        }
        self.touch(now);
    }
    fn apply_agent(&mut self, mut agent: Value, now: u64) {
        if agent["id"].as_str().is_none() { return; }
        agent["kind"] = serde_json::json!("agent");
        agent["offset"] = serde_json::json!(self.content.chars().count());
        upsert_activity(&mut self.activity, agent);
        self.touch(now);
    }
    fn document(&self, conversation: &str) -> Value {
        serde_json::json!({
            "conversation_id": conversation,
            "turn_id": self.turn_id,
            "status": self.status,
            "user_content": self.user_content,
            "content": truncate_chars(&self.content, LIVE_MAX_CONTENT),
            "reasoning": truncate_chars(&self.reasoning, LIVE_MAX_REASONING),
            "activity": self.activity.iter().rev().take(LIVE_MAX_ACTIVITY).rev().map(sanitize_activity).collect::<Vec<_>>(),
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "updated_at": self.updated_at,
        })
    }
}

fn upsert_activity(list: &mut Vec<Value>, event: Value) {
    if let Some(previous) = list.iter_mut().rev().find(|entry| entry["kind"] == event["kind"] && entry["id"] == event["id"]) {
        *previous = event;
    } else {
        list.push(event);
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max { return text.to_string(); }
    let mut value: String = text.chars().take(max).collect();
    value.push('…');
    value
}

/// Keeps the live document small: only fields the phone displays.
fn sanitize_activity(event: &Value) -> Value {
    const KEYS: &[&str] = &["kind", "id", "action", "path", "title", "status", "summary", "task", "model", "text", "content", "reasoning_content"];
    let mut value = serde_json::Map::new();
    for key in KEYS {
        match event.get(*key) {
            Some(Value::String(text)) => { value.insert((*key).into(), serde_json::json!(truncate_chars(text, LIVE_MAX_FIELD))); }
            Some(item @ (Value::Bool(_) | Value::Number(_))) => { value.insert((*key).into(), item.clone()); }
            _ => {}
        }
    }
    Value::Object(value)
}

pub fn notify(app: &tauri::AppHandle, kind: &str, id: &str, conversation: &str, title: &str, body: &str) {
    let state=app.state::<AppState>();
    let Some(uid)=state.firestore.uid() else { return; };
    let auth=match crate::firebase_auth(&state) {Ok(a)=>a,Err(_)=>return};
    // OS notifications are independent of the webview's focus and visibility.
    if let Err(e)=app.notification().builder().title(title).body(body).show() { eprintln!("Windows notification: {e}"); }
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
    let jobs:Vec<_>=jobs.into_iter().filter(|(_,turn,_)|turn.uid.as_deref()==Some(uid.as_str())).collect();
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
        project_ids.into_iter().map(|id|{let mode=permissions.get(&uid,&id);(id,json!(mode))}).collect()
    };
    let isolated=state.firestore.companion_isolated(&auth).await?;
    state.firestore.relay_upsert(&auth,&format!("users/{uid}/devices/{id}"),
        &json!({"name":name,"platform":"windows","last_seen":data::now_millis(),"protocol":2,"remote_enabled":isolated,"models":models,"active_model":user.active_model,"project_permissions":project_permissions})).await?;
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
            match result {Ok(())=>request["status"]=json!("completed"),Err(e)=>{request["status"]=json!("failed");request["error"]=json!(e);}}
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

async fn execute(app:&tauri::AppHandle,uid:&str,auth:&FirestoreAuth,request:&Value)->Result<(),String>{
    let account_state=app.state::<AppState>();let account=account_state.account_lock.lock().await;
    if account_state.firestore.uid().as_deref()!=Some(uid){return Err("login_required".into());}
    let id=request["conversation_id"].as_str().ok_or("invalid_conversation_id")?;data::valid_id(id)?;
    let state=app.state::<AppState>();
    let created=request["created_at"].as_u64().ok_or("invalid_request_time")?;
    if data::now_millis().saturating_sub(created)>300_000{return Err("request_expired".into());}
    match request["action"].as_str().unwrap_or("chat") {
        "stop"=>return state.chat_runs.stop(uid,id),
        "approve"=>return app.state::<crate::approvals::Approvals>().resolve(uid,id,request["approval_id"].as_str().ok_or("invalid_approval")?,request["allow"].as_bool().ok_or("invalid_decision")?),
        "model"=>return crate::set_conversation_model(app.state::<AppState>(),id.into(),request["model"].as_str().ok_or("invalid_model")?.into()).await.map(|_|()),
        "permission"=>{
            let mode=remote_permission_mode(request)?;
            let project=request["project_id"].as_str().ok_or("project_not_found")?;
            crate::project_permission_mode(app.state::<AppState>(),project.into(),Some(mode)).await?;
            let _=app.emit("companion-permissions",json!({"project_id":project}));
            return Ok(());
        },
        "chat"=>(),
        _=>return Err("unsupported_remote_action".into())
    }
    let content=request["content"].as_str().ok_or("empty_message")?;
    if content.trim().is_empty() || content.len()>100_000 {return Err("invalid_message_size".into());}
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
            let conversation=Conversation{id:id.into(),title:crate::truncate_title(content),model,messages:vec![],created_at:now,updated_at:now,context_tokens:0,messages_loaded:true,revision:None};
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
    let _=app.emit("companion-started",json!({"conversation_id":id,"content":content}));
    drop(account);
    crate::run_chat(app.clone(),app.state::<AppState>(),id.into(),content.into(),None,None,None,Some(uid.into())).await.map(|_|())
}

fn remote_permission_mode(request:&Value)->Result<crate::permissions::Mode,String>{
    let mode:crate::permissions::Mode=serde_json::from_value(request["mode"].clone()).map_err(|_|"invalid_permission_mode")?;
    if mode==crate::permissions::Mode::Full && request["confirm_full_access"]!=true {return Err("full_access_confirmation_required".into());}
    Ok(mode)
}

#[cfg(test)]mod tests{
    use super::*;
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
    #[test]fn live_turn_tracks_streams_and_upserts_activity(){
        let mut turn=LiveTurn::running(1,Some("u".into()),"t1","Domanda");
        turn.apply_progress("__delta","Ciao",2);
        turn.apply_progress("__reasoning","Penso",3);
        turn.apply_progress("__activity",r#"{"kind":"tool","id":"t1","action":"read_project_file","path":"a.txt","status":"running"}"#,4);
        turn.apply_progress("__activity",r#"{"kind":"tool","id":"t1","action":"read_project_file","path":"a.txt","status":"completed"}"#,5);
        turn.apply_agent(serde_json::json!({"id":"a1","title":"Sub","status":"running","content":"x"}),6);
        turn.apply_agent(serde_json::json!({"id":"a1","title":"Sub","status":"completed","content":"y"}),7);
        assert_eq!(turn.content,"Ciao");assert_eq!(turn.reasoning,"Penso");
        assert_eq!(turn.activity.len(),2);assert_eq!(turn.activity[0]["status"],"completed");assert_eq!(turn.activity[1]["kind"],"agent");
        let live=turn.document("c");
        assert_eq!(live["user_content"],"Domanda");assert_eq!(live["status"],"running");assert_eq!(live["activity"].as_array().unwrap().len(),2);
        turn.finish("completed",8);assert_eq!(turn.document("c")["status"],"completed");assert_eq!(turn.finished_at,Some(8));
    }
}
