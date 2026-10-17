mod config;
mod folder_access;
mod data;
mod firestore;
mod llm;
mod window_state;
mod speech;
mod project_files;
mod managed_shells;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use config::{AppConfig, FirestoreAuth, PublicConfig, SaveConfigInput, UserConfig};
use data::ChatData;
use folder_access::FolderAccess;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use firestore::Firestore;
use llm::{Attachment, ChatMessage, Usage};
use tauri_plugin_opener::OpenerExt;
use tauri::{Emitter, Manager};
use window_state::WindowGeometry;

const ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");
const TRAY_PNG: &[u8] = include_bytes!("../icons/tray.png");

pub struct AppState {
    speech: std::sync::Arc<speech::Speech>,
    config: Mutex<AppConfig>,
    config_dir: PathBuf,
    user: Mutex<Option<UserConfig>>,
    data: Mutex<ChatData>,
    data_loaded: AtomicBool,
    firestore: Firestore,
    client: reqwest::Client,
    quitting: AtomicBool,
    folder_access: Mutex<FolderAccess>,
    window_geometry: Mutex<Option<WindowGeometry>>,
    window_owner: Mutex<Option<String>>,
    window_restoring: AtomicBool,
    window_save_lock: tauri::async_runtime::Mutex<()>,
    history_save_lock: tauri::async_runtime::Mutex<()>,
    running_chats: Mutex<std::collections::HashSet<String>>,
}

struct ConversationRun<'a> { active: &'a Mutex<std::collections::HashSet<String>>, id: String }
impl Drop for ConversationRun<'_> {
    fn drop(&mut self) { self.active.lock().unwrap().remove(&self.id); }
}

fn app_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::from_bytes(ICON_PNG).expect("icon.png deve essere un PNG valido")
}

fn tray_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::from_bytes(TRAY_PNG).expect("tray.png deve essere un PNG valido")
}

