import 'package:flutter/material.dart';

// Shared with the flat shell in desktop/ui/styles.css.
const ink = Color(0xff1b191f),
    panel = Color(0xff29252f),
    bubble = Color(0xff2a1458),
    sidebar = Color(0xff151319),
    input = Color(0xff333038),
    violet = Color(0xff8b3fe0),
    orchid = Color(0xffbb93fb),
    textColor = Color(0xfff5f0ff),
    muted = Color(0xffb4aebd);

ThemeData auraTheme() => ThemeData(
  useMaterial3: true,
  brightness: Brightness.dark,
  scaffoldBackgroundColor: ink,
  colorScheme: const ColorScheme.dark(
    primary: orchid,
    secondary: violet,
    surface: panel,
    onSurface: textColor,
    onSurfaceVariant: muted,
  ),
  textTheme: const TextTheme(
    bodyLarge: TextStyle(fontSize: 16, height: 1.5, color: textColor),
    bodyMedium: TextStyle(fontSize: 15, height: 1.5, color: textColor),
    titleMedium: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
  ),
  appBarTheme: const AppBarTheme(
    backgroundColor: ink,
    foregroundColor: textColor,
    surfaceTintColor: Colors.transparent,
    elevation: 0,
    scrolledUnderElevation: 0,
    centerTitle: true,
  ),
  dividerColor: muted.withValues(alpha: .12),
  splashFactory: InkSparkle.splashFactory,
  bottomSheetTheme: const BottomSheetThemeData(
    backgroundColor: panel,
    surfaceTintColor: Colors.transparent,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
    ),
  ),
  inputDecorationTheme: InputDecorationTheme(
    filled: true,
    fillColor: panel,
    hintStyle: const TextStyle(color: muted),
    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(20),
      borderSide: BorderSide.none,
    ),
    contentPadding: const EdgeInsets.all(18),
  ),
  filledButtonTheme: FilledButtonThemeData(
    style: FilledButton.styleFrom(
      backgroundColor: violet,
      foregroundColor: Colors.white,
      minimumSize: const Size(48, 52),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(26)),
    ),
  ),
);

class RoundButton extends StatelessWidget {
  const RoundButton({
    super.key,
    required this.icon,
    required this.label,
    this.onPressed,
  });
  final IconData icon;
  final String label;
  final VoidCallback? onPressed;
  @override
  Widget build(BuildContext context) => Center(
    widthFactor: 1,
    heightFactor: 1,
    child: SizedBox.square(
      dimension: 48,
      child: IconButton(
        tooltip: label,
        onPressed: onPressed,
        style: IconButton.styleFrom(
          backgroundColor: panel,
          foregroundColor: textColor,
          disabledForegroundColor: muted.withValues(alpha: .5),
          minimumSize: const Size(48, 48),
          shape: const CircleBorder(),
        ),
        icon: Icon(icon, size: 23),
      ),
    ),
  );
}

class DeviceLabel extends StatelessWidget {
  const DeviceLabel({
    super.key,
    required this.name,
    required this.online,
    this.onTap,
  });
  final String name;
  final bool online;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Semantics(
    label: '$name, ${online ? "collegato" : "non raggiungibile"}',
    button: true,
    child: TextButton(
      onPressed: onTap,
      style: TextButton.styleFrom(
        foregroundColor: muted,
        minimumSize: const Size(48, 48),
        padding: const EdgeInsets.symmetric(horizontal: 12),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.laptop_mac_outlined, size: 19),
          const SizedBox(width: 8),
          Flexible(
            child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
          const SizedBox(width: 8),
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              color: online ? const Color(0xff38c49b) : muted,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 4),
          const Icon(Icons.keyboard_arrow_down_rounded, size: 17),
        ],
      ),
    ),
  );
}

