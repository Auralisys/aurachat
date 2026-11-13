import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'ui.dart';

const _imageTypes = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'};
const _line = Color(0xff45404d);

class ImageComment {
  const ImageComment(this.x, this.y, this.text);
  final double x;
  final double y;
  final String text;
}

class MessageImage {
  const MessageImage(
    this.name,
    this.bytes, [
    this.comments = const [],
    this.aspect,
  ]);
  final String name;
  final Uint8List bytes;
  // Desktop comments: points are fractions of the image size, not drawn into it.
  final List<ImageComment> comments;
  final double? aspect;
}

double? _aspect(Object? annotation) {
  if (annotation is! Map) return null;
  final width = annotation['width'], height = annotation['height'];
  if (width is! num || height is! num || width <= 0 || height <= 0) return null;
  return width / height;
}

List<ImageComment> _comments(Object? annotation) {
  if (annotation is! Map || annotation['comments'] is! List) return const [];
  return [
    for (final comment in annotation['comments'] as List)
      if (comment is Map &&
          comment['x'] is num &&
          comment['y'] is num &&
          comment['text'] is String)
        ImageComment(
          (comment['x'] as num).toDouble().clamp(0.0, 1.0),
          (comment['y'] as num).toDouble().clamp(0.0, 1.0),
          comment['text'] as String,
        ),
  ];
}

// Decoded once per attachment map: rebuilds reuse the same bytes, so
// MemoryImage hits the image cache instead of decoding base64 again.
final _decoded = Expando<Object>();
const _unreadable = Object();

MessageImage? messageImage(Object? file) {
  if (file is! Map) return null;
  final cached = _decoded[file];
  if (cached != null) return cached is MessageImage ? cached : null;
  final data = file['data'], type = file['mime_type'];
  Object result = _unreadable;
  if (data is String && data.isNotEmpty && _imageTypes.contains(type)) {
    try {
      result = MessageImage(
        file['name']?.toString() ?? 'Immagine',
        base64Decode(data),
        _comments(file['annotation']),
        _aspect(file['annotation']),
      );
    } on FormatException {
      result = _unreadable;
    }
  }
  _decoded[file] = result;
  return result is MessageImage ? result : null;
}

/// Seeds the cache for an attachment map created on this phone, whose bytes
/// are already in memory.
void rememberMessageImage(Map<Object?, Object?> file, MessageImage image) =>
    _decoded[file] = image;

List<MessageImage> messageImages(Object? attachments) => [
  for (final file in attachments is List ? attachments : const [])
    ?messageImage(file),
];

class MessageImages extends StatelessWidget {
  const MessageImages({super.key, required this.images});
  final List<MessageImage> images;

  @override
  Widget build(BuildContext context) {
    final size = images.length == 1 ? 200.0 : 104.0;
    return Wrap(
      alignment: WrapAlignment.end,
      spacing: 8,
      runSpacing: 8,
      children: [
        for (var i = 0; i < images.length; i++)
          Semantics(
            button: true,
            excludeSemantics: true,
            label: images.length == 1
                ? 'Apri immagine${images[i].comments.isEmpty ? '' : ', ${images[i].comments.length} commenti'}'
                : 'Apri immagine ${i + 1} di ${images.length}${images[i].comments.isEmpty ? '' : ', ${images[i].comments.length} commenti'}',
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: SizedBox.square(
                dimension: size,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    const ColoredBox(color: input),
                    Image.memory(
                      images[i].bytes,
                      fit: BoxFit.cover,
                      gaplessPlayback: true,
                      errorBuilder: (_, _, _) =>
                          const Icon(Icons.broken_image_outlined, color: muted),
                    ),
                    Material(
                      type: MaterialType.transparency,
                      child: InkWell(
                        onTap: () => openImageViewer(context, images, i),
                      ),
                    ),
                    if (images[i].comments.isNotEmpty)
                      Positioned(
                        right: 6,
                        bottom: 6,
                        child: IgnorePointer(
                          child: _CommentCount(images[i].comments.length),
                        ),
                      ),
                    IgnorePointer(
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          border: Border.all(color: _line),
                          borderRadius: BorderRadius.circular(14),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
      ],
    );
  }
}

Future<void> openImageViewer(
  BuildContext context,
  List<MessageImage> images,
  int index,
) => Navigator.of(context).push(
  MaterialPageRoute<void>(
    fullscreenDialog: true,
    builder: (_) => ImageViewerPage(images: images, initial: index),
  ),
);

class ImageViewerPage extends StatefulWidget {
  const ImageViewerPage({super.key, required this.images, this.initial = 0});
  final List<MessageImage> images;
  final int initial;

  @override
  State<ImageViewerPage> createState() => _ImageViewerPageState();
}

class _ImageViewerPageState extends State<ImageViewerPage> {
  late final pages = PageController(initialPage: widget.initial);
  late int index = widget.initial;
  // A zoomed image owns horizontal drags: panning must not change page.
  bool zoomed = false;

  @override
  void dispose() {
    pages.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final count = widget.images.length;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: textColor,
        leading: const CloseButton(),
        title: Text(
          widget.images[index].name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 15, color: textColor),
        ),
        actions: [
          if (count > 1)
            Padding(
              padding: const EdgeInsets.only(right: 16),
              child: Center(
                child: Text(
                  '${index + 1} di $count',
                  style: const TextStyle(
                    color: muted,
                    fontFeatures: [FontFeature.tabularFigures()],
                  ),
                ),
              ),
            ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: PageView.builder(
              controller: pages,
              physics: zoomed ? const NeverScrollableScrollPhysics() : null,
              itemCount: count,
              onPageChanged: (value) => setState(() {
                index = value;
                zoomed = false;
              }),
              itemBuilder: (context, i) => _ZoomableImage(
                image: widget.images[i],
                onZoom: (value) {
                  if (value != zoomed) setState(() => zoomed = value);
                },
              ),
            ),
          ),
          if (widget.images[index].comments.isNotEmpty)
            _CommentList(widget.images[index].comments),
        ],
      ),
    );
  }
}

