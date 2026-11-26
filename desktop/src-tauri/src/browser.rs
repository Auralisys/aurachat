//! Internal browser: a child webview inside the main window, placed over a panel
//! that the UI lays out. Pages are remote origins, so Tauri refuses their IPC
//! calls; navigation is limited to http(s) and never reaches the app's own
//! `*.localhost` protocols. The UI can capture the visible page as PNG.

use std::{collections::HashMap, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

const MAIN: &str = "main";
const SEARCH: &str = "https://duckduckgo.com/";
const MAX_INPUT: usize = 2048;

#[derive(Default)]
pub struct Browser {
    pages: Mutex<HashMap<String, PageState>>,
}

#[derive(Clone, Default, Serialize)]
pub struct PageState {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub sensitive: bool,
    #[serde(skip)]
    owner: String,
}

#[derive(Clone, Serialize)]
struct PageLink {
    tab_id: String,
    url: String,
}

#[derive(Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Serialize)]
pub struct Opened {
    url: String,
    capture: bool,
}

#[derive(Serialize)]
pub struct Capture {
    data: String,
    mime_type: &'static str,
    url: String,
    title: String,
}

/// Only plain web pages: the app's custom protocols live on `*.localhost`.
pub fn allowed(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    !host.is_empty() && !host.ends_with(".localhost") && url.username().is_empty() && url.password().is_none()
}

/// Turns the address bar text into a URL: full URLs, bare hosts, or a web search.
pub fn page_url(input: &str) -> Result<Url, String> {
    let text = input.trim();
    if text.is_empty() || text.len() > MAX_INPUT {
        return Err("browser_invalid_url".into());
    }
    let search = || Url::parse_with_params(SEARCH, &[("q", text)]).map_err(|_| "browser_invalid_url".to_string());
    let url = if text.contains("://") {
        Url::parse(text).map_err(|_| "browser_invalid_url".to_string())?
    } else if text.chars().any(char::is_whitespace) {
        search()?
    } else {
        let local = ["localhost", "127.0.0.1", "[::1]"].iter().any(|host| {
            text.strip_prefix(host).is_some_and(|rest| rest.is_empty() || rest.starts_with([':', '/']))
        });
        if !local && !text.split(['/', ':']).next().unwrap_or_default().contains('.') {
            search()?
        } else {
            Url::parse(&format!("{}://{text}", if local { "http" } else { "https" })).map_err(|_| "browser_invalid_url".to_string())?
        }
    };
    if allowed(&url) { Ok(url) } else { Err("browser_blocked_url".into()) }
}

fn only_main(caller: &Webview) -> Result<(), String> {
    if caller.label() == MAIN { Ok(()) } else { Err("browser_forbidden".into()) }
}

fn tab_label(tab_id: &str) -> Result<String, String> {
    if tab_id.is_empty() || tab_id.len() > 64 || !tab_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
        return Err("browser_invalid_tab".into());
    }
    Ok(format!("browser-{tab_id}"))
}

fn page(app: &AppHandle, tab_id: &str) -> Result<Webview, String> {
    let owner = app.state::<crate::AppState>().firestore.uid().ok_or("login_required")?;
    if !app.state::<Browser>().pages.lock().unwrap().get(tab_id).is_some_and(|page| page.owner == owner) {
        return Err("browser_forbidden".into());
    }
    app.get_webview(&tab_label(tab_id)?).ok_or_else(|| "browser_closed".into())
}

fn profile_id(owner: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(owner.as_bytes()))
}

fn preferences_path(app: &AppHandle, owner: &str) -> std::path::PathBuf {
    app.state::<crate::AppState>().config_dir.join("browser").join(format!("{}.json", profile_id(owner)))
}

#[derive(Default, Deserialize, Serialize)]
struct Preferences { save_passwords: bool }

fn preferences(app: &AppHandle, owner: &str) -> Result<Preferences, String> {
    match std::fs::read(preferences_path(app, owner)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "browser_preferences_failed".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(_) => Err("browser_preferences_failed".into()),
    }
}

