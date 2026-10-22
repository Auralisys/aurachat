import 'package:flutter/material.dart';

enum ChatAction { recap, rename, copy, delete }

class ChatActionsMenu extends StatelessWidget {
  const ChatActionsMenu({
    super.key,
    required this.onSelected,
    this.canModify = true,
    this.canCopy = true,
  });

  final ValueChanged<ChatAction> onSelected;
  final bool canModify, canCopy;

  @override
  Widget build(BuildContext context) => PopupMenuButton<ChatAction>(
    tooltip: 'Opzioni chat',
    icon: const Icon(Icons.more_horiz_rounded),
    constraints: const BoxConstraints(minWidth: 200),
    style: IconButton.styleFrom(minimumSize: const Size(48, 48)),
    onSelected: onSelected,
    itemBuilder: (context) => [
      const PopupMenuItem(
        value: ChatAction.recap,
        child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(Icons.fact_check_outlined),
          title: Text('Attività e cambiamenti'),
          subtitle: Text('Git, output, fonti e agenti'),
        ),
      ),
      const PopupMenuDivider(),
      PopupMenuItem(
        value: ChatAction.rename,
        enabled: canModify,
        child: const ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(Icons.edit_outlined),
          title: Text('Rinomina chat'),
        ),
      ),
      PopupMenuItem(
        value: ChatAction.copy,
        enabled: canCopy,
        child: const ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(Icons.copy_outlined),
          title: Text('Copia conversazione'),
        ),
      ),
      PopupMenuItem(
        value: ChatAction.delete,
        enabled: canModify,
        child: const ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(Icons.delete_outline_rounded),
          title: Text('Elimina chat'),
        ),
      ),
    ],
  );
}

class RenameChatDialog extends StatefulWidget {
  const RenameChatDialog({super.key, required this.title});
  final String title;
  @override
  State<RenameChatDialog> createState() => _RenameChatDialogState();
}

class _RenameChatDialogState extends State<RenameChatDialog> {
  final form = GlobalKey<FormState>();
  late final TextEditingController title = TextEditingController(
    text: widget.title,
  );
  @override
  void dispose() {
    title.dispose();
    super.dispose();
  }

  void save() {
    if (form.currentState!.validate()) {
      Navigator.pop(context, title.text.trim());
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Rinomina chat'),
    content: Form(
      key: form,
      child: TextFormField(
        controller: title,
        autofocus: true,
        maxLength: 160,
        decoration: const InputDecoration(labelText: 'Titolo della chat'),
        validator: (value) => value == null || value.trim().isEmpty
            ? 'Inserisci un titolo'
            : null,
        onFieldSubmitted: (_) => save(),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Annulla'),
      ),
      FilledButton(onPressed: save, child: const Text('Salva')),
    ],
  );
}
