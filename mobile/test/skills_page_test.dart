import 'package:aurachat_mobile/skills_page.dart';
import 'package:aurachat_mobile/ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets(
    'global skills toggle, search and confirmed install use the selected PC',
    (tester) async {
      final calls = <(String, Map<String, dynamic>)>[];
      final skills = <Map<String, dynamic>>[
        {
          'id': 'global:one',
          'name': 'impeccable',
          'scope': 'global',
          'description': 'Design',
          'enabled': true,
        },
      ];
      await tester.pumpWidget(
        MaterialApp(
          theme: auraTheme(),
          home: SkillsPage(
            pcName: 'PC fixture',
            projects: const {},
            request: (action, args) async {
              calls.add((action, args));
              switch (action) {
                case 'skills_catalog':
                  return {'skills': skills};
                case 'skill_enabled':
                  skills.first['enabled'] = args['enabled'];
                  return {};
                case 'skills_search':
                  return {
                    'skills': [
                      {'name': 'new', 'source': 'owner/repo'},
                    ],
                  };
                case 'skill_install':
                  skills.add({
                    'id': 'global:new',
                    'name': 'new',
                    'scope': 'global',
                    'enabled': true,
                  });
                  return {};
                default:
                  throw StateError(action);
              }
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Skill su PC fixture'), findsOneWidget);
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(calls.last.$1, 'skill_enabled');
      expect(calls.last.$2, {
        'project_id': null,
        'id': 'global:one',
        'enabled': false,
      });
      await tester.enterText(find.byType(TextField), 'new');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cerca su skills.sh'));
      await tester.pumpAndSettle();
      expect(calls.last.$1, 'skills_search');
      await tester.scrollUntilVisible(
        find.text('Installa'),
        150,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Installa'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Annulla'));
      await tester.pumpAndSettle();
      expect(calls.where((c) => c.$1 == 'skill_install'), isEmpty);
      await tester.tap(find.text('Installa'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Installa sul PC'));
      await tester.pumpAndSettle();
      expect(calls.where((c) => c.$1 == 'skill_install').single.$2, {
        'source': 'owner/repo',
        'name': 'new',
        'confirm_install': true,
      });
      expect(find.text('/new'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('failed preference stays unchanged and refresh can recover', (
    tester,
  ) async {
    var fail = false;
    await tester.pumpWidget(
      MaterialApp(
        theme: auraTheme(),
        home: SkillsPage(
          pcName: 'PC',
          projects: const {},
          request: (action, args) async {
            if (action == 'skill_enabled') throw StateError('Save failed');
            if (fail) throw StateError('PC offline');
            return {
              'skills': [
                {'id': 'one', 'name': 'review', 'enabled': true},
              ],
            };
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
    expect(find.textContaining('Save failed'), findsOneWidget);
    fail = true;
    await tester.tap(find.byTooltip('Aggiorna skill'));
    await tester.pumpAndSettle();
    expect(find.textContaining('PC offline'), findsOneWidget);
    fail = false;
    await tester.tap(find.byTooltip('Aggiorna skill'));
    await tester.pumpAndSettle();
    expect(find.textContaining('PC offline'), findsNothing);
  });
}
