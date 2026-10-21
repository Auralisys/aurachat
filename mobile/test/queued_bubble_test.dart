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
}
