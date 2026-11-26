//! A manual PTY owned by the local main webview. No events, chat data or agent tools.
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, State, Webview};
use tokio::sync::{mpsc as stream, Mutex as AsyncMutex};

type Output = Arc<AsyncMutex<stream::Receiver<Vec<u8>>>>;
type NativeChild = Box<dyn Child + Send + Sync>;
type WriteAck = tokio::sync::oneshot::Sender<Result<(), String>>;

#[derive(Default)]
pub struct Terminals(Mutex<Registry>);

#[derive(Default)]
struct Registry {
    next: u64,
    sessions: HashMap<u64, Session>,
}

struct Session {
    owner: String,
    project: String,
    root: PathBuf,
    // Drop both channels before closing ConPTY, so its final output can drain.
    output: Output,
    input: mpsc::SyncSender<(String, WriteAck)>,
    process: Option<Process>,
}

struct Process {
    child: NativeChild,
    master: Box<dyn MasterPty + Send>,
    #[cfg(windows)]
    job: Option<std::os::windows::io::OwnedHandle>,
}

#[cfg(windows)]
fn child_job(child: &NativeChild) -> std::io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::*;
    // The non-inheritable job also terminates descendants if the gateway crashes.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() { return Err(std::io::Error::last_os_error()); }
        let job = OwnedHandle::from_raw_handle(job);
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(job.as_raw_handle(), JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of_val(&info) as u32) == 0
            || AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle().ok_or(std::io::ErrorKind::NotFound)?) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(windows)]
        drop(self.job.take());
        #[cfg(unix)]
        if let Some(pid) = self.child.process_id() {
            // The unreaped session leader pins its PID. Interactive background jobs
            // may have their own process group but still belong to this terminal.
            unsafe {
                libc::kill(pid as i32, libc::SIGSTOP);
                if let Some(fg) = self.master.process_group_leader().filter(|pg| *pg > 0) {
                    if libc::getsid(fg) == pid as i32 { libc::kill(-fg, libc::SIGKILL); }
                }
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            if let Ok(list) = std::process::Command::new("/bin/ps").args(["-A", "-o", "pid="]).output() {
                for member in String::from_utf8_lossy(&list.stdout).split_whitespace().filter_map(|s| s.parse::<i32>().ok()) {
                    if member > 0 && unsafe { libc::getsid(member) } == pid as i32 {
                        unsafe { libc::kill(member, libc::SIGKILL); }
                    }
                }
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Process {
    fn exited(&self) -> std::io::Result<bool> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::{Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT}, System::Threading::WaitForSingleObject};
            let handle = self.child.as_raw_handle().ok_or(std::io::ErrorKind::NotFound)?;
            match unsafe { WaitForSingleObject(handle, 0) } {
                WAIT_OBJECT_0 => Ok(true),
                WAIT_TIMEOUT => Ok(false),
                _ => Err(std::io::Error::last_os_error()),
            }
        }
        #[cfg(unix)]
        {
            let pid = self.child.process_id().ok_or(std::io::ErrorKind::NotFound)?;
            let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
            if unsafe { libc::waitid(libc::P_PID, pid as _, &mut info, libc::WNOHANG | libc::WEXITED | libc::WNOWAIT) } < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(info.si_signo != 0)
        }
    }
}

fn terminal_size(cols: u16, rows: u16) -> PtySize {
    PtySize { cols: cols.clamp(2, 500), rows: rows.clamp(1, 200), pixel_width: 0, pixel_height: 0 }
}

fn start_folder(roots: &[PathBuf]) -> Result<PathBuf, String> {
    roots.iter().find(|p| p.is_absolute() && crate::folder_access::canonical_folder(p)
        .is_ok_and(|s| !s.starts_with(r"\\") && p.as_path() == Path::new(&s)))
        .cloned().ok_or_else(|| "folder_permission_required".into())
}

