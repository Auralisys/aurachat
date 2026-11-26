//! OAuth stays in the native host. Only the authorization URL reaches the trusted
//! UI; tokens, callback codes and PKCE verifiers never enter chat or browser history.
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::Duration};
use rmcp::transport::auth::{AuthError, AuthorizationManager, AuthorizationRequest, AuthorizationSession,
    CredentialRefreshGuard, CredentialStore, StoredCredentials};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Url};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};

#[derive(Default)]
struct Slot {
    lock: Arc<tokio::sync::Mutex<()>>,
    generation: AtomicU64,
}

struct Pending {
    owner: String,
    key: String,
    cancel: Arc<crate::agent_runs::Cancellation>,
}

#[derive(Default)]
pub struct OAuth {
    slots: Mutex<HashMap<PathBuf, Arc<Slot>>>,
    pending: Mutex<HashMap<String, Pending>>,
}

impl OAuth {
    pub fn sensitive_tab(&self, tab: &str) -> bool { self.pending.lock().unwrap().contains_key(tab) }
    pub fn cancel_tab(&self, tab: &str) {
        if let Some(pending) = self.pending.lock().unwrap().get(tab) { pending.cancel.cancel(); }
    }
    pub fn cancel_owner(&self, owner: &str) {
        for pending in self.pending.lock().unwrap().values().filter(|p| p.owner == owner) { pending.cancel.cancel(); }
    }
}

pub fn account_folder(config_dir: &Path, owner: &str) -> PathBuf {
    config_dir.join("mcp").join(format!("{:x}", Sha256::digest(owner.as_bytes())))
}

#[derive(Clone)]
pub struct Store {
    path: PathBuf,
    slot: Arc<Slot>,
    generation: u64,
    account: Option<(AppHandle, String)>,
}

impl Store {
    pub fn for_server(app: &AppHandle, owner: &str, config: &Path, name: &str, url: &str) -> Result<Self, String> {
        let url = Url::parse(url).map_err(|_| "mcp_oauth_invalid_url")?;
        let key = format!("{:x}", Sha256::digest(format!("{}\n{name}\n{url}", config.display()).as_bytes()));
        let path = account_folder(&app.state::<crate::AppState>().config_dir, owner).join("oauth").join(key);
        let slot = app.state::<OAuth>().slots.lock().unwrap().entry(path.clone()).or_default().clone();
        Ok(Self { generation: slot.generation.load(Ordering::SeqCst), slot, path, account: Some((app.clone(), owner.into())) })
    }

    fn check(&self) -> Result<(), AuthError> {
        if self.generation != self.slot.generation.load(Ordering::SeqCst) {
            return Err(AuthError::AuthorizationRequired);
        }
        if let Some((app, owner)) = &self.account {
            if app.state::<crate::AppState>().firestore.uid().as_ref() != Some(owner) {
                return Err(AuthError::CredentialStoreError("session_changed".into()));
            }
        }
        Ok(())
    }

    pub async fn disconnect(&self) -> Result<(), String> {
        if let Some((app, _)) = &self.account {
            for pending in app.state::<OAuth>().pending.lock().unwrap().values()
                .filter(|p| p.key == self.path.to_string_lossy()) { pending.cancel.cancel(); }
        }
        let _guard = self.slot.lock.lock().await;
        self.clear().await.map_err(auth_error)?;
        self.slot.generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn store_error() -> AuthError { AuthError::CredentialStoreError("mcp_oauth_storage_failed".into()) }

#[async_trait::async_trait]
impl CredentialStore for Store {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        self.check()?;
        let Some(bytes) = secret_load(&self.path).map_err(|_| store_error())? else { return Ok(None) };
        let credentials = serde_json::from_slice(&bytes).map_err(|_| store_error())?;
        Ok(Some(credentials))
    }
    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        self.check()?;
        let bytes = serde_json::to_vec(&credentials).map_err(|_| store_error())?;
        secret_save(&self.path, &bytes).map_err(|_| store_error())
    }
    async fn clear(&self) -> Result<(), AuthError> {
        self.check()?;
        secret_clear(&self.path).map_err(|_| store_error())
    }
    async fn on_refresh_token_rejected(&self, rejected: &StoredCredentials) -> Result<(), AuthError> {
        if let Some(mut stored) = self.load().await? {
            if serde_json::to_vec(&stored).map_err(|_| store_error())? == serde_json::to_vec(rejected).map_err(|_| store_error())? {
                stored.token_response = None;
                self.save(stored).await?;
            }
        }
        Ok(())
    }
    async fn acquire_refresh_guard(&self) -> Result<Option<CredentialRefreshGuard>, AuthError> {
        let guard = self.slot.lock.clone().lock_owned().await;
        self.check()?;
        Ok(Some(CredentialRefreshGuard::new(guard)))
    }
}