#[cfg(windows)]
async fn password_autosave(page: &Webview, enabled: bool) -> Result<(), String> {
    use windows::core::Interface;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
    let (tx, rx) = tokio::sync::oneshot::channel();
    page.with_webview(move |platform| {
        let result = (|| -> windows::core::Result<()> {
            unsafe {
                let settings: ICoreWebView2Settings4 = platform.controller().CoreWebView2()?.Settings()?.cast()?;
                settings.SetIsPasswordAutosaveEnabled(enabled)?;
                settings.SetIsGeneralAutofillEnabled(false)
            }
        })();
        let _ = tx.send(result.map_err(|_| "browser_passwords_failed".to_string()));
    }).map_err(|_| "browser_passwords_failed")?;
    tokio::time::timeout(std::time::Duration::from_secs(10), rx).await
        .map_err(|_| "browser_passwords_failed")?.map_err(|_| "browser_passwords_failed")?
}

#[cfg(not(windows))]
async fn password_autosave(_: &Webview, enabled: bool) -> Result<(), String> {
    if enabled { Err("browser_passwords_unsupported".into()) } else { Ok(()) }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn browser_preferences(app: AppHandle, webview: Webview, save_passwords: Option<bool>) -> Result<serde_json::Value, String> {
    only_main(&webview)?;
    let state = app.state::<crate::AppState>();
    let _account = state.account_lock.lock().await;
    let owner = app.state::<crate::AppState>().firestore.uid().ok_or("login_required")?;
    let mut prefs = preferences(&app, &owner)?;
    if let Some(enabled) = save_passwords {
        if !cfg!(windows) { return Err("browser_passwords_unsupported".into()); }
        let ids: Vec<_> = app.state::<Browser>().pages.lock().unwrap().values()
            .filter(|page| page.owner == owner).map(|page| page.tab_id.clone()).collect();
        let path = preferences_path(&app, &owner);
        let previous = match std::fs::read_to_string(&path) {
            Ok(text) => Some(text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("browser_preferences_failed".into()),
        };
        let changed = async {
            for id in &ids { password_autosave(&page(&app, id)?, enabled).await?; }
            crate::project_files::write_file(&path, &serde_json::to_string(&Preferences { save_passwords: enabled }).map_err(|_| "browser_preferences_failed")?, previous.as_deref())
        }.await;
        if let Err(error) = changed {
            for id in &ids {
                if let Some(page) = app.get_webview(&tab_label(id)?) {
                    if password_autosave(&page, prefs.save_passwords).await.is_err() {
                        if let Err(close_error) = close_tab(&app, id) { eprintln!("Browser preferences cleanup failed: {close_error}"); }
                    }
                }
            }
            return Err(error);
        }
        prefs.save_passwords = enabled;
    }
    Ok(serde_json::json!({"save_passwords":prefs.save_passwords,"passwords_supported":cfg!(windows)}))
}

fn publish(app: &AppHandle, tab_id: &str, update: impl FnOnce(&mut PageState)) {
    let state = {
        let browser = app.state::<Browser>();
        let mut pages = browser.pages.lock().unwrap();
        let Some(page) = pages.get_mut(tab_id) else { return };
        update(page);
        page.clone()
    };
    if let Err(error) = app.emit_to(MAIN, "browser-state", state) {
        eprintln!("Browser state event failed: {error}");
    }
}

fn display_url(mut url: Url, sensitive: bool) -> String {
    if sensitive { url.set_query(None); url.set_fragment(None); }
    url.to_string()
}

fn validate_bounds(bounds: &Bounds) -> Result<(), String> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if values.iter().any(|value| !value.is_finite() || *value < 0.0 || *value > 100_000.0) {
        return Err("browser_invalid_bounds".into());
    }
    Ok(())
}

fn place(webview: &Webview, bounds: &Bounds) -> Result<(), String> {
    validate_bounds(bounds)?;
    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into(),
        })
        .map_err(|error| error.to_string())
}