#[cfg(windows)]
fn shell() -> Result<(&'static str, CommandBuilder), String> {
    let system = std::env::var_os("SystemRoot").map(PathBuf::from).filter(|p| p.is_absolute())
        .ok_or("SystemRoot unavailable")?;
    let mut cmd = CommandBuilder::new(system.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"));
    cmd.args(["-NoLogo", "-NoProfile"]);
    Ok(("PowerShell", cmd))
}

#[cfg(unix)]
fn shell() -> Result<(&'static str, CommandBuilder), String> {
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.arg("-i");
    cmd.env_remove("ENV");
    Ok(("sh", cmd))
}

#[derive(Serialize)]
pub struct Opened {
    id: u64,
    root: PathBuf,
    shell: &'static str,
}

impl Registry {
    fn open(&mut self, owner: &str, project: &str, roots: &[PathBuf], cols: u16, rows: u16) -> Result<Opened, String> {
        if self.sessions.len() >= 12 { return Err("terminal_limit".into()); }
        let root = start_folder(roots)?;
        let (shell, mut cmd) = shell()?;
        cmd.cwd(&root);
        cmd.env("TERM", "xterm-256color");
        let pair = native_pty_system().openpty(terminal_size(cols, rows)).map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let (tx, rx) = stream::channel(16);
        let (input, writes) = mpsc::sync_channel::<(String, WriteAck)>(32);
        std::thread::Builder::new().name("terminal-output".into()).spawn(move || {
            let mut buf = [0; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        // Older ConPTY versions synchronously flush when their handle closes.
                        let _ = std::io::copy(&mut reader, &mut std::io::sink());
                        break;
                    },
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        }).map_err(|e| e.to_string())?;
        std::thread::Builder::new().name("terminal-input".into()).spawn(move || {
            for (data, ack) in writes {
                let result = writer.write_all(data.as_bytes()).and_then(|_| writer.flush());
                let failed = result.is_err();
                let _ = ack.send(result.map_err(|e| e.to_string()));
                if failed { break; }
            }
        }).map_err(|e| e.to_string())?;
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let mut process = Process {child, master: pair.master, #[cfg(windows)] job: None};
        #[cfg(windows)]
        { process.job = Some(child_job(&process.child).map_err(|e| e.to_string())?); }
        self.next += 1;
        let id = self.next;
        self.sessions.insert(id, Session {owner: owner.into(), project: project.into(), root: root.clone(),
            output: Arc::new(AsyncMutex::new(rx)), input, process: Some(process)});
        Ok(Opened {id, root, shell})
    }

    fn session(&mut self, owner: &str, id: u64) -> Result<&mut Session, String> {
        self.sessions.get_mut(&id).filter(|s| s.owner == owner).ok_or_else(|| "terminal_closed".into())
    }
}

impl Session {
    fn output(&mut self) -> Result<Output, String> {
        if let Some(process) = &mut self.process {
            if process.exited().map_err(|e| e.to_string())? {
                let exited = self.process.take();
                // Closing ConPTY may wait for the UI to consume the last screenful.
                std::thread::spawn(move || drop(exited));
            }
        }
        Ok(self.output.clone())
    }

    fn write(&self, data: String) -> Result<tokio::sync::oneshot::Receiver<Result<(), String>>, String> {
        if data.len() > 32768 { return Err("terminal_input_large".into()); }
        let (ack, result) = tokio::sync::oneshot::channel();
        self.input.try_send((data, ack)).map_err(|e| match e {
            mpsc::TrySendError::Full(_) => "terminal_busy",
            mpsc::TrySendError::Disconnected(_) => "terminal_closed",
        })?;
        Ok(result)
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        if let Some(process) = &self.process {
            process.master.resize(terminal_size(cols, rows)).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

async fn read_output(output: Output) -> Option<String> {
    let mut rx = output.lock().await;
    let mut bytes = match tokio::time::timeout(Duration::from_millis(450), rx.recv()).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return None,
        Err(_) => return Some(String::new()),
    };
    while bytes.len() < 64 * 1024 {
        match rx.try_recv() { Ok(more) => bytes.extend(more), Err(_) => break }
    }
    Some(STANDARD.encode(bytes))
}

impl Terminals {
    pub fn close_all(&self) {
        let sessions = std::mem::take(&mut self.0.lock().unwrap().sessions);
        drop(sessions);
    }
}

fn identity(label: &str, uid: Option<String>) -> Result<String, String> {
    if label != "main" { return Err("browser_forbidden".into()); }
    uid.ok_or_else(|| "login_required".into())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn terminal_open(webview: Webview, state: State<'_, crate::AppState>, project_id: String, email: String, cols: u16, rows: u16) -> Result<Opened, String> {
    let _account = state.account_lock.lock().await;
    let owner = identity(webview.label(), state.firestore.uid())?;
    if state.config.lock().unwrap().firebase_email != email { return Err("account_changed".into()); }
    let roots = crate::readable_roots(&state, &owner, &project_id)?;
    webview.state::<Terminals>().0.lock().unwrap().open(&owner, &project_id, &roots, cols, rows)
}

fn access<T>(view: &Webview, state: &crate::AppState, id: u64, f: impl FnOnce(&mut Session) -> Result<T,String>) -> Result<T,String> {
    let terminals = view.state::<Terminals>();
    let mut registry = terminals.0.lock().unwrap();
    let owner = identity(view.label(), state.firestore.uid())?;
    let session = registry.session(&owner, id)?;
    if !crate::readable_roots(state, &owner, &session.project).is_ok_and(|roots| roots.contains(&session.root)) {
        registry.sessions.remove(&id);
        return Err("folder_permission_required".into());
    }
    f(session)
}

#[tauri::command]
pub async fn terminal_write(webview: Webview, state: State<'_, crate::AppState>, id: u64, data: String) -> Result<(), String> {
    access(&webview, &state, id, |s| s.write(data))?.await.map_err(|_| "terminal_closed")?
}

#[tauri::command]
pub async fn terminal_resize(webview: Webview, state: State<'_, crate::AppState>, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    access(&webview, &state, id, |s| s.resize(cols, rows))
}

#[tauri::command]
pub async fn terminal_read(webview: Webview, state: State<'_, crate::AppState>, id: u64) -> Result<Option<String>, String> {
    let output = access(&webview, &state, id, Session::output)?;
    let data = read_output(output).await;
    access(&webview, &state, id, |_| Ok(data))
}

#[tauri::command]
pub async fn terminal_close(webview: Webview, state: State<'_, crate::AppState>, id: u64) -> Result<(), String> {
    let owner = identity(webview.label(), state.firestore.uid())?;
    let terminals = webview.state::<Terminals>();
    let mut registry = terminals.0.lock().unwrap();
    if registry.sessions.contains_key(&id) {
        registry.session(&owner, id)?;
        registry.sessions.remove(&id);
    }
    Ok(())
}

#[cfg(test)]
#[path = "terminal_tests.rs"]
mod tests;
