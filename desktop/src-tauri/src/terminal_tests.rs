use super::*;
use std::{fs, io::{BufRead, BufReader}, process::{Command, Stdio}, time::Instant};

struct Fixture(PathBuf);
impl Fixture {
    fn new(name: &str) -> Self {
        let artifacts = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.artifact");
        fs::create_dir_all(&artifacts).unwrap();
        let path = artifacts.join(format!("{name}-{}", std::process::id()));
        fs::create_dir(&path).unwrap();
        let root = PathBuf::from(crate::folder_access::canonical_folder(&path).unwrap());
        fs::write(root.join("message.txt"), "Local PTY verified.").unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for _ in 0..30 {
            if fs::remove_dir_all(&self.0).is_ok() { return; }
            std::thread::sleep(Duration::from_millis(50));
        }
        if !std::thread::panicking() { panic!("Cannot remove fixture {:?}", self.0); }
    }
}

#[test]
fn terminal_access_fails_closed() {
    assert!(identity("browser-1", Some("user".into())).is_err());
    assert!(identity("main", None).is_err());
    assert_eq!(identity("main", Some("u".into())).unwrap(), "u");
    let fixture = Fixture::new("terminal-grants");
    for roots in [vec![], vec![PathBuf::from(".")], vec![fixture.0.join("missing")],
                  vec![fixture.0.join("message.txt")], vec![fixture.0.join("..")]] {
        assert!(start_folder(&roots).is_err());
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap()
}

fn read_until(session: &mut Session, test: impl Fn(&[u8]) -> bool) {
    let rt = runtime();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut seen = Vec::new();
    while Instant::now() < deadline {
        let Some(chunk) = rt.block_on(read_output(session.output().unwrap())) else { break };
        let chunk = STANDARD.decode(chunk).unwrap();
        if chunk.windows(4).any(|s| s == b"\x1b[6n") {
            // ConPTY waits for the emulator's initial cursor-position report.
            session.write("\x1b[1;1R".into()).unwrap().blocking_recv().unwrap().unwrap();
        }
        seen.extend(chunk);
        if test(&seen) { return; }
    }
    panic!("Unexpected fixture PTY output: {:?}", String::from_utf8_lossy(&seen));
}

#[test]
fn real_terminal_uses_project_cwd_and_exits() {
    let fixture = Fixture::new("terminal-native");
    let mut registry = Registry::default();
    let open = registry.open("a", "project", std::slice::from_ref(&fixture.0), 110, 30).unwrap();
    assert!(registry.session("b", open.id).is_err());
    let session = registry.session("a", open.id).unwrap();
    #[cfg(windows)]
    read_until(session, |b| String::from_utf8_lossy(b).contains(fixture.0.to_str().unwrap()));
    session.resize(100, 25).unwrap();
    #[cfg(windows)]
    let command = "Get-Content .\\message.txt\r";
    #[cfg(unix)]
    let command = "cat ./message.txt\r";
    session.write(command.into()).unwrap().blocking_recv().unwrap().unwrap();
    read_until(session, |bytes| String::from_utf8_lossy(bytes).contains("Local PTY verified."));
    session.write("exit\r".into()).unwrap().blocking_recv().unwrap().unwrap();
    let rt = runtime();
    let deadline = Instant::now() + Duration::from_secs(10);
    while rt.block_on(read_output(session.output().unwrap())).is_some() {
        assert!(Instant::now() < deadline, "EOF after shell exit");
    }
}

#[cfg(windows)]
#[test]
fn terminal_cleanup_terminates_descendants() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE}};
    let fixture = Fixture::new("terminal-tree");
    let service = Terminals::default();
    let opened = service.0.lock().unwrap().open("owner", "fixture", std::slice::from_ref(&fixture.0), 180, 40).unwrap();
    let mut registry = service.0.lock().unwrap();
    let session = registry.session("owner", opened.id).unwrap();
    read_until(session, |b| String::from_utf8_lossy(b).contains(fixture.0.to_str().unwrap()));
    let script = "$p = Start-Process ($PSHOME + '\\powershell.exe') '-NoProfile -Command Start-Sleep 60' -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText((Join-Path $PWD 'pid'), [string]$p.Id)\r";
    session.write(script.into()).unwrap().blocking_recv().unwrap().unwrap();
    let pid_path = fixture.0.join("pid");
    read_until(session, |_| fs::read_to_string(&pid_path).ok().is_some_and(|s| s.parse::<u32>().is_ok()));
    let pid = fs::read_to_string(pid_path).unwrap().parse().unwrap();
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(!handle.is_null());
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    drop(registry);
    service.close_all();
    assert_eq!(unsafe { WaitForSingleObject(handle.as_raw_handle(), 3000) }, WAIT_OBJECT_0);
    assert!(service.0.lock().unwrap().sessions.is_empty());
}

// Opt-in: the renderer uses Playwright and the production PTY, connected only by stdio.
#[test]
#[ignore = "requires Playwright and a browser; run with --ignored --nocapture"]
fn browser_terminal_fixture() {
    use serde_json::{json, Value};
    let fixture = Fixture::new("terminal-demo");
    let mut node = Command::new("node").arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/terminal.cjs"))
        .env("AURA_TERMINAL_FIXTURE", &fixture.0).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut sink = node.stdin.take().unwrap();
    let service = Terminals::default();
    let rt = runtime();
    for line in BufReader::new(node.stdout.take().unwrap()).lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let args = &request["args"];
        let id = args["id"].as_u64().unwrap_or(0);
        let cols = args["cols"].as_u64().unwrap_or(80) as u16;
        let rows = args["rows"].as_u64().unwrap_or(24) as u16;
        let result = (|| -> Result<Value, String> {
            let mut registry = service.0.lock().unwrap();
            match request["cmd"].as_str().unwrap() {
                "terminal_open" if args["project_id"] == "fixture" => Ok(json!(registry.open("u", "fixture", std::slice::from_ref(&fixture.0), cols, rows)?)),
                "terminal_read" => Ok(json!(rt.block_on(read_output(registry.session("u", id)?.output()?)))),
                "terminal_write" => {registry.session("u", id)?.write(args["data"].as_str().unwrap().into())?.blocking_recv().unwrap()?; Ok(Value::Null)}
                "terminal_resize" => {registry.session("u", id)?.resize(cols, rows)?; Ok(Value::Null)}
                "terminal_close" => {registry.sessions.remove(&id); Ok(Value::Null)}
                "fixture_logout" => {drop(registry);service.close_all();Ok(Value::Null)}
                "fixture_count" => Ok(json!(registry.sessions.len())),
                _ => Err("fixture refused unexpected request".into()),
            }
        })();
        let response = match result { Ok(value) => json!({"value":value}), Err(error) => json!({"error":error}) };
        if writeln!(sink, "{}", json!({"seq":request["seq"], "result":response})).is_err() { break; }
    }
    assert!(node.wait().unwrap().success());
    assert!(service.0.lock().unwrap().sessions.is_empty());
}
