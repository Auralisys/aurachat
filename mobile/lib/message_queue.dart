import 'composer_attachments.dart';

/// Session-only outbox. Never infer completion from a missing/stale heartbeat.
class QueuedDraft {
  QueuedDraft(this.id, this.text, [this.attachments = const []]);
  final String id;
  String text;
  final List<ComposerAttachment> attachments;
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

class PendingGuide {
  PendingGuide(this.id, this.text, this.turn, [this.attachments = const []]);
  final String id, text;
  final String? turn;
  /// Local copies: the live turn lists guidance text only.
  List<ComposerAttachment> attachments;
  bool seen = false, withdrawing = false;
}

/// Guidance accepted by the PC and not yet read by the model. The live turn is
/// the source of truth; local entries only bridge the gap until it lists them.
class PendingGuides {
  final items = <PendingGuide>[];
  final _withdrawn = <String>{};
  final _read = <String>{};
  String? _turn;
  bool running = false;

  void sync(Map<String, dynamic>? live) {
    running = live?['status'] == 'running';
    final turn = live?['turn_id'] as String?;
    if (turn != _turn) {
      _withdrawn.clear();
      _read.clear();
    }
    _turn = turn;
    if (!running) {
      items.clear();
      return;
    }
    final listed = <String, String>{};
    for (final item in (live?['guidance'] as List?) ?? const []) {
      if (item is Map && item['id'] is String) {
        listed[item['id'] as String] = item['content'] as String? ?? '';
      }
    }
    // Keep read IDs for the turn: send receipts and stale snapshots can lag.
    _read.addAll({
      for (final segment in (live?['segments'] as List?) ?? const [])
        if (segment is Map && segment['guidance_id'] is String)
          segment['guidance_id'] as String,
    });
    items.removeWhere(
      (guide) =>
          guide.turn != turn ||
          _read.contains(guide.id) ||
          guide.seen && !listed.containsKey(guide.id),
    );
    for (final MapEntry(key: id, value: text) in listed.entries) {
      if (_withdrawn.contains(id) || _read.contains(id)) continue;
      final known = items.where((guide) => guide.id == id).firstOrNull;
      if (known != null) {
        known.seen = true;
      } else {
        items.add(PendingGuide(id, text, turn)..seen = true);
      }
    }
  }

  void accepted(
    String id,
    String text, [
    List<ComposerAttachment> attachments = const [],
  ]) {
    if (!running || _withdrawn.contains(id) || _read.contains(id)) return;
    final known = items.where((g) => g.id == id).firstOrNull;
    if (known != null) {
      // The live turn can list the guide before its send receipt arrives.
      if (known.attachments.isEmpty) known.attachments = attachments;
      return;
    }
    items.add(PendingGuide(id, text, _turn, attachments));
  }

  void withdrawn(PendingGuide guide) {
    _withdrawn.add(guide.id);
    items.remove(guide);
  }
}
