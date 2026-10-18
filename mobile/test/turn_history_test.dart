import 'package:aurachat_mobile/turn_history.dart';
import 'package:aurachat_mobile/ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> showTurn(
  WidgetTester tester,
  Map<String, dynamic> message, {
  bool live = false,
  double scale = 1,
  ValueChanged<String>? onStopAgent,
  ValueChanged<String>? onStopShell,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: auraTheme(),
      home: Scaffold(
        body: MediaQuery(
          data: MediaQueryData(
            textScaler: TextScaler.linear(scale),
            disableAnimations: true,
          ),
          child: SingleChildScrollView(
            child: SizedBox(
              width: 320,
              child: TurnHistory(
                message: message,
                live: live,
                onStopAgent: onStopAgent,
                onStopShell: onStopShell,
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> expand(WidgetTester tester, String title) async {
  final target = find.text(title);
  await tester.ensureVisible(target);
  await tester.tap(target);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('truncated snapshots disclose preview limit without hiding prose', (
    tester,
  ) async {
    const notice =
        'Anteprima live ridotta. La cronologia completa sarà disponibile a fine turno.';
    await showTurn(tester, {
      'content': 'Preview',
      'truncated': true,
    }, live: true);
    expect(find.text(notice), findsOneWidget);
    expect(tester.widget<Text>(find.text(notice)).style!.color, muted);
    expect(find.text('Preview'), findsOneWidget);
    await showTurn(tester, {'content': 'Complete'}, live: false);
    expect(find.text(notice), findsNothing);
    expect(find.text('Complete'), findsOneWidget);
  });

  testWidgets('stop callbacks target live agents and nested shells only', (
    tester,
  ) async {
    final agents = <String>[];
    final shells = <String>[];
    final message = <String, dynamic>{
      'activity': [
        {
          'kind': 'agent',
          'id': 'agent-1',
          'title': 'Delegate',
          'status': 'running',
          'activity': [
            {
              'kind': 'tool',
              'title': 'Execute',
              'status': 'running',
              'action': 'execute_project_command',
              'output': '{"id":"shell-1"}',
            },
            {
              'kind': 'tool',
              'title': 'Inspect',
              'status': 'running',
              'action': 'inspect_project_command',
              'shell_id': 'shell-2',
              'output': 'not JSON',
            },
            {
              'kind': 'tool',
              'title': 'Finished',
              'status': 'completed',
              'action': 'execute_project_command',
              'shell_id': 'finished',
            },
            {
              'kind': 'tool',
              'title': 'Invalid',
              'status': 'running',
              'action': 'execute_project_command',
              'output': 'not JSON',
            },
          ],
        },
      ],
    };
    await showTurn(
      tester,
      message,
      live: true,
      onStopAgent: agents.add,
      onStopShell: shells.add,
    );
    await expand(tester, 'Delegate · In corso');
    await tester.tap(find.text('Interrompi agente'));
    await expand(tester, 'Execute · In corso');
    await tester.tap(find.text('Interrompi comando'));
    await expand(tester, 'Execute · In corso');
    await expand(tester, 'Inspect · In corso');
    await tester.ensureVisible(find.text('Interrompi comando'));
    await tester.tap(find.text('Interrompi comando'));
    await expand(tester, 'Finished · Completato');
    await expand(tester, 'Invalid · In corso');
    expect(find.text('Interrompi comando'), findsOneWidget);
    expect(agents, ['agent-1']);
    expect(shells, ['shell-1', 'shell-2']);
    await showTurn(
      tester,
      message,
      live: false,
      onStopAgent: agents.add,
      onStopShell: shells.add,
    );
    expect(find.text('Interrompi agente'), findsNothing);
    expect(find.text('Interrompi comando'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('live labels are visible and steps remain collapsible', (
    tester,
  ) async {
    await showTurn(tester, {
      'activity': [
        {'kind': 'reasoning', 'status': 'running', 'text': 'Supplied thought'},
        {
          'kind': 'tool',
          'title': 'Read',
          'status': 'running',
          'output': 'Hidden output',
        },
        {'kind': 'agent', 'title': 'Research', 'status': 'running'},
        {'kind': 'approval', 'status': 'pending'},
      ],
    }, live: true);
    for (final label in [
      'Ragionamento · In corso',
      'Read · In corso',
      'Research · In corso',
      'Approvazione · In attesa',
    ]) {
      expect(find.text(label).hitTestable(), findsOneWidget);
    }
    expect(find.text('In corso…'), findsNothing);
    expect(find.text('Supplied thought'), findsOneWidget);
    expect(find.text('Hidden output'), findsNothing);
    await expand(tester, 'Ragionamento · In corso');
    expect(find.text('Supplied thought'), findsNothing);
    await expand(tester, 'Read · In corso');
    expect(find.text('Hidden output'), findsOneWidget);
    await expand(tester, 'Attività · 4 · In corso');
    expect(find.text('Read · In corso'), findsNothing);
  });

  testWidgets('interleaves prose and equal-offset events in received order', (
    tester,
  ) async {
    await showTurn(tester, {
      'content': 'BeforeAfter',
      'activity': [
        {'kind': 'reasoning', 'text': 'Actual reasoning', 'offset': 0},
        {'kind': 'tool', 'title': 'Read', 'offset': 6},
        {'kind': 'agent', 'title': 'Delegate', 'offset': 6},
        {'kind': 'approval', 'title': 'Review', 'offset': 6},
      ],
    });
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('group-0'))).dy,
      lessThan(tester.getTopLeft(find.text('Before')).dy),
    );
    expect(
      tester.getTopLeft(find.text('Before')).dy,
      lessThan(tester.getTopLeft(find.byKey(const ValueKey('group-6'))).dy),
    );
    expect(
      tester.getTopLeft(find.byKey(const ValueKey('group-6'))).dy,
      lessThan(tester.getTopLeft(find.text('After')).dy),
    );
    await expand(tester, 'Attività · 3');
    expect(
      tester.getTopLeft(find.text('Read')).dy,
      lessThan(tester.getTopLeft(find.text('Delegate')).dy),
    );
    expect(
      tester.getTopLeft(find.text('Delegate')).dy,
      lessThan(tester.getTopLeft(find.text('Review')).dy),
    );
  });

  testWidgets(
    'clamps bad and decreasing offsets without reordering or emoji loss',
    (tester) async {
      await showTurn(tester, {
        'content': '😀Done',
        'activity': [
          {'kind': 'tool', 'title': 'First', 'offset': 1},
          {'kind': 'tool', 'title': 'Second', 'offset': -4},
          {'kind': 'tool', 'title': 'Last', 'offset': 900},
        ],
      });
      expect(find.text('😀'), findsOneWidget);
      expect(find.text('Done'), findsOneWidget);
      await expand(tester, 'Attività · 2');
      expect(
        tester.getTopLeft(find.text('First')).dy,
        lessThan(tester.getTopLeft(find.text('Second')).dy),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('full tool and approval payloads expand without truncation', (
    tester,
  ) async {
    final output = List.filled(30, 'complete output').join('\n');
    await showTurn(tester, {
      'activity': [
        {
          'kind': 'tool',
          'id': 'read',
          'title': 'Read',
          'arguments': {'path': 'file.txt'},
          'output': output,
        },
        {
          'kind': 'approval',
          'status': 'denied',
          'reason': 'Policy reason',
          'action': {'command': 'restricted command'},
        },
      ],
    });
    await expand(tester, 'Attività · 2');
    expect(find.text(output), findsNothing);
    await expand(tester, 'Read');
    expect(find.text(output), findsOneWidget);
    expect(find.textContaining('"path": "file.txt"'), findsOneWidget);
    await expand(tester, 'Approvazione · Negato');
    expect(find.text('Policy reason'), findsOneWidget);
    expect(
      find.textContaining('"command": "restricted command"'),
      findsOneWidget,
    );
  });

  testWidgets(
    'nested agent reasoning and activity use supplied payloads only',
    (tester) async {
      await showTurn(tester, {
        'activity': [
          {
            'kind': 'agent',
            'title': 'Research',
            'status': 'completed',
            'reasoning_content': 'Provided agent reasoning',
            'content': 'Agent reply',
            'activity': [
              {
                'kind': 'tool',
                'title': 'Nested read',
                'output': 'Nested output',
              },
            ],
          },
        ],
      });
      await expand(tester, 'Attività · 1');
      await expand(tester, 'Research · Completato');
      expect(find.text('Agent reply'), findsOneWidget);
      await expand(tester, 'Attività · 2');
      await expand(tester, 'Ragionamento');
      expect(find.text('Provided agent reasoning'), findsOneWidget);
      await expand(tester, 'Nested read');
      expect(find.text('Nested output'), findsOneWidget);
    },
  );

  testWidgets(
    'no fabricated reasoning and aggregate reasoning is not duplicated',
    (tester) async {
      await showTurn(tester, {'content': '', 'activity': []}, live: true);
      expect(find.text('In corso…'), findsOneWidget);
      expect(find.text('Ragionamento'), findsNothing);
      await showTurn(tester, {
        'reasoning': 'Aggregate duplicate',
        'activity': [
          {'kind': 'reasoning', 'text': 'Positional reasoning'},
        ],
      });
      await expand(tester, 'Attività · 1');
      await expand(tester, 'Ragionamento');
      expect(find.text('Positional reasoning'), findsOneWidget);
      expect(find.text('Aggregate duplicate'), findsNothing);
    },
  );

  testWidgets('expanded step survives live updates and large text fits', (
    tester,
  ) async {
    Map<String, dynamic> message(String output, String content) => {
      'content': content,
      'activity': [
        {
          'kind': 'tool',
          'id': 'stable',
          'title': 'Read',
          'status': 'running',
          'output': output,
        },
      ],
    };
    await showTurn(tester, message('Partial', ''), live: true, scale: 2);
    await expand(tester, 'Read · In corso');
    expect(find.text('Partial'), findsOneWidget);
    await showTurn(
      tester,
      message('Full output', 'Answer'),
      live: true,
      scale: 2,
    );
    expect(find.text('Full output'), findsOneWidget);
    expect(find.text('Answer'), findsOneWidget);
    expect(tester.takeException(), isNull);
    expect(
      tester.getSize(find.byType(ExpansionTile).first).height,
      greaterThanOrEqualTo(48),
    );
  });
}
