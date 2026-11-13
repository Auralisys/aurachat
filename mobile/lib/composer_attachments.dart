import 'dart:async';
import 'dart:convert';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;

import 'message_images.dart';

/// Same limits as the desktop composer (`images.js`, `attachFiles`) and the
/// backend `validate_attachments`: the PC re-checks everything.
abstract final class AttachmentLimits {
  static const images = 8;
  static const texts = 4;
  static const textBytes = 128 << 10;
  static const textTotal = 256 << 10;
  // Base64 characters of all images in one message.
  static const imageData = 6 << 20;
  // Vision models downscale to about 1.3 MP: larger uploads only cost bandwidth.
  static const side = 2048;
  static const pixels = 1.7e6;
  static const imageBytes = 512 << 10;
  static const source = 20 << 20;
}

class AttachmentError implements Exception {
  const AttachmentError(this.code);
  final String code;
  @override
  String toString() => code;
}

/// A draft attachment. [payload] has the desktop wire shape:
/// `{name, content}` for text files, `{name, mime_type, data, content: ''}`
/// for images.
class ComposerAttachment {
  ComposerAttachment.text(this.name, this.content)
    : mimeType = null,
      data = null,
      bytes = null,
      width = 0,
      height = 0,
      size = utf8.encode(content).length;

  ComposerAttachment.image(
    this.name,
    String this.mimeType,
    Uint8List this.bytes,
    this.width,
    this.height,
  ) : content = '',
      data = base64Encode(bytes),
      size = bytes.length;

  ComposerAttachment._renamed(ComposerAttachment source, this.name)
    : content = source.content,
      mimeType = source.mimeType,
      data = source.data,
      bytes = source.bytes,
      width = source.width,
      height = source.height,
      size = source.size;

  final String name;
  final String content;
  final String? mimeType;
  final String? data;
  final Uint8List? bytes;
  final int width, height;

  /// UTF-8 bytes for text files, encoded bytes for images.
  final int size;

  bool get isImage => data != null;

  ComposerAttachment named(String value) =>
      value == name ? this : ComposerAttachment._renamed(this, value);

  // One stable map per attachment: message bubbles cache decoded images by
  // map identity, so local previews never decode base64 again.
  late final Map<String, dynamic> payload = () {
    if (!isImage) return <String, dynamic>{'name': name, 'content': content};
    final map = <String, dynamic>{
      'name': name,
      'mime_type': mimeType,
      'data': data,
      'content': '',
    };
    rememberMessageImage(map, MessageImage(name, bytes!));
    return map;
  }();
}

// ===== Format checks =====

bool _tag(Uint8List bytes, int offset, String text) {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (var i = 0; i < text.length; i++) {
    if (bytes[offset + i] != text.codeUnitAt(i)) return false;
  }
  return true;
}

/// Same signatures as the backend: the declared type must match the content.
String? sniffImage(Uint8List bytes) {
  if (bytes.isNotEmpty && bytes[0] == 0x89 && _tag(bytes, 1, 'PNG\r\n\x1a\n')) {
    return 'image/png';
  }
  if (bytes.length >= 3 &&
      bytes[0] == 0xff &&
      bytes[1] == 0xd8 &&
      bytes[2] == 0xff) {
    return 'image/jpeg';
  }
  if (_tag(bytes, 0, 'GIF87a') || _tag(bytes, 0, 'GIF89a')) return 'image/gif';
  if (_tag(bytes, 0, 'RIFF') && _tag(bytes, 8, 'WEBP')) return 'image/webp';
  return null;
}

