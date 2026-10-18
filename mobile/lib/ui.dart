import 'package:flutter/material.dart';

import 'aura_icons.dart';

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
    titleMedium: TextStyle(
      fontSize: 17,
      height: 1.25,
      letterSpacing: -.2,
      fontWeight: FontWeight.w600,
    ),
  ),
  appBarTheme: const AppBarTheme(
    backgroundColor: ink,
    foregroundColor: textColor,
    surfaceTintColor: Colors.transparent,
    elevation: 0,
    scrolledUnderElevation: 0,
    centerTitle: true,
  ),
  iconButtonTheme: IconButtonThemeData(
    style: IconButton.styleFrom(
      minimumSize: const Size(48, 48),
      tapTargetSize: MaterialTapTargetSize.padded,
      foregroundColor: muted,
    ),
  ),
  listTileTheme: const ListTileThemeData(
    minTileHeight: 52,
    iconColor: muted,
    textColor: textColor,
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
    this.glyph,
    this.onPressed,
  });
  final IconData icon;
  final Widget? glyph;
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
        icon: glyph ?? Icon(icon, size: 22),
      ),
    ),
  );
}

class ComposerChoice {
  const ComposerChoice({
    required this.value,
    required this.label,
    this.description,
    this.enabled = true,
  });
  final String value, label;
  final String? description;
  final bool enabled;
}

/// Icon that opens a compact purple menu instead of a full-width sheet.
class ComposerDropdown extends StatefulWidget {
  const ComposerDropdown({
    super.key,
    required this.icon,
    required this.label,
    required this.choices,
    required this.onSelected,
    this.selected,
    this.enabled = true,
  });
  final IconData icon;
  final String label;
  final List<ComposerChoice> choices;
  final ValueChanged<String> onSelected;
  final String? selected;
  final bool enabled;
  @override
  State<ComposerDropdown> createState() => _ComposerDropdownState();
}

class _ComposerDropdownState extends State<ComposerDropdown> {
  final controller = MenuController();

