import 'dart:convert';
import 'dart:typed_data';

import 'package:aurachat_mobile/attachment_views.dart';
import 'package:aurachat_mobile/composer_attachments.dart';
import 'package:aurachat_mobile/message_images.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;

Matcher _fails(String code) => throwsA(
  isA<AttachmentError>().having((error) => error.code, 'code', code),
);

// RIFF header followed by one chunk whose body starts at offset 20.
Uint8List _webp(String chunk, List<int> body) => Uint8List.fromList([
  ...ascii.encode('RIFF'),
  0, 0, 0, 0,
  ...ascii.encode('WEBP'),
  ...ascii.encode(chunk),
  0, 0, 0, 0,
  ...body,
]);

AttachmentSource _text(String name, [String content = 'x']) =>
    AttachmentSource.bytes(name, utf8.encode(content));

void main() {
  test('image type and size come from the header, as on the PC', () {
    final png = img.encodePng(img.Image(width: 30, height: 20));
    final gif = img.encodeGif(img.Image(width: 30, height: 20));
    final camera = img.Image(width: 40, height: 20);
    camera.exif.imageIfd.orientation = 6;
    final jpeg = img.encodeJpg(camera);

    expect(sniffImage(png), 'image/png');
    expect(imageHeaderSize(png), (width: 30, height: 20));
    expect(sniffImage(gif), 'image/gif');
    expect(imageHeaderSize(gif), (width: 30, height: 20));
    // The EXIF block comes before the frame header and is skipped.
    expect(sniffImage(jpeg), 'image/jpeg');
    expect(imageHeaderSize(jpeg), (width: 40, height: 20));
    for (final webp in [
      _webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x2c, 0x01, 0xc8, 0x00]),
      _webp('VP8L', [0x2f, 0x2b, 0xc1, 0x31, 0x00]),
      _webp('VP8X', [0, 0, 0, 0, 0x2b, 0x01, 0x00, 0xc7, 0x00, 0x00]),
    ]) {
      expect(sniffImage(webp), 'image/webp');
      expect(imageHeaderSize(webp), (width: 300, height: 200));
    }
    expect(sniffImage(utf8.encode('ciao')), isNull);
    expect(imageHeaderSize(Uint8List.sublistView(png, 0, 16)), isNull);
  });

  test('file cards use Italian sizes and count lines like an editor', () {
    expect(fileSizeLabel(1023), '1023 B');
    expect(fileSizeLabel(1024), '1 KB');
    expect(fileSizeLabel(1536), '1,5 KB');
    expect(fileSizeLabel(12 << 10), '12 KB');
    expect(fileSizeLabel(3355443), '3,2 MB');
    expect(MessageFile('a', '').detail, 'File vuoto');
    expect(MessageFile('a', 'uno\n').detail, '4 B · 1 riga');
    expect(MessageFile('a', 'uno\ndue').lines, 2);
    // Images are not files, whatever their name.
    expect(
      messageFiles([
        {'name': 'foto.png', 'mime_type': 'image/png', 'data': 'iVBORw0KGgo='},
        {'name': 'nota.txt', 'content': 'ciao'},
        'non valido',
      ]).map((file) => file.name),
      ['nota.txt'],
    );
  });

  test('names are cleaned, kept within limits and made unique', () {
    expect(imageName(r'C:\DCIM\IMG_0001.HEIC', 'image/jpeg'), 'IMG_0001.jpg');
    expect(imageName('scan.JPEG', 'image/jpeg'), 'scan.JPEG');
    expect(imageName('schermata.webp', 'image/png'), 'schermata.png');
    expect(imageName('', 'image/png'), 'image.png');
    expect(fileName('progetto/note.md'), 'note.md');
    expect(fileName(' \n'), 'file.txt');
    final long = fileName('${'è' * 200}.md');
    expect(utf8.encode(long).length, lessThanOrEqualTo(255));
    expect(long, endsWith('è.md'));
    expect(uniqueName('a.txt', {'a.txt', 'a-2.txt'}), 'a-3.txt');
    expect(uniqueName('README', {'README'}), 'README-2');
  });

  test('only UTF-8 text files up to 128 KB are accepted', () {
    final note = textAttachment('note.md', utf8.encode('ciao è'));
    expect(note.payload, {'name': 'note.md', 'content': 'ciao è'});
    expect(note.size, 7);
    expect(
      () => textAttachment('a.txt', utf8.encode('a\u0000b')),
      _fails('attachment_unsupported'),
    );
    expect(
      () => textAttachment('a.bin', Uint8List.fromList([0xff, 0xfe, 0x00])),
      _fails('attachment_unsupported'),
    );
    expect(
      () => textAttachment('log.txt', utf8.encode('a' * (128 * 1024 + 1))),
      _fails('invalid_attachments'),
    );
    expect(
      () => textAttachment('a.zip', Uint8List(200 * 1024)..fillRange(0, 8, 0xff)),
      _fails('attachment_unsupported'),
    );
  });

  test('a text batch over the limits is rejected whole; restore keeps names unique', () async {
    final errors = <String>[];
    final draft = ComposerAttachments(onError: errors.add);
    await draft.add([_text('a.txt'), _text('a.txt'), _text('b.md')]);
    expect(draft.items.map((file) => file.name), ['a.txt', 'a-2.txt', 'b.md']);

    await draft.add([_text('c.txt'), _text('d.txt')]);
    expect(errors, ['invalid_attachments']);
    expect(draft.items, hasLength(3));

    final sent = draft.take();
    expect(draft.isEmpty, isTrue);
    await draft.add([_text('a.txt', 'nuovo')]);
    draft.restore(sent);
    expect(draft.items.map((file) => file.name), [
      'a.txt',
      'a-2.txt',
      'b.md',
      'a-3.txt',
    ]);
    expect(draft.items.last.content, 'nuovo');
    expect(draft.problem, isNull);
    draft.dispose();
  });

  testWidgets('images are normalized before upload', (tester) async {
    await tester.runAsync(() async {
      final small = img.encodePng(img.Image(width: 10, height: 10));
      final kept = await normalizeImage(small, r'C:\shot.png');
      expect(kept.bytes, same(small));
      expect(kept.name, 'shot.png');
      expect(identical(messageImage(kept.payload)!.bytes, kept.bytes), isTrue);

      final wide = await normalizeImage(
        img.encodePng(img.Image(width: 3000, height: 100)),
        'wide.png',
      );
      expect(wide.mimeType, 'image/png');
      expect(imageHeaderSize(wide.bytes!), (width: 2048, height: 68));

      final camera = img.Image(width: 40, height: 20);
      camera.exif.imageIfd.orientation = 6;
      final source = img.encodeJpg(camera);
      expect(latin1.decode(source), contains('Exif'));
      final photo = await normalizeImage(source, 'IMG_1.jpeg');
      expect(photo.mimeType, 'image/jpeg');
      expect(photo.name, 'IMG_1.jpeg');
      expect(imageHeaderSize(photo.bytes!), (width: 20, height: 40));
      expect(latin1.decode(photo.bytes!), isNot(contains('Exif')));

      await expectLater(
        normalizeImage(Uint8List.fromList([1, 2, 3]), 'rotta.png'),
        _fails('image_unreadable'),
      );
    });
  });

  testWidgets('at most eight images; picked files that are images are routed', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final errors = <String>[];
      final draft = ComposerAttachments(onError: errors.add);
      final png = img.encodePng(img.Image(width: 4, height: 4));
      await draft.add([
        AttachmentSource.bytes('schermata', png),
        for (var i = 0; i < 8; i++)
          AttachmentSource.bytes('foto.png', png, image: true),
      ]);
      expect(errors, ['invalid_attachments']);
      expect(draft.preparing, 0);
      expect(draft.imageRoom, 0);
      expect(draft.items.map((file) => file.name), [
        'schermata.png',
        'foto.png',
        for (var i = 2; i <= 7; i++) 'foto-$i.png',
      ]);
      expect(draft.items.first.payload, {
        'name': 'schermata.png',
        'mime_type': 'image/png',
        'data': base64Encode(png),
        'content': '',
      });
      draft.dispose();
    });
  });
}
