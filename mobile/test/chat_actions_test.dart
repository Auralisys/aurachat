import 'package:aurachat_mobile/chat_actions.dart';
import 'package:aurachat_mobile/ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('chat overflow exposes chat actions, never new chat', (
    tester,
  ) async {
    ChatAction? selected;
    await tester.pumpWidget(
      MaterialApp(
        theme: auraTheme(),
        home: Scaffold(
          appBar: AppBar(
            actions: [ChatActionsMenu(onSelected: (value) => selected = value)],
          ),
        ),
      ),
    );
    await tester.tap(find.byTooltip('Opzioni chat'));
    await tester.pumpAndSettle();
    expect(find.text('Rinomina chat'), findsOneWidget);
    expect(find.text('Copia conversazione'), findsOneWidget);
    expect(find.text('Elimina chat'), findsOneWidget);
    expect(find.text('Nuova chat'), findsNothing);
    await tester.tap(find.text('Rinomina chat'));
    await tester.pumpAndSettle();
    expect(selected, ChatAction.rename);
  });

  testWidgets('working chat disables mutation while allowing copy', (
    tester,
  ) async {
    ChatAction? selected;
    await tester.pumpWidget(
      MaterialApp(
        theme: auraTheme(),
        home: Scaffold(
          appBar: AppBar(
            actions: [
              ChatActionsMenu(
                canModify: false,
                onSelected: (value) => selected = value,
              ),
            ],
          ),
        ),
      ),
    );
    await tester.tap(find.byTooltip('Opzioni chat'));
    await tester.pumpAndSettle();
    for (final item in tester.widgetList<PopupMenuItem<ChatAction>>(
      find.byType(PopupMenuItem<ChatAction>),
    )) {
      expect(item.enabled, item.value == ChatAction.copy);
    }
    await tester.tap(find.text('Copia conversazione'));
    await tester.pumpAndSettle();
    expect(selected, ChatAction.copy);
  });

  testWidgets('rename validates empty titles and returns trimmed title', (
    tester,
  ) async {
    String? result;
    await tester.pumpWidget(
      MaterialApp(
        theme: auraTheme(),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                result = await showDialog<String>(
                  context: context,
                  builder: (_) => const RenameChatDialog(title: 'Original'),
                );
              },
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField), '   ');
    await tester.tap(find.text('Salva'));
    await tester.pumpAndSettle();
    expect(find.text('Inserisci un titolo'), findsOneWidget);
    await tester.enterText(find.byType(TextFormField), ' Updated ');
    await tester.tap(find.text('Salva'));
    await tester.pumpAndSettle();
    expect(result, 'Updated');
  });
}
