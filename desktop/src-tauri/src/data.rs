use crate::llm::ChatMessage;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Albero della cronologia: progetti con cartelle locali e conversazioni dirette.
/// È il contenuto del campo mappa `tree` del documento Firestore `users/{uid}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatData {
    pub projects: Vec<Project>,
    #[serde(default)]
    pub conversations: Vec<Conversation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "StoredProject")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub source_folders: Vec<String>,
    pub conversations: Vec<Conversation>,
}

#[derive(Deserialize)]
struct StoredProject {
    id: String,
    name: String,
    #[serde(default)]
    source_folders: Vec<String>,
    #[serde(default)]
    conversations: Vec<Conversation>,
    #[serde(default)]
    folders: Vec<LegacyFolder>,
}

#[derive(Deserialize)]
struct LegacyFolder {
    conversations: Vec<Conversation>,
}

impl From<StoredProject> for Project {
    fn from(stored: StoredProject) -> Self {
        let mut conversations = stored.conversations;
        for folder in stored.folders {
            conversations.extend(folder.conversations);
        }
        Self { id: stored.id, name: stored.name, source_folders: stored.source_folders, conversations }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    pub created_at: u64,
    pub updated_at: u64,
    pub context_tokens: u64,
    #[serde(default = "loaded")]
    pub messages_loaded: bool,
    #[serde(default)]
    pub revision: Option<String>,
}

fn loaded() -> bool { true }

impl Default for ChatData {
    fn default() -> Self {
        Self { projects: vec![], conversations: vec![] }
    }
}

impl ChatData {
    /// Rebase sidebar edits over answers that finished while the UI was saving.
    pub fn rebase(base: &Self, desired: &Self, current: &Self) -> Result<Self, String> {
        let metadata = crate::firestore::merge_changes(&base.storage_tree()?, &desired.storage_tree()?, &current.storage_tree()?)?;
        let mut merged = Self::from_storage(metadata)?;
        for conversation in merged.conversations_all().map(|c| c.id.clone()).collect::<Vec<_>>() {
            let current = current.find_conversation(&conversation);
            let desired = desired.find_conversation(&conversation);
            let before = base.find_conversation(&conversation);
            let changed_messages = match (before, desired) {
                (Some(b), Some(d)) if b.messages_loaded && d.messages_loaded => serde_json::to_value(&b.messages).ok() != serde_json::to_value(&d.messages).ok(),
                _ => false,
            };
            let source = if changed_messages {
                if before.and_then(|c| c.revision.as_ref()) != current.and_then(|c| c.revision.as_ref()) { return Err("conversation_conflict".into()); }
                desired
            } else { current.or(desired) };
            if let Some(source) = source {
                let target = merged.find_conversation_mut(&conversation).unwrap();
                target.messages = source.messages.clone();target.messages_loaded = source.messages_loaded;target.revision = source.revision.clone();
            }
        }
        Ok(merged)
    }
    pub fn conversations_all(&self) -> impl Iterator<Item = &Conversation> {
        self.conversations.iter().chain(self.projects.iter().flat_map(|p| p.conversations.iter()))
    }

    /// Storage projection: messages never belong to the user document.
    pub fn storage_tree(&self) -> Result<serde_json::Value, String> {
        use serde_json::json;
        let mut projects = serde_json::Map::new();
        let mut conversations = serde_json::Map::new();
        for p in &self.projects {
            valid_id(&p.id)?;
            if projects.insert(p.id.clone(), json!({"name":p.name,"source_folders":p.source_folders,
                "conversation_ids":p.conversations.iter().map(|c| &c.id).collect::<Vec<_>>()})).is_some() { return Err("duplicate_project_id".into()); }
        }
        for c in self.conversations_all() {
            valid_id(&c.id)?;
            if conversations.insert(c.id.clone(), json!({"title":c.title,"created_at":c.created_at,
                "updated_at":c.updated_at,"context_tokens":c.context_tokens})).is_some() { return Err("duplicate_conversation_id".into()); }
        }
        Ok(json!({"schema_version":2,"projects":projects,"project_order":self.projects.iter().map(|p| &p.id).collect::<Vec<_>>(),
            "conversations":conversations,"standalone_conversation_ids":self.conversations.iter().map(|c| &c.id).collect::<Vec<_>>()}))
    }

