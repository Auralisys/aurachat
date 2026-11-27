use std::{io::{Read, Write}, path::Path};
use sha2::{Digest, Sha256};

pub const MAX_SOURCE: usize = 128 << 20;
pub const TYPES: [&str; 6] = ["video/mp4","video/quicktime","video/webm","video/x-matroska","video/x-msvideo","video/ogg"];

pub fn mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => Some(TYPES[0]), "mov" => Some(TYPES[1]), "webm" => Some(TYPES[2]),
        "mkv" => Some(TYPES[3]), "avi" => Some(TYPES[4]), "ogv" => Some(TYPES[5]), _ => None,
    }
}

pub fn valid_id(id: &str) -> bool {
    id.len()==64 && id.bytes().all(|byte|byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn store(directory: &Path, bytes: &[u8]) -> Result<String,String> {
    if bytes.is_empty() {return Err("video_unreadable".into());}
    if bytes.len()>MAX_SOURCE {return Err("video_too_large".into());}
    std::fs::create_dir_all(directory).map_err(|e|e.to_string())?;
    let id=format!("{:x}",Sha256::digest(bytes));
    let path=directory.join(&id);
    if path.exists() {read(directory,&id)?;return Ok(id);}
    // Publish complete files only; concurrent picks of the same video share its content address.
    static NEXT:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
    let temporary=directory.join(format!("{}.{}.{}.part",id,std::process::id(),NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed)));
    let result=(|| {
        let mut file=std::fs::OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|e|e.to_string())?;
        file.write_all(bytes).and_then(|_|file.sync_all()).map_err(|e|e.to_string())?;
        drop(file);
        std::fs::rename(&temporary,&path).map_err(|e|e.to_string())?;
        Ok(id)
    })();
    if result.is_err() && temporary.exists() {
        if let Err(error)=std::fs::remove_file(&temporary) {eprintln!("Video temporary file cleanup failed: {error}");}
    }
    result
}

pub fn read(directory: &Path, id: &str) -> Result<Vec<u8>,String> {
    if !valid_id(id) {return Err("video_unavailable".into());}
    let path=directory.join(id);
    let metadata=std::fs::symlink_metadata(&path).map_err(|_|"video_unavailable")?;
    if !metadata.file_type().is_file() {return Err("video_unavailable".into());}
    if metadata.len()>MAX_SOURCE as u64 {return Err("video_too_large".into());}
    let mut bytes=Vec::new();
    std::fs::File::open(&path).map_err(|e|e.to_string())?.take(MAX_SOURCE as u64 + 1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
    if bytes.len()>MAX_SOURCE {return Err("video_too_large".into());}
    if format!("{:x}",Sha256::digest(&bytes))!=id {return Err("video_unavailable".into());}
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn originals_are_persistent_deduplicated_and_confined() {
        let root=std::env::temp_dir().join(format!("aurachat-video-{}-{}",std::process::id(),crate::data::now_millis()));
        let id=store(&root,b"video fixture").unwrap();
        assert_eq!(store(&root,b"video fixture").unwrap(),id);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(),1);
        assert_eq!(read(&root,&id).unwrap(),b"video fixture");
        for invalid in ["../outside","..\\outside","C:\\secret","https://example.com/video",""] {assert!(read(&root,invalid).is_err());}
        std::fs::write(root.join(&id),b"corrupt").unwrap();
        assert_eq!(read(&root,&id).unwrap_err(),"video_unavailable");
        std::fs::remove_file(root.join(id)).unwrap();std::fs::remove_dir(root).unwrap();
    }
}
