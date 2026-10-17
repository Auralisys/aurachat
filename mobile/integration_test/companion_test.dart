import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:aurachat_mobile/app.dart';
import 'package:aurachat_mobile/companion.dart';

// Real cloud and real desktop/model. Sign in once in the installed app before
// running; no passwords, model credentials or authentication bypasses in tests.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'Android → Firestore → Windows → model → Android',
    (tester) async {
      startAuraChat();
      for (
        var i = 0;
        i < 30 && find.byType(Workspace).evaluate().isEmpty;
        i++
      ) {
        await tester.pump(const Duration(seconds: 1));
      }
      expect(
        find.byType(Workspace),
        findsOneWidget,
        reason:
            'Accedi nell’app Android con lo stesso account del desktop prima del test.',
      );
      final user = FirebaseAuth.instance.currentUser!;
      final api = Companion(user.uid);
      final devices = await api.devices.get();
      expect(
        devices.docs.any((d) => deviceOnline(d.data())),
        isTrue,
        reason:
            'Apri il desktop e pubblica le regole Firestore limitate al proprietario.',
      );
      await tester.tap(find.byTooltip('Nuova chat'));
      await tester.pump();
      final marker =
          'ANDROID_REMOTE_OK_${DateTime.now().millisecondsSinceEpoch}';
      await tester.enterText(
        find.byType(TextField),
        '[Test connessione Android] Rispondi soltanto con: $marker',
      );
      await tester.pump();
      await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
      var answered = false;
      for (var i = 0; i < 120; i++) {
        await tester.pump(const Duration(seconds: 1));
        if (find.textContaining(marker).evaluate().length >= 2) {
          answered = true;
          break;
        }
      }
      expect(
        answered,
        isTrue,
        reason: 'La risposta reale del desktop deve comparire nell’app.',
      );
      final index = await api.user.collection('companion').doc('state').get();
      final chats = chatIndex(
        Map<String, dynamic>.from(index.data()?['tree'] ?? {}),
      );
      final fixture = chats.firstWhere(
        (c) => c['title'].toString().startsWith('[Test connessione Android]'),
      );
      final messages = await api.user
          .collection('conversations')
          .doc(fixture['id'])
          .collection('messages')
          .orderBy('sequence')
          .get();
      expect(
        messages.docs.any(
          (d) =>
              d.data()['role'] == 'assistant' &&
              d.data()['content'].toString().contains(marker),
        ),
        isTrue,
      );
      expect(tester.takeException(), isNull);
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
