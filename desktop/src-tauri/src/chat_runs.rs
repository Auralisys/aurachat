use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::agent_runs::Cancellation;

struct Entry { owner: String, cancellation: Arc<Cancellation>, guidance: Arc<Guidance> }

#[derive(Default)]
struct Mailbox {
    closed: bool,
    accepted: usize,
    bytes: usize,
    /// Base64 image bytes of the turn: the request plus accepted guidance.
    images: usize,
    pending: Vec<PendingGuidance>,
    io: Option<Arc<Cancellation>>,
}

/// Accepted guidance the model has not read yet. Only these can be withdrawn.
pub struct PendingGuidance { pub id: String, pub message: crate::llm::ChatMessage }
impl PendingGuidance {
    /// `__steering` payload: the history message plus the id clients use to match it.
    pub fn event(&self) -> Result<String, String> {
        let mut value = serde_json::to_value(&self.message).map_err(|e|e.to_string())?;
        value["guidance_id"] = serde_json::json!(self.id);
        Ok(value.to_string())
    }
}

fn guidance_bytes(message: &crate::llm::ChatMessage) -> usize {
    message.content.len() + message.attachments.iter().map(|a|a.content.len()).sum::<usize>()
}

/// Guidance cancels root provider IO only; never a running tool or child agent.
#[derive(Default)]
pub struct Guidance(Mutex<Mailbox>);
impl Guidance {
    /// `accepted` runs under the mailbox lock, so its notice always precedes the `__steering` read.
    fn enqueue(&self, message: crate::llm::ChatMessage, accepted: impl FnOnce(&PendingGuidance)) -> Result<String, String> {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        crate::llm::validate_attachments(&message.attachments)?;
        let bytes = guidance_bytes(&message);
        let images = crate::llm::image_data_len(&message.attachments);
        if message.content.trim().is_empty() && message.attachments.is_empty() {return Err("empty_message".into());}
        let mut state = self.0.lock().unwrap();
        if state.closed {return Err("chat_not_running".into());}
        if state.accepted >= 16 || bytes > 65536 || state.bytes + bytes > 262144 {return Err("guidance_limit".into());}
        if state.images + images > crate::llm::MAX_IMAGES_DATA {return Err("image_too_large".into());}
        state.accepted += 1; state.bytes += bytes; state.images += images;
        let id = format!("guide-{}-{}", crate::data::now_millis(), SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        let item = PendingGuidance { id: id.clone(), message };
        accepted(&item);
        state.pending.push(item);
        if let Some(io) = &state.io {io.cancel();}
        Ok(id)
    }
    /// Takes back guidance the model has not read yet; read guidance stays in the turn.
    fn withdraw(&self, id: &str) -> Result<crate::llm::ChatMessage, String> {
        let mut state = self.0.lock().unwrap();
        let index = state.pending.iter().position(|item|item.id == id).ok_or("guidance_consumed")?;
        let item = state.pending.remove(index);
        state.accepted = state.accepted.saturating_sub(1);
        state.bytes = state.bytes.saturating_sub(guidance_bytes(&item.message));
        state.images = state.images.saturating_sub(crate::llm::image_data_len(&item.message.attachments));
        Ok(item.message)
    }
    pub fn pending(&self) -> bool { !self.0.lock().unwrap().pending.is_empty() }
    pub fn take(&self) -> Vec<PendingGuidance> {
        let mut state = self.0.lock().unwrap();state.io = None;std::mem::take(&mut state.pending)
    }
    pub fn begin_io(&self) -> Arc<Cancellation> {
        let mut state = self.0.lock().unwrap();
        let io = Arc::new(Cancellation::default());
        if !state.pending.is_empty() {io.cancel();}
        state.io = Some(io.clone());io
    }
    pub fn end_io(&self) {self.0.lock().unwrap().io = None;}
    /// Atomically choose completion or guidance. No accepted item can be lost.
    pub fn close_if_empty(&self) -> bool {
        let mut state = self.0.lock().unwrap();
        state.io = None;
        if !state.pending.is_empty() {return false;}
        state.closed = true;true
    }
    pub fn close(&self) {let mut state=self.0.lock().unwrap();state.closed=true;if let Some(io)=state.io.take(){io.cancel();}}
}

/// Turni in streaming, uno per conversazione: solo il proprietario può fermarli.
/// Il token è lo stesso usato dagli agenti, così lo stop interrompe l'attesa in corso.
#[derive(Default)]
pub struct ChatRuns(Mutex<HashMap<String, Entry>>);

impl ChatRuns {
    fn begin(&self, owner: &str, conversation: &str, images: usize) -> Arc<Cancellation> {
        let cancellation = Arc::new(Cancellation::default());
        let guidance = Arc::new(Guidance(Mutex::new(Mailbox { images, ..Default::default() })));
        self.0.lock().unwrap().insert(conversation.into(), Entry { owner: owner.into(), cancellation: cancellation.clone(), guidance });
        cancellation
    }
    pub fn stop(&self, owner: &str, conversation: &str) -> Result<(), String> {
        let entries = self.0.lock().unwrap();
        let entry = entries.get(conversation).filter(|e| e.owner == owner).ok_or("chat_not_running")?;
        entry.guidance.close();entry.cancellation.cancel(); Ok(())
    }
    pub fn steer(&self, owner:&str, conversation:&str, message:crate::llm::ChatMessage, accepted: impl FnOnce(&PendingGuidance))->Result<String,String> {
        let entries=self.0.lock().unwrap();
        let entry=entries.get(conversation).filter(|e|e.owner==owner).ok_or("chat_not_running")?;
        entry.guidance.enqueue(message, accepted)
    }
    /// A finished turn has already persisted its leftover guidance: nothing to withdraw.
    pub fn withdraw(&self, owner:&str, conversation:&str, id:&str)->Result<crate::llm::ChatMessage,String> {
        let entries=self.0.lock().unwrap();
        let entry=entries.get(conversation).filter(|e|e.owner==owner).ok_or("guidance_consumed")?;
        entry.guidance.withdraw(id)
    }
    fn finish(&self, conversation: &str) { self.0.lock().unwrap().remove(conversation); }
}

/// Registra il turno e lo rimuove a fine comando, anche quando il comando esce presto.
pub struct Turn<'a> { runs: &'a ChatRuns, conversation: String }

