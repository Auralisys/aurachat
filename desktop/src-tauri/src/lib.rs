mod config;
mod folder_access;
mod data;
mod firestore;
mod llm;
mod window_state;
mod speech;
mod project_files;
mod managed_shells;
mod permissions;
mod approvals;
mod agent_runs;
mod chat_runs;
mod companion;

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
    permissions: Mutex<permissions::Permissions>,
    window_geometry: Mutex<Option<WindowGeometry>>,
    window_owner: Mutex<Option<String>>,
    window_restoring: AtomicBool,
    window_save_lock: tauri::async_runtime::Mutex<()>,
    history_save_lock: tauri::async_runtime::Mutex<()>,
    account_lock: tauri::async_runtime::Mutex<()>,
    running_chats: Mutex<std::collections::HashSet<String>>,
    chat_runs: chat_runs::ChatRuns,
    /// Chat currently shown in the focused main window; completion notices are
    /// redundant while the user is looking at it.
    viewing_chat: Mutex<Option<String>>,
}

struct ConversationRun<'a> { active: &'a Mutex<std::collections::HashSet<String>>, id: String, app: tauri::AppHandle }
impl Drop for ConversationRun<'_> {
    fn drop(&mut self) {
        self.active.lock().unwrap().remove(&self.id);
        update_taskbar_progress(&self.app);
    }
}