/// Pixel size from the file header, without decoding the image.
({int width, int height})? imageHeaderSize(Uint8List bytes) {
  bool has(int offset, int length) =>
      offset >= 0 && offset + length <= bytes.length;
  int be16(int i) => has(i, 2) ? (bytes[i] << 8) | bytes[i + 1] : 0;
  int le16(int i) => has(i, 2) ? bytes[i] | (bytes[i + 1] << 8) : 0;
  int le24(int i) => has(i, 3)
      ? bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16)
      : -1;
  int be32(int i) => has(i, 4)
      ? (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]
      : 0;
  ({int width, int height})? size(int width, int height) =>
      width > 0 && height > 0 ? (width: width, height: height) : null;
  switch (sniffImage(bytes)) {
    case 'image/png':
      return _tag(bytes, 12, 'IHDR') ? size(be32(16), be32(20)) : null;
    case 'image/gif':
      return size(le16(6), le16(8));
    case 'image/webp':
      if (_tag(bytes, 12, 'VP8 ')) {
        return size(le16(26) & 0x3fff, le16(28) & 0x3fff);
      }
      if (_tag(bytes, 12, 'VP8L') && has(21, 4)) {
        final bits =
            bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
        return size((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
      }
      if (_tag(bytes, 12, 'VP8X')) return size(le24(24) + 1, le24(27) + 1);
      return null;
    case 'image/jpeg':
      var i = 2;
      while (true) {
        if (!has(i, 2) || bytes[i] != 0xff) return null;
        while (has(i + 1, 1) && bytes[i + 1] == 0xff) {
          i++;
        }
        if (!has(i + 1, 1)) return null;
        final marker = bytes[i + 1];
        if (marker == 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
          i += 2;
          continue;
        }
        if (marker == 0xda || !has(i + 2, 2)) return null;
        final length = be16(i + 2);
        if (length < 2) return null;
        if (marker >= 0xc0 &&
            marker <= 0xcf &&
            marker != 0xc4 &&
            marker != 0xc8 &&
            marker != 0xcc) {
          return size(be16(i + 7), be16(i + 5));
        }
        i += 2 + length;
      }
    default:
      return null;
  }
}

const _imageExtensions = {
  'png',
  'jpg',
  'jpeg',
  'jpe',
  'jfif',
  'gif',
  'webp',
  'heic',
  'heif',
  'avif',
  'bmp',
};

/// Phone galleries also hold HEIC/AVIF photos: they are decoded and sent as JPEG.
bool hasImageExtension(String name) {
  final dot = name.lastIndexOf('.');
  return dot >= 0 &&
      _imageExtensions.contains(name.substring(dot + 1).toLowerCase());
}

final _controls = RegExp(r'[\u0000-\u001f\u007f]');

String _baseName(String name) =>
    name.split(RegExp(r'[\\/]')).last.replaceAll(_controls, '').trim();

String imageName(String name, String type) {
  const extensions = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  final match = RegExp(
    r'^(.*?)(\.[^.]*)?$',
    dotAll: true,
  ).firstMatch(_baseName(name));
  final stem = (match?.group(1) ?? '').trim(), suffix = match?.group(2) ?? '';
  final base = stem.isEmpty ? 'image' : String.fromCharCodes(stem.runes.take(60));
  final keep =
      type == 'image/jpeg' &&
      RegExp(r'^\.jpe?g$', caseSensitive: false).hasMatch(suffix);
  return base + (keep ? suffix : extensions[type]!);
}

/// Text file names stay as picked, within the backend's 255 bytes.
String fileName(String name) {
  final clean = _baseName(name);
  if (clean.isEmpty) return 'file.txt';
  if (utf8.encode(clean).length <= 255) return clean;
  final dot = clean.lastIndexOf('.');
  final suffix = dot > 0 && clean.length - dot <= 16 ? clean.substring(dot) : '';
  var budget = 255 - utf8.encode(suffix).length;
  final stem = StringBuffer();
  for (final rune in clean.substring(0, clean.length - suffix.length).runes) {
    final char = String.fromCharCode(rune);
    budget -= utf8.encode(char).length;
    if (budget < 0) break;
    stem.write(char);
  }
  return '$stem$suffix';
}

String uniqueName(String name, Set<String> taken) {
  if (!taken.contains(name)) return name;
  final dot = name.lastIndexOf('.');
  final stem = dot > 0 ? name.substring(0, dot) : name;
  final suffix = dot > 0 ? name.substring(dot) : '';
  var index = 2;
  while (taken.contains('$stem-$index$suffix')) {
    index++;
  }
  return '$stem-$index$suffix';
}

// A large file is still "text" when its start is valid UTF-8 without NUL:
// it then fails on size, not on format.
bool _looksLikeText(Uint8List bytes) {
  var end = math.min(bytes.length, 4096);
  if (end < bytes.length) {
    var start = end;
    while (start > 0 && end - start < 3 && (bytes[start - 1] & 0xc0) == 0x80) {
      start--;
    }
    if (start > 0 && bytes[start - 1] >= 0xc0) end = start - 1;
  }
  try {
    return !utf8.decode(Uint8List.sublistView(bytes, 0, end)).contains('\u0000');
  } on FormatException {
    return false;
  }
}

ComposerAttachment textAttachment(String name, Uint8List bytes) {
  if (bytes.length > AttachmentLimits.textBytes) {
    throw AttachmentError(
      _looksLikeText(bytes) ? 'invalid_attachments' : 'attachment_unsupported',
    );
  }
  final String content;
  try {
    content = utf8.decode(bytes);
  } on FormatException {
    throw const AttachmentError('attachment_unsupported');
  }
  if (content.contains('\u0000')) {
    throw const AttachmentError('attachment_unsupported');
  }
  return ComposerAttachment.text(fileName(name), content);
}

// ===== Image normalization =====

/// Decodes the image once, then sends small originals untouched and
/// re-encodes the rest. JPEG and unknown types (HEIC, AVIF...) are always
/// re-encoded: the engine applies EXIF rotation and location metadata is dropped.
Future<ComposerAttachment> normalizeImage(Uint8List bytes, String name) async {
  if (bytes.isEmpty) throw const AttachmentError('image_unreadable');
  if (bytes.length > AttachmentLimits.source) {
    throw const AttachmentError('image_too_large');
  }
  final type = sniffImage(bytes);
  final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
  final ui.ImageDescriptor descriptor;
  try {
    descriptor = await ui.ImageDescriptor.encoded(buffer);
  } catch (_) {
    throw const AttachmentError('image_unreadable');
  } finally {
    buffer.dispose();
  }
  try {
    final width = descriptor.width, height = descriptor.height;
    if (width <= 0 || height <= 0) {
      throw const AttachmentError('image_unreadable');
    }
    final header = imageHeaderSize(bytes);
    final fits =
        math.max(width, height) <= AttachmentLimits.side &&
        width * height <= AttachmentLimits.pixels;
    if (type != null &&
        type != 'image/jpeg' &&
        fits &&
        bytes.length <= AttachmentLimits.imageBytes &&
        header?.width == width &&
        header?.height == height) {
      // Decode once to reject corrupt data; GIF animations stay intact.
      (await _frame(descriptor, width, height)).dispose();
      return ComposerAttachment.image(
        imageName(name, type),
        type,
        bytes,
        width,
        height,
      );
    }
    return await _encode(descriptor, width, height, type, name);
  } finally {
    descriptor.dispose();
  }
}

Future<ui.Image> _frame(ui.ImageDescriptor descriptor, int width, int height) async {
  final ui.Codec codec;
  try {
    codec = await descriptor.instantiateCodec(
      targetWidth: width,
      targetHeight: height,
    );
  } catch (_) {
    throw const AttachmentError('image_unreadable');
  }
  try {
    return (await codec.getNextFrame()).image;
  } catch (_) {
    throw const AttachmentError('image_unreadable');
  } finally {
    codec.dispose();
  }
}

Future<ComposerAttachment> _encode(
  ui.ImageDescriptor descriptor,
  int width,
  int height,
  String? source,
  String name,
) async {
  var scale = math.min(
    1.0,
    math.min(
      AttachmentLimits.side / math.max(width, height),
      math.sqrt(AttachmentLimits.pixels / (width * height)),
    ),
  );
  var type = source == null || source == 'image/jpeg'
      ? 'image/jpeg'
      : 'image/png';
  var quality = 85;
  ui.Image? frame;
  var frameScale = 0.0;
  try {
    for (var attempt = 0; attempt < 8; attempt++) {
      if (frame == null || frameScale != scale) {
        frame?.dispose();
        frame = null;
        // The engine decodes straight to the target size: large photos never
        // exist in memory at full resolution.
        frame = await _frame(
          descriptor,
          math.max(1, (width * scale).round()),
          math.max(1, (height * scale).round()),
        );
        frameScale = scale;
      }
      final output = type == 'image/png'
          ? await _png(frame)
          : await _jpeg(frame, quality);
      final actual = sniffImage(output);
      if (actual == null) throw const AttachmentError('image_unreadable');
      if (output.length <= AttachmentLimits.imageBytes) {
        return ComposerAttachment.image(
          imageName(name, actual),
          actual,
          output,
          frame.width,
          frame.height,
        );
      }
      if (type == 'image/png') {
        type = 'image/jpeg';
      } else if (quality > 60) {
        quality = 60;
      } else {
        scale *= 0.75;
      }
    }
  } finally {
    frame?.dispose();
  }
  throw const AttachmentError('image_too_large');
}

Future<Uint8List> _png(ui.Image frame) async {
  final data = await frame.toByteData(format: ui.ImageByteFormat.png);
  if (data == null) throw const AttachmentError('image_unreadable');
  return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
}

Future<Uint8List> _jpeg(ui.Image frame, int quality) async {
  final data = await frame.toByteData(format: ui.ImageByteFormat.rawRgba);
  if (data == null) throw const AttachmentError('image_unreadable');
  return _jpegInBackground(
    data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
    frame.width,
    frame.height,
    quality,
  );
}

// Kept apart so the isolate closure captures only sendable values.
Future<Uint8List> _jpegInBackground(
  Uint8List rgba,
  int width,
  int height,
  int quality,
) => Isolate.run(() => encodeJpegRgba(rgba, width, height, quality));

/// JPEG has no alpha: premultiplied pixels are flattened on white, as image
/// viewers do. A fresh image carries no EXIF block.
@visibleForTesting
Uint8List encodeJpegRgba(Uint8List rgba, int width, int height, int quality) {
  final rgb = Uint8List(width * height * 3);
  for (var i = 0, j = 0; i + 3 < rgba.length && j + 2 < rgb.length; i += 4, j += 3) {
    final blank = 255 - rgba[i + 3];
    rgb[j] = math.min(255, rgba[i] + blank);
    rgb[j + 1] = math.min(255, rgba[i + 1] + blank);
    rgb[j + 2] = math.min(255, rgba[i + 2] + blank);
  }
  final image = img.Image.fromBytes(
    width: width,
    height: height,
    bytes: rgb.buffer,
    numChannels: 3,
  );
  return img.encodeJpg(
    image,
    quality: quality,
    chroma: img.JpegChroma.yuv420,
  );
}

// ===== Draft =====

/// A picked file, read only when its turn comes: up to 8 photos of 20 MB
/// never sit in memory together.
class AttachmentSource {
  const AttachmentSource(this.name, this.read, {this.size, this.image = false});
  AttachmentSource.bytes(this.name, Uint8List bytes, {this.image = false})
    : read = (() async => bytes),
      size = bytes.length;
  final String name;
  final Future<Uint8List> Function() read;
  final int? size;

  /// From the photo picker or the camera.
  final bool image;
}

/// Composer attachments. Text files are added at once; images are prepared
/// one at a time in the background, like on the desktop.
class ComposerAttachments extends ChangeNotifier {
  ComposerAttachments({this.onError});

  /// First problem of each [add] call, as a `remoteError` code.
  void Function(String code)? onError;
  final _items = <ComposerAttachment>[];
  int _preparing = 0;
  Future<void> _work = Future.value();
  bool _disposed = false;

  List<ComposerAttachment> get items => List.unmodifiable(_items);
  bool get isEmpty => _items.isEmpty;
  bool get isNotEmpty => _items.isNotEmpty;

  /// Images still being prepared: sending waits for them.
  int get preparing => _preparing;
  int get imageRoom =>
      AttachmentLimits.images -
      _items.where((file) => file.isImage).length -
      _preparing;

  Set<String> get _names => {for (final file in _items) file.name};

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  void remove(ComposerAttachment file) {
    if (_items.remove(file)) _changed();
  }

  /// Hands the ready attachments to a message and empties the draft.
  List<ComposerAttachment> take() {
    final files = List.of(_items);
    _items.clear();
    _changed();
    return files;
  }

  /// Puts back attachments of a message that was not sent, before the ones
  /// added meanwhile. Limits are checked again when sending.
  void restore(List<ComposerAttachment> files) {
    if (files.isEmpty) return;
    final current = List.of(_items);
    _items
      ..clear()
      ..addAll(files);
    for (final file in current) {
      if (!files.contains(file)) _items.add(file.named(uniqueName(file.name, _names)));
    }
    _changed();
  }

  /// The limits a draft breaks, as a `remoteError` code, or null.
  String? get problem {
    final texts = _items.where((file) => !file.isImage).toList();
    final images = _items.where((file) => file.isImage).toList();
    if (texts.length > AttachmentLimits.texts ||
        images.length > AttachmentLimits.images ||
        texts.fold(0, (sum, file) => sum + file.size) >
            AttachmentLimits.textTotal) {
      return 'invalid_attachments';
    }
    if (images.fold(0, (sum, file) => sum + file.data!.length) >
        AttachmentLimits.imageData) {
      return 'image_too_large';
    }
    return null;
  }

  Future<void> add(List<AttachmentSource> sources) async {
    var reported = false;
    void report(String code) {
      if (reported || _disposed) return;
      reported = true;
      onError?.call(code);
    }

    final images = <AttachmentSource>[];
    final texts = <ComposerAttachment>[];
    for (final source in sources) {
      if (source.image || hasImageExtension(source.name)) {
        images.add(source);
        continue;
      }
      try {
        if ((source.size ?? 0) > AttachmentLimits.source) {
          throw const AttachmentError('attachment_unsupported');
        }
        final bytes = await source.read();
        if (sniffImage(bytes) != null) {
          images.add(AttachmentSource.bytes(source.name, bytes, image: true));
        } else {
          texts.add(textAttachment(source.name, bytes));
        }
      } on AttachmentError catch (e) {
        report(e.code);
      } catch (_) {
        report('attachment_unreadable');
      }
    }
    if (_disposed) return;
    if (texts.isNotEmpty) {
      final all = [..._items.where((file) => !file.isImage), ...texts];
      if (all.length > AttachmentLimits.texts ||
          all.fold(0, (sum, file) => sum + file.size) >
              AttachmentLimits.textTotal) {
        report('invalid_attachments');
      } else {
        for (final file in texts) {
          _items.add(file.named(uniqueName(file.name, _names)));
        }
        _changed();
      }
    }
    if (images.isNotEmpty) await _addImages(images, report);
  }

  Future<void> _addImages(
    List<AttachmentSource> sources,
    void Function(String code) report,
  ) async {
    final accepted = sources.take(math.max(0, imageRoom)).toList();
    if (accepted.length < sources.length) report('invalid_attachments');
    if (accepted.isEmpty) return;
    _preparing += accepted.length;
    _changed();
    for (final source in accepted) {
      final job = _work.then((_) => _prepare(source));
      _work = job.then<void>((_) {}, onError: (_) {});
      ComposerAttachment? file;
      try {
        file = await job;
      } on AttachmentError catch (e) {
        report(e.code);
      } catch (_) {
        report('image_unreadable');
      }
      if (_disposed) return;
      _preparing--;
      if (file != null) {
        final total = _items
            .where((item) => item.isImage)
            .fold(0, (sum, item) => sum + item.data!.length);
        if (total + file.data!.length > AttachmentLimits.imageData) {
          report('image_too_large');
        } else {
          _items.add(file.named(uniqueName(file.name, _names)));
        }
      }
      _changed();
    }
  }

  Future<ComposerAttachment> _prepare(AttachmentSource source) async {
    if ((source.size ?? 0) > AttachmentLimits.source) {
      throw const AttachmentError('image_too_large');
    }
    return normalizeImage(await source.read(), source.name);
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
