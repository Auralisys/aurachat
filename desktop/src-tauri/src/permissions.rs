use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path, process::{Command, Stdio}};
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode { #[default] Ask, Auto, Full }

#[derive(Default, Serialize, Deserialize)]
pub struct Permissions(BTreeMap<String, BTreeMap<String, Mode>>);
impl Permissions {
    pub fn load(dir: &Path) -> Result<Self, String> {
        match std::fs::read(dir.join("action-permissions.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.to_string()),
        }
    }
    pub fn get(&self, uid: &str, project: &str) -> Mode { self.0.get(uid).and_then(|p|p.get(project)).copied().unwrap_or_default() }
    pub fn set(&mut self, dir: &Path, uid: &str, project: &str, mode: Mode) -> Result<(), String> {
        let mut next = Self(self.0.clone());
        next.0.entry(uid.into()).or_default().insert(project.into(), mode);
        let temporary = dir.join("action-permissions.tmp");
        std::fs::write(&temporary, serde_json::to_vec_pretty(&next).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        std::fs::rename(temporary, dir.join("action-permissions.json")).map_err(|e|e.to_string())?;
        *self = next; Ok(())
    }
}

#[derive(Clone)]
pub struct Execution { pub app: tauri::AppHandle, pub owner: String, pub project: String, pub conversation: String, pub turn_id:String, pub intent:String, pub agent_id:Option<String>, pub cancellation:Option<std::sync::Arc<crate::agent_runs::Cancellation>> }
impl Execution {
    pub fn mode(&self) -> Result<Mode, String> {
        let state = self.app.state::<crate::AppState>();
        if state.firestore.uid().as_deref() != Some(&self.owner) { return Err("session_changed".into()); }
        if self.cancellation.as_ref().is_some_and(|c|c.is_cancelled()) {return Err("agent_cancelled".into());}
        if self.agent_id.as_ref().is_some_and(|id|self.app.state::<crate::agent_runs::AgentRuns>().cancelled(id)) { return Err("agent_cancelled".into()); }
        let mode = state.permissions.lock().unwrap().get(&self.owner, &self.project); Ok(mode)
    }
    pub fn approve(&self, action:serde_json::Value, routine:bool)->Result<(),String> {
        crate::approvals::approve(self,action,routine)
    }
    pub fn command(&self, cwd: &Path, program: &str, arguments: &[String]) -> Result<serde_json::Value, String> {
        let trusted_git = std::env::var_os("ProgramFiles").map(std::path::PathBuf::from).map(|p|p.join("Git/cmd/git.exe")).filter(|p|p.is_file());
        let routine = routine_command(program, arguments) && trusted_git.is_some();
        self.approve(serde_json::json!({"kind":"command","path":cwd,"program":program,"arguments":arguments}), routine)?;
        let mut command = if routine { Command::new(trusted_git.unwrap()) } else { Command::new(program) };
        if routine { command.args(["--no-optional-locks", "-c", "core.fsmonitor=false"]); }
        command.args(arguments).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let child = command.spawn().map_err(|e|e.to_string())?;
        let shells = self.app.state::<std::sync::Arc<crate::managed_shells::Shells>>();
        let app = self.app.clone();
        let snapshot = shells.track(self.owner.clone(), self.conversation.clone(), self.agent_id.clone(), serde_json::json!({"program":program,"arguments":arguments}).to_string(), cwd.display().to_string(), child, move |snapshot| { let _ = app.emit("shell-activity", snapshot); });
        if self.mode().is_err() { let _=shells.stop(&self.owner,&self.conversation,&snapshot.id);return Err("agent_cancelled".into()); }
        // Return long-running processes to the model; the user can inspect and stop them in Shell.
        for _ in 0..150 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if let Some(current) = shells.list(&self.owner, &self.conversation).into_iter().find(|s|s.id == snapshot.id) {
                if current.status != "running" { return serde_json::to_value(current).map_err(|e|e.to_string()); }
            }
        }
        Ok(serde_json::json!({"id":snapshot.id,"status":"running","message":"Use inspect_project_command to check output. Do not launch the command again."}))
    }
    pub fn inspect(&self, id: &str) -> Result<serde_json::Value, String> {
        self.mode()?;
        let shells = self.app.state::<std::sync::Arc<crate::managed_shells::Shells>>();
        let snapshot = shells.list(&self.owner, &self.conversation).into_iter().find(|s|s.id == id).ok_or("shell_not_found")?;
        serde_json::to_value(snapshot).map_err(|e|e.to_string())
    }
}

pub(crate) fn requires_approval(mode: Mode, routine: bool) -> bool { mode == Mode::Ask || (mode == Mode::Auto && !routine) }

// Deliberately narrow automatic review: arbitrary scripts and Git hooks always need manual approval.
fn routine_command(program: &str, args: &[String]) -> bool {
    program == "git" && matches!(args.iter().map(String::as_str).collect::<Vec<_>>().as_slice(), ["--version"] | ["status", "--short"] | ["status", "--porcelain"] | ["rev-parse", "--show-toplevel"])
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn modes_persist_locally_and_review_fails_closed() {
        let dir = std::env::temp_dir().join(format!("aurachat-permissions-{}",crate::data::now_millis()));std::fs::create_dir(&dir).unwrap();
        let mut permissions = Permissions::load(&dir).unwrap();assert_eq!(permissions.get("u","p"),Mode::Ask);
        permissions.set(&dir,"u","p",Mode::Auto).unwrap();let saved=Permissions::load(&dir).unwrap();
        assert_eq!(saved.get("u","p"),Mode::Auto);assert_eq!(saved.get("other","p"),Mode::Ask);assert_eq!(saved.get("u","other"),Mode::Ask);
        assert!(requires_approval(Mode::Ask,true));assert!(!requires_approval(Mode::Auto,true));assert!(requires_approval(Mode::Auto,false));assert!(!requires_approval(Mode::Full,false));
        assert!(routine_command("git", &["status".into(),"--short".into()]));
        for args in [vec!["push".into()],vec!["-c".into(),"core.fsmonitor=evil".into(),"status".into()],vec!["commit".into()]] {assert!(!routine_command("git",&args));}
        assert!(!routine_command("powershell", &["git status".into()]));
        std::fs::write(dir.join("action-permissions.json"),"invalid").unwrap();assert!(Permissions::load(&dir).is_err());
        std::fs::remove_file(dir.join("action-permissions.json")).unwrap();std::fs::remove_dir(dir).unwrap();
    }
}
