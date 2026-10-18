/// Session-only outbox. Never infer completion from a missing/stale heartbeat.
class QueuedDraft {
  QueuedDraft(this.id, this.text);
  final String id;
  String text;
}

class ConversationQueue {
  ConversationQueue(this.device, this.conversation, this.project);
  final String device, conversation;
  final String? project;
  final drafts = <QueuedDraft>[];
  String? waitingRequest, waitingTurn, paused;
  bool completed = false, liveKnown = false, running = false;
  QueuedDraft? operation;
  bool steering = false;

  /// A draft can move when this lane is not sending and its target turn is
  /// idle. `completed` is informational: a lane queued while another chat was
  /// running must still flush once that chat finishes.
  bool get canFlush =>
      drafts.isNotEmpty && operation == null && paused == null && !running;

  void observeLive(Map<String, dynamic>? live) {
    liveKnown = true;
    running = live?['status'] == 'running';
    final turn = live?['turn_id'];
    if (turn is! String || turn.isEmpty) return;
    if (running) waitingTurn ??= turn;
    if (turn != waitingTurn) return;
    if (['completed', 'cancelled', 'stopped'].contains(live?['status'])) {
      // The turn ended: the queue continues in FIFO order, as after a normal
      // completion. A stop does not discard messages the user already wrote.
      completed = true;
      waitingTurn = null;
    }
    if (live?['status'] == 'failed') {
      operation = null;
      steering = false;
      paused = 'Turno non riuscito. Controlla la chat prima di inviare la coda.';
    }
  }

  bool begin(QueuedDraft draft, {bool asGuide = false}) {
    if (operation != null || !drafts.contains(draft)) return false;
    if (!asGuide && (!canFlush || drafts.first != draft)) return false;
    operation = draft;
    steering = asGuide;
    if (!asGuide) {
      completed = false;
      waitingRequest = null;
      waitingTurn = null;
    }
    return true;
  }

  void observeRequest(String id, String? status) {
    if (id != waitingRequest) return;
    if (status == 'completed') {
      if (operation != null && !steering) drafts.remove(operation);
      operation = null;
      completed = true;
      waitingRequest = null;
    } else if (['failed', 'cancelled'].contains(status)) {
      operation = null;
      waitingRequest = null;
      paused = 'Richiesta non completata. Controlla la chat prima di riprovare.';
    }
  }

  void finishGuide(QueuedDraft draft, {required bool accepted}) {
    if (operation != draft || !steering) return;
    if (accepted) drafts.remove(draft);
    operation = null;
    steering = false;
    if (!accepted) paused = 'Guida non accettata. Il messaggio resta in coda.';
  }

  bool edit(QueuedDraft draft, String text) {
    if (operation != null || !drafts.contains(draft) || text.trim().isEmpty) return false;
    draft.text = text.trim();
    return true;
  }

  bool remove(QueuedDraft draft) => operation == null && drafts.remove(draft);
}
