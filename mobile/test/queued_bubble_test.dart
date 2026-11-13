import 'package:aurachat_mobile/composer_attachments.dart';
import 'package:aurachat_mobile/message_queue.dart';
import 'package:aurachat_mobile/queued_bubble.dart';
import 'package:aurachat_mobile/ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('queued bubble exposes send-now, edit and delete', (
    tester,
  ) async {
    var sentNow = 0, edited = 0, deleted = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: auraTheme(),
        home: Scaffold(
          body: QueuedMessageBubble(
            text: 'Messaggio in attesa',
            status: 'In coda',
            onSendNow: () => sentNow++,
            onEdit: () => edited++,
            onDelete: () => deleted++,
          ),
        ),
      ),
    );
    expect(find.text('In coda'), findsOneWidget);
    expect(find.text('Messaggio in attesa'), findsOneWidget);
    await tester.tap(find.byTooltip('Azioni messaggio in coda'));
    await tester.pumpAndSettle();
    expect(find.text('Invia subito'), findsOneWidget);
    expect(find.text('Modifica'), findsOneWidget);
    expect(find.text('Cancella'), findsOneWidget);
    await tester.tap(find.text('Invia subito'));
    await tester.pumpAndSettle();
    expect(sentNow, 1);
    await tester.tap(find.byTooltip('Azioni messaggio in coda'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Modifica'));
    await tester.pumpAndSettle();
    expect(edited, 1);
    await tester.tap(find.byTooltip('Azioni messaggio in coda'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancella'));
    await tester.pumpAndSettle();
    expect(deleted, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('locked queued bubble keeps its menu disabled', (tester) async {
    var actions = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: auraTheme(),
        home: Scaffold(
          body: QueuedMessageBubble(
            text: 'In invio',
            status: 'Invio…',
            locked: true,
            onSendNow: () => actions++,
            onEdit: () => actions++,
            onDelete: () => actions++,
          ),
        ),
      ),
    );
    await tester.tap(find.byTooltip('Azioni messaggio in coda'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Invia subito'));
    await tester.pumpAndSettle();
    expect(actions, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('queued bubble paints its outline without clipping long text', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: auraTheme(),
        home: Scaffold(
          body: SingleChildScrollView(
            child: SizedBox(
              width: 320,
              child: QueuedMessageBubble(
                text: 'Messaggio lungo con accenti àèì e emoji 🐕. ' * 8,
                status: 'In coda',
              ),
            ),
          ),
        ),
      ),
    );
    final outline = find.descendant(
      of: find.byType(QueuedMessageBubble),
      matching: find.byWidgetPredicate(
        (widget) => widget is CustomPaint && widget.foregroundPainter != null,
      ),
    );
    expect(outline, findsOneWidget);
    expect(tester.getSize(outline).width, lessThanOrEqualTo(320 * .88));
    expect(tester.takeException(), isNull);
  });

  test(
    'queue flushes after its turn ends, even if queued during another chat',
    () {
      final lane = ConversationQueue('d', 'c', null);
      lane.drafts.add(QueuedDraft('1', 'ciao'));
      expect(lane.canFlush, isTrue);
      lane.observeLive({'status': 'running', 'turn_id': 't1'});
      expect(lane.canFlush, isFalse);
      lane.observeLive({'status': 'completed', 'turn_id': 't1'});
      expect(lane.canFlush, isTrue);
      lane.observeLive({'status': 'running', 'turn_id': 't2'});
      lane.observeLive({'status': 'cancelled', 'turn_id': 't2'});
      expect(lane.canFlush, isTrue);
      lane.observeLive({'status': 'running', 'turn_id': 't3'});
      lane.observeLive({'status': 'failed', 'turn_id': 't3'});
      expect(lane.canFlush, isFalse);
      expect(lane.paused, isNotNull);
      expect(lane.operation, isNull);
    },
  );

  test('pending guides stay until read, withdrawn or the turn ends', () {
    final guides = PendingGuides();
    Map<String, dynamic> live(
      List<Map<String, String>> guidance, {
      String status = 'running',
      String turn = 't1',
      List<Map<String, String>> segments = const [],
    }) => {
      'status': status,
      'turn_id': turn,
      'guidance': guidance,
      'segments': segments,
    };
    guides.sync(live([]));
    guides.accepted('g1', 'Prima');
    expect(guides.items.map((g) => g.id), ['g1']);
    // Not listed yet: the local receipt bridges until the live turn catches up.
    guides.sync(live([]));
    expect(guides.items.single.seen, isFalse);
    guides.sync(
      live([
        {'id': 'g1', 'content': 'Prima'},
        {'id': 'g2', 'content': 'Dal PC'},
      ]),
    );
    expect(guides.items.map((g) => g.text), ['Prima', 'Dal PC']);
    expect(guides.items.every((g) => g.seen), isTrue);
    guides.withdrawn(guides.items.last);
    // A stale snapshot cannot resurrect a withdrawn guide.
    guides.sync(
      live([
        {'id': 'g1', 'content': 'Prima'},
        {'id': 'g2', 'content': 'Dal PC'},
      ]),
    );
    expect(guides.items.map((g) => g.id), ['g1']);
    guides.sync(live([]));
    expect(guides.items, isEmpty);
    guides.accepted('g3', 'Letta subito');
    guides.sync(
      live(
        [],
        segments: [
          {'role': 'user', 'content': 'Letta subito', 'guidance_id': 'g3'},
        ],
      ),
    );
    expect(guides.items, isEmpty);
    guides.accepted('g4', 'Fine turno');
    guides.sync(live([], status: 'completed'));
    expect(guides.items, isEmpty);
    expect(guides.running, isFalse);
    guides.accepted('g5', 'Ignorata');
    expect(guides.items, isEmpty);
  });

  test('a late send receipt cannot restore a guide already read in live', () {
    final guides = PendingGuides()
      ..sync({
        'status': 'running',
        'turn_id': 't1',
        'guidance': [],
        'segments': [
          {'role': 'user', 'content': 'Usa la cache', 'guidance_id': 'g1'},
        ],
      })
      ..accepted('g1', 'Usa la cache');
    expect(guides.items, isEmpty);
    expect(guides.running, isTrue);

    guides.accepted('g2', 'Guida non ancora letta');
    expect(guides.items.map((g) => g.id), ['g2']);
  });

  test('read guides stay resolved across stale snapshots of the same turn', () {
    final guides = PendingGuides()
      ..sync({'status': 'running', 'turn_id': 't1'})
      ..accepted('g1', 'Usa la cache');
    expect(guides.items.single.id, 'g1');

    guides.sync({
      'status': 'running',
      'turn_id': 't1',
      'guidance': [
        {'id': 'g1', 'content': 'Usa la cache'},
      ],
      'segments': [
        {'role': 'user', 'content': 'Usa la cache', 'guidance_id': 'g1'},
      ],
    });
    expect(guides.items, isEmpty);

    guides
      ..sync({
        'status': 'running',
        'turn_id': 't1',
        'guidance': [
          {'id': 'g1', 'content': 'Usa la cache'},
        ],
        'segments': [],
      })
      ..accepted('g1', 'Usa la cache');
    expect(guides.items, isEmpty);

    guides
      ..sync({'status': 'completed', 'turn_id': 't1'})
      ..accepted('g1', 'Usa la cache');
    expect(guides.items, isEmpty);
    guides
      ..sync({'status': 'running', 'turn_id': 't2'})
      ..accepted('g2', 'Nuovo turno');
    expect(guides.items.single.turn, 't2');
  });

  testWidgets('pending guide bubble offers edit and cancel-send only', (
    tester,
  ) async {
    var cancelled = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: auraTheme(),
        home: Scaffold(
          body: QueuedMessageBubble(
            text: 'Usa la cache',
            status: 'Guida · in attesa',
            sendNowAction: false,
            deleteLabel: 'Annulla invio',
            onEdit: () {},
            onDelete: () => cancelled++,
          ),
        ),
      ),
    );
    await tester.tap(find.byTooltip('Azioni messaggio in coda'));
    await tester.pumpAndSettle();
    expect(find.text('Invia subito'), findsNothing);
    expect(find.text('Modifica'), findsOneWidget);
    await tester.tap(find.text('Annulla invio'));
    await tester.pumpAndSettle();
    expect(cancelled, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('attachments-only draft shows its file without an empty bubble', (
    tester,
  ) async {
    Future<void> render(String text) => tester.pumpWidget(
      MaterialApp(
        theme: auraTheme(),
        home: Scaffold(
          body: QueuedMessageBubble(
            text: text,
            status: 'In coda',
            attachments: const [
              {'name': 'note.md', 'content': '# Titolo\nRiga'},
            ],
          ),
        ),
      ),
    );
    final textBubble = find.byWidgetPredicate(
      (widget) =>
          widget is Container &&
          widget.decoration is BoxDecoration &&
          (widget.decoration! as BoxDecoration).color == bubble,
    );
    await render('Leggi la nota');
    expect(textBubble, findsOneWidget);
    await render('');
    expect(textBubble, findsNothing);
    expect(find.text('note.md'), findsOneWidget);
    expect(find.text('13 B · 2 righe'), findsOneWidget);
    await tester.tap(find.text('note.md'));
    await tester.pumpAndSettle();
    expect(find.text('# Titolo\nRiga'), findsOneWidget);
    expect(find.byTooltip('Copia testo'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  test('a guide listed before its receipt still gets its attachments', () {
    final file = ComposerAttachment.text('note.md', 'ciao');
    final guides = PendingGuides()
      ..sync({
        'status': 'running',
        'turn_id': 't1',
        'guidance': [
          {'id': 'g1', 'content': 'Leggi la nota'},
        ],
      })
      ..accepted('g1', 'Leggi la nota', [file]);
    expect(guides.items.single.attachments, [file]);
    guides.accepted('g1', 'Leggi la nota', const []);
    expect(guides.items.single.attachments, [file]);
  });
}