#[cfg(windows)]
fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use windows::Win32::{Foundation::{HLOCAL, LocalFree}, Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN}};
    if bytes.len() > 65536 { return Err("mcp_oauth_storage_failed".into()); }
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr().cast_mut() };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        let result = if decrypt {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptProtectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        };
        result.map_err(|_| "mcp_oauth_storage_failed")?;
        let value = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(value)
    }
}

#[cfg(windows)]
fn secret_load(path: &Path) -> Result<Option<Vec<u8>>, String> {
    use base64::Engine;
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("mcp_oauth_storage_failed".into()),
    };
    let mut bytes = Vec::new();
    file.by_ref().take(100_001).read_to_end(&mut bytes).map_err(|_| "mcp_oauth_storage_failed")?;
    if bytes.len() > 100_000 { return Err("mcp_oauth_storage_failed".into()); }
    let encrypted = base64::engine::general_purpose::STANDARD.decode(bytes).map_err(|_| "mcp_oauth_storage_failed")?;
    protect(&encrypted, true).map(Some)
}

#[cfg(windows)]
fn secret_save(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use base64::Engine;
    let encrypted = base64::engine::general_purpose::STANDARD.encode(protect(bytes, false)?);
    let previous = match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("mcp_oauth_storage_failed".into()),
    };
    crate::project_files::write_file(path, &encrypted, previous.as_deref())
}

#[cfg(windows)]
fn secret_clear(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("mcp_oauth_storage_failed".into()),
    }
}

