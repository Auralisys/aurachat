import 'dart:convert';
import 'dart:ui' as ui;
import 'package:aurachat_mobile/chat_actions.dart';
import 'package:aurachat_mobile/skills_page.dart';
import 'package:aurachat_mobile/ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const previewKey = ValueKey('preview');
  final previews = <Map<String, String>>[];
  Future<void> capture(WidgetTester tester, String name) async {
    final boundary = tester.renderObject<RenderRepaintBoundary>(
      find.byKey(previewKey),
    );
    final image = await boundary
        .toImage(pixelRatio: 2)
        .timeout(const Duration(seconds: 20));
    try {
      final data = await image
          .toByteData(format: ui.ImageByteFormat.png)
          .timeout(const Duration(seconds: 20));
      if (data == null) throw StateError('Preview capture returned no image');
      previews.add({
        'name': name,
        'png': base64Encode(data.buffer.asUint8List()),
      });
      binding.reportData = {'previews': previews};
    } finally {
      image.dispose();
    }
  }

  testWidgets('offline native skills and chat options previews', (
    tester,
  ) async {
    await tester.pumpWidget(
      RepaintBoundary(
        key: previewKey,
        child: MaterialApp(
          theme: auraTheme(),
          home: SkillsPage(
            pcName: 'PC di prova',
            projects: const {
              'p': {'name': 'AuraChat'},
            },
            request: (action, args) async => {
              'skills': [
                {
                  'id': 'one',
                  'name': 'impeccable',
                  'description': 'Progettazione e cura delle interfacce.',
                  'scope': 'global',
                  'enabled': true,
                },
                {
                  'id': 'two',
                  'name': 'review',
                  'description': 'Revisione del codice del progetto.',
                  'scope': 'project',
                  'enabled': false,
                },
              ],
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await capture(tester, 'android-skills');
    await tester.pumpWidget(
      RepaintBoundary(
        key: previewKey,
        child: MaterialApp(
          theme: auraTheme(),
          home: MediaQuery(
            data: MediaQueryData.fromView(
              tester.view,
            ).copyWith(textScaler: const TextScaler.linear(1.3)),
            child: Scaffold(
              appBar: AppBar(
                title: const Text('Chat di prova'),
                actions: [ChatActionsMenu(onSelected: (_) {})],
              ),
              body: const Padding(
                padding: EdgeInsets.all(20),
                child: Text(
                  'Conversazione di prova senza account o chiamate di rete.',
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Opzioni chat'));
    await tester.pumpAndSettle();
    expect(find.text('Nuova chat'), findsNothing);
    expect(find.text('Rinomina chat'), findsOneWidget);
    await capture(tester, 'android-chat-options-large-text');
    expect(tester.takeException(), isNull);
  });
}
