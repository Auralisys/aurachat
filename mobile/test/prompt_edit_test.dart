import 'dart:convert';

import 'package:aurachat_mobile/app.dart';
import 'package:aurachat_mobile/chat_actions.dart';
import 'package:aurachat_mobile/companion.dart';
import 'package:aurachat_mobile/prompt_edit.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

typedef Json = Map<String, dynamic>;
const pc = 'users/u/devices/pc';
const chat = 'users/u/conversations/chat';
const source = '$chat/messages/m000000000002';
final history = <Json>[
  {'sequence': 0, 'role': 'user', 'content': 'Primo'},
  {'sequence': 1, 'role': 'assistant', 'content': 'Prima risposta'},
  {
    'sequence': 2,
    'role': 'user',
    'content': 'Secondo',
    'attachments': [
      {'name': 'note.txt', 'content': 'originale'},
      {
        'name': 'photo.png',
        'content': '',
        'data': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'mime_type': 'image/png',
        'id': 'img',
        'annotation': {
          'comments': [
            {'text': 'qui'},
          ],
        },
      },
    ],
  },
  {'sequence': 3, 'role': 'assistant', 'content': 'Risposta'},
  {'sequence': 4, 'role': 'user', 'content': 'Altro'},
  {'sequence': 5, 'role': 'assistant', 'content': 'Fine'},
];
final prompt = SavedPromptEdit(history, 2, 100);

void main() {
  testWidgets(
    'edit warns before sending; cancel keeps the original and the draft',
    (tester) async {
      final draft = TextEditingController(text: 'Bozza separata');
      addTearDown(draft.dispose);
      String? sent;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: Column(
                children: [
                  MessageView(
                    message: prompt.message,
                    onEdit: () async {
                      sent = await showDialog<String>(
                        context: context,
                        builder: (_) => EditPromptDialog(prompt: prompt),
                      );
                    },
                  ),
                  TextField(controller: draft),
                ],
              ),
            ),
          ),
        ),
      );
      Future<void> open() async {
        await tester.tap(find.byTooltip('Modifica messaggio'));
        await tester.pumpAndSettle();
      }

      final field = find.descendant(
        of: find.byType(EditPromptDialog),
        matching: find.byType(TextField),
      );
      await open();
      expect(tester.widget<TextField>(field).controller!.text, 'Secondo');
      expect(find.textContaining('3 messaggi successivi'), findsOneWidget);
      expect(find.text('Allegati mantenuti: 2'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      await tester.enterText(field, 'Nuovo');
      await tester.tap(find.text('Annulla'));
      await tester.pumpAndSettle();
      expect(sent, isNull);
      expect(draft.text, 'Bozza separata');
      await open();
      expect(tester.widget<TextField>(field).controller!.text, 'Secondo');
      await tester.enterText(field, 'Nuovo');
      await tester.pump();
      await tester.tap(find.text('Invia modifica'));
      await tester.pumpAndSettle();
      expect(sent, 'Nuovo');
      expect(prompt.text, 'Secondo');
      expect(draft.text, 'Bozza separata');
    },
  );

  test(
    'only saved, answered prompts at their stored sequence are eligible',
    () {
      expect(SavedPromptEdit.answered(history, 0), isTrue);
      expect(SavedPromptEdit.answered(history, 2), isTrue);
      for (final index in [-1, 1, 5, 6]) {
        expect(SavedPromptEdit.answered(history, index), isFalse);
      }
      expect(SavedPromptEdit.answered(history.take(3).toList(), 2), isFalse);
      expect(SavedPromptEdit.answered(history.sublist(2), 0), isFalse);
      expect(SavedPromptEdit(history, 0, 100).accepts('  '), isFalse);
      expect(prompt.accepts(''), isTrue); // Original attachments remain.
      expect(prompt.accepts('è' * 50001), isFalse);
    },
  );

  test(
    'one indexed chat request preserves chunked originals as ordered parts',
    () async {
      final db = _Store();
      final encoded = jsonEncode(history[2]);
      db.docs[source] = {'sequence': 2, 'chunked': true, 'part_count': 2};
      db.docs['$source/parts/p000000'] = {'data': encoded.substring(0, 45)};
      db.docs['$source/parts/p000001'] = {'data': encoded.substring(45)};
      final id = await Companion('u', firestore: db).send(
        'pc',
        'chat',
        'Modifica',
        edit: (prompt: prompt, current: () => true),
      );
      final req = db.writes['$pc/requests/$id']!;
      expect(req['action'], 'chat');
      expect(req['status'], 'pending');
      expect(req['edit_index'], 2);
      expect(req['new_conversation'], isFalse);
      expect(req['content'], 'Modifica');
      final parts = req['attachment_parts'] as List;
      expect([
        for (final part in parts)
          db.writes['$pc/requests/$part']!['attachment'],
      ], history[2]['attachments']);
      expect(db.writes.length, 3);
      expect(db.docs[source]!['chunked'], isTrue);
    },
  );

  test(
    'rejects stale targets, busy/unsupported PCs and a changed local lane without writes',
    () async {
      for (final change in <void Function(_Store)>[
        (db) => db.docs[chat]!['message_count'] = 7,
        (db) => db.docs[chat]!['updated_at'] = 101,
        (db) => db.docs[source] = {...history[2], 'role': 'assistant'},
        (db) => db.docs[source] = {...history[2], 'attachments': []},
        (db) => db.docs['$pc/live_turns/chat'] = {'status': 'running'},
        (db) => db.docs[pc]!['protocol'] = 9,
        (db) => db.docs[pc]!['remote_enabled'] = false,
        (db) => db.current = false,
      ]) {
        final db = _Store();
        change(db);
        await expectLater(
          Companion('u', firestore: db).send(
            'pc',
            'chat',
            'Modifica',
            edit: (prompt: prompt, current: () => db.current),
          ),
          throwsA(isA<EditUnavailable>()),
        );
        expect(db.writes, isEmpty);
      }
    },
  );

  test(
    'protocol 6 accepts text edits; older PCs and desktop-only files fail closed',
    () async {
      final db = _Store();
      final api = Companion('u', firestore: db);
      final first = SavedPromptEdit(history, 0, 100);
      db.docs['$chat/messages/m000000000000'] = history.first;
      Future<String> send(SavedPromptEdit value) => api.send(
        'pc',
        'chat',
        'Nuovo',
        edit: (prompt: value, current: () => true),
      );
      db.docs[pc]!['protocol'] = 5;
      await expectLater(send(first), throwsA(isA<EditUnavailable>()));
      db.docs[pc]!['protocol'] = 6;
      final id = await send(first);
      final request = db.writes['$pc/requests/$id']!;
      expect(request['edit_index'], 0);
      expect(request.containsKey('attachment_parts'), isFalse);
      db.docs[pc]!['protocol'] = 10;
      for (final file in [
        {'name': 'note', 'path': r'C:\local\note', 'content': ''},
        {'name': 'big.png', 'mime_type': 'image/png', 'data': 'A' * 1048576},
      ]) {
        final edited = [...history];
        edited[0] = {
          ...history[0],
          'attachments': [file],
        };
        await expectLater(
          send(SavedPromptEdit(edited, 0, 100)),
          throwsA(isA<EditUnavailable>()),
        );
      }
      expect(db.writes.length, 1);
    },
  );
}

