import 'package:aurachat_mobile/skill_picker.dart';
import 'package:aurachat_mobile/ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late TextEditingController controller;
  late FocusNode focus;

  setUp(() {
    controller = TextEditingController();
    focus = FocusNode();
  });

  tearDown(() {
    controller.dispose();
    focus.dispose();
  });

  Future<void> mount(
    WidgetTester tester, {
    List<Map<String, dynamic>> skills = const [],
    bool hasProject = true,
    bool enabled = true,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: auraTheme(),
        home: Scaffold(
          body: Column(
            children: [
              SkillPicker(
                controller: controller,
                focus: focus,
                skills: skills,
                enabled: enabled,
                hasProject: hasProject,
              ),
              TextField(controller: controller, focusNode: focus),
            ],
          ),
        ),
      ),
    );
    await tester.tap(find.byType(TextField));
    await tester.pumpAndSettle();
  }

  testWidgets(
    'filter is case insensitive and selection updates composer and caret',
    (tester) async {
      await mount(
        tester,
        skills: const [
          {'name': 'review', 'description': 'Review changes'},
          {'name': 'build', 'description': 'Build project'},
        ],
      );
      await tester.enterText(find.byType(TextField), '/REV');
      await tester.pumpAndSettle();
      expect(find.text('/review'), findsOneWidget);
      expect(find.text('/build'), findsNothing);
      await tester.tap(find.text('/review'));
      await tester.pumpAndSettle();
      expect(controller.text, '/review ');
      expect(controller.selection, const TextSelection.collapsed(offset: 8));
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '/review ',
      );
      expect(focus.hasFocus, isTrue);
      expect(find.byType(ListTile), findsNothing);
    },
  );

  testWidgets('duplicate names are disabled and cannot modify the composer', (
    tester,
  ) async {
    await mount(
      tester,
      skills: const [
        {'name': 'review', 'description': 'Root one'},
        {'name': 'review', 'description': 'Root two'},
        {'name': 'build', 'description': 'Unique'},
      ],
    );
    await tester.enterText(find.byType(TextField), '/');
    await tester.pumpAndSettle();
    final duplicates = find.widgetWithText(ListTile, '/review');
    expect(duplicates, findsNWidgets(2));
    for (final tile in tester.widgetList<ListTile>(duplicates)) {
      expect(tile.enabled, isFalse);
    }
    expect(
      find.byTooltip('Nome duplicato nelle cartelle del progetto'),
      findsNWidgets(2),
    );
    await tester.tap(duplicates.first);
    await tester.pumpAndSettle();
    expect(controller.text, '/');
    expect(
      tester.widget<ListTile>(find.widgetWithText(ListTile, '/build')).enabled,
      isTrue,
    );
  });

  testWidgets('empty free chat points to skills management', (tester) async {
    await mount(tester, hasProject: false);
    await tester.enterText(find.byType(TextField), '/');
    await tester.pumpAndSettle();
    expect(
      find.text('Nessuna skill disponibile. Gestiscile da Menu > Skill.'),
      findsOneWidget,
    );
    expect(find.byType(ListTile), findsNothing);
    expect(find.text('Nessuna skill disponibile nel progetto.'), findsNothing);
  });

  testWidgets('free chats expose global skills but not disabled skills', (
    tester,
  ) async {
    await mount(
      tester,
      hasProject: false,
      skills: const [
        {
          'name': 'impeccable',
          'description': 'Design interfaces',
          'scope': 'global',
        },
        {'name': 'disabled', 'enabled': false},
        {'name': 'shadowed', 'shadowed': true},
      ],
    );
    await tester.enterText(find.byType(TextField), '/');
    await tester.pumpAndSettle();
    expect(find.text('/impeccable'), findsOneWidget);
    expect(find.text('/disabled'), findsNothing);
    expect(find.text('/shadowed'), findsNothing);
    await tester.tap(find.text('/impeccable'));
    expect(controller.text, '/impeccable ');
  });

  testWidgets('typing a trailing prompt hides suggestions', (tester) async {
    await mount(
      tester,
      skills: const [
        {'name': 'review'},
      ],
    );
    await tester.enterText(find.byType(TextField), '/review');
    await tester.pumpAndSettle();
    expect(find.widgetWithText(ListTile, '/review'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '/review inspect changes');
    await tester.pumpAndSettle();
    expect(find.byType(ListTile), findsNothing);
    expect(controller.text, '/review inspect changes');
  });

  testWidgets('unfocused and disabled composers hide suggestions', (
    tester,
  ) async {
    await mount(
      tester,
      skills: const [
        {'name': 'review'},
      ],
    );
    await tester.enterText(find.byType(TextField), '/');
    await tester.pumpAndSettle();
    expect(find.byType(ListTile), findsOneWidget);
    focus.unfocus();
    await tester.pumpAndSettle();
    expect(find.byType(ListTile), findsNothing);
    await mount(
      tester,
      skills: const [
        {'name': 'review'},
      ],
      enabled: false,
    );
    expect(focus.hasFocus, isTrue);
    expect(find.byType(ListTile), findsNothing);
  });
}