async fn create(app: &AppHandle, tab_id: &str, url: Url, bounds: &Bounds, owner: &str, sensitive: bool) -> Result<Webview, String> {
    #[cfg(target_os = "macos")]
    {
        // Older WebKit silently falls back to the shared default store.
        let version = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion")
            .output().map_err(|_| "browser_profile_unsupported")?;
        if !version.status.success() || !String::from_utf8_lossy(&version.stdout).trim()
            .split('.').next().and_then(|major| major.parse::<u32>().ok()).is_some_and(|major| major >= 14) {
            return Err("browser_profile_unsupported".into());
        }
    }
    let save_passwords = preferences(app, owner)?.save_passwords;
    let window = app.get_window(MAIN).ok_or("browser_closed")?;
    let blocked = app.clone();
    let opener = app.clone();
    let loads = app.clone();
    let titles = app.clone();
    let blocked_id = tab_id.to_string();
    let opener_id = tab_id.to_string();
    let loads_id = tab_id.to_string();
    let titles_id = tab_id.to_string();
    let profile = app.path().app_local_data_dir().map_err(|_| "browser_preferences_failed")?.join("browser").join(profile_id(owner));
    std::fs::create_dir_all(&profile).map_err(|_| "browser_preferences_failed")?;
    let builder = WebviewBuilder::new(tab_label(tab_id)?, WebviewUrl::External(Url::parse("about:blank").map_err(|_| "browser_invalid_url")?))
        .data_directory(profile)
        .on_navigation(move |url| {
            let ok = allowed(url) || url.as_str() == "about:blank";
            if !ok {
                if let Err(error) = blocked.emit_to(MAIN, "browser-blocked", PageLink { tab_id: blocked_id.clone(), url: url.to_string() }) {
                    eprintln!("Browser navigation event failed: {error}");
                }
            }
            ok
        })
        // The trusted UI owns tabs; remote pages never create unmanaged windows.
        .on_new_window(move |url, _| {
            if allowed(&url) {
                if let Err(error) = opener.emit_to(MAIN, "browser-new-tab", PageLink { tab_id: opener_id.clone(), url: url.to_string() }) {
                    eprintln!("Browser tab event failed: {error}");
                }
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |_, payload| {
            let url = display_url(payload.url().clone(), sensitive);
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            publish(&loads, &loads_id, |page| {
                if page.url != url {
                    page.title.clear();
                }
                page.url = url;
                page.loading = loading;
            });
        })
        .on_document_title_changed(move |_, title| publish(&titles, &titles_id, |page| page.title = if sensitive { "OAuth".into() } else { title }));
    #[cfg(target_os = "macos")]
    let builder = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(owner.as_bytes());
        let mut id = [0u8; 16]; id.copy_from_slice(&digest[..16]);
        builder.data_store_identifier(id)
    };
    let page = window
        .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
        .map_err(|error| error.to_string())?;
    let ready = async {
        page.hide().map_err(|error| error.to_string())?;
        password_autosave(&page, save_passwords).await?;
        page.navigate(url).map_err(|error| error.to_string())
    }.await;
    if let Err(error) = ready {
        if let Err(close_error) = page.close() { eprintln!("Browser creation cleanup failed: {close_error}"); }
        return Err(error);
    }
    Ok(page)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn browser_open(app: AppHandle, webview: Webview, tab_id: String, url: String, bounds: Bounds) -> Result<Opened, String> {
    only_main(&webview)?;
    let state = app.state::<crate::AppState>();
    let _account = state.account_lock.lock().await;
    let label = tab_label(&tab_id)?;
    let url = page_url(&url)?;
    validate_bounds(&bounds)?;
    let owner = app.state::<crate::AppState>().firestore.uid().ok_or("login_required")?;
    let sensitive = app.state::<crate::mcp_oauth::OAuth>().sensitive_tab(&tab_id);
    {
        let browser = app.state::<Browser>();
        let mut pages = browser.pages.lock().unwrap();
        let entry = pages.entry(tab_id.clone()).or_insert_with(|| PageState { tab_id: tab_id.clone(), owner: owner.clone(), sensitive, ..Default::default() });
        if entry.owner != owner { return Err("browser_forbidden".into()); }
    }
    publish(&app, &tab_id, |page| {
        page.url = display_url(url.clone(), sensitive);
        page.title.clear();
        page.loading = true;
    });
    let result = match app.get_webview(&label) {
        Some(page) => place(&page, &bounds).and_then(|_| page.navigate(url.clone()).map_err(|error| error.to_string())),
        None => create(&app, &tab_id, url.clone(), &bounds, &owner, sensitive).await.map(|_| ()),
    };
    if let Err(error) = result {
        publish(&app, &tab_id, |page| page.loading = false);
        return Err(error);
    }
    if sensitive && !app.state::<crate::mcp_oauth::OAuth>().sensitive_tab(&tab_id) {
        close_tab(&app, &tab_id)?;
        return Err("mcp_oauth_cancelled".into());
    }
    Ok(Opened { url: display_url(url, sensitive), capture: cfg!(windows) && !sensitive })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn browser_bounds(app: AppHandle, webview: Webview, tab_id: String, bounds: Bounds, visible: bool) -> Result<(), String> {
    only_main(&webview)?;
    let Some(page) = app.get_webview(&tab_label(&tab_id)?) else { return Ok(()) };
    if visible {
        self::page(&app, &tab_id)?;
        place(&page, &bounds)?;
        let ids: Vec<_> = app.state::<Browser>().pages.lock().unwrap().keys().cloned().collect();
        for id in ids.into_iter().filter(|id| id != &tab_id) {
            if let Some(other) = app.get_webview(&tab_label(&id)?) {
                other.hide().map_err(|error| error.to_string())?;
            }
        }
        page.show()
    } else {
        page.hide()
    }
    .map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn browser_action(app: AppHandle, webview: Webview, tab_id: String, action: String) -> Result<(), String> {
    only_main(&webview)?;
    let page = page(&app, &tab_id)?;
    match action.as_str() {
        "back" => page.eval("history.back()"),
        "forward" => page.eval("history.forward()"),
        "stop" => page.eval("window.stop()"),
        "reload" => page.reload(),
        _ => return Err("browser_invalid_action".into()),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn browser_close(app: AppHandle, webview: Webview, tab_id: String) -> Result<(), String> {
    only_main(&webview)?;
    close_tab(&app, &tab_id)
}

pub fn close_tab(app: &AppHandle, tab_id: &str) -> Result<(), String> {
    app.state::<crate::mcp_oauth::OAuth>().cancel_tab(&tab_id);
    if let Some(page) = app.get_webview(&tab_label(&tab_id)?) {
        page.hide().map_err(|error| error.to_string())?;
        page.close().map_err(|error| error.to_string())?;
    }
    app.state::<Browser>().pages.lock().unwrap().remove(tab_id);
    Ok(())
}

pub fn close_owner(app: &AppHandle, owner: &str) -> Result<(), String> {
    app.state::<crate::mcp_oauth::OAuth>().cancel_owner(owner);
    let ids: Vec<_> = app.state::<Browser>().pages.lock().unwrap().values()
        .filter(|page| page.owner == owner).map(|page| page.tab_id.clone()).collect();
    for id in ids { close_tab(app, &id)?; }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn browser_capture(app: AppHandle, webview: Webview, tab_id: String) -> Result<Capture, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    only_main(&webview)?;
    let page = page(&app, &tab_id)?;
    let state = app.state::<Browser>().pages.lock().unwrap().get(&tab_id).cloned().ok_or("browser_closed")?;
    if state.sensitive { return Err("browser_auth_capture_forbidden".into()); }
    let url = page.url().map_err(|error| error.to_string())?.to_string();
    let bytes = capture_png(&page).await?;
    if crate::llm::image_mime(&bytes) != Some("image/png") {
        return Err("browser_capture_failed".into());
    }
    if page.url().map_err(|error| error.to_string())?.as_str() != url {
        return Err("browser_capture_failed".into());
    }
    Ok(Capture { data: BASE64.encode(bytes), mime_type: "image/png", url, title: state.title })
}

#[cfg(windows)]
async fn capture_png(page: &Webview) -> Result<Vec<u8>, String> {
    use std::sync::Arc;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use webview2_com::CapturePreviewCompletedHandler;
    use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateMemStream;

    fn read_all(stream: &IStream) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        let mut chunk = vec![0u8; 64 << 10];
        unsafe {
            stream.Seek(0, STREAM_SEEK_SET, None).map_err(|error| error.to_string())?;
            loop {
                let mut read = 0u32;
                stream.Read(chunk.as_mut_ptr().cast(), chunk.len() as u32, Some(&mut read)).ok().map_err(|error| error.to_string())?;
                if read == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..read as usize]);
                if bytes.len() > 64 << 20 {
                    return Err("browser_capture_failed".into());
                }
            }
        }
        Ok(bytes)
    }

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let reply = tx.clone();
    page.with_webview(move |platform| {
        let send = move |result| {
            if let Some(tx) = reply.lock().unwrap().take() {
                let _ = tx.send(result);
            }
        };
        let started = (|| -> Result<(), String> {
            unsafe {
                let core = platform.controller().CoreWebView2().map_err(|error| error.to_string())?;
                let stream = SHCreateMemStream(None).ok_or("browser_capture_failed")?;
                let reader = stream.clone();
                let done = send.clone();
                let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                    done(result.map_err(|error| error.to_string()).and_then(|_| read_all(&reader)));
                    Ok(())
                }));
                core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler).map_err(|error| error.to_string())
            }
        })();
        if let Err(error) = started {
            send(Err(error));
        }
    })
    .map_err(|error| error.to_string())?;
    drop(tx);
    match tokio::time::timeout(std::time::Duration::from_secs(15), rx).await {
        Ok(Ok(result)) => result.map_err(|error| {
            eprintln!("Browser capture failed: {error}");
            "browser_capture_failed".to_string()
        }),
        _ => Err("browser_capture_failed".into()),
    }
}