#[cfg(target_os = "macos")]
fn keychain(path: &Path) -> Result<keyring::Entry, String> {
    keyring::Entry::new("AuraChat MCP OAuth", &format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes())))
        .map_err(|_| "mcp_oauth_storage_failed".into())
}
#[cfg(target_os = "macos")]
fn secret_load(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match keychain(path)?.get_secret() {
        Ok(bytes) => Ok(Some(bytes)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("mcp_oauth_storage_failed".into()),
    }
}
#[cfg(target_os = "macos")]
fn secret_save(path: &Path, bytes: &[u8]) -> Result<(), String> {
    keychain(path)?.set_secret(bytes).map_err(|_| "mcp_oauth_storage_failed".into())
}
#[cfg(target_os = "macos")]
fn secret_clear(path: &Path) -> Result<(), String> {
    match keychain(path)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("mcp_oauth_storage_failed".into()),
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
fn secret_load(_: &Path) -> Result<Option<Vec<u8>>, String> { Err("mcp_oauth_storage_unsupported".into()) }
#[cfg(not(any(windows, target_os = "macos")))]
fn secret_save(_: &Path, _: &[u8]) -> Result<(), String> { Err("mcp_oauth_storage_unsupported".into()) }
#[cfg(not(any(windows, target_os = "macos")))]
fn secret_clear(_: &Path) -> Result<(), String> { Err("mcp_oauth_storage_unsupported".into()) }

// SDK/provider errors may contain token response bodies, codes or callback URLs.
pub fn auth_error(error: AuthError) -> String {
    match error {
        AuthError::CredentialStoreError(_) => "mcp_oauth_storage_failed",
        AuthError::AuthorizationRequired | AuthError::TokenRefreshRejected(_) => "mcp_oauth_required",
        AuthError::RegistrationFailed(_) => "mcp_oauth_registration_failed",
        AuthError::TokenRefreshFailed(_) => "mcp_oauth_refresh_failed",
        AuthError::TokenExchangeFailed(_) => "mcp_oauth_exchange_failed",
        _ => "mcp_oauth_failed",
    }.into()
}

fn validate_endpoint(endpoint: &str, resource: &str) -> Result<(), String> {
    let url = Url::parse(endpoint).map_err(|_| "mcp_oauth_invalid_url")?;
    let local = |url: &Url| matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let fixture = Url::parse(resource).is_ok_and(|url| local(&url));
    if url.username().is_empty() && url.password().is_none() && url.fragment().is_none()
        && url.host_str().is_some() && (url.scheme() == "https" || (fixture && local(&url) && url.scheme() == "http")) {
        Ok(())
    } else { Err("mcp_oauth_invalid_url".into()) }
}

pub async fn manager(url: &str, store: Store) -> Result<AuthorizationManager, String> {
    let mut manager = AuthorizationManager::new(url.to_string()).await.map_err(auth_error)?;
    // No redirect may forward a code, verifier or refresh token to another endpoint.
    manager.with_client(mcp_http::Client::builder().redirect(mcp_http::redirect::Policy::none())
        .timeout(Duration::from_secs(30)).build().map_err(|_| "mcp_oauth_failed")?).map_err(auth_error)?;
    let resolution = manager.resolve_metadata().await.map_err(auth_error)?;
    if !resolution.source.is_discovered() { return Err("mcp_oauth_discovery_failed".into()); }
    for endpoint in [&resolution.metadata.authorization_endpoint, &resolution.metadata.token_endpoint]
        .into_iter().chain(resolution.metadata.registration_endpoint.as_ref()) {
        validate_endpoint(endpoint, url)?;
    }
    manager.set_metadata(resolution.metadata);
    manager.set_credential_store(store);
    Ok(manager)
}

fn callback_url(request: &str, redirect: &Url, expected_state: &str) -> Result<Url, String> {
    let mut lines = request.split("\r\n");
    let parts: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    if parts.len() != 3 || parts[0] != "GET" || !parts[1].starts_with('/') || parts[1].starts_with("//") {
        return Err("mcp_oauth_bad_callback".into());
    }
    let host = lines.filter_map(|line| line.split_once(':')).find(|(key, _)| key.eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.trim());
    let expected_host = format!("127.0.0.1:{}", redirect.port().ok_or("mcp_oauth_bad_callback")?);
    if host != Some(expected_host.as_str()) {
        return Err("mcp_oauth_bad_callback".into());
    }
    let url = redirect.join(parts[1]).map_err(|_| "mcp_oauth_bad_callback")?;
    if url.origin() != redirect.origin() || url.path() != redirect.path() || url.fragment().is_some() {
        return Err("mcp_oauth_bad_callback".into());
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    for key in ["state", "code", "error", "iss"] {
        if pairs.iter().filter(|(name, _)| name == key).count() > 1 { return Err("mcp_oauth_bad_callback".into()); }
    }
    if !pairs.iter().any(|(key, value)| key == "state" && value == expected_state) {
        return Err("mcp_oauth_bad_callback".into());
    }
    if pairs.iter().filter(|(key, value)| (key == "code" || key == "error") && !value.is_empty()).count() != 1 {
        return Err("mcp_oauth_bad_callback".into());
    }
    Ok(url)
}

async fn receive_callback(listener: TcpListener, session: &AuthorizationSession) -> Result<(), String> {
    let redirect = Url::parse(&session.redirect_uri).map_err(|_| "mcp_oauth_failed")?;
    let expected = Url::parse(&session.auth_url).map_err(|_| "mcp_oauth_failed")?.query_pairs()
        .find(|(key, _)| key == "state").map(|(_, value)| value.into_owned()).ok_or("mcp_oauth_failed")?;
    loop {
        let (mut stream, peer) = listener.accept().await.map_err(|_| "mcp_oauth_callback_failed")?;
        if !peer.ip().is_loopback() { continue; }
        let read = async {
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") && bytes.len() <= 16384 {
                bytes.push(stream.read_u8().await.map_err(|_| "mcp_oauth_bad_callback")?);
            }
            if bytes.len() > 16384 { return Err("mcp_oauth_bad_callback".to_string()); }
            let request = std::str::from_utf8(&bytes).map_err(|_| "mcp_oauth_bad_callback")?;
            callback_url(request, &redirect, &expected)
        };
        let callback = match tokio::time::timeout(Duration::from_secs(3), read).await {
            Ok(Ok(url)) => url,
            _ => {
                let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                continue;
            }
        };
        let result = if callback.query_pairs().any(|(key, _)| key == "error") {
            Err("mcp_oauth_denied".into())
        } else {
            session.handle_callback_url(callback.as_str()).await.map(|_| ()).map_err(auth_error)
        };
        let body = if result.is_ok() {
            "AuraChat: accesso completato. Torna ad AuraChat; puoi chiudere questa scheda.\nAuraChat: connected. Return to AuraChat; you can close this tab."
        } else {
            "AuraChat: autorizzazione non riuscita. Torna ad AuraChat per riprovare.\nAuraChat: authorization failed. Return to AuraChat to try again."
        };
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = stream.write_all(response.as_bytes()).await;
        return result;
    }
}

struct PendingGuard { app: AppHandle, tab: String, owner: String }
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.app.state::<OAuth>().pending.lock().unwrap().remove(&self.tab);
        if let Err(error) = crate::browser::close_tab(&self.app, &self.tab) {
            eprintln!("MCP authorization webview could not close: {error}");
        }
        if let Err(error) = self.app.emit_to("main", "mcp-oauth-close", json!({"tab_id":self.tab,"owner":self.owner})) {
            eprintln!("MCP authorization tab could not close: {error}");
        }
    }
}

