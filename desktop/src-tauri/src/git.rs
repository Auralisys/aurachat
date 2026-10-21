use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::Read, path::{Path, PathBuf}, process::{Command, Stdio}};
#[cfg(not(windows))]
use std::time::{Duration, Instant};

static OPERATIONS: std::sync::Mutex<()> = std::sync::Mutex::new(());
const LIMIT: usize = 2 * 1024 * 1024;
#[cfg(test)]
thread_local! {static COMMAND_COUNT: std::cell::Cell<usize> = const {std::cell::Cell::new(0)};}

fn command(root: &Path, index: Option<&Path>) -> Command {
    let mut cmd=Command::new("git");
    cmd.current_dir(root).args(["--no-pager","--literal-pathspecs","-c","core.quotepath=false","-c","status.renames=false"])
        .env("GIT_TERMINAL_PROMPT","0").env("GCM_INTERACTIVE","Never")
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_COMMON_DIR").env_remove("GIT_OBJECT_DIRECTORY")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(index)=index {cmd.env("GIT_INDEX_FILE",index);}
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

fn collect(mut stream: impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes=Vec::new();let mut buffer=[0;8192];
    loop {
        let n=stream.read(&mut buffer)?;if n==0 {break;}
        if bytes.len()<=LIMIT {bytes.extend_from_slice(&buffer[..n]);}
    }
    Ok(bytes)
}

fn run(root: &Path, index: Option<&Path>, args: &[&str]) -> Result<String,String> {
    #[cfg(test)]
    COMMAND_COUNT.with(|count|count.set(count.get()+1));
    let mut child=command(root,index).args(args).spawn().map_err(|e|format!("Git: {e}"))?;
    let stdout=child.stdout.take().ok_or("Git stdout unavailable")?;
    let stderr=child.stderr.take().ok_or("Git stderr unavailable")?;
    let out=std::thread::spawn(move||collect(stdout));
    let err=std::thread::spawn(move||collect(stderr));
    #[cfg(windows)]
    let status={
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::{HANDLE,WAIT_OBJECT_0,WAIT_TIMEOUT},System::Threading::WaitForSingleObject};
        let result=unsafe {WaitForSingleObject(HANDLE(child.as_raw_handle()),90_000)};
        if result!=WAIT_OBJECT_0 {
            let _=child.kill();let _=child.wait();
            return Err(if result==WAIT_TIMEOUT {"Git timed out. Check repository/authentication before retrying; the operation may have partially completed.".into()}
                else {format!("Git wait failed: {}",windows::core::Error::from_thread())});
        }
        child.wait().map_err(|e|e.to_string())?
    };
    #[cfg(not(windows))]
    let child_started=Instant::now();
    #[cfg(not(windows))]
    let status=loop {
        if let Some(status)=child.try_wait().map_err(|e|e.to_string())? {break status;}
        if child_started.elapsed()>Duration::from_secs(90) {
            let _=child.kill();let _=child.wait();
            return Err("Git timed out. Check repository/authentication before retrying; the operation may have partially completed.".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let output=out.join().map_err(|_|"Git reader failed")?.map_err(|e|e.to_string())?;
    let error=err.join().map_err(|_|"Git reader failed")?.map_err(|e|e.to_string())?;
    if output.len()>LIMIT || error.len()>LIMIT {return Err("Git output exceeds 2 MiB; select fewer files.".into());}
    if !status.success() {return Err(format!("Git: {}",String::from_utf8_lossy(&error).trim()));}
    String::from_utf8(output).map_err(|_|"Git output/filenames are not UTF-8.".into())
}

fn repository(root: &Path) -> Result<PathBuf,String> {
    let root=root.canonicalize().map_err(|e|e.to_string())?;
    let top=PathBuf::from(run(&root,None,&["rev-parse","--show-toplevel"])?.trim()).canonicalize().map_err(|e|e.to_string())?;
    if root!=top {return Err("Authorize the repository root as a project folder to use Git.".into());}
    Ok(root)
}

fn head(root: &Path) -> Result<String,String> {
    if let Ok(value)=run(root,None,&["rev-parse","--verify","HEAD"]) {
        return Ok(value.trim().into());
    }
    let branch=run(root,None,&["symbolic-ref","-q","HEAD"])?;
    if !run(root,None,&["show-ref","--verify",branch.trim()]).is_ok() {return Ok(String::new());}
    Err("Cannot read HEAD.".into())
}

fn ready(root: &Path) -> Result<(),String> {
    run(root,None,&["symbolic-ref","-q","HEAD"]).map_err(|_|"Detached HEAD: check out a branch before committing.")?;
    if !run(root,None,&["ls-files","-u"])?.is_empty() {return Err("Resolve Git conflicts before committing.".into());}
    let git_dir=root.join(run(root,None,&["rev-parse","--git-dir"])?.trim());
    for name in ["MERGE_HEAD","CHERRY_PICK_HEAD","REVERT_HEAD","rebase-merge","rebase-apply"] {
        if git_dir.join(name).exists() {return Err("Finish the current merge/rebase before committing.".into());}
    }
    Ok(())
}

fn changes(root: &Path, base: &str) -> Result<Vec<Value>,String> {
    let text=run(root,None,&["status","--porcelain=v1","-z","--untracked-files=all"])?;
    let mut files=parse_changes(&text)?;
    let stats=if base.is_empty(){String::new()}else{run(root,None,&["diff","HEAD","--numstat","-z","--no-renames","--no-ext-diff","--no-textconv"])?};
    apply_stats(&mut files,&stats,None)?;
    apply_stats(&mut files,&run(root,None,&["diff","--cached","--numstat","-z","--no-renames","--no-ext-diff","--no-textconv"])?,Some("staged"))?;
    apply_stats(&mut files,&run(root,None,&["diff","--numstat","-z","--no-renames","--no-ext-diff","--no-textconv"])?,Some("unstaged"))?;
    for file in &mut files {
        if file["status"]=="??" || base.is_empty() {
            let path=root.join(file["path"].as_str().ok_or("Invalid path")?);
            if std::fs::symlink_metadata(&path).is_ok_and(|m|m.file_type().is_symlink()) {file["binary"]=json!(true);continue;}
            if !path.is_file() {continue;}
            let mut bytes=Vec::new();
            std::fs::File::open(&path).map_err(|e|e.to_string())?.take(LIMIT as u64+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
            if bytes.len()>LIMIT {return Err(format!("{} exceeds 2 MiB; inspect large files externally.",path.display()));}
            let binary=bytes.contains(&0)||std::str::from_utf8(&bytes).is_err();
            file["binary"]=json!(binary);
            if !binary {file["added"]=json!(bytes.iter().filter(|b|**b==b'\n').count()+usize::from(!bytes.is_empty()&&bytes.last()!=Some(&b'\n')));}
            if file["status"]=="??" {
                file["unstaged"]=json!({"added":file["added"],"removed":0,"binary":binary});
            }
        }
    }
    Ok(files)
}

fn parse_changes(text: &str) -> Result<Vec<Value>,String> {
    let mut files=Vec::new();
    for entry in text.split('\0').filter(|s|!s.is_empty()) {
        if entry.len()<4 || !entry.is_char_boundary(3) {return Err("Unsupported Git status.".into());}
        let state=&entry[..2];
        files.push(json!({"path":&entry[3..],"status":state,"added":0,"removed":0,"binary":false,
            "staged":if state!="??" && state.as_bytes()[0]!=b' ' {Some(json!({"added":0,"removed":0,"binary":false}))}else{None},
            "unstaged":if state=="??" || state.as_bytes()[1]!=b' ' {Some(json!({"added":0,"removed":0,"binary":false}))}else{None}}));
    }
    if files.len()>1000 {return Err("More than 1000 changed files; use an external Git client.".into());}
    Ok(files)
}

fn apply_stats(files: &mut [Value], text: &str, side: Option<&str>) -> Result<(),String> {
    for entry in text.split('\0').filter(|s|!s.is_empty()) {
        let parts:Vec<_>=entry.splitn(3,'\t').collect();
        if parts.len()!=3 {return Err("Invalid Git line statistics.".into());}
        if let Some(file)=files.iter_mut().find(|f|f["path"]==parts[2]) {
            let target=if let Some(side)=side {&mut file[side]}else{file};
            target["binary"]=json!(parts[0]=="-");
            if parts[0]!="-" {
                target["added"]=json!(parts[0].parse::<u64>().map_err(|_|"Invalid added line count")?);
                target["removed"]=json!(parts[1].parse::<u64>().map_err(|_|"Invalid removed line count")?);
            }
        }
    }
    Ok(())
}

fn index_revision(root: &Path, base: &str) -> Result<String,String> {
    let branch=run(root,None,&["symbolic-ref","-q","HEAD"]).unwrap_or_else(|_|"HEAD".into());
    Ok(format!("{:x}",Sha256::digest(format!("{base}\n{branch}\n{}",run(root,None,&["ls-files","--stage","-z"])?))))
}

fn status_inner(root: &Path) -> Result<Value,String> {
    let base=head(root)?;
    let files=changes(root,&base)?;
    let branch=run(root,None,&["symbolic-ref","--short","-q","HEAD"]).ok().map(|s|s.trim().to_string());
    let upstream=run(root,None,&["rev-parse","--abbrev-ref","--symbolic-full-name","@{upstream}"]).ok().map(|s|s.trim().to_string());
    let (mut ahead,mut behind)=(0u64,0u64);
    if upstream.is_some() {
        let counts=run(root,None,&["rev-list","--left-right","--count","HEAD...@{upstream}"])?;
        let parts:Vec<_>=counts.split_whitespace().collect();
        if parts.len()!=2 {return Err("Invalid ahead/behind counts.".into());}
        ahead=parts[0].parse().map_err(|_|"Invalid ahead count")?;behind=parts[1].parse().map_err(|_|"Invalid behind count")?;
    }
    Ok(json!({"branch":branch,"head":base,"revision":index_revision(root,&base)?,"upstream":upstream,"ahead":ahead,"behind":behind,
        "added":files.iter().filter_map(|f|f["added"].as_u64()).sum::<u64>(),
        "removed":files.iter().filter_map(|f|f["removed"].as_u64()).sum::<u64>(),"files":files}))
}

pub fn status(root: &Path) -> Result<Value,String> {
    let _lock=OPERATIONS.lock().map_err(|_|"Git lock failed")?;
    status_inner(&repository(root)?)
}

pub fn stage(root: &Path, paths: &[String], revision: &str, unstage: bool) -> Result<Value,String> {
    let _lock=OPERATIONS.lock().map_err(|_|"Git lock failed")?;
    let root=repository(root)?;
    ready(&root)?;
    let base=head(&root)?;
    if index_revision(&root,&base)?!=revision {return Err("Staging or HEAD changed. Refresh before changing the selection.".into());}
    // Staging needs paths/status only, not three diffs and a complete sidebar refresh.
    let files=parse_changes(&run(&root,None,&["status","--porcelain=v1","-z","--untracked-files=all"])?)?;
    if paths.is_empty() || paths.len()>1000 {return Err("Choose at least one file.".into());}
    for (i,path) in paths.iter().enumerate() {
        if paths[..i].contains(path)||!files.iter().any(|f|f["path"]==*path && !f[if unstage {"staged"}else{"unstaged"}].is_null()) {
            return Err("Selection changed. Refresh before staging/unstaging.".into());
        }
        if path.contains(['\r','\n'])||root.join(path).is_dir() {return Err("Submodules and newline filenames must be managed externally.".into());}
    }
    let mut args=if !unstage {vec!["add","--all","--"]}
        else if base.is_empty() {vec!["update-index","--force-remove","--"]}
        else {vec!["restore","--source=HEAD","--staged","--"]};
    args.extend(paths.iter().map(String::as_str));
    if index_revision(&root,&head(&root)?)?!=revision {return Err("Staging or HEAD changed. Refresh before changing the selection.".into());}
    run(&root,None,&args)?;
    Ok(json!({"revision":index_revision(&root,&head(&root)?)?}))
}

fn staged_preview(root: &Path) -> Result<(String,String),String> {
    ready(root)?;
    let tree=run(root,None,&["write-tree"])?;
    let diff=run(root,None,&["diff","--cached","--no-ext-diff","--no-textconv","--no-renames"])?;
    if diff.is_empty() {return Err("Stage changes before preparing a commit.".into());}
    Ok((format!("{}:{}",index_revision(root,&head(root)?)?,tree.trim()),diff))
}

pub fn preview(root: &Path) -> Result<Value,String> {
    let _lock=OPERATIONS.lock().map_err(|_|"Git lock failed")?;
    let root=repository(root)?;
    let (revision,diff)=staged_preview(&root)?;
    if diff.len()>64000 {return Err("Diff exceeds 64 KB; select fewer files.".into());}
    Ok(json!({"revision":revision,"index_revision":index_revision(&root,&head(&root)?)?,"diff":diff}))
}

pub fn commit(root: &Path, revision: &str, message: &str) -> Result<Value,String> {
    let _lock=OPERATIONS.lock().map_err(|_|"Git lock failed")?;
    let root=repository(root)?;
    if message.trim().is_empty()||message.len()>16000||message.contains('\0') {return Err("Enter a commit message (up to 16000 bytes).".into());}
    if staged_preview(&root)?.0!=revision {return Err("Staging/HEAD changed after preview. Review the staged changes again.".into());}
    run(&root,None,&["commit","-m",message]).map_err(|e|format!("{e}\nStaged changes are preserved. No push was performed."))?;
    Ok(json!({"head":head(&root)?}))
}

fn push_target(root: &Path) -> Result<Value,String> {
    let branch=run(root,None,&["symbolic-ref","--short","-q","HEAD"])?.trim().to_string();
    let remote=run(root,None,&["config","--get",&format!("branch.{branch}.remote")])?.trim().to_string();
    let target=run(root,None,&["config","--get",&format!("branch.{branch}.merge")])?.trim().to_string();
    if remote.is_empty()||remote=="."||remote.starts_with('-')||!target.starts_with("refs/heads/") {return Err("Configure a remote upstream before pushing.".into());}
    let urls=run(root,None,&["remote","get-url","--push","--all",&remote])?;
    if urls.lines().count()!=1 {return Err("Push requires one remote push URL.".into());}
    let head=head(root)?;
    let revision=format!("{:x}",Sha256::digest(format!("{branch}\n{remote}\n{target}\n{urls}\n{head}")));
    Ok(json!({"revision":revision,"remote":remote,"target":target,"head":head}))
}

pub fn push_preview(root: &Path) -> Result<Value,String> {
    let _lock=OPERATIONS.lock().map_err(|_|"Git lock failed")?;
    push_target(&repository(root)?)
}

pub fn push(root: &Path, revision: &str) -> Result<Value,String> {
    let _lock=OPERATIONS.lock().map_err(|_|"Git lock failed")?;
    let root=repository(root)?;let target=push_target(&root)?;
    if target["revision"]!=revision {return Err("HEAD or push destination changed; review and confirm again.".into());}
    let remote=target["remote"].as_str().ok_or("Invalid remote")?;
    let reference=format!("HEAD:{}",target["target"].as_str().ok_or("Invalid target")?);
    run(&root,None,&["-c","push.followTags=false","push","--recurse-submodules=no",remote,&reference])?;
    Ok(json!({"head":head(&root)?}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn staging_acknowledges_without_full_status_scans() {
        let f=Fixture::new("latency");
        f.write("fast.txt","first\n");
        let revision=status(&f.0).unwrap()["revision"].as_str().unwrap().to_string();
        COMMAND_COUNT.with(|count|count.set(0));
        let started=std::time::Instant::now();
        let result=stage(&f.0,&paths(&["fast.txt"]),&revision,false).unwrap();
        let commands=COMMAND_COUNT.with(|count|count.get());
        eprintln!("Stage acknowledgement: {} ms / {commands} Git processes",started.elapsed().as_millis());
        // Includes unborn HEAD fallback checks; no numstat/diff or post-operation status scan.
        assert!(commands<=21,"Unexpected staging overhead: {commands}");
        assert_eq!(result.as_object().unwrap().len(),1);
        assert_eq!(result["revision"],status(&f.0).unwrap()["revision"]);
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(name:&str)->Self {
            let root=std::env::temp_dir().join(format!("aurachat-git-test-{name}-{}-{}",std::process::id(),crate::data::now_millis()));
            std::fs::create_dir_all(&root).unwrap();
            run(&root,None,&["init","-b","main"]).unwrap();
            run(&root,None,&["config","user.name","Fixture"]).unwrap();
            run(&root,None,&["config","user.email","fixture@example.invalid"]).unwrap();
            run(&root,None,&["config","core.autocrlf","false"]).unwrap();
            Self(root)
        }
        fn write(&self,name:&str,text:&str){std::fs::write(self.0.join(name),text).unwrap();}
    }
    impl Drop for Fixture {fn drop(&mut self){std::fs::remove_dir_all(&self.0).unwrap();}}
    fn paths(names:&[&str])->Vec<String>{names.iter().map(|s|s.to_string()).collect()}
    fn stage_files(root:&Path,names:&[&str],unstage:bool) {
        let revision=status(root).unwrap()["revision"].as_str().unwrap().to_string();
        stage(root,&paths(names),&revision,unstage).unwrap();
    }
    fn commit_staged(root:&Path,message:&str) {
        let p=preview(root).unwrap();commit(root,p["revision"].as_str().unwrap(),message).unwrap();
    }

    #[test]
    fn staged_commit_preserves_unstaged_edits_and_rejects_changed_index() {
        let f=Fixture::new("selected");
        f.write("a.txt","old\n");f.write("b.txt","old\n");
        stage_files(&f.0,&["a.txt","b.txt"],false);commit_staged(&f.0,"Initial");
        f.write("a.txt","one\ntwo\n");f.write("b.txt","staged\n");
        stage_files(&f.0,&["b.txt"],false);
        let first=preview(&f.0).unwrap();
        assert!(!first["diff"].as_str().unwrap().contains("one"));
        assert!(first["diff"].as_str().unwrap().contains("staged"));
        stage_files(&f.0,&["a.txt"],false);
        assert!(commit(&f.0,first["revision"].as_str().unwrap(),"Stale").unwrap_err().contains("changed"));
        let fresh=preview(&f.0).unwrap();
        f.write("a.txt","changed\n");
        let status=status(&f.0).unwrap();
        let partial=status["files"].as_array().unwrap().iter().find(|f|f["path"]=="a.txt").unwrap();
        assert!(!partial["staged"].is_null());assert!(!partial["unstaged"].is_null());
        run(&f.0,None,&["checkout","-b","another"]).unwrap();
        assert!(commit(&f.0,fresh["revision"].as_str().unwrap(),"Wrong branch").is_err());
        run(&f.0,None,&["checkout","main"]).unwrap();
        commit(&f.0,fresh["revision"].as_str().unwrap(),"Staged only").unwrap();
        assert_eq!(run(&f.0,None,&["show","HEAD:a.txt"]).unwrap(),"one\ntwo\n");
        assert_eq!(std::fs::read_to_string(f.0.join("a.txt")).unwrap(),"changed\n");
        assert!(run(&f.0,None,&["diff","--cached","--name-only"]).unwrap().is_empty());
        let revision=super::status(&f.0).unwrap()["revision"].as_str().unwrap().to_string();
        assert!(stage(&f.0,&paths(&["../outside"]),&revision,false).is_err());
        std::fs::create_dir(f.0.join("sub")).unwrap();
        assert!(super::status(&f.0.join("sub")).unwrap_err().contains("root"));
    }

    #[test]
    fn stage_unstage_all_preserves_files_including_unborn_and_deleted() {
        let f=Fixture::new("stage");
        f.write("a.txt","a\n");f.write("b.txt","b\n");
        stage_files(&f.0,&["a.txt","b.txt"],false);
        assert!(status(&f.0).unwrap()["files"].as_array().unwrap().iter().all(|f|!f["staged"].is_null()));
        stage_files(&f.0,&["a.txt","b.txt"],true);
        assert!(preview(&f.0).is_err());
        assert_eq!(std::fs::read_to_string(f.0.join("a.txt")).unwrap(),"a\n");
        stage_files(&f.0,&["a.txt","b.txt"],false);commit_staged(&f.0,"Initial");
        std::fs::remove_file(f.0.join("b.txt")).unwrap();f.write("a.txt","new\n");
        let old=status(&f.0).unwrap()["revision"].as_str().unwrap().to_string();
        stage_files(&f.0,&["a.txt","b.txt"],false);
        assert!(stage(&f.0,&paths(&["a.txt"]),&old,true).is_err());
        stage_files(&f.0,&["a.txt","b.txt"],true);
        assert!(!f.0.join("b.txt").exists());
        assert_eq!(std::fs::read_to_string(f.0.join("a.txt")).unwrap(),"new\n");
        assert!(preview(&f.0).is_err());
    }

    #[test]
    fn statistics_include_untracked_deleted_binary_and_initial_files() {
        let f=Fixture::new("stats");
        f.write("a.txt","one\ntwo\n");f.write("delete.txt","gone\n");
        assert_eq!(status(&f.0).unwrap()["added"],3);
        stage_files(&f.0,&["a.txt","delete.txt"],false);commit_staged(&f.0,"Initial");
        f.write("a.txt","one\nthree\nfour\n");
        std::fs::remove_file(f.0.join("delete.txt")).unwrap();
        f.write("new file.txt","new\nlast");
        std::fs::write(f.0.join("binary.dat"),[0,1,2]).unwrap();
        let status=status(&f.0).unwrap();
        assert_eq!(status["added"],4);assert_eq!(status["removed"],2);
        assert!(status["files"].as_array().unwrap().iter().any(|f|f["binary"]==true));
        stage_files(&f.0,&["delete.txt","new file.txt","binary.dat"],false);
        commit_staged(&f.0,"Files");
    }

    #[test]
    fn push_uses_upstream_and_rejects_changed_head_or_destination() {
        let f=Fixture::new("push");let remote=Fixture::new("remote");
        let bare=remote.0.join("remote.git");
        run(&remote.0,None,&["init","--bare",bare.to_str().unwrap()]).unwrap();
        f.write("a.txt","first\n");
        stage_files(&f.0,&["a.txt"],false);commit_staged(&f.0,"Initial");
        assert!(push_preview(&f.0).is_err());
        run(&f.0,None,&["remote","add","origin",bare.to_str().unwrap()]).unwrap();
        run(&f.0,None,&["push","-u","origin","main"]).unwrap();
        let old=push_preview(&f.0).unwrap();
        f.write("a.txt","second\n");stage_files(&f.0,&["a.txt"],false);commit_staged(&f.0,"Second");
        assert!(push(&f.0,old["revision"].as_str().unwrap()).is_err());
        let target=push_preview(&f.0).unwrap();push(&f.0,target["revision"].as_str().unwrap()).unwrap();
        assert_eq!(status(&f.0).unwrap()["ahead"],0);
        assert_eq!(run(&remote.0,None,&["--git-dir",bare.to_str().unwrap(),"rev-parse","refs/heads/main"]).unwrap().trim(),head(&f.0).unwrap());
    }
}