class AuraComposer extends StatelessWidget {
  const AuraComposer({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.online,
    required this.busy,
    required this.onSend,
    required this.onStop,
    required this.onOptions,
    this.modelName = 'Modello',
    this.permissionLabel = 'Permessi progetto',
    this.onModel,
    this.onPermissions,
  });
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool online, busy;
  final String modelName, permissionLabel;
  final VoidCallback onSend, onStop, onOptions;
  final VoidCallback? onModel, onPermissions;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([controller, focusNode]),
    builder: (context, _) {
      final ready = online && controller.text.trim().isNotEmpty;
      final expanded = focusNode.hasFocus || controller.text.isNotEmpty;
      final field = TextField(
        key: const ValueKey('chat-composer'),
        controller: controller,
        focusNode: focusNode,
        minLines: 1,
        maxLines: expanded ? 4 : 1,
        maxLength: 25000,
        textCapitalization: TextCapitalization.sentences,
        keyboardType: TextInputType.multiline,
        cursorColor: orchid,
        style: const TextStyle(fontSize: 16, height: 1.4),
        decoration: InputDecoration(
          hintText: 'Chiedi ad AuraChat',
          counterText: '',
          filled: false,
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          contentPadding: expanded
              ? const EdgeInsets.fromLTRB(14, 10, 14, 2)
              : const EdgeInsets.symmetric(vertical: 11, horizontal: 2),
        ),
        onTapOutside: (_) => focusNode.unfocus(),
      );
      final options = IconButton(
        tooltip: 'Opzioni chat',
        onPressed: onOptions,
        color: textColor,
        icon: const Icon(Icons.add_rounded, size: 25),
      );
      final send = IconButton.filled(
        tooltip: busy ? 'Interrompi risposta' : 'Invia messaggio',
        onPressed: busy
            ? onStop
            : ready
            ? onSend
            : null,
        style: IconButton.styleFrom(
          backgroundColor: violet,
          foregroundColor: Colors.white,
          disabledBackgroundColor: textColor.withValues(alpha: .09),
          disabledForegroundColor: muted,
          minimumSize: const Size(48, 48),
          shape: const CircleBorder(),
        ),
        icon: Icon(
          busy ? Icons.stop_rounded : Icons.arrow_upward_rounded,
          size: 24,
        ),
      );
      // Keep the TextField in the same slot when focus expands the toolbar.
      return AnimatedContainer(
        duration: MediaQuery.disableAnimationsOf(context)
            ? Duration.zero
            : const Duration(milliseconds: 180),
        curve: Curves.easeOutCubic,
        decoration: BoxDecoration(
          color: input,
          borderRadius: BorderRadius.circular(28),
          border: Border.all(
            color: focusNode.hasFocus
                ? orchid.withValues(alpha: .4)
                : textColor.withValues(alpha: .08),
          ),
        ),
        padding: const EdgeInsets.all(4),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                if (!expanded) options,
                Expanded(
                  key: const ValueKey('composer-field-cell'),
                  child: field,
                ),
                if (!expanded) send,
              ],
            ),
            if (expanded)
              Row(
                children: [
                  options,
                  IconButton(
                    tooltip: permissionLabel,
                    onPressed: busy ? null : onPermissions,
                    color: orchid,
                    icon: const Icon(Icons.shield_outlined, size: 21),
                  ),
                  Expanded(
                    child: TextButton(
                      onPressed: online && !busy ? onModel : null,
                      style: TextButton.styleFrom(
                        foregroundColor: muted,
                        minimumSize: const Size(48, 48),
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                      ),
                      child: Row(
                        children: [
                          Flexible(
                            child: Text(
                              modelName,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 13),
                            ),
                          ),
                          const SizedBox(width: 3),
                          const Icon(
                            Icons.keyboard_arrow_down_rounded,
                            size: 16,
                          ),
                        ],
                      ),
                    ),
                  ),
                  send,
                ],
              ),
          ],
        ),
      );
    },
  );
}

class ChatLibrary extends StatefulWidget {
  const ChatLibrary({
    super.key,
    required this.projects,
    required this.chats,
    required this.onSelect,
    required this.onNew,
    this.selectedId,
    this.query = '',
    this.working = const {},
  });
  final Map<String, dynamic> projects;
  final List<Map<String, dynamic>> chats;
  final ValueChanged<Map<String, dynamic>> onSelect;
  final ValueChanged<String?> onNew;
  final String? selectedId;
  final String query;
  final Set<String> working;
  @override
  State<ChatLibrary> createState() => _ChatLibraryState();
}