#[tauri::command]
fn speech_model_status(state: tauri::State<'_, AppState>) -> speech::ModelStatus { state.speech.status() }
#[tauri::command]
async fn download_speech_model(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<speech::ModelStatus, String> {
    let result = state.speech.download(|status| { let _ = app.emit("speech-model-progress", status); }).await;
    let _ = app.emit("speech-model-progress", state.speech.status());
    result
}
#[tauri::command]
fn cancel_speech_download(state: tauri::State<'_, AppState>) { state.speech.cancel(); }
#[tauri::command]
async fn remove_speech_model(state: tauri::State<'_, AppState>) -> Result<speech::ModelStatus, String> {
    let speech = state.speech.clone();
    tauri::async_runtime::spawn_blocking(move || speech.remove()).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn transcribe_audio(state: tauri::State<'_, AppState>, samples: Vec<f32>, language: String) -> Result<String, String> {
    let speech = state.speech.clone();
    tauri::async_runtime::spawn_blocking(move || speech.transcribe(samples, language)).await.map_err(|e| e.to_string())?
}

fn clean(s: &str) -> String {
    s.trim().to_string()
}

fn truncate_title(s: &str) -> String {
    let t: String = s.chars().take(40).collect();
    let t = t.replace('\n', " ").trim().to_string();
    if t.is_empty() {
        "Chat".to_string()
    } else {
        t
    }
}

fn firebase_auth(state: &AppState) -> Result<FirestoreAuth, String> {
    let cfg = state.config.lock().unwrap();
    let auth = cfg.firestore_auth();
    if !auth.configured() {
        return Err("firebase_not_configured".to_string());
    }
    Ok(auth)
}

#[tauri::command(rename_all = "snake_case")]
fn list_shells(state: tauri::State<'_, AppState>, shells: tauri::State<'_, std::sync::Arc<managed_shells::Shells>>, conversation_id: String) -> Result<Vec<managed_shells::Snapshot>, String> {
    let owner = state.firestore.uid().ok_or("login_required")?;
    Ok(shells.list(&owner, &conversation_id))
}

#[tauri::command(rename_all = "snake_case")]
async fn stop_shell(state: tauri::State<'_, AppState>, shells: tauri::State<'_, std::sync::Arc<managed_shells::Shells>>, conversation_id: String, id: String) -> Result<managed_shells::Snapshot, String> {
    let owner = state.firestore.uid().ok_or("login_required")?;
    let shells = shells.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shells.stop(&owner, &conversation_id, &id)).await.map_err(|e| e.to_string())?
}

async fn ensure_uid(state: &AppState, auth: &FirestoreAuth) -> Result<String, String> {
    state.firestore.id_token(auth).await?;
    if let Some((uid, refresh)) = state.firestore.session() {
        let mut cfg = state.config.lock().unwrap();
        if cfg.uid != uid || cfg.refresh_token != refresh || !cfg.firebase_password.is_empty() {
            cfg.uid = uid;
            cfg.refresh_token = refresh;
            cfg.firebase_password.clear();
            cfg.save(&state.config_dir)?;
        }
    }
    state
        .firestore
        .uid()
        .ok_or_else(|| "auth: uid mancante".to_string())
}

async fn load_user_cached(
    state: &AppState,
    auth: &FirestoreAuth,
    uid: &str,
) -> Result<UserConfig, String> {
    if let Some(u) = state.user.lock().unwrap().clone() {
        return Ok(u);
    }
    let u = state.firestore.load_user(uid, auth).await?;
    *state.user.lock().unwrap() = Some(u.clone());
    Ok(u)
}

// ===== Configurazione =====

#[tauri::command]
fn get_local_config(state: tauri::State<'_, AppState>) -> PublicConfig {
    PublicConfig::from_parts(&state.config.lock().unwrap(), &UserConfig::default())
}

#[tauri::command]
async fn login(state: tauri::State<'_, AppState>, email: String, password: String) -> Result<PublicConfig, String> {
    let mut candidate = state.config.lock().unwrap().clone();
    candidate.firebase_email = clean(&email);
    candidate.firebase_password = password;
    candidate.refresh_token.clear();
    candidate.uid.clear();
    if !candidate.firestore_auth().configured() { return Err("login_required".into()); }
    state.firestore.login(&candidate.firestore_auth()).await?;
    let (uid, refresh) = state.firestore.session().ok_or("session_expired")?;
    candidate.uid = uid;
    candidate.refresh_token = refresh;
    candidate.firebase_password.clear();
    candidate.save(&state.config_dir)?;
    *state.config.lock().unwrap() = candidate;
    *state.user.lock().unwrap() = None;
    *state.data.lock().unwrap() = ChatData::default();
    state.data_loaded.store(false, Ordering::SeqCst);
    get_config(state).await
}

#[tauri::command]
async fn get_config(state: tauri::State<'_, AppState>) -> Result<PublicConfig, String> {
    let cfg = state.config.lock().unwrap().clone();
    let auth = cfg.firestore_auth();
    if !auth.configured() {
        return Ok(PublicConfig::from_parts(&cfg, &UserConfig::default()));
    }
    let uid = ensure_uid(&state, &auth).await?;
    let user = load_user_cached(&state, &auth, &uid).await?;
    let cfg = state.config.lock().unwrap().clone();
    Ok(PublicConfig::from_parts(&cfg, &user))
}

#[tauri::command]
async fn save_config(
    state: tauri::State<'_, AppState>,
    input: SaveConfigInput,
) -> Result<PublicConfig, String> {
    {
        let mut cfg = state.config.lock().unwrap();
        if cfg.firebase_email != clean(&input.firebase_email) || cfg.firebase_project_id != clean(&input.firebase_project_id) || cfg.firebase_api_key != clean(&input.firebase_api_key) || input.firebase_password.as_ref().is_some_and(|p| !p.is_empty()) {
            return Err("login_required".into());
        }
        cfg.firebase_project_id = clean(&input.firebase_project_id);
        cfg.firebase_api_key = clean(&input.firebase_api_key);
        cfg.firebase_email = clean(&input.firebase_email);
        if let Some(pw) = input.firebase_password {
            let pw = clean(&pw);
            if !pw.is_empty() {
                cfg.firebase_password = pw;
            }
        }
        cfg.save(&state.config_dir)?;
    }

    let auth = firebase_auth(&state)?;
    let uid = ensure_uid(&state, &auth).await?;
    let mut user = load_user_cached(&state, &auth, &uid).await?;
    user.firebase_project_id = auth.project_id.clone();
    user.firebase_api_key = auth.api_key.clone();
    if let Some(k) = input.api_key {
        let k = clean(&k);
        if !k.is_empty() {
            user.api_key = k;
        }
    }
    state.firestore.save_user(&uid, &auth, &user).await?;
    *state.user.lock().unwrap() = Some(user.clone());

    let cfg = state.config.lock().unwrap().clone();
    Ok(PublicConfig::from_parts(&cfg, &user))
}

#[tauri::command]
async fn set_model(state: tauri::State<'_, AppState>, model: String) -> Result<PublicConfig, String> {
    let model = clean(&model);
    let auth = firebase_auth(&state)?;
    let uid = ensure_uid(&state, &auth).await?;
    let mut user = load_user_cached(&state, &auth, &uid).await?;
    if !user.models.contains_key(&model) {
        return Err("model_not_found".to_string());
    }
    user.active_model = model.clone();
    state.firestore.save_user(&uid, &auth, &user).await?;
    *state.user.lock().unwrap() = Some(user.clone());

    let cfg = state.config.lock().unwrap().clone();
    Ok(PublicConfig::from_parts(&cfg, &user))
}

#[tauri::command]
fn get_locale(lang: String) -> String {
    match lang.as_str() {
        "it" => include_str!("../../ui/locales/it.json").to_string(),
        _ => include_str!("../../ui/locales/en.json").to_string(),
    }
}

// ===== Cronologia (Firestore `users/{uid}.tree`) =====

#[tauri::command]
async fn get_data(state: tauri::State<'_, AppState>) -> Result<ChatData, String> {
    if !state.data_loaded.load(Ordering::SeqCst) {
        let auth = firebase_auth(&state)?;
        let uid = ensure_uid(&state, &auth).await?;
        let tree = match state.firestore.load_tree(&uid, &auth).await {
            Err(e) if e == "history_migration_required" => {
                state.firestore.migrate_user_tree(&uid,&auth,&state.config_dir.join("migration-backups")).await?;
                state.firestore.load_tree(&uid,&auth).await?
            },
            result => result?,
        };
        *state.data.lock().unwrap() = tree;
        state.data_loaded.store(true, Ordering::SeqCst);
    }
    Ok(state.data.lock().unwrap().clone())
}

#[tauri::command]
async fn save_data(state: tauri::State<'_, AppState>, data: ChatData, base: Option<ChatData>) -> Result<ChatData, String> {
    let auth = firebase_auth(&state)?;
    let uid = ensure_uid(&state, &auth).await?;
    let _save = state.history_save_lock.lock().await;
    let data = if let Some(base) = base { ChatData::rebase(&base, &data, &state.data.lock().unwrap())? } else { data };
    {
        let old = state.data.lock().unwrap();
        state.folder_access.lock().unwrap().validate_links(&uid, &old, &data)?;
    }
    state.firestore.save_tree(&uid, &auth, &data).await?;
    let data=state.firestore.cached_tree(&uid).unwrap_or(data);
    *state.data.lock().unwrap() = data.clone();
    state.data_loaded.store(true, Ordering::SeqCst);
    {
        let mut grants = state.folder_access.lock().unwrap();
        grants.retain_linked(&uid, &data);
        grants.save(&state.config_dir)?;
    }
    Ok(data)
}

#[tauri::command(rename_all = "snake_case")]
async fn get_conversation(state:tauri::State<'_, AppState>, conversation_id:String) -> Result<data::Conversation,String> {
    let auth=firebase_auth(&state)?;
    let uid=ensure_uid(&state,&auth).await?;
    let _save = state.history_save_lock.lock().await;
    if state.data.lock().unwrap().find_conversation(&conversation_id).is_none() { return Err("conversation_not_found".into()); }
    let conversation=state.firestore.load_conversation(&uid,&auth,&conversation_id).await?;
    if let Some(cached)=state.data.lock().unwrap().find_conversation_mut(&conversation_id) { *cached=conversation.clone(); }
    Ok(conversation)
}

// ===== Chat =====

#[derive(serde::Serialize)]
struct ChatResponse {
    content: String,
    usage: Usage,
    messages: Vec<ChatMessage>,
    data: ChatData,
}

#[tauri::command(rename_all = "snake_case")]
async fn chat(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    conversation_id: String,
    content: String,
    attachments: Option<Vec<Attachment>>,
    retry: Option<bool>,
    edit_index: Option<usize>,
) -> Result<ChatResponse, String> {
    if !state.running_chats.lock().unwrap().insert(conversation_id.clone()) { return Err("chat_in_progress".into()); }
    let _run = ConversationRun {active:&state.running_chats, id:conversation_id.clone()};
    let content = clean(&content);
    let attachments = attachments.unwrap_or_default();
    llm::validate_attachments(&attachments)?;
    let retry = retry.unwrap_or(false);
    if !retry && content.is_empty() && attachments.is_empty() {
        return Err("empty_message".to_string());
    }

    let auth = firebase_auth(&state)?;
    let uid = ensure_uid(&state, &auth).await?;
    let user = load_user_cached(&state, &auth, &uid).await?;
    if user.api_key.is_empty() {
        return Err("no_api_key".to_string());
    }
    let mc = user.models.get(&user.active_model).ok_or("model_not_found")?;
    let base_url = mc.base_url.clone();
    let model = mc.model.clone();
    let api_key = user.api_key.clone();

    let needs_load=state.data.lock().unwrap().find_conversation(&conversation_id).is_some_and(|c| !c.messages_loaded);
    if needs_load {
        let conversation=state.firestore.load_conversation(&uid,&auth,&conversation_id).await?;
        if let Some(cached)=state.data.lock().unwrap().find_conversation_mut(&conversation_id) { *cached=conversation; }
    }
    let (history, user_message, keep_count) = {
        let data = state.data.lock().unwrap();
        let conv = data.find_conversation(&conversation_id).ok_or("conversation_not_found")?;
        llm::prepare_turn(&conv.messages,content,attachments,retry,edit_index)?
    };

    let project = {
        let tree = state.data.lock().unwrap();
        tree.projects.iter().find(|p| p.conversations.iter().any(|c| c.id == conversation_id)).map(|project| {
            let grants = state.folder_access.lock().unwrap().paths(&uid, &project.id);
            let (allowed, unavailable): (Vec<_>,Vec<_>) = project.source_folders.iter().cloned().partition(|p| grants.contains(p));
            project_files::ProjectFiles { name: project.name.clone(), roots: allowed.into_iter().map(PathBuf::from).collect(), unavailable }
        })
    };
    let turn_activity = std::sync::Mutex::new(Vec::<serde_json::Value>::new());
    let content_offset = std::sync::atomic::AtomicUsize::new(0);
    let (reply, usage) = llm::chat_completion(&state.client, &base_url, &model, &api_key, &history, project, |action,text| {
        let mut events = turn_activity.lock().unwrap();
        if action == "__delta" { content_offset.fetch_add(text.encode_utf16().count(), std::sync::atomic::Ordering::Relaxed); }
        if action == "__reasoning" {
            if events.last().is_none_or(|e| e["kind"] != "reasoning" || e["offset"].as_u64() != Some(content_offset.load(std::sync::atomic::Ordering::Relaxed) as u64)) {
                events.push(serde_json::json!({"kind":"reasoning","text":"","offset":content_offset.load(std::sync::atomic::Ordering::Relaxed),"at":data::now_millis()}));
            }
            let entry = events.last_mut().unwrap();
            let mut content = entry["text"].as_str().unwrap_or("").to_string();content.push_str(text);entry["text"] = content.into();
        } else if action == "__activity" {
            if let Ok(mut event) = serde_json::from_str::<serde_json::Value>(text) {
                event["offset"] = content_offset.load(std::sync::atomic::Ordering::Relaxed).into();
                if let Some(previous) = events.iter_mut().find(|e| e["kind"] == "tool" && e["id"] == event["id"]) { *previous = event; }
                else { events.push(event); }
            }
        }
        let _ = app.emit("chat-progress", serde_json::json!({"conversation_id":conversation_id,"kind":action,"text":text}));
    }, |mut agent| {
        agent["conversation_id"] = serde_json::json!(conversation_id);
        let mut events = turn_activity.lock().unwrap();
        let mut stored = agent.clone();stored["kind"] = serde_json::json!("agent");stored["offset"] = content_offset.load(std::sync::atomic::Ordering::Relaxed).into();
        if let Some(previous) = events.iter_mut().find(|e| e["kind"] == "agent" && e["id"] == stored["id"]) { *previous = stored; }
        else { events.push(stored); }
        let _ = app.emit("agent-activity", agent);
    }).await?;
    let turn_activity = turn_activity.into_inner().unwrap();

    let _save = state.history_save_lock.lock().await;
    if state.firestore.uid().as_deref() != Some(&uid) { return Err("login_required".into()); }
    let (messages, tree) = {
        let mut data = state.data.lock().unwrap().clone();
        let conv = data
            .find_conversation_mut(&conversation_id)
            .ok_or("conversation_not_found")?;
        let is_new = conv.messages.is_empty();
        conv.messages.truncate(keep_count);
        conv.messages.push(user_message);
        conv.messages.push(ChatMessage { role:"assistant".into(),content:reply.clone(),attachments:vec![],feedback:None,activity:turn_activity });
        conv.updated_at = data::now_millis();
        conv.context_tokens = usage.total_tokens;
        if is_new {
            conv.title = truncate_title(if conv.messages[0].content.is_empty() {
                conv.messages[0].attachments.first().map(|f| f.name.as_str()).unwrap_or("Chat")
            } else { &conv.messages[0].content });
        }
        (conv.messages.clone(), data.clone())
    };

    let mut tree=tree;
    let conversation=tree.find_conversation(&conversation_id).ok_or("conversation_not_found")?.clone();
    let saved=state.firestore.save_conversation(&uid,&auth,&conversation,&tree).await?;
    if let Some(cached)=tree.find_conversation_mut(&conversation_id) { *cached=saved; }
    let tree=state.firestore.cached_tree(&uid).unwrap_or(tree);
    *state.data.lock().unwrap() = tree.clone();

    Ok(ChatResponse {
        content: reply,
        usage,
        messages,
        data: tree,
    })
}

#[tauri::command]
fn open_external_url(app:tauri::AppHandle, url:String) -> Result<(),String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") { return Err("unsupported URL".into()); }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn choose_chat_files(window:tauri::WebviewWindow) -> Result<Vec<Attachment>,String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let paths = window.dialog().file().set_parent(&window)
            .add_filter("Text files", &["txt","md","json","csv","log","js","ts","rs","py","html","css","toml","yaml","yml"])
            .blocking_pick_files().unwrap_or_default();
        if paths.len() > 4 { return Err("invalid_attachments".into()); }
        let mut files = Vec::new();
        for path in paths {
            let path = path.into_path().map_err(|e| e.to_string())?;
            let name = path.file_name().and_then(|n| n.to_str()).ok_or("invalid_attachments")?.to_string();
            let mut bytes = Vec::new();
            std::fs::File::open(&path).map_err(|e| e.to_string())?.take(131073).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            let content = String::from_utf8(bytes).map_err(|_| "invalid_attachments")?;
            files.push(Attachment {name,content});
        }
        llm::validate_attachments(&files)?;
        Ok(files)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
async fn choose_project_folder(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, project_id: String, lang: String) -> Result<Option<String>, String> {
    if project_id.trim().is_empty() { return Err("project id required".into()); }
    let auth = firebase_auth(&state)?;
    let uid = ensure_uid(&state, &auth).await?;
    let selected = tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let selected = window.dialog().file().set_parent(&window)
            .set_title(if lang == "it" { "Scegli la cartella di lavoro" } else { "Choose the working folder" })
            .blocking_pick_folder();
        let Some(selected) = selected else { return Ok(None); };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        let path = folder_access::canonical_folder(&path)?;
        let (message, allow, deny) = if lang == "it" {
            (format!("Consenti ad AuraChat di leggere i file in questa cartella e nelle sottocartelle?\n\n{path}\n\nIl consenso vale solo per questo progetto e questo dispositivo. I file pertinenti alle tue richieste potranno essere inviati al modello configurato. Scrittura ed esecuzione richiederanno permessi separati."), "Consenti lettura", "Non consentire")
        } else {
            (format!("Allow AuraChat to read files in this folder and its subfolders?\n\n{path}\n\nPermission applies only to this project on this device. Files relevant to your requests may be sent to the configured model. Writing and execution require separate permissions."), "Allow reading", "Don't allow")
        };
        let allowed = window.dialog().message(message).title("AuraChat")
            .buttons(MessageDialogButtons::OkCancelCustom(allow.into(), deny.into())).blocking_show();
        if !allowed { return Ok(None); }
        std::fs::read_dir(&path).map_err(|e| format!("folder access: {e}"))?;
        Ok(Some(path))
    }).await.map_err(|e| e.to_string())??;
    if let Some(path) = &selected {
        let mut grants = state.folder_access.lock().unwrap();
        grants.grant(&uid, &project_id, path.clone());
        grants.save(&state.config_dir)?;
    }
    Ok(selected)
}

#[tauri::command(rename_all = "snake_case")]
async fn project_folder_access(state: tauri::State<'_, AppState>, project_id: String) -> Result<Vec<String>, String> {
    let auth = firebase_auth(&state)?;
    let uid = ensure_uid(&state, &auth).await?;
    Ok(state.folder_access.lock().unwrap().paths(&uid, &project_id))
}

#[tauri::command]
async fn prune_folder_access(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let auth = firebase_auth(&state)?;
    let uid = ensure_uid(&state, &auth).await?;
    let tree = state.data.lock().unwrap().clone();
    let mut grants = state.folder_access.lock().unwrap();
    grants.retain_linked(&uid, &tree);
    grants.save(&state.config_dir)
}

#[tauri::command(rename_all = "snake_case")]
async fn restore_window(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>, restore_saved: bool) -> Result<(), String> {
    let _save = state.window_save_lock.lock().await;
    let auth = firebase_auth(&state).ok();
    let uid = if restore_saved {
        ensure_uid(&state, auth.as_ref().ok_or("login_required")?).await?
    } else { String::new() };
    if state.window_owner.lock().unwrap().as_ref() == Some(&uid) { return Ok(()); }
    let saved = if restore_saved {
        state.firestore.load_window(&uid, auth.as_ref().unwrap()).await?
    } else { None };
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let target = saved.as_ref().and_then(|g| monitors.iter().find(|m| {
        let a = m.work_area();
        (g.x as i64) >= a.position.x as i64 && (g.x as i64) < a.position.x as i64 + a.size.width as i64
            && (g.y as i64) >= a.position.y as i64 && (g.y as i64) < a.position.y as i64 + a.size.height as i64
    })).cloned().or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("window: no monitor available")?;
    let area = target.work_area();
    let scale = target.scale_factor();
    let default_width = ((1080.0 * scale) as u32).min(area.size.width);
    let default_height = ((880.0 * scale) as u32).min(area.size.height);
    let geometry = saved.unwrap_or(WindowGeometry {
        x: area.position.x + ((area.size.width - default_width) / 2) as i32,
        y: area.position.y + ((area.size.height - default_height) / 2) as i32,
        width: default_width, height: default_height, maximized: false,
    }).fit(area.position.x, area.position.y, area.size.width, area.size.height, scale);
    state.window_restoring.store(true, Ordering::SeqCst);
    let result = (|| -> tauri::Result<()> {
        window.set_resizable(true)?;
        window.unmaximize()?;
        window.set_min_size(Some(tauri::PhysicalSize::new(((720.0 * scale) as u32).min(area.size.width), ((680.0 * scale) as u32).min(area.size.height))))?;
        window.set_size(tauri::PhysicalSize::new(geometry.width, geometry.height))?;
        window.set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y))?;
        if geometry.maximized { window.maximize()?; }
        Ok(())
    })();
    if result.is_ok() {
        *state.window_geometry.lock().unwrap() = Some(geometry);
        *state.window_owner.lock().unwrap() = Some(uid);
    }
    state.window_restoring.store(false, Ordering::SeqCst);
    result.map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_window_state(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let _save = state.window_save_lock.lock().await;
    if state.window_restoring.load(Ordering::SeqCst) { return Ok(()); }
    let owner = state.window_owner.lock().unwrap().clone();
    let geometry = state.window_geometry.lock().unwrap().clone();
    if let (Some(owner), Some(geometry)) = (owner.filter(|uid| !uid.is_empty()), geometry) {
        let auth = firebase_auth(&state)?;
        let uid = ensure_uid(&state, &auth).await?;
        if uid != owner { return Err("window: account changed".into()); }
        state.firestore.save_window(&uid, &auth, &geometry).await?;
    }
    Ok(())
}

