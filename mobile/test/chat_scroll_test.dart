import 'package:aurachat_mobile/chat_scroll.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> msg(String role) => {'role': role, 'content': role};

Widget item(double height, [Key? key]) => SizedBox(key: key, height: height);

Future<ScrollController> open(
  WidgetTester tester,
  List<Widget> children, {
  int? anchor,
}) async {
  final controller = ScrollController();
  addTearDown(controller.dispose);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SizedBox(
          height: 600,
          child: ConversationList(
            controller: controller,
            anchorIndex: anchor,
            children: children,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return controller;
}

// Ten earlier messages (1000), the prompt at index 10, then the answer.
List<Widget> chat({double prompt = 100, required double answer}) => [
  for (var i = 0; i < 10; i++) item(100),
  item(prompt),
  item(answer),
];

void main() {
  test('lastPromptIndex is the last user message', () {
    expect(lastPromptIndex([]), isNull);
    expect(lastPromptIndex([msg('assistant')]), isNull);
    expect(
      lastPromptIndex([msg('user'), msg('assistant'), msg('user'), msg('assistant')]),
      2,
    );
  });

  test('landingOffset starts on the prompt, or on the answer if the prompt is tall', () {
    double at(double prompt, {double max = 3000}) => landingOffset(
      top: 1000,
      promptHeight: prompt,
      viewport: 600,
      max: max,
    );
    expect(at(100), 988);
    expect(at(240), 988);
    expect(at(241), 1229);
    expect(at(100, max: 500), 500);
    expect(landingOffset(top: 4, promptHeight: 50, viewport: 600, max: 900), 0);
  });

  testWidgets('a long answer opens on the start of its prompt', (tester) async {
    final controller = await open(tester, chat(answer: 2000), anchor: 10);
    // Prompt top = 20 padding + 1000, minus the gap.
    expect(controller.offset, 1008);
    expect(tester.widget<Opacity>(find.byType(Opacity)).opacity, 1);
  });

  testWidgets('a tall prompt opens on the start of the answer', (tester) async {
    final controller = await open(
      tester,
      chat(prompt: 400, answer: 2000),
      anchor: 10,
    );
    expect(controller.offset, 20 + 1000 + 400 - 12);
  });

  testWidgets('an exchange that fits on screen opens at the bottom', (tester) async {
    final controller = await open(tester, chat(answer: 300), anchor: 10);
    expect(controller.offset, controller.position.maxScrollExtent);
    expect(controller.offset, greaterThan(0));
  });

  testWidgets('without an anchor the chat opens at the bottom', (tester) async {
    final controller = await open(tester, chat(answer: 2000));
    expect(controller.offset, controller.position.maxScrollExtent);
  });

  testWidgets('a lazy list of uneven messages still finds the prompt', (tester) async {
    final children = [
      for (var i = 0; i < 300; i++) item(60 + (i % 9) * 45),
      item(80),
      item(6000),
    ];
    final controller = await open(tester, children, anchor: 300);
    var top = 20.0;
    for (var i = 0; i < 300; i++) {
      top += 60 + (i % 9) * 45;
    }
    expect(controller.offset, top - 12);
  });

  testWidgets('an exchange too long to keep built opens at the bottom', (tester) async {
    final controller = await open(tester, chat(answer: 40000), anchor: 10);
    expect(controller.offset, controller.position.maxScrollExtent);
  });

  testWidgets('later updates never move the scroll', (tester) async {
    final controller = ScrollController();
    addTearDown(controller.dispose);
    Widget host(List<Widget> children) => MaterialApp(
      home: Scaffold(
        body: SizedBox(
          height: 600,
          child: ConversationList(
            controller: controller,
            anchorIndex: 10,
            children: children,
          ),
        ),
      ),
    );
    await tester.pumpWidget(host(chat(answer: 2000)));
    await tester.pumpAndSettle();
    expect(controller.offset, 1008);
    // Streaming grows the answer and a new message arrives below it.
    await tester.pumpWidget(host([...chat(answer: 2600), item(300)]));
    await tester.pumpAndSettle();
    expect(controller.offset, 1008);
  });
}
