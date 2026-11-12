//! Saldo dell'account DeepSeek (`GET /user/balance`).
//! Appartiene alla key del provider e non alla chat: la key resta nel backend e alla UI arrivano solo gli importi.

use serde::Serialize;
use serde_json::Value;

const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const UNAVAILABLE: &str = "balance_unavailable";
const UNAUTHORIZED: &str = "balance_unauthorized";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BalanceInfo {
    pub currency: String,
    pub total: f64,
    pub granted: f64,
    pub topped_up: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Balance {
    /// Falso quando il credito non basta più per le richieste.
    pub is_available: bool,
    pub infos: Vec<BalanceInfo>,
    pub top_up_url: &'static str,
}

/// Legge il saldo da `url`, che il chiamante ricava da `config::balance_url`: la key non va mai verso altri host.
/// Gli errori sono codici stabili, mai testo del provider.
pub async fn fetch(client: &reqwest::Client, url: &str, api_key: &str) -> Result<Balance, String> {
    let response = client.get(url).bearer_auth(api_key).timeout(TIMEOUT).send().await
        .map_err(|error| failed(format!("richiesta fallita: {error}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(if matches!(status.as_u16(), 401 | 403) { UNAUTHORIZED.into() } else { failed(format!("HTTP {}", status.as_u16())) });
    }
    let body = response.text().await.map_err(|error| failed(format!("lettura risposta: {error}")))?;
    parse(&body)
}

fn failed(cause: String) -> String {
    eprintln!("Balance unavailable: {cause}");
    UNAVAILABLE.into()
}

fn parse(body: &str) -> Result<Balance, String> {
    let value: Value = serde_json::from_str(body).map_err(|error| failed(format!("risposta non-JSON: {error}")))?;
    let balance = (|| {
        let is_available = value["is_available"].as_bool()?;
        let infos = value["balance_infos"].as_array()?.iter().map(info).collect::<Option<Vec<_>>>()?;
        Some(Balance { is_available, infos, top_up_url: crate::config::DEEPSEEK_TOP_UP_URL })
    })();
    balance.ok_or_else(|| failed("risposta inattesa".into()))
}

fn info(entry: &Value) -> Option<BalanceInfo> {
    let currency = entry["currency"].as_str()?;
    if currency.len() != 3 || !currency.bytes().all(|byte| byte.is_ascii_uppercase()) { return None; }
    Some(BalanceInfo {
        currency: currency.into(),
        total: amount(&entry["total_balance"])?,
        granted: amount(&entry["granted_balance"])?,
        topped_up: amount(&entry["topped_up_balance"])?,
    })
}

/// DeepSeek manda gli importi come stringhe decimali.
fn amount(value: &Value) -> Option<f64> {
    let amount = match value {
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        Value::Number(number) => number.as_f64()?,
        _ => return None,
    };
    amount.is_finite().then_some(amount)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    const BODY: &str = r#"{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"}]}"#;

    /// Risponde a una sola richiesta e restituisce quella ricevuta, intestazioni comprese.
    fn serve(status: &'static str, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/user/balance", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = socket.read(&mut buffer).unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
            }
            write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (url, server)
    }

    fn fetch_blocking(url: &str, key: &str) -> Result<Balance, String> {
        tauri::async_runtime::block_on(fetch(&reqwest::Client::new(), url, key))
    }

    #[test]
    fn parses_the_documented_response() {
        let balance = parse(BODY).unwrap();
        assert!(balance.is_available);
        assert_eq!(balance.infos, vec![BalanceInfo { currency: "CNY".into(), total: 110.0, granted: 10.0, topped_up: 100.0 }]);
        assert_eq!(balance.top_up_url, "https://platform.deepseek.com/top_up");
        let empty = parse(r#"{"is_available":false,"balance_infos":[]}"#).unwrap();
        assert!(!empty.is_available && empty.infos.is_empty());
        let numbers = parse(r#"{"is_available":true,"balance_infos":[{"currency":"USD","total_balance":1.5,"granted_balance":0,"topped_up_balance":"1.5"}]}"#).unwrap();
        assert_eq!(numbers.infos[0].total, 1.5);
    }

    #[test]
    fn rejects_malformed_responses() {
        let entry = |currency: &str, total: &str| format!(r#"{{"is_available":true,"balance_infos":[{{"currency":{currency},"total_balance":{total},"granted_balance":"0","topped_up_balance":"0"}}]}}"#);
        for body in [
            "not json".to_string(),
            "{}".to_string(),
            r#"{"is_available":true}"#.to_string(),
            r#"{"is_available":"yes","balance_infos":[]}"#.to_string(),
            r#"{"is_available":true,"balance_infos":[{}]}"#.to_string(),
            entry(r#""usd""#, r#""1""#),
            entry(r#""US""#, r#""1""#),
            entry(r#""USDX""#, r#""1""#),
            entry("null", r#""1""#),
            entry(r#""USD""#, r#""abc""#),
            entry(r#""USD""#, r#""NaN""#),
            entry(r#""USD""#, r#""inf""#),
            entry(r#""USD""#, "null"),
        ] {
            assert_eq!(parse(&body).unwrap_err(), UNAVAILABLE, "{body}");
        }
    }

    #[test]
    fn fetch_sends_the_key_as_bearer_and_reads_the_balance() {
        let (url, server) = serve("200 OK", BODY);
        let balance = fetch_blocking(&url, "test-key").unwrap();
        let request = server.join().unwrap().to_lowercase();
        assert!(request.starts_with("get /user/balance http/1.1"));
        assert!(request.contains("authorization: bearer test-key"));
        assert_eq!(balance.infos[0].total, 110.0);
    }

    #[test]
    fn fetch_reports_stable_codes_and_never_the_provider_text() {
        for (status, code) in [
            ("401 Unauthorized", UNAUTHORIZED),
            ("403 Forbidden", UNAUTHORIZED),
            ("402 Payment Required", UNAVAILABLE),
            ("500 Internal Server Error", UNAVAILABLE),
            ("200 OK", UNAVAILABLE),
        ] {
            let (url, server) = serve(status, r#"{"error":"secret-key was rejected"}"#);
            assert_eq!(fetch_blocking(&url, "secret-key").unwrap_err(), code, "{status}");
            server.join().unwrap();
        }
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        assert_eq!(fetch_blocking(&format!("http://{closed}/user/balance"), "secret-key").unwrap_err(), UNAVAILABLE);
    }
}
