use crate::data::ChatData;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

/// Local, read-only consent. Cloud project paths never grant device access.
#[derive(Default, Serialize, Deserialize)]
pub struct FolderAccess(BTreeMap<String, BTreeMap<String, Vec<String>>>);

impl FolderAccess {
    pub fn load(dir: &Path) -> Result<Self, String> {
        match std::fs::read(dir.join("folder-permissions.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("folder permissions: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(format!("folder permissions: {e}")),
        }
    }
    pub fn save(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let temporary = dir.join("folder-permissions.tmp");
        std::fs::write(&temporary, serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(temporary, dir.join("folder-permissions.json")).map_err(|e| e.to_string())
    }
    pub fn paths(&self, uid: &str, project: &str) -> Vec<String> {
        self.0.get(uid).and_then(|p| p.get(project)).cloned().unwrap_or_default()
    }
    pub fn grant(&mut self, uid: &str, project: &str, path: String) {
        let paths = self.0.entry(uid.into()).or_default().entry(project.into()).or_default();
        if !paths.contains(&path) { paths.push(path); }
    }
    pub fn retain_linked(&mut self, uid: &str, tree: &ChatData) {
        if let Some(projects) = self.0.get_mut(uid) {
            projects.retain(|id, paths| {
                if let Some(project) = tree.projects.iter().find(|p| &p.id == id) {
                    paths.retain(|path| project.source_folders.contains(path));
                    !paths.is_empty()
                } else { false }
            });
        }
    }
    pub fn validate_links(&self, uid: &str, old: &ChatData, new: &ChatData) -> Result<(), String> {
        for project in &new.projects {
            let previous = old.projects.iter().find(|p| p.id == project.id);
            let grants = self.paths(uid, &project.id);
            for path in &project.source_folders {
                if !previous.is_some_and(|p| p.source_folders.contains(path)) && !grants.contains(path) {
                    return Err("folder_permission_required".into());
                }
            }
        }
        Ok(())
    }
}

pub fn canonical_folder(path: &Path) -> Result<String, String> {
    let path = path.canonicalize().map_err(|e| format!("folder unavailable: {e}"))?;
    if !path.is_dir() { return Err("not a directory".into()); }
    let value = path.to_str().ok_or("unsupported folder path")?;
    Ok(if let Some(unc) = value.strip_prefix(r"\\?\UNC\") { format!(r"\\{unc}") }
        else { value.strip_prefix(r"\\?\").unwrap_or(value).to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::Project;
    #[test]
    fn consent_survives_restart_and_invalid_stores_fail_closed() {
        let dir = std::env::temp_dir().join(format!("aurachat-folder-access-{}-{}", std::process::id(), crate::data::now_millis()));
        std::fs::create_dir(&dir).unwrap();
        let mut grants = FolderAccess::load(&dir).unwrap();
        let path = canonical_folder(&dir).unwrap();
        grants.grant("u", "p", path.clone());
        grants.save(&dir).unwrap();
        assert_eq!(FolderAccess::load(&dir).unwrap().paths("u", "p"), vec![path]);
        assert!(canonical_folder(&dir.join("folder-permissions.json")).is_err());
        std::fs::write(dir.join("folder-permissions.json"), "invalid").unwrap();
        assert!(FolderAccess::load(&dir).is_err());
        std::fs::remove_file(dir.join("folder-permissions.json")).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn grants_are_local_account_and_project_scoped_and_revocable() {
        let mut grants = FolderAccess::default();
        grants.grant("u", "p", "C:/work".into());
        grants.grant("u", "p", "C:/work".into());
        assert_eq!(grants.paths("u", "p").len(), 1);
        assert!(grants.paths("other", "p").is_empty());
        assert!(grants.paths("u", "other").is_empty());
        let tree = ChatData { projects: vec![Project { id: "p".into(), name: "Work".into(), source_folders: vec!["C:/work".into()], source_folders_by_device: Default::default(), legacy_source_folders: None, conversations: vec![] }], conversations: vec![] };
        assert!(grants.validate_links("u", &ChatData::default(), &tree).is_ok());
        assert!(grants.validate_links("other", &ChatData::default(), &tree).is_err());
        let restored: FolderAccess = serde_json::from_slice(&serde_json::to_vec(&grants).unwrap()).unwrap();
        assert_eq!(restored.paths("u", "p"), grants.paths("u", "p"));
        grants.retain_linked("u", &ChatData::default());
        assert!(grants.paths("u", "p").is_empty());
    }
}
