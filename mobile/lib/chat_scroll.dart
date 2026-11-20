import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

/// Index of the last message written by the user: where the last exchange starts.
int? lastPromptIndex(List<Map<String, dynamic>> messages) {
  for (var i = messages.length - 1; i >= 0; i--) {
    if (messages[i]['role'] == 'user') return i;
  }
  return null;
}

/// Offset at which a chat opens on its last exchange.
///
/// [top] is the offset that puts the prompt at the top edge. A prompt taller
/// than 40% of the screen would hide the answer, so the view then starts where
/// the answer does. The clamp makes an exchange that fits on screen land at
/// the bottom, as a chat without any anchor does.
double landingOffset({
  required double top,
  required double promptHeight,
  required double viewport,
  required double max,
  double gap = 12,
}) {
  final start = promptHeight > viewport * .4 ? top + promptHeight : top;
  return (start - gap).clamp(0, max).toDouble();
}

/// The message list of a chat. When it is built it lands once, hidden, and
/// only then shows: on the start of the last exchange if [anchorIndex] is
/// set, at the bottom otherwise. It never moves the scroll afterwards.
class ConversationList extends StatefulWidget {
  const ConversationList({
    super.key,
    required this.controller,
    required this.children,
    this.anchorIndex,
  });
  final ScrollController controller;
  final List<Widget> children;

  /// Index in [children] of the prompt to land on; read only when first built.
  final int? anchorIndex;

  @override
  State<ConversationList> createState() => _ConversationListState();
}

class _ConversationListState extends State<ConversationList> {
  static const _maxJumps = 8;
  // Large enough to keep the whole last exchange built, so the anchor can be
  // measured while at the bottom. Longer than this lands at the bottom.
  static const _landingCache = ScrollCacheExtent.pixels(30000);
  final _anchor = GlobalKey();
  late final int? _anchorIndex = widget.anchorIndex;
  bool _landing = true;
  int _jumps = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _land());
  }

  void _land() {
    if (!mounted || !_landing) return;
    final controller = widget.controller;
    if (!controller.hasClients || controller.positions.length != 1) {
      return _show();
    }
    final position = controller.position;
    // A lazy list reports a partial extent until laid out: go down until stable.
    if (position.pixels < position.maxScrollExtent - .5 && _jumps++ < _maxJumps) {
      controller.jumpTo(position.maxScrollExtent);
      WidgetsBinding.instance.addPostFrameCallback((_) => _land());
      return;
    }
    final target = _anchorOffset(position);
    if (target != null) controller.jumpTo(target);
    _show();
  }

  double? _anchorOffset(ScrollPosition position) {
    final box = _anchor.currentContext?.findRenderObject();
    if (_anchorIndex == null || box is! RenderBox || !box.hasSize) return null;
    final viewport = RenderAbstractViewport.maybeOf(box);
    if (viewport == null) return null;
    return landingOffset(
      top: viewport.getOffsetToReveal(box, 0).offset,
      promptHeight: box.size.height,
      viewport: position.viewportDimension,
      max: position.maxScrollExtent,
    );
  }

  void _show() {
    if (mounted) setState(() => _landing = false);
  }

  @override
  Widget build(BuildContext context) => Opacity(
    opacity: _landing ? 0 : 1,
    child: ListView(
      controller: widget.controller,
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
      scrollCacheExtent: _landing ? _landingCache : null,
      children: [
        for (var i = 0; i < widget.children.length; i++)
          i == _anchorIndex
              ? KeyedSubtree(key: _anchor, child: widget.children[i])
              : widget.children[i],
      ],
    ),
  );
}