fn capture_window(window: &tauri::Window) {
    let state = window.state::<AppState>();
    if state.window_restoring.load(Ordering::SeqCst) { return; }
    if state.window_owner.lock().unwrap().as_ref().is_none_or(|uid| uid.is_empty()) { return; }
    if window.is_minimized().unwrap_or(true) { return; }
    if let (Ok(position), Ok(size), Ok(maximized)) = (window.outer_position(), window.inner_size(), window.is_maximized()) {
        let mut cached = state.window_geometry.lock().unwrap();
        if let Some(geometry) = cached.as_mut() {
            let before = geometry.clone();
            geometry.capture(position, size, maximized);
            if *geometry != before { let _ = window.emit("window-geometry-changed", ()); }
        }
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "Apri AuraChat", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Esci", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    TrayIconBuilder::with_id("main-tray")
        .icon(tray_icon())
        .tooltip("AuraChat")
        .menu(&menu)
        // Il click sinistro apre la finestra, non il menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = save_window_state(handle.state::<AppState>()).await {
                        eprintln!("Window layout save failed: {error}");
                    }
                    handle.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(std::sync::Arc::new(managed_shells::Shells::default()))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let config = AppConfig::load(&config_dir);
            let folder_access = FolderAccess::load(&config_dir)?;
            app.manage(AppState {
                speech: std::sync::Arc::new(speech::Speech::new(&config_dir)),
                config: Mutex::new(config),
                folder_access: Mutex::new(folder_access),
                config_dir,
                user: Mutex::new(None),
                data: Mutex::new(ChatData::default()),
                data_loaded: AtomicBool::new(false),
                firestore: Firestore::new(),
                client: reqwest::Client::new(),
                quitting: AtomicBool::new(false),
                window_geometry: Mutex::new(None),
                window_owner: Mutex::new(None),
                window_restoring: AtomicBool::new(false),
                window_save_lock: tauri::async_runtime::Mutex::new(()),
                history_save_lock: tauri::async_runtime::Mutex::new(()),
                running_chats: Mutex::new(std::collections::HashSet::new()),
            });

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_icon(app_icon());
            }

            setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                capture_window(window);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let quitting = window
                    .state::<AppState>()
                    .quitting
                    .load(Ordering::SeqCst);
                if !quitting {
                    // La chiusura della finestra nasconde nel tray: il processo
                    // resta in background. Si esce solo dal menu del tray ("Esci").
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            get_local_config,
            login,
            save_config,
            set_model,
            get_data,
            get_conversation,
            save_data,
            chat,
            get_locale,
            restore_window,
            save_window_state,
            choose_project_folder,
            project_folder_access,
            prune_folder_access,
            choose_chat_files,
            open_external_url
            ,list_shells, stop_shell
            ,speech_model_status, download_speech_model, cancel_speech_download, remove_speech_model, transcribe_audio
        ])
        .build(tauri::generate_context!())
        .expect("errore durante l'avvio di AuraChat")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) { app.state::<std::sync::Arc<managed_shells::Shells>>().stop_all(); }
        });
}
