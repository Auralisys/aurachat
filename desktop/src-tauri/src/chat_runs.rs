use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::agent_runs::Cancellation;

struct Entry { owner: String, cancellation: Arc<Cancellation>, guidance: Arc<Guidance> }

#[derive(Default)]
struct Mailbox {
    closed: bool,
    accepted: usize,
    bytes: usize,
    pending: Vec<crate::llm::ChatMessage>,
    io: Option<Arc<Cancellation>>,
}

/// Guidance cancels root provider IO only; never a running tool or child agent.
#[derive(Default)]
pub struct Guidance(Mutex<Mailbox>);
impl Guidance {
    fn enqueue(&self, message: crate::llm::ChatMessage) -> Result<(), String> {
        crate::llm::validate_attachments(&message.attachments)?;
        let bytes = message.content.len() + message.attachments.iter().map(|a|a.content.len()).sum::<usize>();
        if message.content.trim().is_empty() && message.attachments.is_empty() {return Err("empty_message".into());}
        let mut state = self.0.lock().unwrap();
        if state.closed {return Err("chat_not_running".into());}
        if state.accepted >= 16 || bytes > 65536 || state.bytes + bytes > 262144 {return Err("guidance_limit".into());}
        state.accepted += 1; state.bytes += bytes;
        state.pending.push(message);
        if let Some(io) = &state.io {io.cancel();}
        Ok(())
    }
    pub fn pending(&self) -> bool { !self.0.lock().unwrap().pending.is_empty() }
    pub fn take(&self) -> Vec<crate::llm::ChatMessage> {
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
    fn begin(&self, owner: &str, conversation: &str) -> Arc<Cancellation> {
        let cancellation = Arc::new(Cancellation::default());
        self.0.lock().unwrap().insert(conversation.into(), Entry { owner: owner.into(), cancellation: cancellation.clone(), guidance: Arc::new(Guidance::default()) });
        cancellation
    }
    pub fn stop(&self, owner: &str, conversation: &str) -> Result<(), String> {
        let entries = self.0.lock().unwrap();
        let entry = entries.get(conversation).filter(|e| e.owner == owner).ok_or("chat_not_running")?;
        entry.guidance.close();entry.cancellation.cancel(); Ok(())
    }
    pub fn steer(&self, owner:&str, conversation:&str, message:crate::llm::ChatMessage)->Result<(),String> {
        let entries=self.0.lock().unwrap();
        let entry=entries.get(conversation).filter(|e|e.owner==owner).ok_or("chat_not_running")?;
        entry.guidance.enqueue(message)
    }
    fn finish(&self, conversation: &str) { self.0.lock().unwrap().remove(conversation); }
}

/// Registra il turno e lo rimuove a fine comando, anche quando il comando esce presto.
pub struct Turn<'a> { runs: &'a ChatRuns, conversation: String }

impl<'a> Turn<'a> {
    pub fn guidance(&self)->Arc<Guidance> {self.runs.0.lock().unwrap().get(&self.conversation).unwrap().guidance.clone()}
    pub fn start(runs: &'a ChatRuns, owner: &str, conversation: &str) -> (Self, Arc<Cancellation>) {
        (Self { runs, conversation: conversation.into() }, runs.begin(owner, conversation))
    }
}

impl Drop for Turn<'_> {
    fn drop(&mut self) { self.runs.finish(&self.conversation); }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn only_the_owner_can_stop_the_streaming_turn() {
        let runs = ChatRuns::default();
        let (turn, cancellation) = Turn::start(&runs, "u", "c");
        // Un altro account non puo fermare il turno e il token resta pulito.
        assert!(runs.stop("other", "c").is_err());
        assert!(!cancellation.is_cancelled());
        runs.stop("u", "c").unwrap();
        assert!(cancellation.is_cancelled());
        // A fine turno lo stop non ha piu un bersaglio.
        drop(turn);
        assert!(runs.stop("u", "c").is_err());
    }
}
