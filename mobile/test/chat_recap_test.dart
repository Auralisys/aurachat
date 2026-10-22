import 'dart:async';
import 'dart:convert';

import 'package:aurachat_mobile/chat_recap.dart';
import 'package:aurachat_mobile/ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'recap includes only final outputs, nested agents and unique web sources',
    () {
      Map<String, dynamic> tool(String action, Object output) => {
        'kind': 'tool',
        'action': action,
        'status': 'completed',
        'output': jsonEncode(output),
      };
      final publication = tool('publish_project_output', {
        'path': r'C:\project\report.md',
        'final_output': true,
        'written_bytes': 30,
      });
      final recap = ChatRecap([
        {
          'role': 'user',
          'content':
              'Vedi https://example.com/report e https://example.com/report',
          'attachments': [
            {'name': 'notes.txt', 'content': 'Appunti'},
          ],
        },
        {
          'role': 'assistant',
          'activity': [
            tool('write_project_file', {
              'path': 'scratch.ps1',
              'written_bytes': 12,
            }),
            publication,
            tool('fetch_web_page', {'url': 'https://example.com/report'}),
            {
              'kind': 'agent',
              'id': 'a',
              'title': 'Ricerca',
              'activity': [publication],
            },
            tool('publish_project_output', {
              'path': 'fake.md',
              'final_output': false,
            }),
          ],
        },
        {
          'role': 'assistant',
          'activity': [
            {
              'kind': 'agent',
              'id': 'a',
              'title': 'Ricerca',
              'status': 'completed',
            },
            tool('fetch_web_page', {'url': 'file:///secret'}),
          ],
        },
      ]);
      expect(recap.sources.length, 2);
      expect(recap.sources.first['url'], 'https://example.com/report');
      expect(recap.outputs.single['path'], r'C:\project\report.md');
      expect(recap.agents.single['status'], 'completed');
    },
  );

  testWidgets(
    'offline recap remains readable on a narrow screen with large text',
    (tester) async {
      tester.view.physicalSize = const Size(360, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var calls = 0;
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
          home: ChatRecapPage(
            title:
                'Una chat con un titolo molto lungo in un progetto multi repo',
            conversationId: 'c',
            pcName: 'PC di lavoro',
            online: false,
            protocol: 4,
            hasProject: true,
            messages: const [
              {'role': 'user', 'content': 'https://example.com/docs'},
            ],
            request: (_, _) async {
              calls++;
              return {};
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(calls, 0);
      expect(find.textContaining('Aggiorna AuraChat sul PC'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Fonti · 1'), 160);
      await tester.ensureVisible(find.text('Fonti · 1'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Fonti · 1'));
      await tester.pumpAndSettle();
      expect(find.text('example.com'), findsOneWidget);
      expect(find.text('Nuova chat'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'recap follows new messages and a live turn that starts after opening',
    (tester) async {
      final messages = StreamController<List<Map<String, dynamic>>>();
      final live = StreamController<List<Map<String, dynamic>>>();
      addTearDown(messages.close);
      addTearDown(live.close);
      await tester.pumpWidget(
        MaterialApp(
          theme: auraTheme(),
          home: ChatRecapPage(
            title: 'Chat',
            conversationId: 'c',
            pcName: 'PC',
            online: false,
            protocol: 5,
            hasProject: false,
            messages: const [],
            messagesStream: messages.stream,
            liveStream: live.stream,
            request: (_, _) async => {},
          ),
        ),
      );
      messages.add([
        {'role': 'user', 'content': 'https://example.com'},
      ]);
      live.add([
        {
          'conversation_id': 'c',
          'status': 'running',
          'updated_at': DateTime.now().millisecondsSinceEpoch,
          'activity': [
            {
              'kind': 'agent',
              'id': 'a',
              'title': 'Analisi',
              'status': 'running',
            },
          ],
        },
      ]);
      await tester.pumpAndSettle();
      expect(find.text('Fonti · 1'), findsOneWidget);
      expect(find.text('Agenti · 1'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
