import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:aurachat_mobile/ui.dart';

void main() {
  testWidgets('navigation controls stay circular in a wide leading slot', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: auraTheme(),
        home: Scaffold(
          appBar: AppBar(
            leadingWidth: 76,
            toolbarHeight: 72,
            leading: Padding(
              padding: const EdgeInsets.only(left: 16, top: 12, bottom: 12),
              child: RoundButton(
                icon: Icons.arrow_back_rounded,
                label: 'Indietro',
                onPressed: () {},
              ),
            ),
            actions: [
              RoundButton(
                icon: Icons.edit_outlined,
                label: 'Nuova',
                onPressed: () {},
              ),
            ],
          ),
        ),
      ),
    );
    final back = tester.getSize(
      find.widgetWithIcon(IconButton, Icons.arrow_back_rounded),
    );
    final next = tester.getSize(
      find.widgetWithIcon(IconButton, Icons.edit_outlined),
    );
    expect(back, const Size(48, 48));
    expect(next, back);
  });
  testWidgets(
    'projects expand, open their chat, and create in the right project',
    (tester) async {
      String? selected, created;
      await tester.pumpWidget(
        MaterialApp(
          theme: auraTheme(),
          home: Scaffold(
            body: ChatLibrary(
              projects: const {
                'p': {'name': 'AuraChat'},
              },
              chats: const [
                {'id': 'a', 'title': 'Chat del progetto', 'project_id': 'p'},
                {'id': 'b', 'title': 'Chat libera'},
              ],
              onSelect: (chat) => selected = chat['id'],
              onNew: (project) => created = project,
            ),
          ),
        ),
      );
      expect(find.text('Chat del progetto'), findsNothing);
      expect(find.byTooltip('Nuova chat in AuraChat'), findsNothing);
      await tester.tap(find.text('AuraChat'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Chat del progetto'));
      expect(selected, 'a');
      await tester.tap(find.byTooltip('Nuova chat in AuraChat'));
      expect(created, 'p');
      await tester.tap(find.text('AuraChat'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Nuova chat in AuraChat'), findsNothing);
      expect(find.text('Chat libera'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('working chats show a progress indicator', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: auraTheme(),
        home: Scaffold(
          body: ChatLibrary(
            projects: const {},
            chats: const [
              {'id': 'a', 'title': 'In corso'},
              {'id': 'b', 'title': 'Ferma'},
            ],
            working: const {'a'},
            onSelect: (_) {},
            onNew: (_) {},
          ),
        ),
      ),
    );
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('In corso'), findsOneWidget);
    expect(find.text('Ferma'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'search finds project conversations without opening each project',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: auraTheme(),
          home: Scaffold(
            body: ChatLibrary(
              projects: const {
                'p': {'name': 'Lavoro'},
              },
              chats: const [
                {'id': 'a', 'title': 'La risposta cercata', 'project_id': 'p'},
                {'id': 'b', 'title': 'Un’altra conversazione'},
              ],
              query: 'cercata',
              onSelect: (_) {},
              onNew: (_) {},
            ),
          ),
        ),
      );
      expect(find.text('La risposta cercata'), findsWidgets);
      expect(find.text('Un’altra conversazione'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'composer handles multiline drafts, send, stop and large text on narrow phones',
    (tester) async {
      tester.view.physicalSize = const Size(320, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = TextEditingController();
      final focus = FocusNode();
      addTearDown(controller.dispose);
      addTearDown(focus.dispose);
      var sent = 0, stopped = 0;
      String? selectedModel, selectedPermission;
      Future<void> render(bool busy) => tester.pumpWidget(
        MaterialApp(
          theme: auraTheme(),
          home: MediaQuery(
            data: const MediaQueryData(
              size: Size(320, 700),
              textScaler: TextScaler.linear(2),
              viewInsets: EdgeInsets.only(bottom: 280),
            ),
            child: Scaffold(
              body: Column(
                children: [
                  const Spacer(),
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: AuraComposer(
                      controller: controller,
                      focusNode: focus,
                      online: true,
                      busy: busy,
                      onSend: () => sent++,
                      onStop: () => stopped++,
                      onOptions: () {},
                      models: const [
                        ComposerChoice(value: 'a', label: 'Alpha'),
                        ComposerChoice(value: 'b', label: 'Beta'),
                      ],
                      selectedModel: 'a',
                      onModelSelected: (value) => selectedModel = value,
                      permissions: const [
                        ComposerChoice(
                          value: 'ask',
                          label: 'Richiedi approvazione',
                        ),
                        ComposerChoice(value: 'auto', label: 'Approva per me'),
                      ],
                      selectedPermission: 'ask',
                      onPermissionSelected: (value) =>
                          selectedPermission = value,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
      await render(false);
      await tester.tap(find.byTooltip('Invia messaggio'));
      expect(sent, 0);
      await tester.enterText(
        find.byKey(const ValueKey('chat-composer')),
        'Prima riga\nSeconda riga',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Modello: Modello'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Beta'));
      await tester.pumpAndSettle();
      expect(selectedModel, 'b');
      await tester.tap(find.byTooltip('Permessi progetto'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Approva per me'));
      await tester.pumpAndSettle();
      expect(selectedPermission, 'auto');
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Invia messaggio'));
      expect(sent, 1);
      await render(true);
      await tester.tap(find.byTooltip('Interrompi risposta'));
      expect(stopped, 1);
      expect(controller.text, 'Prima riga\nSeconda riga');
      expect(
        tester.getBottomRight(find.byType(AuraComposer)).dy,
        lessThanOrEqualTo(420),
      );
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'library keeps long names usable with large text and reduced motion',
    (tester) async {
      tester.view.physicalSize = const Size(320, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      String? selected;
      await tester.pumpWidget(
        MaterialApp(
          theme: auraTheme(),
          home: MediaQuery(
            data: const MediaQueryData(
              size: Size(320, 700),
              textScaler: TextScaler.linear(2),
              disableAnimations: true,
            ),
            child: Scaffold(
              body: ChatLibrary(
                projects: const {
                  'p': {'name': 'Un progetto con un nome molto lungo'},
                },
                chats: const [
                  {
                    'id': 'a',
                    'title': 'Una conversazione con un titolo molto lungo',
                    'project_id': 'p',
                  },
                ],
                onSelect: (chat) => selected = chat['id'] as String,
                onNew: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Un progetto con un nome molto lungo'));
      await tester.pump();
      final row = find.widgetWithText(
        ListTile,
        'Una conversazione con un titolo molto lungo',
      );
      expect(tester.getSize(row).height, greaterThanOrEqualTo(48));
      expect(
        tester
            .getSize(
              find.byTooltip(
                'Nuova chat in Un progetto con un nome molto lungo',
              ),
            )
            .width,
        greaterThanOrEqualTo(48),
      );
      await tester.tap(row);
      expect(selected, 'a');
      expect(tester.takeException(), isNull);
    },
  );
}