impl<'a> Turn<'a> {
    pub fn guidance(&self)->Arc<Guidance> {self.runs.0.lock().unwrap().get(&self.conversation).unwrap().guidance.clone()}
    /// `images`: base64 image bytes already in the request, so guidance cannot exceed the turn budget.
    pub fn start(runs: &'a ChatRuns, owner: &str, conversation: &str, images: usize) -> (Self, Arc<Cancellation>) {
        (Self { runs, conversation: conversation.into() }, runs.begin(owner, conversation, images))
    }
}

impl Drop for Turn<'_> {
    fn drop(&mut self) { self.runs.finish(&self.conversation); }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn only_the_owner_can_stop_the_streaming_turn() {
        let runs = ChatRuns::default();
        let (turn, cancellation) = Turn::start(&runs, "u", "c", 0);
        // Un altro account non puo fermare il turno e il token resta pulito.
        assert!(runs.stop("other", "c").is_err());
        assert!(!cancellation.is_cancelled());
        runs.stop("u", "c").unwrap();
        assert!(cancellation.is_cancelled());
        // A fine turno lo stop non ha piu un bersaglio.
        drop(turn);
        assert!(runs.stop("u", "c").is_err());
    }
    fn guide(text:&str)->crate::llm::ChatMessage {
        crate::llm::ChatMessage{role:"user".into(),content:text.into(),attachments:vec![],feedback:None,activity:vec![]}
    }
    #[test] fn unread_guidance_can_be_withdrawn_only_by_its_owner_and_only_once() {
        let runs = ChatRuns::default();
        let (turn, _) = Turn::start(&runs, "u", "c", 0);
        let guidance = turn.guidance();
        let io = guidance.begin_io();
        let mut notified = String::new();
        let first = runs.steer("u", "c", guide("first"), |item| notified = item.id.clone()).unwrap();
        assert_eq!(notified, first);
        // Accepting guidance still interrupts provider IO at once.
        assert!(io.is_cancelled());
        let second = runs.steer("u", "c", guide("second"), |_| {}).unwrap();
        assert_ne!(first, second);
        assert_eq!(runs.withdraw("other", "c", &first).unwrap_err(), "guidance_consumed");
        assert_eq!(runs.withdraw("u", "c", &first).unwrap().content, "first");
        assert_eq!(runs.withdraw("u", "c", &first).unwrap_err(), "guidance_consumed");
        let taken = guidance.take();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].id, second);
        let event: serde_json::Value = serde_json::from_str(&taken[0].event().unwrap()).unwrap();
        assert_eq!(event["guidance_id"], second.as_str());
        assert_eq!(event["content"], "second");
        // Read guidance is part of the turn: it can no longer be taken back.
        assert_eq!(runs.withdraw("u", "c", &second).unwrap_err(), "guidance_consumed");
        drop(turn);
        assert_eq!(runs.withdraw("u", "c", &second).unwrap_err(), "guidance_consumed");
    }
    #[test] fn withdrawn_guidance_frees_its_quota() {
        let guidance = Guidance::default();
        let ids: Vec<_> = (0..16).map(|index| guidance.enqueue(guide(&format!("g{index}")), |_| {}).unwrap()).collect();
        assert_eq!(guidance.enqueue(guide("over"), |_| {}).unwrap_err(), "guidance_limit");
        guidance.withdraw(&ids[3]).unwrap();
        guidance.enqueue(guide("replacement"), |_| {}).unwrap();
        assert!(guidance.take().iter().all(|item| item.message.content != "g3"));
    }
    #[test] fn guidance_images_share_the_turn_image_budget() {
        use base64::Engine as _;
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR\0\0\0\x02\0\0\0\x02".to_vec();png.extend_from_slice(&[8,6,0,0,0,0,0,0,0]);
        let data = base64::engine::general_purpose::STANDARD.encode(png);
        let image = || crate::llm::ChatMessage{role:"user".into(),content:String::new(),attachments:vec![crate::llm::Attachment::image("a.png","image/png",data.clone())],feedback:None,activity:vec![]};
        let runs = ChatRuns::default();
        let (_turn, _) = Turn::start(&runs, "u", "c", crate::llm::MAX_IMAGES_DATA - data.len() - 4);
        let first = runs.steer("u", "c", image(), |_| {}).unwrap();
        assert_eq!(runs.steer("u", "c", image(), |_| {}).unwrap_err(), "image_too_large");
        runs.withdraw("u", "c", &first).unwrap();
        runs.steer("u", "c", image(), |_| {}).unwrap();
    }
}