  @override
  Widget build(BuildContext context) {
    final width = (MediaQuery.sizeOf(context).width - 48).clamp(220.0, 320.0);
    return MenuAnchor(
      controller: controller,
      alignmentOffset: const Offset(0, 8),
      style: MenuStyle(
        backgroundColor: const WidgetStatePropertyAll(panel),
        surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        shadowColor: const WidgetStatePropertyAll(Colors.black54),
        elevation: const WidgetStatePropertyAll(16),
        padding: const WidgetStatePropertyAll(EdgeInsets.all(6)),
        minimumSize: WidgetStatePropertyAll(Size(width, 0)),
        maximumSize: WidgetStatePropertyAll(Size(width, double.infinity)),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(18),
            side: BorderSide(color: violet.withValues(alpha: .5)),
          ),
        ),
      ),
      menuChildren: [
        for (final choice in widget.choices)
          MenuItemButton(
            onPressed: choice.enabled
                ? () {
                    controller.close();
                    widget.onSelected(choice.value);
                  }
                : null,
            style: MenuItemButton.styleFrom(
              foregroundColor: textColor,
              backgroundColor: choice.value == widget.selected
                  ? violet.withValues(alpha: .22)
                  : Colors.transparent,
              disabledForegroundColor: muted.withValues(alpha: .45),
              minimumSize: const Size.fromHeight(48),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        choice.label,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 14,
                          height: 1.3,
                          fontWeight: choice.value == widget.selected
                              ? FontWeight.w600
                              : FontWeight.w500,
                        ),
                      ),
                      if (choice.description != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            choice.description!,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 12,
                              height: 1.3,
                              color: muted,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                if (choice.value == widget.selected)
                  const Icon(Icons.check_rounded, size: 18, color: orchid),
              ],
            ),
          ),
      ],
      builder: (context, controller, child) => IconButton(
        tooltip: widget.label,
        onPressed: widget.enabled && widget.choices.isNotEmpty
            ? () => controller.isOpen ? controller.close() : controller.open()
            : null,
        color: muted,
        disabledColor: muted.withValues(alpha: .4),
        style: IconButton.styleFrom(
          minimumSize: const Size(40, 40),
          padding: EdgeInsets.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: const CircleBorder(),
        ),
        icon: Icon(widget.icon, size: 20),
      ),
    );
  }
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
    this.models = const [],
    this.selectedModel,
    this.onModelSelected,
    this.permissions = const [],
    this.selectedPermission,
    this.onPermissionSelected,
    this.showMic = true,
    this.micActive = false,
    this.onMic,
    this.allowQueue = false,
  });
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool online, busy, allowQueue, showMic, micActive;
  final String modelName, permissionLabel;
  final List<ComposerChoice> models, permissions;
  final String? selectedModel, selectedPermission;
  final VoidCallback onSend, onStop, onOptions;
  final VoidCallback? onMic;
  final ValueChanged<String>? onModelSelected, onPermissionSelected;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([controller, focusNode]),
    builder: (context, _) {
      final ready = online && controller.text.trim().isNotEmpty;
      // Keep every control on the same 40 px footprint: the filled send button
      // used to dwarf the icon-only tools.
      final toolStyle = IconButton.styleFrom(
        minimumSize: const Size(40, 40),
        padding: EdgeInsets.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: const CircleBorder(),
      );
      final send = IconButton.filled(
        tooltip: busy ? 'Invia in coda' : 'Invia messaggio',
        onPressed: busy
            ? (allowQueue && ready ? onSend : null)
            : ready
            ? onSend
            : null,
        style: toolStyle.copyWith(
          backgroundColor: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.disabled)
                ? textColor.withValues(alpha: .09)
                : violet,
          ),
          foregroundColor: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.disabled)
                ? muted
                : Colors.white,
          ),
          fixedSize: const WidgetStatePropertyAll(Size(40, 40)),
        ),
        icon: const Icon(Icons.arrow_upward_rounded, size: 20),
      );
      final stop = IconButton.filled(
        tooltip: 'Interrompi risposta',
        onPressed: onStop,
        style: toolStyle.copyWith(
          backgroundColor: WidgetStatePropertyAll(
            muted.withValues(alpha: .18),
          ),
          foregroundColor: const WidgetStatePropertyAll(textColor),
          fixedSize: const WidgetStatePropertyAll(Size(40, 40)),
        ),
        icon: const Icon(Icons.stop_rounded, size: 18),
      );
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
                ? orchid.withValues(alpha: .32)
                : Colors.transparent,
          ),
        ),
        padding: const EdgeInsets.all(4),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              key: const ValueKey('chat-composer'),
              controller: controller,
              focusNode: focusNode,
              minLines: 1,
              maxLines: 4,
              maxLength: 25000,
              textCapitalization: TextCapitalization.sentences,
              keyboardType: TextInputType.multiline,
              cursorColor: orchid,
              style: const TextStyle(fontSize: 16, height: 1.4),
              decoration: const InputDecoration(
                hintText: 'Chiedi ad AuraChat',
                counterText: '',
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                contentPadding: EdgeInsets.fromLTRB(14, 10, 14, 2),
              ),
              onTapOutside: (_) => focusNode.unfocus(),
            ),
            Row(
              key: const ValueKey('composer-toolbar'),
              children: [
                // Left, as on desktop: attachments and project permissions.
                IconButton(
                  tooltip: 'Opzioni chat',
                  onPressed: onOptions,
                  color: muted,
                  style: toolStyle,
                  icon: const Icon(Icons.add_rounded, size: 20),
                ),
                ComposerDropdown(
                  key: const ValueKey('composer-permissions'),
                  icon: Icons.shield_outlined,
                  label: permissionLabel,
                  choices: permissions,
                  selected: selectedPermission,
                  enabled: !busy,
                  onSelected: (value) => onPermissionSelected?.call(value),
                ),
                const Spacer(),
                // Right, as on desktop: model, dictation, stop, send.
                ComposerDropdown(
                  key: const ValueKey('composer-model'),
                  icon: Icons.auto_awesome_rounded,
                  label: 'Modello: $modelName',
                  choices: models,
                  selected: selectedModel,
                  enabled: online && !busy,
                  onSelected: (value) => onModelSelected?.call(value),
                ),
                if (showMic)
                  IconButton(
                    tooltip: micActive ? 'Ferma dettatura' : 'Dettatura',
                    onPressed: onMic,
                    color: micActive ? orchid : muted,
                    disabledColor: muted.withValues(alpha: .4),
                    style: toolStyle,
                    icon: Icon(
                      micActive ? Icons.mic_rounded : Icons.mic_none_rounded,
                      size: 20,
                    ),
                  ),
                // Stop is shown for the whole turn; send joins it only when
                // there is a draft to queue, matching the desktop composer.
                if (busy) ...[
                  stop,
                  if (allowQueue && ready) send,
                ] else
                  send,
              ],
            ),
          ],
        ),
      );
    },
  );
}

