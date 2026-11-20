//! The `create_chat` tool: the model opens another chat in the same project and
//! starts it with a first message. A linked chat also remembers its parent
//! (`Conversation.linked_from`); the handoff text travels in memory and is never
//! saved as a file.
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::{agent_runs::Runtime, data::{self, ChatData, Conversation}, llm::ChatMessage, AppState};

pub const MAX_PER_TURN: usize = 3;
const MAX_TITLE_CHARS: usize = 80;
const MAX_MESSAGE_BYTES: usize = 100_000;

pub fn definition() -> Value {
    json!({"type":"function","function":{
        "name":"create_chat",
        "description":"Open a new chat in the same project (or without a project when this chat has none) and start it with a first message. Use ONLY when the user explicitly asks for a new chat, an independent chat, a chat linked to this one, or a handoff into a new chat. The new chat cannot see this conversation, so `message` must be self-contained. Set linked=true only when the user asks for a linked or dependent chat: it is then shown as linked to this one. Does not wait for the new chat to finish. Maximum three per turn.",
        "parameters":{"type":"object","properties":{
            "title":{"type":"string","description":"Short title of the new chat"},
            "message":{"type":"string","description":"First message sent to the new chat, with all the context it needs"},
            "linked":{"type":"boolean","description":"True when the new chat depends on this one (default false)"}
        },"required":["title","message"],"additionalProperties":false}
    }})
}

#[derive(Debug, PartialEq)]
pub struct Request { pub title: String, pub message: String, pub linked: bool }

pub fn parse(arguments: &Value) -> Result<Request, String> {
    let title = arguments["title"].as_str().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    let message = arguments["message"].as_str().unwrap_or("").trim().to_string();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS || title.chars().any(char::is_control)
        || message.is_empty() || message.len() > MAX_MESSAGE_BYTES {
        return Err("Provide a short title and a non-empty message (maximum 100000 characters).".into());
    }
    Ok(Request { title, message, linked: arguments["linked"].as_bool().unwrap_or(false) })
}

fn new_id() -> String {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!("chat-{}-{}", data::now_millis(), SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

/// Adds `child` next to `parent`: same project, or the free chats.
fn place(tree: &mut ChatData, parent: &str, child: Conversation) -> Result<(), String> {
    if let Some(project) = tree.projects.iter_mut().find(|p| p.conversations.iter().any(|c| c.id == parent)) {
        project.conversations.push(child);
    } else if tree.conversations.iter().any(|c| c.id == parent) {
        tree.conversations.push(child);
    } else {
        return Err("conversation_not_found".into());
    }
    Ok(())
}

fn conversation(id: &str, parent: &Conversation, request: &Request) -> Conversation {
    let now = data::now_millis();
    Conversation {
        id: id.into(), title: request.title.clone(), title_state: Some("manual".into()), model: parent.model.clone(),
        linked_from: request.linked.then(|| parent.id.clone()), messages: vec![], created_at: now, updated_at: now,
        context_tokens: 0, messages_loaded: true, revision: None, usage: Default::default(),
    }
}

pub async fn create(runtime: &Runtime, arguments: &Value) -> Result<Value, String> {
    let request = parse(arguments)?;
    let app = runtime.app.clone();
    let state = app.state::<AppState>();
    let id = new_id();
    {
        let _save = state.history_save_lock.lock().await;
        let auth = crate::firebase_auth(&state)?;
        if state.firestore.uid().as_deref() != Some(runtime.owner.as_str()) { return Err("login_required".into()); }
        let mut tree = state.data.lock().unwrap().clone();
        let parent = tree.find_conversation(&runtime.conversation).ok_or("conversation_not_found")?.clone();
        place(&mut tree, &runtime.conversation, conversation(&id, &parent, &request))?;
        state.firestore.save_tree(&runtime.owner, &auth, &tree).await?;
        *state.data.lock().unwrap() = state.firestore.cached_tree(&runtime.owner).unwrap_or(tree);
    }
    // The first turn of a created chat cannot create more chats.
    state.spawned_chats.lock().unwrap().insert(id.clone());
    let message = ChatMessage { role: "user".into(), content: request.message.clone(), attachments: vec![], feedback: None,
        activity: vec![], created_at: Some(data::now_millis()), pastes: vec![] };
    let _ = app.emit("companion-started", json!({"conversation_id": id, "content": request.message, "message": message, "keep_count": 0}));
    start(app, runtime.owner.clone(), id.clone(), request.message);
    Ok(json!({"chat_id": id, "title": request.title, "linked": request.linked, "status": "started"}))
}

/// Runs the first turn of the created chat in the background and tells the UI when it ends.
fn start(app: tauri::AppHandle, owner: String, id: String, message: String) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let result = crate::run_chat(app.clone(), state, id.clone(), message, None, vec![], Some(false), None, Some(owner)).await;
        if let Err(error) = result { eprintln!("Created chat failed: {error}"); }
        app.state::<AppState>().spawned_chats.lock().unwrap().remove(&id);
        let _ = app.emit("companion-updated", json!({"conversation_id": id}));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree_with(parent: &str, in_project: bool) -> ChatData {
        let chat = json!({"id":parent,"title":"Parent","model":"m","created_at":1,"updated_at":1,"context_tokens":0});
        serde_json::from_value(if in_project {
            json!({"projects":[{"id":"p","name":"P","source_folders":[],"conversations":[chat]}],"conversations":[]})
        } else {
            json!({"projects":[],"conversations":[chat]})
        }).unwrap()
    }

    #[test]
    fn arguments_are_validated_and_normalised() {
        let ok = parse(&json!({"title":"  Fix\n  login ","message":" Continue ","linked":true})).unwrap();
        assert_eq!(ok, Request { title: "Fix login".into(), message: "Continue".into(), linked: true });
        assert!(!parse(&json!({"title":"A","message":"B"})).unwrap().linked);
        for bad in [json!({}), json!({"title":"","message":"x"}), json!({"title":"x","message":"  "}),
            json!({"title":"x".repeat(81),"message":"x"}), json!({"title":"a\u{7}b","message":"x"}),
            json!({"title":"x","message":"y".repeat(100_001)})] {
            assert!(parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_created_chat_joins_the_project_of_its_parent() {
        let request = parse(&json!({"title":"Next","message":"go","linked":true})).unwrap();
        for in_project in [true, false] {
            let mut tree = tree_with("a", in_project);
            let parent = tree.find_conversation("a").unwrap().clone();
            place(&mut tree, "a", conversation("b", &parent, &request)).unwrap();
            let child = tree.find_conversation("b").unwrap();
            assert_eq!((child.linked_from.as_deref(), child.model.as_deref(), child.title_state.as_deref()), (Some("a"), Some("m"), Some("manual")));
            assert_eq!(tree.projects.iter().map(|p| p.conversations.len()).sum::<usize>() > 0, in_project);
            assert_eq!(tree.conversations.len() == 2, !in_project);
        }
        let parent = tree_with("a", false).conversations.remove(0);
        assert!(place(&mut tree_with("a", false), "missing", conversation("b", &parent, &request)).is_err());
    }

    #[test]
    fn an_independent_chat_keeps_no_link_and_ids_are_valid_and_unique() {
        let request = parse(&json!({"title":"Next","message":"go"})).unwrap();
        let parent = tree_with("a", false).conversations.remove(0);
        assert_eq!(conversation("b", &parent, &request).linked_from, None);
        let (first, second) = (new_id(), new_id());
        assert_ne!(first, second);
        data::valid_id(&first).unwrap();
    }
}
