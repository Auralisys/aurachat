import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'composer_attachments.dart';
import 'message_images.dart';
import 'ui.dart';

const _line = Color(0xff45404d);
const _imageTypes = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'};
const _tile = 72.0;

/// A text file attached to a message: `{name, content}` without image data.
class MessageFile {
  MessageFile(this.name, this.content);
  final String name;
  final String content;
  late final int size = utf8.encode(content).length;
  late final int lines = content.isEmpty
      ? 0
      : '\n'.allMatches(content).length + (content.endsWith('\n') ? 0 : 1);

  String get detail => lines == 0
      ? 'File vuoto'
      : '${fileSizeLabel(size)} · ${lines == 1 ? '1 riga' : '$lines righe'}';
}

// Built once per attachment map, like decoded images: rebuilds never count
// the lines of a 128 KB file again.
final _files = Expando<Object>();
const _notFile = Object();

MessageFile? messageFile(Object? file) {
  if (file is! Map) return null;
  final cached = _files[file];
  if (cached != null) return cached is MessageFile ? cached : null;
  final data = file['data'], content = file['content'];
  final name = file['name']?.toString().trim() ?? '';
  // Same rule as the desktop: whatever is not an image is shown as a file.
  final Object result = data is String && _imageTypes.contains(file['mime_type'])
      ? _notFile
      : MessageFile(
          name.isEmpty ? 'File' : name,
          content is String ? content : '',
        );
  _files[file] = result;
  return result is MessageFile ? result : null;
}

List<MessageFile> messageFiles(Object? attachments) => [
  for (final file in attachments is List ? attachments : const [])
    ?messageFile(file),
];

/// `512 B`, `1,5 KB`, `12 KB`, `3,2 MB`.
String fileSizeLabel(int bytes) {
  if (bytes < 1024) return '$bytes B';
  var value = bytes / 1024, unit = 'KB';
  if (value >= 1024) {
    value /= 1024;
    unit = 'MB';
  }
  final fixed = value.toStringAsFixed(value < 10 ? 1 : 0);
  final number = fixed.endsWith('.0')
      ? fixed.substring(0, fixed.length - 2)
      : fixed.replaceFirst('.', ',');
  return '$number $unit';
}

/// Draft attachments above the composer text: photos as thumbnails, text files
/// as cards and one placeholder for each image still being prepared.
class ComposerAttachmentStrip extends StatelessWidget {
  const ComposerAttachmentStrip({
    super.key,
    required this.files,
    required this.onRemove,
    this.preparing = 0,
  });
  final List<ComposerAttachment> files;
  final int preparing;
  final ValueChanged<ComposerAttachment> onRemove;

  @override
  Widget build(BuildContext context) {
    final still = MediaQuery.disableAnimationsOf(context);
    final images = [
      for (final file in files)
        if (file.isImage) file,
    ];
    return AnimatedSize(
      duration: still ? Duration.zero : const Duration(milliseconds: 180),
      curve: Curves.easeOutCubic,
      alignment: Alignment.topCenter,
      child: files.isEmpty && preparing == 0
          ? const SizedBox(width: double.infinity)
          : SingleChildScrollView(
              key: const ValueKey('composer-attachments'),
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(6, 6, 6, 2),
              child: Row(
                spacing: 8,
                children: [
                  for (final file in files)
                    _Appear(
                      key: ObjectKey(file),
                      still: still,
                      child: file.isImage
                          ? _ImageTile(
                              file: file,
                              onOpen: () => openImageViewer(context, [
                                for (final image in images)
                                  messageImage(image.payload)!,
                              ], images.indexOf(file)),
                              onRemove: () => onRemove(file),
                            )
                          : _FileTile(file: file, onRemove: () => onRemove(file)),
                    ),
                  for (var i = 0; i < preparing; i++)
                    _Appear(
                      key: ValueKey(('preparing', i)),
                      still: still,
                      child: const _PreparingTile(),
                    ),
                ],
              ),
            ),
    );
  }
}

class _Appear extends StatelessWidget {
  const _Appear({super.key, required this.child, this.still = false});
  final Widget child;
  final bool still;

  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
    tween: Tween(begin: 0, end: 1),
    duration: still ? Duration.zero : const Duration(milliseconds: 160),
    curve: Curves.easeOutCubic,
    child: child,
    builder: (context, t, child) => Opacity(
      opacity: t,
      child: Transform.scale(scale: .94 + .06 * t, child: child),
    ),
  );
}

class _ImageTile extends StatelessWidget {
  const _ImageTile({
    required this.file,
    required this.onOpen,
    required this.onRemove,
  });
  final ComposerAttachment file;
  final VoidCallback onOpen, onRemove;