class _ChatLibraryState extends State<ChatLibrary> {
  final expanded = <String>{};
  @override
  Widget build(BuildContext context) {
    final query = widget.query.trim().toLowerCase();
    final matches = widget.chats
        .where(
          (c) => (c['title'] ?? '').toString().toLowerCase().contains(query),
        )
        .toList();
    final projects = widget.projects.entries
        .where(
          (p) =>
              query.isEmpty ||
              (p.value['name'] ?? '').toString().toLowerCase().contains(
                query,
              ) ||
              matches.any((c) => c['project_id'] == p.key),
        )
        .toList();
    final recent = query.isEmpty
        ? matches.where((c) => c['project_id'] == null).toList()
        : matches;
    return ListView(
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
      children: [
        if (projects.isNotEmpty) ...[
          const Padding(
            padding: EdgeInsets.fromLTRB(4, 16, 4, 12),
            child: Text(
              'Progetti',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
            ),
          ),
          ...projects.map((p) {
            final open = expanded.contains(p.key) || query.isNotEmpty;
            final children = widget.chats
                .where(
                  (c) =>
                      c['project_id'] == p.key &&
                      (query.isEmpty ||
                          matches.contains(c) ||
                          p.value['name'].toString().toLowerCase().contains(
                            query,
                          )),
                )
                .toList();
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: ListTile(
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 4,
                        ),
                        minLeadingWidth: 22,
                        horizontalTitleGap: 14,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(14),
                        ),
                        leading: Icon(
                          open
                              ? Icons.folder_open_outlined
                              : Icons.folder_outlined,
                          size: 25,
                        ),
                        title: Text(
                          p.value['name'] ?? 'Progetto',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 17),
                        ),
                        onTap: () => setState(
                          () => open
                              ? expanded.remove(p.key)
                              : expanded.add(p.key),
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Nuova chat in ${p.value['name']}',
                      onPressed: () => widget.onNew(p.key),
                      icon: const Icon(Icons.edit_outlined, size: 22),
                      color: muted,
                    ),
                  ],
                ),
                AnimatedSize(
                  duration: MediaQuery.disableAnimationsOf(context)
                      ? Duration.zero
                      : const Duration(milliseconds: 220),
                  curve: Curves.easeOutCubic,
                  alignment: Alignment.topCenter,
                  child: !open
                      ? const SizedBox(width: double.infinity)
                      : Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: children.isEmpty
                              ? [
                                  const Padding(
                                    padding: EdgeInsets.fromLTRB(44, 12, 4, 16),
                                    child: Text(
                                      'Nessuna chat in questo progetto.',
                                      style: TextStyle(color: muted),
                                    ),
                                  ),
                                ]
                              : children
                                    .map((c) => chatRow(c, indent: 40))
                                    .toList(),
                        ),
                ),
              ],
            );
          }),
          const SizedBox(height: 24),
        ],
        Row(
          children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(left: 4),
                child: Text(
                  query.isEmpty ? 'Recenti' : 'Conversazioni',
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ),
            IconButton(
              tooltip: 'Nuova chat',
              onPressed: () => widget.onNew(null),
              icon: const Icon(Icons.edit_outlined, size: 22),
              color: muted,
            ),
          ],
        ),
        if (recent.isEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 16, 4, 24),
            child: Text(
              query.isEmpty
                  ? 'Le tue chat appariranno qui.'
                  : 'Nessuna conversazione trovata.',
              style: const TextStyle(color: muted),
            ),
          ),
        ...recent.map(chatRow),
      ],
    );
  }

  Widget chatRow(Map<String, dynamic> chat, {double indent = 0}) => Padding(
    padding: EdgeInsets.only(left: indent),
    child: ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      selected: widget.selectedId == chat['id'],
      selectedTileColor: panel,
      selectedColor: textColor,
      title: Text(
        chat['title'] ?? 'Chat',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 16),
      ),
      trailing: widget.working.contains(chat['id'])
          ? const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 1.6),
            )
          : null,
      onTap: () => widget.onSelect(chat),
    ),
  );
}