class _CommentCount extends StatelessWidget {
  const _CommentCount(this.count);
  final int count;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      color: Colors.black87,
      borderRadius: BorderRadius.circular(10),
    ),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.mode_comment_outlined, size: 12, color: textColor),
          const SizedBox(width: 4),
          Text(
            '$count',
            style: const TextStyle(fontSize: 11, color: textColor),
          ),
        ],
      ),
    ),
  );
}

class _Marker extends StatelessWidget {
  const _Marker(this.number);
  final int number;

  @override
  Widget build(BuildContext context) => Container(
    width: 24,
    height: 24,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: const Color(0xff8b5cf6),
      shape: BoxShape.circle,
      border: Border.all(color: Colors.white, width: 2),
    ),
    child: Text(
      '$number',
      style: const TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w600,
        color: Colors.white,
      ),
    ),
  );
}

class _CommentList extends StatelessWidget {
  const _CommentList(this.comments);
  final List<ImageComment> comments;

  @override
  Widget build(BuildContext context) => ConstrainedBox(
    constraints: BoxConstraints(
      maxHeight: MediaQuery.sizeOf(context).height * 0.3,
    ),
    child: DecoratedBox(
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: _line)),
      ),
      child: ListView.separated(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        itemCount: comments.length,
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (_, i) => Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ExcludeSemantics(child: _Marker(i + 1)),
            const SizedBox(width: 10),
            Expanded(
              child: Semantics(
                label: 'Commento ${i + 1}',
                child: Text(
                  comments[i].text,
                  style: const TextStyle(color: textColor, height: 1.35),
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

class _ZoomableImage extends StatefulWidget {
  const _ZoomableImage({required this.image, required this.onZoom});
  final MessageImage image;
  final ValueChanged<bool> onZoom;

  @override
  State<_ZoomableImage> createState() => _ZoomableImageState();
}

class _ZoomableImageState extends State<_ZoomableImage> {
  final transform = TransformationController();

  @override
  void dispose() {
    transform.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final image = Image.memory(
      widget.image.bytes,
      fit: widget.image.aspect == null ? BoxFit.contain : BoxFit.fill,
      gaplessPlayback: true,
      semanticLabel: widget.image.name,
      errorBuilder: (_, _, _) => const Text(
        'Immagine non leggibile.',
        style: TextStyle(color: muted),
      ),
    );
    final aspect = widget.image.aspect;
    final comments = widget.image.comments;
    return InteractiveViewer(
      transformationController: transform,
      maxScale: 5,
      onInteractionEnd: (_) =>
          widget.onZoom(transform.value.getMaxScaleOnAxis() > 1.01),
      child: Center(
        child: aspect == null || comments.isEmpty
            ? image
            : AspectRatio(
                aspectRatio: aspect,
                child: LayoutBuilder(
                  builder: (context, box) => Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Positioned.fill(child: image),
                      for (var i = 0; i < comments.length; i++)
                        Positioned(
                          left: comments[i].x * box.maxWidth - 12,
                          top: comments[i].y * box.maxHeight - 12,
                          child: ExcludeSemantics(child: _Marker(i + 1)),
                        ),
                    ],
                  ),
                ),
              ),
      ),
    );
  }
}
