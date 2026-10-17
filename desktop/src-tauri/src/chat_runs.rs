use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::agent_runs::Cancellation;

struct Entry { owner: String, cancellation: Arc<Cancellation> }

/// Turni in streaming, uno per conversazione: solo il proprietario può fermarli.
/// Il token è lo stesso usato dagli agenti, così lo stop interrompe l'attesa in corso.
#[derive(Default)]
pub struct ChatRuns(Mutex<HashMap<String, Entry>>);

impl ChatRuns {
    fn begin(&self, owner: &str, conversation: &str) -> Arc<Cancellation> {
        let cancellation = Arc::new(Cancellation::default());
        self.0.lock().unwrap().insert(conversation.into(), Entry { owner: owner.into(), cancellation: cancellation.clone() });
        cancellation
    }
    pub fn stop(&self, owner: &str, conversation: &str) -> Result<(), String> {
        let entries = self.0.lock().unwrap();
        let entry = entries.get(conversation).filter(|e| e.owner == owner).ok_or("chat_not_running")?;
        entry.cancellation.cancel(); Ok(())
    }
    fn finish(&self, conversation: &str) { self.0.lock().unwrap().remove(conversation); }
}

/// Registra il turno e lo rimuove a fine comando, anche quando il comando esce presto.
pub struct Turn<'a> { runs: &'a ChatRuns, conversation: String }

impl<'a> Turn<'a> {
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