pub async fn authorize(app: &AppHandle, owner: &str, name: &str, url: &str, store: Store) -> Result<AuthorizationManager, String> {
    let _guard = store.slot.lock.lock().await;
    store.check().map_err(auth_error)?;
    let mut manager = manager(url, store.clone()).await?;
    if manager.initialize_from_store().await.map_err(auth_error)? {
        // Refresh happens under the store's own lock in AuthClient, not this setup lock.
        return Ok(manager);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|_| "mcp_oauth_callback_failed")?;
    let redirect = format!("http://127.0.0.1:{}/oauth/callback", listener.local_addr().map_err(|_| "mcp_oauth_callback_failed")?.port());
    let request = AuthorizationRequest::new(redirect).with_client_name("AuraChat").with_scopes(["openid"]);
    let session = AuthorizationSession::new(manager, request).await.map_err(|(_, error)| auth_error(error))?;
    store.check().map_err(auth_error)?;
    let tab = format!("oauth-{:x}", Sha256::digest(session.auth_url.as_bytes()));
    let tab = tab[..60].to_string();
    let cancel = Arc::new(crate::agent_runs::Cancellation::default());
    app.state::<OAuth>().pending.lock().unwrap().insert(tab.clone(), Pending { owner: owner.into(), key: store.path.to_string_lossy().into_owned(), cancel: cancel.clone() });
    let _pending = PendingGuard { app: app.clone(), tab: tab.clone(), owner: owner.into() };
    let email = app.state::<crate::AppState>().config.lock().unwrap().firebase_email.clone();
    app.emit_to("main", "mcp-oauth-open", json!({"tab_id":tab,"email":email,"server":name,"url":session.auth_url}))
        .map_err(|_| "mcp_oauth_browser_failed")?;
    let result = tokio::time::timeout(Duration::from_secs(180), cancel.run(receive_callback(listener, &session))).await
        .map_err(|_| "mcp_oauth_timeout")?.map_err(|_| "mcp_oauth_cancelled")?;
    // Sign-in may have finished in the system browser: bring AuraChat back with the outcome.
    if let Some(window) = app.get_window("main") {
        let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus();
    }
    result?;
    store.check().map_err(auth_error)?;
    Ok(session.auth_manager)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::{ServiceExt, transport::{StreamableHttpClientTransport, auth::AuthClient}};

    #[test]
    fn callbacks_reject_wrong_state_host_path_and_duplicate_parameters() {
        let redirect = Url::parse("http://127.0.0.1:4321/oauth/callback").unwrap();
        let request = |target: &str| format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:4321\r\n\r\n");
        assert!(callback_url(&request("/oauth/callback?state=secret&code=ok"), &redirect, "secret").is_ok());
        for path in ["/wrong?state=secret&code=ok", "/oauth/callback?state=other&code=ok",
            "/oauth/callback?code=ok", "//elsewhere/oauth/callback?state=secret",
            "/oauth/callback?state=secret&state=other&code=ok", "/oauth/callback?state=secret&code=one&code=two",
            "/oauth/callback?state=secret&iss=one&iss=two", "/oauth/callback?state=secret",
            "/oauth/callback?state=secret&code=ok&error=denied", "/oauth/callback?state=secret&code="] {
            assert!(callback_url(&request(path), &redirect, "secret").is_err(), "{path}");
        }
        assert!(callback_url(&request("/oauth/callback?state=secret").replace("Host: 127.0.0.1:4321", "Host: attacker.example"), &redirect, "secret").is_err());
        for url in ["http://auth.example/token", "https://u:p@auth.example/token", "file:///token", "https://auth.example/token#secret"] {
            assert!(validate_endpoint(url, "https://api.mobbin.com/mcp").is_err());
        }
        assert!(validate_endpoint("http://127.0.0.1:123/token", "https://api.mobbin.com/mcp").is_err());
        assert!(validate_endpoint("https://auth.example/token", "https://api.mobbin.com/mcp").is_ok());
        assert!(!auth_error(AuthError::TokenExchangeFailed("secret token body".into())).contains("secret"));
    }

    #[cfg(windows)]
    #[test]
    fn oauth_discovery_pkce_callback_persistence_refresh_and_revocation() {
        use std::io::BufRead;
        struct Fixture { child: std::process::Child, dir: PathBuf }
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = self.child.kill(); let _ = self.child.wait();
                std::fs::remove_dir_all(&self.dir).unwrap();
            }
        }
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("tests").join("mcp-oauth-server.cjs");
        let child = std::process::Command::new("node").arg(path).stdout(std::process::Stdio::piped()).spawn().unwrap();
        let dir = std::env::temp_dir().join(format!("aurachat-oauth-test-{}-{}", std::process::id(), crate::data::now_millis()));
        std::fs::create_dir(&dir).unwrap();
        let mut fixture = Fixture { child, dir };
        let mut base = String::new();
        std::io::BufReader::new(fixture.child.stdout.take().unwrap()).read_line(&mut base).unwrap();
        let base = base.trim().to_string();
        let url = format!("{base}/mcp");
        let store = Store { path: fixture.dir.join("credentials"), slot: Arc::new(Slot::default()), generation: 0, account: None };
        tauri::async_runtime::block_on(async {
            let initial = manager(&url, store.clone()).await.unwrap();
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let redirect = format!("http://127.0.0.1:{}/oauth/callback", listener.local_addr().unwrap().port());
            let request = AuthorizationRequest::new(redirect).with_client_name("AuraChat").with_scopes(["openid"]);
            let session = AuthorizationSession::new(initial, request).await.map_err(|(_, error)| error).unwrap();
            let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(10)).build().unwrap();
            let response = http.get(&session.auth_url).send().await.unwrap();
            let callback = response.headers()["location"].to_str().unwrap().to_string();
            let (accepted, browser) = tokio::join!(receive_callback(listener, &session), async {
                let bad = callback.replace("state=", "state=invalid-");
                assert_eq!(http.get(&bad).send().await.unwrap().status(), 400);
                http.get(&callback).send().await.unwrap()
            });
            accepted.unwrap();
            assert_eq!(browser.status(), 200);
            let stored = store.load().await.unwrap().unwrap();
            assert_eq!(stored.client_id, "fixture-client");
            let disk = std::fs::read_to_string(&store.path).unwrap();
            assert!(!disk.contains("fixture-access") && !disk.contains("fixture-refresh"));
            let copy = Store { path: fixture.dir.join("restart"), ..store.clone() };
            std::fs::copy(&store.path, &copy.path).unwrap();
            assert_eq!(serde_json::to_value(copy.load().await.unwrap()).unwrap(), serde_json::to_value(&stored).unwrap());

            let mut restart = manager(&url, store.clone()).await.unwrap();
            assert!(restart.initialize_from_store().await.unwrap());
            let client = AuthClient::new(mcp_http::Client::builder().redirect(mcp_http::redirect::Policy::none()).build().unwrap(), restart);
            let transport = StreamableHttpClientTransport::with_client(client, rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig::with_uri(url.clone()));
            let connection = ().serve(transport).await.unwrap();
            assert_eq!(connection.list_all_tools().await.unwrap().iter().map(|tool|tool.name.as_ref()).collect::<Vec<_>>(), ["search_screens","search_flows","search_sections"]);
            let mut second = manager(&url, store.clone()).await.unwrap();
            assert!(second.initialize_from_store().await.unwrap());
            let second_client = AuthClient::new(mcp_http::Client::builder().redirect(mcp_http::redirect::Policy::none()).build().unwrap(), second);
            let second_transport = StreamableHttpClientTransport::with_client(second_client, rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig::with_uri(url.clone()));
            let mut expired = store.load().await.unwrap().unwrap();
            expired.token_received_at = Some(0);
            store.save(expired).await.unwrap();
            let (result, second_connection) = tokio::join!(
                connection.call_tool(rmcp::model::CallToolRequestParams::new("search_screens")),
                ().serve(second_transport)
            );
            let result = result.unwrap();
            second_connection.unwrap().cancel().await.unwrap();
            assert_eq!(serde_json::to_value(result).unwrap()["content"][1]["type"], "image");
            let after = serde_json::to_value(store.load().await.unwrap()).unwrap();
            connection.cancel().await.unwrap();
            let counts: serde_json::Value = http.get(format!("{base}/fixture/stats")).send().await.unwrap().json().await.unwrap();
            assert_eq!(counts["registration"], 1); assert_eq!(counts["exchange"], 1); assert_eq!(counts["calls"], 1);
            // The SDK may refresh twice, but must always reload the latest rotated token under the lock.
            let refreshes = counts["refresh"].as_u64().unwrap();
            assert!((1..=2).contains(&refreshes));
            assert_eq!(after["token_response"]["refresh_token"], format!("fixture-refresh-{refreshes}"));

            let mut restored = manager(&url, store.clone()).await.unwrap();
            assert!(restored.initialize_from_store().await.unwrap());
            http.get(format!("{base}/fixture/transient")).send().await.unwrap();
            assert!(restored.refresh_token().await.is_err());
            assert_eq!(serde_json::to_value(store.load().await.unwrap()).unwrap(), after, "transient failures preserve rotated credentials");
            http.get(format!("{base}/fixture/transient")).send().await.unwrap();
            http.get(format!("{base}/fixture/revoke")).send().await.unwrap();
            assert!(restored.refresh_token().await.is_err());
            assert!(store.load().await.unwrap().unwrap().token_response.is_none(), "revocation requires a fresh sign-in");
            assert!(!manager(&url, store.clone()).await.unwrap().initialize_from_store().await.unwrap());
            store.disconnect().await.unwrap();
            assert!(!store.path.exists());
            assert!(store.save(stored).await.is_err(), "disconnected clients cannot restore their tokens");
        });
    }
}

