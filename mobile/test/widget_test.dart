import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:aurachat_mobile/app.dart';
import 'package:aurachat_mobile/companion.dart';

void main() {
  test(
    'device liveness expires and chat index preserves project ownership',
    () {
      expect(
        deviceOnline({'last_seen': 1000, 'remote_enabled': true}, 2000),
        isTrue,
      );
      expect(deviceOnline({'last_seen': 1000}, 47000), isFalse);
      final index = chatIndex({
        'conversations': {
          'a': {'title': 'A', 'updated_at': 1},
          'b': {'title': 'B', 'updated_at': 2},
        },
        'projects': {
          'p': {
            'name': 'Project',
            'conversation_ids': ['a'],
          },
        },
      });
      expect(index.first['id'], 'b');
      expect(index.last['project_id'], 'p');
      expect(index.last['project_name'], 'Project');
      expect(index.first['project_id'], isNull);
    },
  );
  test('live turns count only while running and fresh', () {
    const now = 100000;
    expect(
      liveTurnRunning({'status': 'running', 'updated_at': now - 1000}, now),
      isTrue,
    );
    expect(
      liveTurnRunning({'status': 'running', 'updated_at': now - 21000}, now),
      isFalse,
    );
    expect(
      liveTurnRunning({'status': 'completed', 'updated_at': now}, now),
      isFalse,
    );
    expect(liveTurnRunning(null, now), isFalse);
  });
  testWidgets(
    'login validates empty fields without attempting authentication',
    (tester) async {
      await tester.pumpWidget(const MaterialApp(home: Login()));
      await tester.tap(find.text('Accedi'));
      await tester.pump();
      expect(find.text('Inserisci la tua email'), findsOneWidget);
      expect(find.text('Inserisci la password'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
