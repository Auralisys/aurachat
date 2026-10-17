//! Tracks processes started by the native runner after permission checks.
use std::{collections::HashMap, io::Read, process::Child, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::Duration};
use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub id: String,
    pub conversation_id: String,
    pub agent_id: Option<String>,
    pub title: String,
    pub command: String,
    pub cwd: String,
    pub status: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub revision: u64,
}

type Notify = Arc<dyn Fn(Snapshot) + Send + Sync>;
struct Entry { owner: String, child: Mutex<Child>, snapshot: Mutex<Snapshot>, notify: Notify, publish_lock: Mutex<()> }
#[derive(Default)]
pub struct Shells { entries: Mutex<HashMap<String, Arc<Entry>>>, sequence: AtomicU64 }

impl Entry {
    fn publish(&self) {
        let _publish = self.publish_lock.lock().unwrap();
        let snapshot = {let mut snapshot = self.snapshot.lock().unwrap();snapshot.revision += 1;snapshot.clone()};
        (self.notify)(snapshot);
    }
    fn finish(&self, code: Option<i32>, cancelled: bool) -> Snapshot {
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot.status == "running" {
            snapshot.status = if cancelled { "cancelled" } else if code == Some(0) { "completed" } else { "failed" }.into();
            snapshot.exit_code = code;
        }
        snapshot.clone()
    }
}

fn capture(reader: impl Read + Send + 'static, entry: Arc<Entry>) {
    std::thread::spawn(move || {
        let mut reader = reader;let mut buffer = [0; 4096];
        loop {
            let count = match reader.read(&mut buffer) { Ok(0) | Err(_) => break, Ok(count) => count };
            {
                let mut snapshot = entry.snapshot.lock().unwrap();
                snapshot.output.push_str(&String::from_utf8_lossy(&buffer[..count]));
                // Keep the most recent 128 KiB of terminal output.
                if snapshot.output.len() > 131072 {
                    let mut start = snapshot.output.len() - 131072;
                    while !snapshot.output.is_char_boundary(start) { start += 1; }
                    snapshot.output.drain(..start);
                }
            }
            entry.publish();
        }
    });
}

impl Shells {
    /// A native runner hands over an already-authorized child with piped output.
    pub fn track(&self, owner: String, conversation_id: String, agent_id: Option<String>, command: String, cwd: String, mut child: Child, notify: impl Fn(Snapshot) + Send + Sync + 'static) -> Snapshot {
        let id = format!("shell-{}", self.sequence.fetch_add(1, Ordering::Relaxed));
        let stdout = child.stdout.take();let stderr = child.stderr.take();
        let snapshot = Snapshot {id:id.clone(), conversation_id, agent_id, title:command.clone(), command, cwd, status:"running".into(), output:String::new(), exit_code:None, revision:0};
        let entry = Arc::new(Entry {owner, child:Mutex::new(child), snapshot:Mutex::new(snapshot.clone()), notify:Arc::new(notify), publish_lock:Mutex::new(())});
        self.entries.lock().unwrap().insert(id, entry.clone());entry.publish();
        if let Some(stdout) = stdout { capture(stdout, entry.clone()); }
        if let Some(stderr) = stderr { capture(stderr, entry.clone()); }
        std::thread::spawn(move || loop {
            let status = entry.child.lock().unwrap().try_wait();
            match status {
                Ok(Some(status)) => {entry.finish(status.code(), false);entry.publish();break;}
                Err(error) => {
                    let mut snapshot = entry.snapshot.lock().unwrap();snapshot.status = "failed".into();snapshot.output.push_str(&format!("\n{error}"));drop(snapshot);entry.publish();break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(80)),
            }
        });
        snapshot
    }

    pub fn list(&self, owner: &str, conversation_id: &str) -> Vec<Snapshot> {
        self.entries.lock().unwrap().values().filter(|entry| entry.owner == owner)
            .map(|entry| entry.snapshot.lock().unwrap().clone()).filter(|s| s.conversation_id == conversation_id).collect()
    }

    pub fn stop(&self, owner: &str, conversation_id: &str, id: &str) -> Result<Snapshot, String> {
        let entry = self.entries.lock().unwrap().get(id).cloned().ok_or("shell_not_found")?;
        if entry.owner != owner || entry.snapshot.lock().unwrap().conversation_id != conversation_id { return Err("shell_not_found".into()); }
        Self::stop_entry(&entry)
    }

    fn stop_entry(entry: &Entry) -> Result<Snapshot, String> {
        let mut child = entry.child.lock().unwrap();
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let snapshot = entry.finish(status.code(), false);drop(child);entry.publish();return Ok(snapshot);
        }
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            // Only registered live children can be stopped, never a PID from the UI.
            let status = std::process::Command::new("taskkill.exe").args(["/PID", &child.id().to_string(), "/T", "/F"])
                .creation_flags(0x08000000).output().map_err(|e| e.to_string())?;
            if !status.status.success() && child.try_wait().map_err(|e| e.to_string())?.is_none() { return Err(String::from_utf8_lossy(&status.stderr).into_owned()); }
        }
        #[cfg(not(windows))] child.kill().map_err(|e| e.to_string())?;
        let status = child.wait().map_err(|e| e.to_string())?;
        let snapshot = entry.finish(status.code(), true);drop(child);entry.publish();Ok(snapshot)
    }

    pub fn stop_all(&self) {
        let entries: Vec<_> = self.entries.lock().unwrap().values().cloned().collect();
        for entry in entries { let _ = Self::stop_entry(&entry); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    fn wait_until(mut condition: impl FnMut() -> bool) {
        for _ in 0..100 { if condition() { return; } std::thread::sleep(Duration::from_millis(50)); }
        panic!("shell did not reach the expected state");
    }
    #[test]
    fn captures_real_output_and_stops_only_the_registered_owners_shell() {
        let shells = Shells::default();
        #[cfg(windows)] let mut command = {let mut c=Command::new("cmd.exe");c.args(["/D","/C","echo fixture-output & ping -n 60 127.0.0.1 >nul"]);c};
        #[cfg(not(windows))] let mut command = {let mut c=Command::new("sh");c.args(["-c","echo fixture-output; exec sleep 60"]);c};
        let child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let shell = shells.track("owner".into(), "conversation".into(), None, "fixture".into(), String::new(), child, |_| {});
        wait_until(|| shells.list("owner", "conversation")[0].output.contains("fixture-output"));
        assert!(shells.list("other", "conversation").is_empty());
        assert!(shells.stop("other", "conversation", &shell.id).is_err());
        assert!(shells.stop("owner", "other", &shell.id).is_err());
        let stopped = shells.stop("owner", "conversation", &shell.id).unwrap();
        assert_eq!(stopped.status, "cancelled");
        assert_eq!(shells.stop("owner", "conversation", &shell.id).unwrap().status, "cancelled");
    }
    #[test]
    fn retains_natural_exit_and_code() {
        let shells = Shells::default();
        #[cfg(windows)] let mut command = {let mut c=Command::new("cmd.exe");c.args(["/D","/C","exit 7"]);c};
        #[cfg(not(windows))] let mut command = {let mut c=Command::new("sh");c.args(["-c","exit 7"]);c};
        let shell = shells.track("owner".into(), "conversation".into(), None, "fixture".into(), String::new(), command.spawn().unwrap(), |_| {});
        wait_until(|| shells.list("owner", "conversation")[0].status == "failed");
        assert_eq!(shells.stop("owner", "conversation", &shell.id).unwrap().exit_code, Some(7));
    }
}
