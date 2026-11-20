//! Files the user cites with `@` in the composer: a search over the folders the project may read,
//! and a read-only preview that never leaves them.
use std::{collections::VecDeque, io::Read, path::{Path, PathBuf}};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};

const SKIPPED: [&str; 11] = [".git", "node_modules", "target", "build", "dist", ".dart_tool", ".gradle", "Pods", ".next", ".venv", "__pycache__"];
const MAX_SCANNED: usize = 30_000;
const MAX_RESULTS: usize = 30;
const MAX_PREVIEW_TEXT: usize = 256 << 10;
const MAX_PREVIEW_IMAGE: usize = 5 << 20;

/// Files whose project-relative path contains every word of `query`, shallowest and best-named first.
/// The walk is breadth first, skips links and dependency/build folders, and stops after a fixed
/// number of files so a huge folder cannot stall the app.
pub fn search(roots: &[PathBuf], query: &str) -> Value {
    let words = query.split_whitespace().map(str::to_lowercase).collect::<Vec<_>>();
    let mut queue = roots.iter().map(|root| (root.clone(), root.clone())).collect::<VecDeque<_>>();
    let (mut found, mut scanned, mut truncated) = (Vec::new(), 0usize, false);
    'walk: while let Some((root, dir)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue; };
        let mut entries = entries.flatten().collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let Ok(kind) = entry.file_type() else { continue; };
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_dir() {
                if !SKIPPED.contains(&name.as_str()) { queue.push_back((root.clone(), entry.path())); }
                continue;
            }
            if !kind.is_file() { continue; }
            scanned += 1;
            if scanned > MAX_SCANNED { truncated = true; break 'walk; }
            let path = entry.path();
            let Some(shown) = path.to_str().map(str::to_string) else { continue; };
            let relative = path.strip_prefix(&root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            let lower = relative.to_lowercase();
            if !words.iter().all(|word| lower.contains(word.as_str())) { continue; }
            let file = name.to_lowercase();
            let rank = match words.first() {
                Some(first) if file.starts_with(first.as_str()) => 0,
                Some(first) if file.contains(first.as_str()) => 1,
                _ => 2,
            };
            let depth = relative.matches('/').count();
            found.push(((rank, depth, relative.len()), json!({"path":shown,"name":name,"relative":relative})));
            // Without a query the shallowest files are the answer: no need to read the whole tree.
            if words.is_empty() && found.len() >= MAX_RESULTS { break 'walk; }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    let more = found.len() > MAX_RESULTS;
    found.truncate(MAX_RESULTS);
    json!({"files":found.into_iter().map(|(_, file)| file).collect::<Vec<_>>(),"truncated":truncated || more})
}

/// A read-only view of a file inside one of `roots`. Symbolic links and `..` are resolved before the
/// containment check, so a path can never reach outside the folders the user authorized.
pub fn preview(roots: &[PathBuf], path: &str) -> Result<Value, String> {
    if !crate::llm::valid_link_path(path) { return Err("invalid_path".into()); }
    let target = Path::new(path).canonicalize().map_err(|_| "file_unavailable".to_string())?;
    if !roots.iter().filter_map(|root| root.canonicalize().ok()).any(|root| target.starts_with(root)) { return Err("outside_project".into()); }
    let size = std::fs::metadata(&target).map_err(|e| e.to_string()).and_then(|meta| if meta.is_file() { Ok(meta.len()) } else { Err("not_a_file".to_string()) })?;
    let mut bytes = Vec::new();
    std::fs::File::open(&target).map_err(|e| e.to_string())?.take(MAX_PREVIEW_IMAGE as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if let Some(mime) = crate::llm::image_mime(&bytes) {
        let data = BASE64.encode(&bytes);
        if bytes.len() <= MAX_PREVIEW_IMAGE && crate::llm::image_type(&data).is_ok() {
            return Ok(json!({"kind":"image","size":size,"mime_type":mime,"data":data}));
        }
        return Ok(json!({"kind":"binary","size":size}));
    }
    let truncated = bytes.len() > MAX_PREVIEW_TEXT;
    bytes.truncate(MAX_PREVIEW_TEXT);
    // A cut in the middle of a character is not an encoding error.
    let text = match String::from_utf8(bytes) {
        Ok(text) => Some(text),
        Err(error) if truncated && error.utf8_error().error_len().is_none() => {
            let valid = error.utf8_error().valid_up_to();
            Some(String::from_utf8_lossy(&error.as_bytes()[..valid]).into_owned())
        }
        Err(_) => None,
    };
    match text.filter(|text| !text.contains('\0')) {
        Some(text) => Ok(json!({"kind":"text","size":size,"content":text,"truncated":truncated})),
        None => Ok(json!({"kind":"binary","size":size})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aurachat-mentions-{name}-{}-{}", std::process::id(), crate::data::now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn search_ranks_by_name_and_skips_dependencies() {
        let root = fixture("search");
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("README.md"), "x").unwrap();
        std::fs::write(root.join("src/readme-notes.txt"), "x").unwrap();
        std::fs::write(root.join("src/deep/main.rs"), "x").unwrap();
        std::fs::write(root.join("node_modules/pkg/readme.md"), "x").unwrap();
        let found = search(&[root.clone()], "readme");
        let names = found["files"].as_array().unwrap().iter().map(|f| f["relative"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(names, ["README.md", "src/readme-notes.txt"]);
        assert!(Path::new(found["files"][0]["path"].as_str().unwrap()).is_absolute());
        let words = search(&[root.clone()], "src main");
        assert_eq!(words["files"].as_array().unwrap().len(), 1);
        assert_eq!(search(&[root.clone()], "")["files"].as_array().unwrap().len(), 3);
        assert!(search(&[root.clone()], "does-not-exist")["files"].as_array().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_stays_inside_the_authorized_roots() {
        let root = fixture("preview");
        let outside = fixture("outside");
        std::fs::write(root.join("note.txt"), "héllo").unwrap();
        std::fs::write(root.join("blob.bin"), [0u8, 159, 146, 150]).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        let note = root.join("note.txt");
        let shown = preview(&[root.clone()], note.to_str().unwrap()).unwrap();
        assert_eq!((shown["kind"].as_str(), shown["content"].as_str(), shown["truncated"].as_bool()), (Some("text"), Some("héllo"), Some(false)));
        assert_eq!(preview(&[root.clone()], root.join("blob.bin").to_str().unwrap()).unwrap()["kind"], "binary");
        assert_eq!(preview(&[root.clone()], outside.join("secret.txt").to_str().unwrap()), Err("outside_project".into()));
        let sneaky = root.join("..").join(outside.file_name().unwrap()).join("secret.txt");
        assert_eq!(preview(&[root.clone()], sneaky.to_str().unwrap()), Err("outside_project".into()));
        assert_eq!(preview(&[root.clone()], "relative.txt"), Err("invalid_path".into()));
        assert_eq!(preview(&[root.clone()], root.join("missing.txt").to_str().unwrap()), Err("file_unavailable".into()));
        assert_eq!(preview(&[root.clone()], root.to_str().unwrap()), Err("not_a_file".into()));
        std::fs::write(root.join("big.txt"), format!("a{}", "é".repeat(MAX_PREVIEW_TEXT))).unwrap();
        let big = preview(&[root.clone()], root.join("big.txt").to_str().unwrap()).unwrap();
        assert_eq!(big["truncated"], true);
        assert!(big["content"].as_str().unwrap().len() <= MAX_PREVIEW_TEXT);
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
}