#[cfg(not(windows))]
async fn capture_png(_: &Webview) -> Result<Vec<u8>, String> {
    Err("browser_capture_unsupported".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_labels_are_isolated_from_app_webviews() {
        assert_eq!(tab_label("one").unwrap(), "browser-one");
        assert_ne!(tab_label("one").unwrap(), tab_label("two").unwrap());
        assert_ne!(tab_label("main").unwrap(), MAIN);
        for id in ["", "../main", "one/two", "one.two", "with space", "é"] {
            assert!(tab_label(id).is_err(), "{id}");
        }
        assert!(tab_label(&"a".repeat(65)).is_err());
    }

    #[test]
    fn bounds_are_checked_before_creating_a_page() {
        for value in [f64::NAN, f64::INFINITY, -1.0, 100_001.0] {
            assert!(validate_bounds(&Bounds { x: value, y: 0.0, width: 400.0, height: 600.0 }).is_err());
        }
        assert!(validate_bounds(&Bounds { x: 0.0, y: 0.0, width: 0.0, height: 0.0 }).is_ok());
    }

    #[test]
    fn oauth_addresses_hide_codes_and_profiles_do_not_share_accounts() {
        let callback = Url::parse("http://127.0.0.1:4321/oauth/callback?code=secret&state=secret#token").unwrap();
        assert_eq!(display_url(callback.clone(), true), "http://127.0.0.1:4321/oauth/callback");
        assert_eq!(display_url(callback.clone(), false), callback.as_str());
        assert_ne!(profile_id("fixture-one"), profile_id("fixture-two"));
        assert!(!profile_id("fixture-one").contains("fixture-one"));
        assert!(!Preferences::default().save_passwords);
        assert!(page_url("https://user:password@example.com").is_err());
    }

    #[test]
    fn address_bar_text_becomes_a_safe_url() {
        assert_eq!(page_url("example.com/docs").unwrap().as_str(), "https://example.com/docs");
        assert_eq!(page_url("localhost:3000").unwrap().as_str(), "http://localhost:3000/");
        assert_eq!(page_url("127.0.0.1/app").unwrap().as_str(), "http://127.0.0.1/app");
        assert_eq!(page_url("https://example.com/a?b=1").unwrap().as_str(), "https://example.com/a?b=1");
        assert_eq!(page_url("deepseek api docs").unwrap().as_str(), "https://duckduckgo.com/?q=deepseek+api+docs");
        assert_eq!(page_url("rust").unwrap().as_str(), "https://duckduckgo.com/?q=rust");
        for blocked in ["file:///C:/Windows/win.ini", "http://tauri.localhost/index.html", "https://ipc.localhost/", "http://TAURI.LOCALHOST./", "ftp://example.com/"] {
            assert!(page_url(blocked).is_err(), "{blocked}");
        }
        // Script and data schemes are never opened: they become plain searches.
        for text in ["javascript:alert(1)", "data:text/html,hi"] {
            assert_eq!(page_url(text).unwrap().host_str(), Some("duckduckgo.com"));
        }
        assert!(page_url("   ").is_err());
        assert!(page_url(&"a".repeat(MAX_INPUT + 1)).is_err());
    }
}
