import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'ui.dart';

const _imageTypes = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'};
const _line = Color(0xff45404d);

class MessageImage {
  const MessageImage(this.name, this.bytes);
  final String name;
  final Uint8List bytes;
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
      );
    } on FormatException {
      result = _unreadable;
    }
  }
  _decoded[file] = result;
  return result is MessageImage ? result : null;
}

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
                ? 'Apri immagine'
                : 'Apri immagine ${i + 1} di ${images.length}',
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
      body: PageView.builder(
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
    );
  }
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
  Widget build(BuildContext context) => InteractiveViewer(
    transformationController: transform,
    maxScale: 5,
    onInteractionEnd: (_) =>
        widget.onZoom(transform.value.getMaxScaleOnAxis() > 1.01),
    child: Center(
      child: Image.memory(
        widget.image.bytes,
        fit: BoxFit.contain,
        gaplessPlayback: true,
        semanticLabel: widget.image.name,
        errorBuilder: (_, _, _) => const Text(
          'Immagine non leggibile.',
          style: TextStyle(color: muted),
        ),
      ),
    ),
  );
}
