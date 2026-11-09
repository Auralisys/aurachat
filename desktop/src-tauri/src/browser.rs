//! Internal browser: a child webview inside the main window, placed over a panel
//! that the UI lays out. Pages are remote origins, so Tauri refuses their IPC
//! calls; navigation is limited to http(s) and never reaches the app's own
//! `*.localhost` protocols. The UI can capture the visible page as PNG.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};

pub const LABEL: &str = "browser";
const MAIN: &str = "main";
const SEARCH: &str = "https://duckduckgo.com/";
const MAX_INPUT: usize = 2048;

#[derive(Default)]
pub struct Browser {
    page: Mutex<PageState>,
}

#[derive(Clone, Default, Serialize)]
pub struct PageState {
    pub url: String,
    pub title: String,
    pub loading: bool,
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
    !host.is_empty() && !host.ends_with(".localhost")
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

fn page(app: &AppHandle) -> Result<Webview, String> {
    app.get_webview(LABEL).ok_or_else(|| "browser_closed".into())
}

fn publish(app: &AppHandle, update: impl FnOnce(&mut PageState)) {
    let state = {
        let browser = app.state::<Browser>();
        let mut page = browser.page.lock().unwrap();
        update(&mut page);
        page.clone()
    };
    if let Err(error) = app.emit_to(MAIN, "browser-state", state) {
        eprintln!("Browser state event failed: {error}");
    }
}

fn place(webview: &Webview, bounds: &Bounds) -> Result<(), String> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if values.iter().any(|value| !value.is_finite() || *value < 0.0 || *value > 100_000.0) {
        return Err("browser_invalid_bounds".into());
    }
    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into(),
        })
        .map_err(|error| error.to_string())
}

fn create(app: &AppHandle, url: Url, bounds: &Bounds) -> Result<Webview, String> {
    let window = app.get_window(MAIN).ok_or("browser_closed")?;
    let blocked = app.clone();
    let opener = app.clone();
    let loads = app.clone();
    let titles = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .on_navigation(move |url| {
            let ok = allowed(url) || url.as_str() == "about:blank";
            if !ok {
                let _ = blocked.emit_to(MAIN, "browser-blocked", url.as_str());
            }
            ok
        })
        // Pop-ups replace the current page instead of opening unmanaged windows.
        .on_new_window(move |url, _| {
            if allowed(&url) {
                let app = opener.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(webview) = app.get_webview(LABEL) {
                        let _ = webview.navigate(url);
                    }
                });
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |_, payload| {
            let url = payload.url().to_string();
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            publish(&loads, |page| {
                if page.url != url {
                    page.title.clear();
                }
                page.url = url;
                page.loading = loading;
            });
        })
        .on_document_title_changed(move |_, title| publish(&titles, |page| page.title = title));
    window
        .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_open(app: AppHandle, webview: Webview, url: String, bounds: Bounds) -> Result<Opened, String> {
    only_main(&webview)?;
    let url = page_url(&url)?;
    publish(&app, |page| {
        page.url = url.to_string();
        page.title.clear();
        page.loading = true;
    });
    match app.get_webview(LABEL) {
        Some(page) => {
            place(&page, &bounds)?;
            page.show().map_err(|error| error.to_string())?;
            page.navigate(url.clone()).map_err(|error| error.to_string())?;
        }
        None => {
            create(&app, url.clone(), &bounds)?;
        }
    }
    Ok(Opened { url: url.to_string(), capture: cfg!(windows) })
}

#[tauri::command]
pub async fn browser_bounds(app: AppHandle, webview: Webview, bounds: Bounds, visible: bool) -> Result<(), String> {
    only_main(&webview)?;
    let Some(page) = app.get_webview(LABEL) else { return Ok(()) };
    if visible {
        place(&page, &bounds)?;
        page.show()
    } else {
        page.hide()
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_action(app: AppHandle, webview: Webview, action: String) -> Result<(), String> {
    only_main(&webview)?;
    let page = page(&app)?;
    match action.as_str() {
        "back" => page.eval("history.back()"),
        "forward" => page.eval("history.forward()"),
        "stop" => page.eval("window.stop()"),
        "reload" => page.reload(),
        _ => return Err("browser_invalid_action".into()),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, webview: Webview) -> Result<(), String> {
    only_main(&webview)?;
    if let Some(page) = app.get_webview(LABEL) {
        page.close().map_err(|error| error.to_string())?;
    }
    *app.state::<Browser>().page.lock().unwrap() = PageState::default();
    Ok(())
}

#[tauri::command]
pub async fn browser_capture(app: AppHandle, webview: Webview) -> Result<Capture, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    only_main(&webview)?;
    let page = page(&app)?;
    let bytes = capture_png(&page).await?;
    if crate::llm::image_mime(&bytes) != Some("image/png") {
        return Err("browser_capture_failed".into());
    }
    let state = app.state::<Browser>().page.lock().unwrap().clone();
    let url = page.url().map(|url| url.to_string()).unwrap_or(state.url);
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