  @override
  Widget build(BuildContext context) {
    // Decoded at thumbnail size, along the side that BoxFit.cover fills.
    final target = (_tile * MediaQuery.devicePixelRatioOf(context)).round();
    final landscape = file.width >= file.height;
    return SizedBox.square(
      dimension: _tile,
      child: Stack(
        fit: StackFit.expand,
        children: [
          Semantics(
            button: true,
            excludeSemantics: true,
            label: 'Apri ${file.name}',
            onTap: onOpen,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  const ColoredBox(color: panel),
                  Image.memory(
                    file.bytes!,
                    fit: BoxFit.cover,
                    gaplessPlayback: true,
                    cacheWidth: landscape ? null : target,
                    cacheHeight: landscape ? target : null,
                    errorBuilder: (_, _, _) =>
                        const Icon(Icons.broken_image_outlined, color: muted),
                  ),
                  Material(
                    type: MaterialType.transparency,
                    child: InkWell(onTap: onOpen),
                  ),
                  const IgnorePointer(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        border: Border.fromBorderSide(BorderSide(color: _line)),
                        borderRadius: BorderRadius.all(Radius.circular(14)),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          Positioned(
            top: 0,
            right: 0,
            child: _RemoveButton(name: file.name, onPressed: onRemove, scrim: true),
          ),
        ],
      ),
    );
  }
}

class _FileTile extends StatelessWidget {
  const _FileTile({required this.file, required this.onRemove});
  final ComposerAttachment file;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final info = messageFile(file.payload)!;
    void open() => openTextFile(context, info);
    return SizedBox(
      width: 212,
      height: _tile,
      child: Material(
        color: panel,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: const BorderSide(color: _line),
        ),
        clipBehavior: Clip.antiAlias,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: Semantics(
                button: true,
                excludeSemantics: true,
                label: 'Apri ${info.name}, ${info.detail}',
                onTap: open,
                child: InkWell(
                  onTap: open,
                  child: Padding(
                    padding: const EdgeInsets.only(left: 12),
                    child: _FileLabel(info),
                  ),
                ),
              ),
            ),
            Center(child: _RemoveButton(name: file.name, onPressed: onRemove)),
            const SizedBox(width: 4),
          ],
        ),
      ),
    );
  }
}

class _RemoveButton extends StatelessWidget {
  const _RemoveButton({
    required this.name,
    required this.onPressed,
    this.scrim = false,
  });
  final String name;
  final VoidCallback onPressed;
  // Over a photo the cross needs its own dark disc to stay visible.
  final bool scrim;

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: 'Rimuovi $name',
    onPressed: onPressed,
    style: IconButton.styleFrom(
      fixedSize: const Size.square(40),
      minimumSize: const Size.square(40),
      padding: EdgeInsets.zero,
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      shape: const CircleBorder(),
      foregroundColor: scrim ? Colors.white : muted,
    ),
    icon: scrim
        ? const DecoratedBox(
            decoration: BoxDecoration(
              color: Color(0x99000000),
              shape: BoxShape.circle,
            ),
            child: Padding(
              padding: EdgeInsets.all(3),
              child: Icon(Icons.close_rounded, size: 16),
            ),
          )
        : const Icon(Icons.close_rounded, size: 18),
  );
}

class _PreparingTile extends StatelessWidget {
  const _PreparingTile();

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Preparazione immagine',
    excludeSemantics: true,
    child: Container(
      width: _tile,
      height: _tile,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: panel,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: _line),
      ),
      child: const SizedBox.square(
        dimension: 18,
        child: CircularProgressIndicator(strokeWidth: 2, color: orchid),
      ),
    ),
  );
}

class _FileIcon extends StatelessWidget {
  const _FileIcon();

  @override
  Widget build(BuildContext context) => Container(
    width: 36,
    height: 36,
    decoration: BoxDecoration(
      color: violet.withValues(alpha: .18),
      borderRadius: BorderRadius.circular(10),
    ),
    child: const Icon(Icons.description_outlined, size: 18, color: orchid),
  );
}

class _FileLabel extends StatelessWidget {
  const _FileLabel(this.file);
  final MessageFile file;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      const _FileIcon(),
      const SizedBox(width: 10),
      Flexible(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              file.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 13,
                height: 1.3,
                fontWeight: FontWeight.w600,
                color: textColor,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              file.detail,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12, height: 1.3, color: muted),
            ),
          ],
        ),
      ),
    ],
  );
}

/// Text files of a message, under its text as on the desktop.
class MessageFiles extends StatelessWidget {
  const MessageFiles({super.key, required this.files});
  final List<MessageFile> files;

  @override
  Widget build(BuildContext context) => Wrap(
    alignment: WrapAlignment.end,
    spacing: 8,
    runSpacing: 8,
    children: [
      for (final file in files)
        ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48, maxWidth: 260),
          child: Semantics(
            button: true,
            excludeSemantics: true,
            label: 'Apri file ${file.name}, ${file.detail}',
            onTap: () => openTextFile(context, file),
            child: Material(
              color: panel,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
                side: const BorderSide(color: _line),
              ),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: () => openTextFile(context, file),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(8, 8, 14, 8),
                  child: _FileLabel(file),
                ),
              ),
            ),
          ),
        ),
    ],
  );
}

