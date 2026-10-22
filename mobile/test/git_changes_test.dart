import 'package:aurachat_mobile/git_changes.dart';
import 'package:aurachat_mobile/ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> status(
  int added, {
  bool staged = false,
  bool committed = false,
}) => {
  'branch': 'main',
  'head': 'head',
  'revision': staged ? 'staged' : 'initial',
  'upstream': 'origin/main',
  'ahead': committed ? 1 : 0,
  'added': committed ? 0 : added,
  'removed': 0,
  'files': committed
      ? []
      : [
          {
            'path': 'lib/app.dart',
            'added': added,
            'removed': 0,
            'staged': staged ? {'added': added, 'removed': 0} : null,
            'unstaged': staged ? null : {'added': added, 'removed': 0},
          },
        ],
};

Future<void> visibleTap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'manual repo selection, stale revisions and large text keep commit safe',
    (tester) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final calls = <String>[];
      var externalChange = false;
      Future<Map<String, dynamic>> request(
        String operation,
        Map<String, dynamic> args,
      ) async {
        calls.add(operation);
        switch (operation) {
          case 'discover':
            return {
              'repositories': ['one', 'two'],
              'truncated': false,
            };
          case 'status':
            final result = status(args['root'] == 'two' ? 20 : 1, staged: true);
            if (externalChange) result['revision'] = 'external';
            return result;
          case 'preview':
            return {
              'revision': 'preview',
              'index_revision': 'staged',
              'diff': '+ changed',
            };
          case 'commit':
            expect(args['root'], 'one');
            throw StateError('Staging/HEAD changed after preview.');
          default:
            throw StateError('Unexpected $operation');
        }
      }

      await tester.pumpWidget(
        MaterialApp(
          theme: auraTheme(),
          builder: (_, child) => MediaQuery(
            data: const MediaQueryData(
              size: Size(360, 800),
              textScaler: TextScaler.linear(1.6),
            ),
            child: child!,
          ),
          home: Scaffold(
            body: ListView(
              padding: const EdgeInsets.all(24),
              children: [
                GitChanges(request: request, online: true, canMutate: true),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      tester
          .widget<DropdownButtonFormField<String>>(
            find.byType(DropdownButtonFormField<String>),
          )
          .onChanged!('one');
      await tester.pumpAndSettle();
      expect(find.text('+1'), findsOneWidget);
      await visibleTap(tester, find.text('Commit…'));
      await tester.ensureVisible(find.byType(TextField));
      await tester.enterText(find.byType(TextField), 'A reviewed message');
      await tester.pumpAndSettle();
      await visibleTap(tester, find.text('Conferma commit'));
      expect(calls.where((c) => c == 'commit').length, 1);
      await tester.ensureVisible(find.byTooltip('Aggiorna cambiamenti'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Staging/HEAD changed'), findsOneWidget);
      externalChange = true;
      await visibleTap(tester, find.byTooltip('Aggiorna cambiamenti'));
      expect(find.textContaining('Lo stage è cambiato'), findsOneWidget);
      expect(find.text('Conferma commit'), findsNothing);
      expect(
        tester
            .widget<DropdownButtonFormField<String>>(
              find.byType(DropdownButtonFormField<String>),
            )
            .initialValue,
        'one',
      );
      await visibleTap(tester, find.text('Commit…'));
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'A reviewed message',
      );
      expect(
        calls.where((c) => c == 'commit').length,
        1,
        reason: 'Failed mutations are never auto-replayed',
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'chooses the most changed repo and requires stage, preview and explicit commit/push',
    (tester) async {
      final calls = <({String operation, Map<String, dynamic> arguments})>[];
      bool staged = false, committed = false;
      Future<Map<String, dynamic>> request(
        String operation,
        Map<String, dynamic> args,
      ) async {
        calls.add((operation: operation, arguments: args));
        switch (operation) {
          case 'discover':
            return {
              'repositories': ['one', 'two'],
              'truncated': false,
            };
          case 'status':
            return status(
              args['root'] == 'two' ? 20 : 1,
              staged: staged,
              committed: committed && args['root'] == 'two',
            );
          case 'stage':
            expect(args['root'], 'two');
            expect(args['paths'], ['lib/app.dart']);
            expect(args['revision'], 'initial');
            staged = true;
            return {'revision': 'staged'};
          case 'preview':
            return {
              'revision': 'preview',
              'index_revision': 'staged',
              'diff': '+ changed',
            };
          case 'commit':
            expect(args['root'], 'two');
            expect(args['revision'], 'preview');
            expect(args['message'], 'Fix app');
            expect(args['confirmed'], true);
            committed = true;
            return {'head': 'committed'};
          case 'push_preview':
            expect(
              args['root'],
              'two',
              reason:
                  'Commit and push must stay on the same repo even when another repo now has more changes',
            );
            return {
              'revision': 'push',
              'remote': 'origin',
              'target': 'refs/heads/main',
              'head': 'committed',
            };
          case 'push':
            throw StateError('Git: authentication failed');
          default:
            throw StateError('Unexpected $operation');
        }
      }

      await tester.pumpWidget(
        MaterialApp(
          theme: auraTheme(),
          home: Scaffold(
            body: ListView(
              padding: const EdgeInsets.all(24),
              children: [
                GitChanges(request: request, online: true, canMutate: true),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('+20'), findsOneWidget);
      expect(
        (tester.widget<DropdownButtonFormField<String>>(
          find.byType(DropdownButtonFormField<String>),
        )).initialValue,
        'two',
      );
      expect(
        tester
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, 'Commit…'),
            )
            .onPressed,
        isNull,
      );
      expect(
        calls.where((c) => c.operation == 'commit' || c.operation == 'stage'),
        isEmpty,
      );
      await visibleTap(tester, find.text('Aggiungi tutti allo stage'));
      await visibleTap(tester, find.text('Commit e push…'));
      expect(calls.where((c) => c.operation == 'commit'), isEmpty);
      expect(find.text('+ changed'), findsOneWidget);
      await tester.ensureVisible(find.byType(TextField));
      await tester.enterText(find.byType(TextField), 'Fix app');
      await tester.pumpAndSettle();
      await visibleTap(tester, find.text('Conferma commit, poi push…'));
      expect(calls.where((c) => c.operation == 'commit').length, 1);
      expect(calls.where((c) => c.operation == 'push'), isEmpty);
      expect(find.text('Confermare il push?'), findsOneWidget);
      await tester.tap(find.text('Annulla'));
      await tester.pumpAndSettle();
      expect(calls.where((c) => c.operation == 'push'), isEmpty);
      await visibleTap(tester, find.text('Push…'));
      await tester.tap(find.text('Conferma push'));
      await tester.pumpAndSettle();
      expect(calls.where((c) => c.operation == 'commit').length, 1);
      expect(
        calls.where((c) => c.operation == 'push').single.arguments['confirmed'],
        true,
      );
      expect(find.textContaining('authentication failed'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'offline makes no requests, and running chats cannot stage or commit',
    (tester) async {
      var calls = 0;
      Future<Map<String, dynamic>> request(
        String operation,
        Map<String, dynamic> args,
      ) async {
        calls++;
        if (operation == 'discover') {
          return {
            'repositories': ['one'],
            'truncated': false,
          };
        }
        if (operation == 'status') return status(12);
        throw StateError('Unexpected mutation');
      }

      Widget app(bool online) => MaterialApp(
        theme: auraTheme(),
        home: Scaffold(
          body: SingleChildScrollView(
            child: GitChanges(
              request: request,
              online: online,
              canMutate: false,
            ),
          ),
        ),
      );
      await tester.pumpWidget(app(false));
      await tester.pumpAndSettle();
      expect(calls, 0);
      await tester.pumpWidget(app(true));
      await tester.pumpAndSettle();
      expect(calls, 2);
      expect(
        tester
            .widget<TextButton>(
              find.widgetWithText(TextButton, 'Aggiungi tutti allo stage'),
            )
            .onPressed,
        isNull,
      );
      expect(
        tester
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, 'Commit…'),
            )
            .onPressed,
        isNull,
      );
    },
  );
}
