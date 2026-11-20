import 'dart:convert';

/// The saved turn the reader chose, not a row in the combined live/queue UI.
class SavedPromptEdit {
  const SavedPromptEdit(this.history, this.index, this.updatedAt);

  final List<Map<String, dynamic>> history;
  final int index, updatedAt;
  Map<String, dynamic> get message => history[index];
  String get text => message['content'] as String;
  int get subsequent => history.length - index - 1;
  bool get hasAttachments =>
      message['attachments'] is List &&
      (message['attachments'] as List).isNotEmpty;
  List<Map<String, dynamic>> get attachments => [
    for (final file in message['attachments'] as List? ?? const [])
      Map<String, dynamic>.from(file as Map),
  ];

  static const protocol = 6;

  static bool answered(List<Map<String, dynamic>> history, int index) =>
      index >= 0 &&
      index + 1 < history.length &&
      history[index]['role'] == 'user' &&
      history[index]['content'] is String &&
      history[index]['sequence'] == index &&
      history.skip(index + 1).any((m) => m['role'] == 'assistant');

  String? get attachmentProblem {
    final files = message['attachments'];
    if (files == null || files is List && files.isEmpty) return null;
    // The relay refuses desktop path links. Each other attachment must fit
    // intact in one Firestore part; never strip metadata or recompress history.
    if (files is! List ||
        files.length > 12 ||
        files.any(
          (f) =>
              f is! Map ||
              f['name'] is! String ||
              f['path'] != null ||
              utf8.encode(jsonEncode(f)).length > 1000000,
        )) {
      return 'Questi allegati non possono essere reinviati dal telefono. Modifica il messaggio sul PC.';
    }
    return null;
  }

  bool accepts(String replacement) =>
      replacement != text &&
      (replacement.trim().isNotEmpty || hasAttachments) &&
      utf8.encode(replacement).length <= 100000;

  bool matchesMetadata(Map<String, dynamic>? chat) =>
      chat?['updated_at'] == updatedAt &&
      chat?['message_count'] == history.length;

  bool matchesOriginal(Object? stored) => _sameValue(message, stored);
}

// Firestore maps have no key order, including nested image annotations.
bool _sameValue(Object? a, Object? b) {
  if (a is Map && b is Map) {
    return a.length == b.length &&
        a.keys.every((k) => b.containsKey(k) && _sameValue(a[k], b[k]));
  }
  if (a is List && b is List) {
    return a.length == b.length &&
        a.indexed.every((entry) => _sameValue(entry.$2, b[entry.$1]));
  }
  return a == b;
}

class EditUnavailable implements Exception {
  const EditUnavailable();
  static const message =
      'Modifica non inviata. Controlla la cronologia e lo stato del PC prima di riprovare.';
}
