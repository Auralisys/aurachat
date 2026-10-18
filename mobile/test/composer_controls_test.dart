import 'package:aurachat_mobile/ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget host(Widget child) => MaterialApp(
  theme: auraTheme(),
  home: Scaffold(
    body: Align(
      alignment: Alignment.bottomCenter,
      child: Padding(padding: const EdgeInsets.all(16), child: child),
    ),
  ),
);

void main() {
  testWidgets('composer shows model, permissions and microphone as icons', (
    tester,
  ) async {
    final controller = TextEditingController();
    final focus = FocusNode();
    addTearDown(controller.dispose);
    addTearDown(focus.dispose);
    var micTaps = 0;
    await tester.pumpWidget(
      host(
        AuraComposer(
          controller: controller,
          focusNode: focus,
          online: true,
          busy: false,
          onSend: () {},
          onStop: () {},
          onOptions: () {},
          models: const [
            ComposerChoice(value: 'a', label: 'Alpha'),
            ComposerChoice(value: 'b', label: 'Beta'),
          ],
          selectedModel: 'a',
          permissions: const [
            ComposerChoice(value: 'ask', label: 'Richiedi approvazione'),
          ],
          selectedPermission: 'ask',
          onMic: () => micTaps++,
        ),
      ),
    );
    expect(find.byIcon(Icons.add_rounded), findsOneWidget);
    expect(find.byIcon(Icons.auto_awesome_rounded), findsOneWidget);
    expect(find.byIcon(Icons.shield_outlined), findsOneWidget);
    expect(find.byIcon(Icons.mic_none_rounded), findsOneWidget);
    // Controls are icons: the selected model name stays out of the card.
    expect(find.text('Alpha'), findsNothing);
    await tester.tap(find.byTooltip('Dettatura'));
    expect(micTaps, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('model and permission choices open in custom menus', (
    tester,
  ) async {
    final controller = TextEditingController();
    final focus = FocusNode();
    addTearDown(controller.dispose);
    addTearDown(focus.dispose);
    String? model, permission;
    await tester.pumpWidget(
      host(
        AuraComposer(
          controller: controller,
          focusNode: focus,
          online: true,
          busy: false,
          onSend: () {},
          onStop: () {},
          onOptions: () {},
          models: const [
            ComposerChoice(value: 'a', label: 'Alpha'),
            ComposerChoice(
              value: 'b',
              label: 'Beta',
              description: 'Modello di riserva',
            ),
          ],
          selectedModel: 'a',
          onModelSelected: (value) => model = value,
          permissions: const [
            ComposerChoice(value: 'ask', label: 'Richiedi approvazione'),
            ComposerChoice(value: 'full', label: 'Accesso completo'),
          ],
          selectedPermission: 'ask',
          onPermissionSelected: (value) => permission = value,
        ),
      ),
    );
    await tester.tap(find.byTooltip('Modello: Modello'));
    await tester.pumpAndSettle();
    expect(find.byType(MenuItemButton), findsNWidgets(2));
    expect(find.byType(BottomSheet), findsNothing);
    expect(find.text('Modello di riserva'), findsOneWidget);
    await tester.tap(find.text('Beta'));
    await tester.pumpAndSettle();
    expect(model, 'b');
    expect(find.byType(MenuItemButton), findsNothing);

    await tester.tap(find.byTooltip('Permessi progetto'));
    await tester.pumpAndSettle();
    expect(find.byType(BottomSheet), findsNothing);
    await tester.tap(find.text('Accesso completo'));
    await tester.pumpAndSettle();
    expect(permission, 'full');
    expect(tester.takeException(), isNull);
  });

  testWidgets('disabled model menu cannot be opened while offline', (
    tester,
  ) async {
    final controller = TextEditingController();
    final focus = FocusNode();
    addTearDown(controller.dispose);
    addTearDown(focus.dispose);
    await tester.pumpWidget(
      host(
        AuraComposer(
          controller: controller,
          focusNode: focus,
          online: false,
          busy: false,
          onSend: () {},
          onStop: () {},
          onOptions: () {},
          models: const [ComposerChoice(value: 'a', label: 'Alpha')],
        ),
      ),
    );
    await tester.tap(find.byTooltip('Modello: Modello'));
    await tester.pumpAndSettle();
    expect(find.byType(MenuItemButton), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('send and stop follow the desktop composer logic', (
    tester,
  ) async {
    final controller = TextEditingController();
    final focus = FocusNode();
    addTearDown(controller.dispose);
    addTearDown(focus.dispose);
    var sent = 0, stopped = 0;
    Future<void> render(bool busy) => tester.pumpWidget(
      host(
        AuraComposer(
          controller: controller,
          focusNode: focus,
          online: true,
          busy: busy,
          allowQueue: true,
          onSend: () => sent++,
          onStop: () => stopped++,
          onOptions: () {},
        ),
      ),
    );
    await render(true);
    expect(find.byTooltip('Interrompi risposta'), findsOneWidget);
    expect(find.byTooltip('Invia in coda'), findsNothing);
    await tester.enterText(find.byKey(const ValueKey('chat-composer')), 'Bozza');
    await tester.pump();
    expect(find.byTooltip('Interrompi risposta'), findsOneWidget);
    expect(find.byTooltip('Invia in coda'), findsOneWidget);
    await render(false);
    expect(find.byTooltip('Interrompi risposta'), findsNothing);
    expect(find.byTooltip('Invia messaggio'), findsOneWidget);
    // Every toolbar control shares the same 40 px footprint.
    expect(
      tester.getSize(find.byTooltip('Invia messaggio')),
      const Size(40, 40),
    );
    expect(
      tester.getSize(find.byTooltip('Dettatura')),
      tester.getSize(find.byTooltip('Invia messaggio')),
    );
    expect(
      tester.getSize(find.byTooltip('Modello: Modello')),
      tester.getSize(find.byTooltip('Invia messaggio')),
    );
    expect(sent, 0);
    expect(stopped, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('nav context label shows project and PC status', (tester) async {
    var deviceTaps = 0;
    Future<void> render({required bool online}) => tester.pumpWidget(
      MaterialApp(
        theme: auraTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: Scaffold(
          appBar: AppBar(
            title: ChatContextLabel(
              project: 'AuraChat',
              pc: 'PC di Lorenzo',
              online: online,
              onTap: () => deviceTaps++,
            ),
          ),
        ),
      ),
    );
    Color dot() => (tester
                .widget<Container>(
                  find.byWidgetPredicate(
                    (widget) =>
                        widget is Container &&
                        widget.constraints?.maxWidth == 6,
                  ),
                )
                .decoration!
            as BoxDecoration)
        .color!;
    await render(online: true);
    expect(find.text('AuraChat'), findsOneWidget);
    expect(find.text('PC di Lorenzo'), findsOneWidget);
    expect(find.text(' • '), findsOneWidget);
    expect(find.byIcon(Icons.keyboard_arrow_down_rounded), findsOneWidget);
    expect(dot(), const Color(0xff38c49b));
    await tester.tap(find.byTooltip('Cambia PC'));
    expect(deviceTaps, 1);
    await render(online: false);
    expect(dot(), muted);
    expect(tester.takeException(), isNull);
  });
}