// Only the transaction API is implemented. An accidental ordinary/queued
// write fails the test instead of silently simulating a successful edit.
class _Store extends Fake implements FirebaseFirestore {
  int sequence = 0;
  bool current = true;
  final docs = <String, Json>{
    pc: {
      'protocol': 10,
      'remote_enabled': true,
      'last_seen': DateTime.now().millisecondsSinceEpoch,
    },
    chat: {'updated_at': 100, 'message_count': history.length},
    source: history[2],
  };
  final writes = <String, Json>{};
  @override
  CollectionReference<Json> collection(String path) => _Collection(this, path);
  @override
  Future<T> runTransaction<T>(
    TransactionHandler<T> transactionHandler, {
    Duration timeout = const Duration(seconds: 30),
    int maxAttempts = 5,
  }) => transactionHandler(_Transaction(this));
}

// ignore: subtype_of_sealed_class
class _Collection extends Fake implements CollectionReference<Json> {
  _Collection(this.db, this.path);
  final _Store db;
  @override
  final String path;
  @override
  DocumentReference<Json> doc([String? path]) =>
      _Document(db, '${this.path}/${path ?? ++db.sequence}');
}

// ignore: subtype_of_sealed_class
class _Document extends Fake implements DocumentReference<Json> {
  _Document(this.db, this.path);
  final _Store db;
  @override
  final String path;
  @override
  String get id => path.split('/').last;
  @override
  CollectionReference<Json> collection(String collectionPath) =>
      _Collection(db, '$path/$collectionPath');
}

class _Transaction extends Fake implements Transaction {
  _Transaction(this.db);
  final _Store db;
  @override
  Future<DocumentSnapshot<T>> get<T>(DocumentReference<T> ref) async =>
      _Snapshot<T>(db.docs[ref.path] as T?);
  @override
  Transaction set<T>(DocumentReference<T> ref, T data, [SetOptions? options]) {
    db.writes[ref.path] = data as Json;
    return this;
  }
}

// ignore: subtype_of_sealed_class
class _Snapshot<T> extends Fake implements DocumentSnapshot<T> {
  _Snapshot(this.value);
  final T? value;
  @override
  T? data() => value;
}