    pub fn from_storage(value: serde_json::Value) -> Result<Self, String> {
        use serde_json::Value;
        if value.get("schema_version").and_then(Value::as_u64) != Some(2) {
            return serde_json::from_value(value).map_err(|e| format!("parse tree: {e}"));
        }
        let refs = value["conversations"].as_object().ok_or("invalid_conversation_index")?;
        let chats = |ids: &Value| -> Result<Vec<Conversation>, String> {
            ids.as_array().ok_or("invalid_conversation_ids")?.iter().map(|id| {
                let id = id.as_str().ok_or("invalid_conversation_id")?;valid_id(id)?;
                let mut c = refs.get(id).ok_or("missing_conversation_reference")?.clone();
                let object = c.as_object_mut().ok_or("invalid_conversation_summary")?;
                object.insert("id".into(),serde_json::json!(id));object.insert("messages".into(),serde_json::json!([]));
                object.insert("messages_loaded".into(),serde_json::json!(false));
                serde_json::from_value(c).map_err(|e| e.to_string())
            }).collect()
        };
        let mut projects = Vec::new();
        for id in value["project_order"].as_array().ok_or("invalid_project_order")? {
            let id = id.as_str().ok_or("invalid_project_id")?;valid_id(id)?;
            let p = &value["projects"][id];
            projects.push(Project { id:id.into(),name:p["name"].as_str().ok_or("invalid_project_name")?.into(),
                source_folders:serde_json::from_value(p["source_folders"].clone()).map_err(|e|e.to_string())?,
                conversations:chats(&p["conversation_ids"])? });
        }
        let tree = Self { projects, conversations:chats(&value["standalone_conversation_ids"])? };
        if tree.storage_tree()? != value { return Err("invalid_tree_references".into()); }
        Ok(tree)
    }
    pub fn find_conversation(&self, id: &str) -> Option<&Conversation> {
        if let Some(conversation) = self.conversations.iter().find(|c| c.id == id) {
            return Some(conversation);
        }
        self.projects.iter().find_map(|p| p.conversations.iter().find(|c| c.id == id))
    }

    pub fn find_conversation_mut(&mut self, id: &str) -> Option<&mut Conversation> {
        if let Some(conversation) = self.conversations.iter_mut().find(|c| c.id == id) {
            return Some(conversation);
        }
        self.projects.iter_mut().find_map(|p| p.conversations.iter_mut().find(|c| c.id == id))
    }
}

pub fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 1500 || id.contains('/') || id == "." || id == ".." || (id.starts_with("__") && id.ends_with("__")) {
        return Err("invalid_document_id".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_folders_become_direct_chats_without_becoming_filesystem_grants() {
        let mut data: ChatData = serde_json::from_value(serde_json::json!({"projects":[{
            "id":"p", "name":"Project", "folders":[{"id":"f", "name":"Old group", "conversations":[{
                "id":"c", "title":"Saved", "messages":[], "created_at":1, "updated_at":2, "context_tokens":0
            }]}]
        }]})).unwrap();
        assert!(data.projects[0].source_folders.is_empty());
        assert_eq!(data.projects[0].conversations.len(), 1);
        data.find_conversation_mut("c").unwrap().title = "Kept".into();
        let saved = serde_json::to_value(&data).unwrap();
        assert!(saved["projects"][0].get("folders").is_none());
        let restored: ChatData = serde_json::from_value(saved).unwrap();
        assert_eq!(restored.find_conversation("c").unwrap().title, "Kept");
    }

    #[test]
    fn old_trees_and_standalone_chats_round_trip() {
        let mut data: ChatData = serde_json::from_str(r#"{"projects":[]}"#).unwrap();
        assert!(data.conversations.is_empty());
        data.conversations.push(Conversation {
            id: "personal".into(), title: "Chat".into(), messages: vec![],
            created_at: 0, updated_at: 0, context_tokens: 0,
            messages_loaded:true, revision:None,
        });
        data.find_conversation_mut("personal").unwrap().title = "Saved".into();
        let saved = serde_json::to_string(&data).unwrap();
        let loaded: ChatData = serde_json::from_str(&saved).unwrap();
        assert_eq!(loaded.find_conversation("personal").unwrap().title, "Saved");
    }

    #[test]
    fn v2_tree_contains_only_metadata_and_preserves_order_and_ids() {
        let full:ChatData=serde_json::from_value(serde_json::json!({"projects":[{"id":"p","name":"P","source_folders":["C:/work"],"conversations":[{
            "id":"c","title":"Chat","messages":[{"role":"user","content":"private message","attachments":[{"name":"a.txt","content":"private attachment"}],"feedback":true}],
            "created_at":1,"updated_at":2,"context_tokens":3}]}],"conversations":[]})).unwrap();
        let stored=full.storage_tree().unwrap();
        assert_eq!(stored["projects"]["p"]["conversation_ids"],serde_json::json!(["c"]));
        assert!(!stored.to_string().contains("private"));
        let restored=ChatData::from_storage(stored.clone()).unwrap();
        assert_eq!(restored.storage_tree().unwrap(),stored);
        assert!(restored.find_conversation("c").unwrap().messages.is_empty());
        assert!(!restored.find_conversation("c").unwrap().messages_loaded);
        let mut invalid=stored;invalid["standalone_conversation_ids"]=serde_json::json!(["c"]);
        assert!(ChatData::from_storage(invalid).is_err());
    }
}