/// Two compact lines for the navigation bar: chat title above, project and PC
/// below, with a status dot for the selected desktop.
class ChatContextLabel extends StatelessWidget {
  const ChatContextLabel({
    super.key,
    this.project,
    this.pc,
    required this.online,
    this.onTap,
  });
  final String? project, pc;
  final bool online;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final projectName = project?.trim() ?? '';
    final pcName = (pc?.trim().isNotEmpty ?? false) ? pc!.trim() : 'Nessun PC';
    const style = TextStyle(
      fontSize: 12,
      height: 1.2,
      fontWeight: FontWeight.w500,
      color: muted,
    );
    final label = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (projectName.isNotEmpty) ...[
          Flexible(
            child: Text(
              projectName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: style,
            ),
          ),
          const Text(' • ', style: style),
        ],
        Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(
            color: online ? const Color(0xff38c49b) : muted,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 4),
        Flexible(
          child: Text(
            pcName,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: style,
          ),
        ),
        if (onTap != null) ...[
          const SizedBox(width: 2),
          const Icon(Icons.keyboard_arrow_down_rounded, size: 14, color: muted),
        ],
      ],
    );
    return Semantics(
      label: [
        if (projectName.isNotEmpty) projectName,
        '$pcName, ${online ? 'collegato' : 'non raggiungibile'}',
      ].join(', '),
      button: onTap != null,
      onTap: onTap,
      excludeSemantics: true,
      child: onTap == null
          ? label
          : Tooltip(
              message: 'Cambia PC',
              child: InkWell(
                onTap: onTap,
                borderRadius: BorderRadius.circular(8),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 5,
                    vertical: 1,
                  ),
                  child: label,
                ),
              ),
            ),
    );
  }
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
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
      children: [
        if (projects.isNotEmpty) ...[
          const Padding(
            padding: EdgeInsets.fromLTRB(4, 16, 4, 8),
            child: Text(
              'Progetti',
              style: TextStyle(
                fontSize: 14,
                height: 1.3,
                fontWeight: FontWeight.w600,
                color: muted,
              ),
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
                        horizontalTitleGap: 12,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(14),
                        ),
                        leading: AuraGlyph(
                          open ? 'folder_open' : 'folder_closed',
                          size: 22,
                        ),
                        title: Text(
                          p.value['name'] ?? 'Progetto',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 16, height: 1.3),
                        ),
                        onTap: () => setState(
                          () => open
                              ? expanded.remove(p.key)
                              : expanded.add(p.key),
                        ),
                      ),
                    ),
                    if (open)
                      IconButton(
                        tooltip: 'Nuova chat in ${p.value['name']}',
                        onPressed: () => widget.onNew(p.key),
                        icon: const AuraGlyph('new_chat', size: 22),
                        color: muted,
                      ),
                  ],
                ),
                projectExpansion(
                  context,
                  !open
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
          const SizedBox(height: 16),
        ],
        Row(
          children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(left: 4),
                child: Text(
                  query.isEmpty ? 'Recenti' : 'Conversazioni',
                  style: const TextStyle(
                    fontSize: 14,
                    height: 1.3,
                    fontWeight: FontWeight.w600,
                    color: muted,
                  ),
                ),
              ),
            ),
            IconButton(
              tooltip: 'Nuova chat',
              onPressed: () => widget.onNew(null),
              icon: const AuraGlyph('new_chat', size: 22),
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

  Widget projectExpansion(BuildContext context, Widget child) {
    // A static subtree also avoids zero-duration AnimatedSize layout mutations.
    if (MediaQuery.disableAnimationsOf(context)) return child;
    return AnimatedSize(
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOutCubic,
      alignment: Alignment.topCenter,
      child: child,
    );
  }

  Widget chatRow(Map<String, dynamic> chat, {double indent = 0}) => Padding(
    padding: EdgeInsets.only(left: indent),
    child: ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 4),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      selected: widget.selectedId == chat['id'],
      selectedTileColor: panel,
      selectedColor: textColor,
      title: Text(
        chat['title'] ?? 'Chat',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 16, height: 1.35),
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