fn update_taskbar_progress(app: &tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let handle = app.clone();
        // Read the current count on the UI thread so concurrent completions cannot leave stale progress.
        if let Err(error) = app.run_on_main_thread(move || {
            let state = handle.state::<AppState>();
            let active = state.running_chats.lock().unwrap();
            if let Some(window) = handle.get_webview_window("main") {
                if let Err(error) = window.set_progress_bar(window_state::chat_progress(active.len())) {
                    eprintln!("Taskbar progress update failed: {error}");
                }
            }
        }) {
            eprintln!("Taskbar progress dispatch failed: {error}");
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
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
    companion::notify(&app,"speech-download",&data::now_millis().to_string(),"","Modello vocale",if result.is_ok(){"Il download è terminato."}else{"Il download non è stato completato."});
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
async fn prepare_speech_model(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let speech = state.speech.clone();
    let worker = speech.clone();
    let result = tauri::async_runtime::spawn_blocking(move || worker.prepare()).await.map_err(|e| e.to_string())?;
    let _ = app.emit("speech-model-progress", speech.status());
    result
}
#[tauri::command]
async fn transcribe_audio(app: tauri::AppHandle, state: tauri::State<'_, AppState>, samples: Vec<f32>, language: String) -> Result<String, String> {
    let speech = state.speech.clone();
    let result=tauri::async_runtime::spawn_blocking(move || speech.transcribe(samples, language)).await.map_err(|e| e.to_string())?;
    companion::notify(&app,"transcription",&data::now_millis().to_string(),"","Trascrizione terminata",if result.is_ok(){"Il testo dettato è pronto."}else{"La trascrizione non è riuscita."});
    result
}

fn clean(s: &str) -> String {
    s.trim().to_string()
}

fn first_title(content: &str, attachments: &[Attachment]) -> String {
    match attachments.first() {
        Some(file) if content.trim().is_empty() => truncate_title(&file.name),
        _ => truncate_title(content),
    }
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
    let mut u = state.firestore.load_user(uid, auth).await?;
    u.migrate_providers();
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
    let _account=state.account_lock.lock().await;
    if !state.running_chats.lock().unwrap().is_empty() { return Err("account_busy".into()); }
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
    get_config(state.clone()).await
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
            if let Some(provider) = user.models.get(&user.active_model).and_then(|m| user.providers.get_mut(&m.provider_id)) {
                provider.api_key = k;
            } else { return Err("model_not_found".into()); }
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
async fn save_provider(state: tauri::State<'_, AppState>, input: config::SaveProviderInput) -> Result<PublicConfig, String> {
    let auth = firebase_auth(&state)?;
    let uid = ensure_uid(&state, &auth).await?;
    let mut user = load_user_cached(&state, &auth, &uid).await?;
    user.save_provider(input)?;
    state.firestore.save_user(&uid, &auth, &user).await?;
    *state.user.lock().unwrap() = Some(user.clone());
    Ok(PublicConfig::from_parts(&state.config.lock().unwrap(), &user))
}

#[tauri::command]
async fn remove_provider(state: tauri::State<'_, AppState>, id: String) -> Result<PublicConfig, String> {
    let auth = firebase_auth(&state)?;
    let uid = ensure_uid(&state, &auth).await?;
    let mut user = load_user_cached(&state, &auth, &uid).await?;
    if user.providers.remove(&id).is_none() { return Err("invalid_provider".into()); }
    user.models.retain(|_, m| m.provider_id != id);
    user.ensure_active_model();
    state.firestore.save_user(&uid, &auth, &user).await?;
    *state.user.lock().unwrap() = Some(user.clone());
    Ok(PublicConfig::from_parts(&state.config.lock().unwrap(), &user))
}

#[tauri::command]
async fn logout(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let _account=state.account_lock.lock().await;
    if !state.running_chats.lock().unwrap().is_empty() { return Err("account_busy".into()); }
    let mut cfg = state.config.lock().unwrap().clone();
    cfg.firebase_email.clear();
    cfg.firebase_password.clear();
    cfg.uid.clear();
    cfg.refresh_token.clear();
    cfg.save(&state.config_dir)?;
    *state.config.lock().unwrap() = cfg;
    state.firestore.logout();
    *state.user.lock().unwrap() = None;
    *state.data.lock().unwrap() = ChatData::default();
    *state.viewing_chat.lock().unwrap() = None;
    state.data_loaded.store(false, Ordering::SeqCst);
    Ok(())
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

#[tauri::command(rename_all = "snake_case")]
async fn set_conversation_model(state: tauri::State<'_, AppState>, conversation_id: String, model: String) -> Result<ChatData, String> {
    let model = clean(&model);
    let auth = firebase_auth(&state)?;
    let uid = ensure_uid(&state, &auth).await?;
    let user = load_user_cached(&state, &auth, &uid).await?;
    if !user.models.contains_key(&model) { return Err("model_not_found".into()); }
    if state.running_chats.lock().unwrap().contains(&conversation_id) { return Err("chat_in_progress".into()); }
    let _save = state.history_save_lock.lock().await;
    let needs_load = state.data.lock().unwrap().find_conversation(&conversation_id).is_some_and(|c| !c.messages_loaded);
    if needs_load {
        let conversation = state.firestore.load_conversation(&uid, &auth, &conversation_id).await?;
        if let Some(cached) = state.data.lock().unwrap().find_conversation_mut(&conversation_id) { *cached = conversation; }
    }
    let tree = {
        let mut data = state.data.lock().unwrap().clone();
        let conversation = data.find_conversation_mut(&conversation_id).ok_or("conversation_not_found")?;
        if conversation.model.as_deref() == Some(model.as_str()) { return Ok(data); }
        conversation.model = Some(model.clone());
        data
    };
    let conversation = tree.find_conversation(&conversation_id).ok_or("conversation_not_found")?.clone();
    state.firestore.save_conversation(&uid, &auth, &conversation, &tree).await?;
    let tree = state.firestore.cached_tree(&uid).unwrap_or(tree);
    *state.data.lock().unwrap() = tree.clone();
    Ok(tree)
}

// ===== Chat =====

#[derive(serde::Serialize)]
struct ChatResponse {
    content: String,
    usage: Usage,
    messages: Vec<ChatMessage>,
    data: ChatData,
    cancelled: bool,
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
    run_chat(app,state,conversation_id,content,attachments,retry,edit_index,None).await
}

async fn run_chat(
    app:tauri::AppHandle, state:tauri::State<'_,AppState>,conversation_id:String,content:String,
    attachments:Option<Vec<Attachment>>,retry:Option<bool>,edit_index:Option<usize>,expected_owner:Option<String>,
) -> Result<ChatResponse,String> {
    let notification_owner=state.config.lock().unwrap().uid.clone();
    let event_id=format!("{}-{}",conversation_id,data::now_millis());
    let _=app.emit("live-turn",serde_json::json!({"conversation_id":conversation_id.clone(),"turn_id":event_id.clone(),"status":"running","user_content":content.clone()}));
    let result=chat_inner(app.clone(),state.clone(),conversation_id.clone(),content,attachments,retry,edit_index,expected_owner).await;
    let turn_status=match &result {Ok(reply) if reply.cancelled=>"cancelled",Ok(_)=>"completed",Err(_)=>"failed"};
    let _=app.emit("live-turn",serde_json::json!({"conversation_id":conversation_id.clone(),"turn_id":event_id.clone(),"status":turn_status}));
    let (title,body)=match &result {
        Ok(reply) if reply.cancelled => ("Risposta interrotta", "La risposta parziale è stata salvata."),
        Ok(_) => ("Risposta pronta", "AuraChat ha terminato la risposta."),
        Err(_) => ("Chat terminata con errore", "Apri AuraChat per controllare il problema."),
    };
    if state.firestore.uid().as_deref()==Some(notification_owner.as_str()) {
        let chat_title=state.data.lock().unwrap().find_conversation(&conversation_id)
            .map(|chat|chat.title.clone()).filter(|name|!name.trim().is_empty()).unwrap_or_else(||title.into());
        let preview=match &result {
            Ok(reply) if !reply.content.trim().is_empty()=>companion::notification_preview(&reply.content,200),
            _=>body.into(),
        };
        companion::notify(&app,"chat",&event_id,&conversation_id,&companion::notification_preview(&chat_title,100),&preview);
    }
    result
}

async fn chat_inner(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    conversation_id: String,
    content: String,
    attachments: Option<Vec<Attachment>>,
    retry: Option<bool>,
    edit_index: Option<usize>,
    expected_owner: Option<String>,
) -> Result<ChatResponse, String> {
    let account=state.account_lock.lock().await;
    if !state.running_chats.lock().unwrap().insert(conversation_id.clone()) { return Err("chat_in_progress".into()); }
    let _run = ConversationRun {active:&state.running_chats, id:conversation_id.clone(), app:app.clone()};
    update_taskbar_progress(&app);
    let content = clean(&content);
    let attachments = attachments.unwrap_or_default();
    llm::validate_attachments(&attachments)?;
    let retry = retry.unwrap_or(false);
    if !retry && content.is_empty() && attachments.is_empty() {
        return Err("empty_message".to_string());
    }

    let auth = firebase_auth(&state)?;
    let uid = ensure_uid(&state, &auth).await?;
    if expected_owner.as_ref().is_some_and(|expected|expected!=&uid) {return Err("login_required".into());}
    drop(account);
    let user = load_user_cached(&state, &auth, &uid).await?;
    // Registra il turno prima della richiesta, per poterlo fermare dallo stop.
    let (turn, stop) = chat_runs::Turn::start(&state.chat_runs, &uid, &conversation_id);
    let guidance = turn.guidance();
    let effective_model = state.data.lock().unwrap().find_conversation(&conversation_id).and_then(|c| c.model.clone()).unwrap_or_else(|| user.active_model.clone());
    let mc = user.models.get(&effective_model).ok_or("model_not_found")?;
    if user.model_key(mc).is_empty() { return Err("no_api_key".into()); }
    let base_url = mc.base_url.clone();
    let model = mc.model.clone();
    let api_key = user.model_key(mc).to_string();

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

    // Il nome e il modello della chat nascono dal primo messaggio, prima della risposta del modello.
    if let Some(conversation) = state.data.lock().unwrap().find_conversation_mut(&conversation_id) {
        if conversation.messages.is_empty() {
            conversation.title = first_title(&user_message.content, &user_message.attachments);
            conversation.model = Some(effective_model.clone());
        }
    }

    let turn_id=format!("turn-{}",data::now_millis());
    let project = {
        let tree = state.data.lock().unwrap();
        tree.projects.iter().find(|p| p.conversations.iter().any(|c| c.id == conversation_id)).map(|project| {
            let grants = state.folder_access.lock().unwrap().paths(&uid, &project.id);
            let (allowed, unavailable): (Vec<_>,Vec<_>) = project.source_folders.iter().cloned().partition(|p| grants.contains(p));
            project_files::ProjectFiles { name: project.name.clone(), roots: allowed.into_iter().map(PathBuf::from).collect(), unavailable,
                execution: Some(permissions::Execution {app:app.clone(),owner:uid.clone(),project:project.id.clone(),conversation:conversation_id.clone(),turn_id:turn_id.clone(),intent:history.last().map(|m|m.content.chars().take(16000).collect()).unwrap_or_default(),agent_id:None,cancellation:Some(stop.clone())}) }
        })
    };
    let turn_activity = std::sync::Mutex::new(Vec::<serde_json::Value>::new());
    let streamed = std::sync::Mutex::new(String::new());
    let content_offset = std::sync::atomic::AtomicUsize::new(0);
    let segments = std::sync::Mutex::new(Vec::<ChatMessage>::new());
    let progress = |action:&str,text:&str| {
        let mut events = turn_activity.lock().unwrap();
        if action == "__steering" {
            if let Ok(message) = serde_json::from_str::<ChatMessage>(text) {
                let content=std::mem::take(&mut *streamed.lock().unwrap());
                let activity=std::mem::take(&mut *events);
                let mut segments=segments.lock().unwrap();
                if !content.is_empty() || !activity.is_empty() {
                    segments.push(ChatMessage{role:"assistant".into(),content,activity,attachments:vec![],feedback:None});
                }
                segments.push(message);
                content_offset.store(0,std::sync::atomic::Ordering::Relaxed);
            }
        }
        if action == "__delta" { streamed.lock().unwrap().push_str(text); content_offset.fetch_add(text.encode_utf16().count(), std::sync::atomic::Ordering::Relaxed); }
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
    };
    let completion = llm::chat_completion_steered(&state.client, &base_url, &model, &api_key, &history, project, Some(agent_runs::Runtime{app:app.clone(),owner:uid.clone(),conversation:conversation_id.clone()}), Some(guidance.clone()), &progress, |mut agent| {
        agent["conversation_id"] = serde_json::json!(conversation_id);
        let mut events = turn_activity.lock().unwrap();
        let mut stored = agent.clone();stored["kind"] = serde_json::json!("agent");stored["offset"] = content_offset.load(std::sync::atomic::Ordering::Relaxed).into();
        if let Some(previous) = events.iter_mut().find(|e| e["kind"] == "agent" && e["id"] == stored["id"]) { for (key,value) in stored.as_object().unwrap() {previous[key]=value.clone();} }
        else { events.push(stored); }
        let _ = app.emit("agent-activity", agent);
    });
    let outcome = stop.run(completion).await;
    guidance.close();
    // Stop/error can win before the runner consumes accepted guidance.
    for message in guidance.take() {progress("__steering",&serde_json::to_string(&message).map_err(|e|e.to_string())?);}
    if outcome.is_err() {
        app.state::<agent_runs::AgentRuns>().cancel_conversation(&uid,&conversation_id);
        let shells=app.state::<std::sync::Arc<managed_shells::Shells>>().inner().clone();
        let owner=uid.clone();let conversation=conversation_id.clone();
        tauri::async_runtime::spawn_blocking(move||{
            for shell in shells.list(&owner,&conversation).into_iter().filter(|shell|shell.status=="running") {
                let _=shells.stop(&owner,&conversation,&shell.id);
            }
        }).await.map_err(|error|error.to_string())?;
    }
    let reviews=app.state::<approvals::Approvals>().take_turn(&uid,&conversation_id,&turn_id);
    // Uno stop conserva la parte di risposta mostrata finora invece di scartarla con la richiesta.
    let deferred_error = match &outcome {Ok(Err(error)) if !segments.lock().unwrap().is_empty()=>Some(error.clone()),_=>None};
    let (reply, mut usage, cancelled) = match outcome {
        Ok(Ok((reply,usage))) => (reply, usage, false),
        Ok(Err(_)) if deferred_error.is_some() => (std::mem::take(&mut *streamed.lock().unwrap()), Usage{prompt_tokens:0,completion_tokens:0,total_tokens:0}, false),
        Ok(Err(error)) => return Err(error),
        Err(_) => (std::mem::take(&mut *streamed.lock().unwrap()), Usage{prompt_tokens:0,completion_tokens:0,total_tokens:0}, true),
    };
    let mut turn_activity = turn_activity.into_inner().unwrap();
    if cancelled {
        fn cancel(events:&mut [serde_json::Value]) {
            for event in events {
                if matches!(event["status"].as_str(),Some("running"|"reviewing"|"pending"|"waiting")){event["status"]="cancelled".into();}
                if let Some(nested)=event["activity"].as_array_mut(){cancel(nested);}
            }
        }
        cancel(&mut turn_activity);
        for event in &turn_activity {
            if event["kind"]=="agent" && event["status"]=="cancelled" {
                let mut snapshot=event.clone();snapshot["conversation_id"]=serde_json::json!(conversation_id);
                let _=app.emit("agent-activity",snapshot);
            }
        }
    }
    for review in reviews {
        usage.prompt_tokens+=review.usage["prompt_tokens"].as_u64().unwrap_or(0);usage.completion_tokens+=review.usage["completion_tokens"].as_u64().unwrap_or(0);usage.total_tokens+=review.usage["total_tokens"].as_u64().unwrap_or(0);
        let mut event=serde_json::to_value(review).map_err(|e|e.to_string())?;event["kind"]="approval".into();event["offset"]=0.into();turn_activity.push(event);
    }

    let _save = state.history_save_lock.lock().await;
    if state.firestore.uid().as_deref() != Some(&uid) { return Err("login_required".into()); }
    let (messages, tree) = {
        let mut data = state.data.lock().unwrap().clone();
        let conv = data
            .find_conversation_mut(&conversation_id)
            .ok_or("conversation_not_found")?;
        conv.messages.truncate(keep_count);
        conv.messages.push(user_message);
        conv.messages.extend(segments.into_inner().unwrap());
        if !reply.trim().is_empty() || !turn_activity.is_empty() {
            conv.messages.push(ChatMessage { role:"assistant".into(),content:reply.clone(),attachments:vec![],feedback:None,activity:turn_activity });
        }
        conv.updated_at = data::now_millis();
        if usage.total_tokens > 0 { conv.context_tokens = usage.total_tokens; }
        (conv.messages.clone(), data.clone())
    };

    let mut tree=tree;
    let conversation=tree.find_conversation(&conversation_id).ok_or("conversation_not_found")?.clone();
    let saved=state.firestore.save_conversation(&uid,&auth,&conversation,&tree).await?;
    if let Some(cached)=tree.find_conversation_mut(&conversation_id) { *cached=saved; }
    let tree=state.firestore.cached_tree(&uid).unwrap_or(tree);
    *state.data.lock().unwrap() = tree.clone();

    if let Some(error)=deferred_error {return Err(error);}
    Ok(ChatResponse {
        content: reply,
        usage,
        messages,
        data: tree,
        cancelled,
    })
}

/// Reports which chat the UI is showing. The window focus is checked when a
/// notification is about to be sent, so minimize/tray/blur still notify.
#[tauri::command(rename_all = "snake_case")]
fn set_viewing_chat(state: tauri::State<'_, AppState>, conversation_id: Option<String>) {
    *state.viewing_chat.lock().unwrap() = conversation_id.filter(|id| data::valid_id(id).is_ok());
}

pub(crate) async fn project_skill_catalog(app:&tauri::AppHandle, uid:&str, project_id:&str)->Result<serde_json::Value,String> {
    let state=app.state::<AppState>();
    if state.firestore.uid().as_deref()!=Some(uid){return Err("login_required".into());}
    let files={
        let tree=state.data.lock().unwrap();
        let project=tree.projects.iter().find(|project|project.id==project_id).ok_or("project_not_found")?;
        let grants=state.folder_access.lock().unwrap().paths(uid,project_id);
        project_files::ProjectFiles{name:project.name.clone(),roots:project.source_folders.iter().filter(|path|grants.contains(path)).map(PathBuf::from).collect(),unavailable:vec![],
            execution:Some(permissions::Execution{app:app.clone(),owner:uid.into(),project:project_id.into(),conversation:String::new(),turn_id:String::new(),intent:String::new(),agent_id:None,cancellation:None})}
    };
    tauri::async_runtime::spawn_blocking(move||files.discover_skills()).await.map_err(|error|error.to_string())
}

#[tauri::command(rename_all = "snake_case")]
async fn project_skills(app:tauri::AppHandle,state:tauri::State<'_,AppState>,project_id:String)->Result<serde_json::Value,String>{
    let uid=state.firestore.uid().ok_or("login_required")?;
    project_skill_catalog(&app,&uid,&project_id).await
}

#[tauri::command(rename_all = "snake_case")]
fn steer_chat(state: tauri::State<'_, AppState>, conversation_id:String, content:String, attachments:Option<Vec<Attachment>>) -> Result<(),String> {
    let owner=state.firestore.uid().ok_or("login_required")?;
    state.chat_runs.steer(&owner,&conversation_id,ChatMessage{
        role:"user".into(),content:clean(&content),attachments:attachments.unwrap_or_default(),feedback:None,activity:vec![],
    })
}

#[tauri::command(rename_all = "snake_case")]
fn stop_chat(state: tauri::State<'_, AppState>, conversation_id: String) -> Result<(), String> {
    let owner = state.firestore.uid().ok_or("login_required")?;
    state.chat_runs.stop(&owner, &conversation_id)
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

#[tauri::command(rename_all = "snake_case")]
async fn project_permission_mode(state: tauri::State<'_, AppState>, project_id: String, mode: Option<permissions::Mode>) -> Result<permissions::Mode, String> {
    let auth = firebase_auth(&state)?;
    let uid = ensure_uid(&state, &auth).await?;
    if !state.data.lock().unwrap().projects.iter().any(|p|p.id == project_id) { return Err("project_not_found".into()); }
    let mut permissions = state.permissions.lock().unwrap();
    if let Some(mode) = mode {
        let tree = state.data.lock().unwrap();
        let running = state.running_chats.lock().unwrap();
        if tree.projects.iter().find(|p|p.id == project_id).is_some_and(|p|p.conversations.iter().any(|c|running.contains(&c.id))) { return Err("permissions_in_use".into()); }
        permissions.set(&state.config_dir, &uid, &project_id, mode)?;
    }
    Ok(permissions.get(&uid, &project_id))
}

#[tauri::command(rename_all = "snake_case")]
fn list_approvals(state:tauri::State<'_,AppState>, approvals:tauri::State<'_,approvals::Approvals>, conversation_id:String)->Result<Vec<approvals::Snapshot>,String>{
    let owner=state.firestore.uid().ok_or("login_required")?;Ok(approvals.list(&owner,&conversation_id))
}
#[tauri::command(rename_all = "snake_case")]
fn resolve_approval(state:tauri::State<'_,AppState>, approvals:tauri::State<'_,approvals::Approvals>, conversation_id:String,id:String,allow:bool)->Result<(),String>{
    let owner=state.firestore.uid().ok_or("login_required")?;approvals.resolve(&owner,&conversation_id,&id,allow)
}
#[tauri::command(rename_all = "snake_case")]
async fn stop_subagent(state:tauri::State<'_,AppState>, agents:tauri::State<'_,agent_runs::AgentRuns>, shells:tauri::State<'_,std::sync::Arc<managed_shells::Shells>>,conversation_id:String,id:String)->Result<(),String>{
    let owner=state.firestore.uid().ok_or("login_required")?;agents.stop(&owner,&conversation_id,&id)?;
    let shells=shells.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {for shell in shells.list(&owner,&conversation_id).into_iter().filter(|s|s.agent_id.as_deref()==Some(&id)&&s.status=="running"){let _=shells.stop(&owner,&conversation_id,&shell.id);}}).await.map_err(|e|e.to_string())?;Ok(())
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
        .plugin(tauri_plugin_single_instance::init(|app,_,_| {
            if let Some(window)=app.get_webview_window("main") {let _=window.show();let _=window.set_focus();}
        }))
        .manage(std::sync::Arc::new(managed_shells::Shells::default()))
        .manage(approvals::Approvals::default())
        .manage(agent_runs::AgentRuns::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let config = AppConfig::load(&config_dir);
            let folder_access = FolderAccess::load(&config_dir)?;
            app.manage(AppState {
                speech: std::sync::Arc::new(speech::Speech::new(&config_dir)),
                config: Mutex::new(config),
                folder_access: Mutex::new(folder_access),
                permissions: Mutex::new(permissions::Permissions::load(&config_dir)?),
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
                account_lock: tauri::async_runtime::Mutex::new(()),
                running_chats: Mutex::new(std::collections::HashSet::new()),
                chat_runs: chat_runs::ChatRuns::default(),
                viewing_chat: Mutex::new(None),
            });

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_icon(app_icon());
            }

            setup_tray(app)?;
            companion::start(app.handle());
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
            save_provider,
            remove_provider,
            logout,
            set_model,
            set_conversation_model,
            get_data,
            get_conversation,
            save_data,
            chat,
            set_viewing_chat,
            project_skills,
            stop_chat,
            steer_chat,
            get_locale,
            restore_window,
            save_window_state,
            choose_project_folder,
            project_folder_access,
            project_permission_mode,
            list_approvals, resolve_approval, stop_subagent,
            prune_folder_access,
            choose_chat_files,
            open_external_url
            ,list_shells, stop_shell
            ,speech_model_status, download_speech_model, cancel_speech_download, remove_speech_model, prepare_speech_model, transcribe_audio
        ])
        .build(tauri::generate_context!())
        .expect("errore durante l'avvio di AuraChat")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) { app.state::<std::sync::Arc<managed_shells::Shells>>().stop_all(); }
        });
}