Future<void> openTextFile(BuildContext context, MessageFile file) =>
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * .85,
      ),
      builder: (_) => _TextFileSheet(file),
    );

class _TextFileSheet extends StatefulWidget {
  const _TextFileSheet(this.file);
  final MessageFile file;

  @override
  State<_TextFileSheet> createState() => _TextFileSheetState();
}

class _TextFileSheetState extends State<_TextFileSheet> {
  final scroll = ScrollController();
  Timer? reset;
  bool copied = false;

  Future<void> copy() async {
    await Clipboard.setData(ClipboardData(text: widget.file.content));
    if (!mounted) return;
    reset?.cancel();
    setState(() => copied = true);
    reset = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => copied = false);
    });
  }

  @override
  void dispose() {
    reset?.cancel();
    scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final file = widget.file;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 8, 12),
          child: Row(
            children: [
              const _FileIcon(),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      file.name,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      file.detail,
                      style: const TextStyle(
                        fontSize: 12,
                        height: 1.3,
                        color: muted,
                      ),
                    ),
                  ],
                ),
              ),
              if (file.content.isNotEmpty)
                IconButton(
                  tooltip: copied ? 'Copiato' : 'Copia testo',
                  onPressed: copy,
                  icon: AnimatedSwitcher(
                    duration: MediaQuery.disableAnimationsOf(context)
                        ? Duration.zero
                        : const Duration(milliseconds: 160),
                    child: Icon(
                      copied ? Icons.check_rounded : Icons.copy_rounded,
                      key: ValueKey(copied),
                      size: 20,
                      color: copied ? orchid : muted,
                    ),
                  ),
                ),
            ],
          ),
        ),
        const Divider(height: 1),
        Flexible(
          child: file.content.isEmpty
              ? const Padding(
                  padding: EdgeInsets.all(24),
                  child: Text('File vuoto.', style: TextStyle(color: muted)),
                )
              : Scrollbar(
                  controller: scroll,
                  child: SingleChildScrollView(
                    controller: scroll,
                    padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
                    child: SelectionArea(
                      child: Text(
                        file.content,
                        style: const TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 13,
                          height: 1.5,
                          color: textColor,
                        ),
                      ),
                    ),
                  ),
                ),
        ),
      ],
    );
  }
}

enum AttachmentPick { camera, photos, files }

/// Sheet of the composer "+": camera, photo library or files.
Future<AttachmentPick?> showAttachmentSheet(
  BuildContext context, {
  required int imageRoom,
}) => showModalBottomSheet<AttachmentPick>(
  context: context,
  showDragHandle: true,
  useSafeArea: true,
  builder: (_) => AttachmentSheet(imageRoom: imageRoom),
);

class AttachmentSheet extends StatelessWidget {
  const AttachmentSheet({super.key, required this.imageRoom});
  final int imageRoom;

  @override
  Widget build(BuildContext context) {
    final images = imageRoom > 0;
    void pick(AttachmentPick value) => Navigator.pop(context, value);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 16),
            child: Text(
              'Allega',
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
          Row(
            spacing: 10,
            children: [
              Expanded(
                child: _SourceTile(
                  key: const ValueKey('attach-camera'),
                  icon: Icons.photo_camera_outlined,
                  label: 'Fotocamera',
                  onTap: images ? () => pick(AttachmentPick.camera) : null,
                ),
              ),
              Expanded(
                child: _SourceTile(
                  key: const ValueKey('attach-photos'),
                  icon: Icons.photo_library_outlined,
                  label: 'Foto',
                  onTap: images ? () => pick(AttachmentPick.photos) : null,
                ),
              ),
              Expanded(
                child: _SourceTile(
                  key: const ValueKey('attach-files'),
                  icon: Icons.description_outlined,
                  label: 'File',
                  onTap: () => pick(AttachmentPick.files),
                ),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 14, 4, 0),
            child: Text(
              images
                  ? 'Immagini PNG, JPEG, GIF, WebP o HEIC e file di testo fino a 128\u00a0KB.'
                  : 'Hai raggiunto il limite di ${AttachmentLimits.images} immagini: puoi ancora allegare file di\u00a0testo.',
              style: const TextStyle(fontSize: 12, height: 1.4, color: muted),
            ),
          ),
        ],
      ),
    );
  }
}

class _SourceTile extends StatelessWidget {
  const _SourceTile({
    super.key,
    required this.icon,
    required this.label,
    this.onTap,
  });
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    enabled: onTap != null,
    excludeSemantics: true,
    label: label,
    onTap: onTap,
    child: Opacity(
      opacity: onTap == null ? .45 : 1,
      child: Material(
        color: input,
        borderRadius: BorderRadius.circular(20),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(8, 18, 8, 16),
            child: Column(
              children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: violet.withValues(alpha: .18),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(icon, size: 24, color: orchid),
                ),
                const SizedBox(height: 10),
                Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 14,
                    height: 1.3,
                    fontWeight: FontWeight.w600,
                    color: textColor,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
