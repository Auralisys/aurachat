import 'package:aurachat_mobile/app.dart';
import 'package:aurachat_mobile/message_images.dart';
import 'package:aurachat_mobile/ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_test/flutter_test.dart';

const _png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

Map<String, dynamic> _image(String name) => {
  'name': name,
  'content': '',
  'mime_type': 'image/png',
  'data': _png,
};

Widget _host(Map<String, dynamic> message) => MaterialApp(
  theme: auraTheme(),
  home: Scaffold(body: MessageView(message: message)),
);

void main() {
  test('only readable image attachments become images, decoded once', () {
    final first = _image('schermo.png');
    final images = messageImages([
      first,
      {'name': 'note.txt', 'content': 'testo'},
      {..._image('finta.svg'), 'mime_type': 'image/svg+xml'},
      {..._image('rotta.png'), 'data': 'non base64!'},
      'non una mappa',
    ]);
    expect(images.map((image) => image.name), ['schermo.png']);
    expect(images.single.bytes.take(4), [0x89, 0x50, 0x4e, 0x47]);
    expect(identical(messageImage(first)!.bytes, images.single.bytes), isTrue);
    expect(messageImages(null), isEmpty);
  });

  testWidgets('image-only message shows thumbnails without an empty bubble', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host({
        'role': 'user',
        'content': '',
        'attachments': [_image('uno.png'), _image('due.png')],
      }),
    );
    expect(find.byType(MessageImages), findsOneWidget);
    expect(find.bySemanticsLabel('Apri immagine 1 di 2'), findsOneWidget);
    expect(find.byType(Image), findsNWidgets(2));
    expect(find.byType(MarkdownBody), findsNothing);

    await tester.tap(find.bySemanticsLabel('Apri immagine 2 di 2'));
    await tester.pumpAndSettle();
    expect(find.byType(ImageViewerPage), findsOneWidget);
    expect(find.text('due.png'), findsOneWidget);
    expect(find.text('2 di 2'), findsOneWidget);

    await tester.fling(find.byType(PageView), const Offset(400, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.text('uno.png'), findsOneWidget);
    expect(find.text('1 di 2'), findsOneWidget);

    await tester.tap(find.byType(CloseButton));
    await tester.pumpAndSettle();
    expect(find.byType(ImageViewerPage), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('text with an image keeps the bubble below the thumbnail', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host({
        'role': 'user',
        'content': 'Cosa vedi?',
        'attachments': [_image('foto.png')],
      }),
    );
    expect(find.bySemanticsLabel('Apri immagine'), findsOneWidget);
    expect(find.text('Cosa vedi?'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('Cosa vedi?')).dy,
      greaterThan(tester.getBottomLeft(find.byType(MessageImages)).dy),
    );
    expect(tester.takeException(), isNull);
  });

  test('remote image errors are explained in Italian', () {
    expect(remoteError('images_unsupported'), contains('immagini'));
    expect(remoteError('image_too_large'), contains('6 MB'));
    expect(remoteError('invalid_message_size'), contains('troppo grande'));
  });
}
