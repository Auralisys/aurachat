import 'package:flutter/material.dart';
import 'prompt_edit.dart';

class EditPromptDialog extends StatefulWidget {
  const EditPromptDialog({super.key, required this.prompt});
  final SavedPromptEdit prompt;

  @override
  State<EditPromptDialog> createState() => _EditPromptDialogState();
}

class _EditPromptDialogState extends State<EditPromptDialog> {
  late final text = TextEditingController(text: widget.prompt.text);

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final prompt = widget.prompt;
    return AlertDialog(
      scrollable: true,
      title: const Text('Modifica messaggio'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            prompt.subsequent == 1
                ? 'Quando invii, la risposta successiva viene sostituita da una nuova risposta.'
                : 'Quando invii, i ${prompt.subsequent} messaggi successivi vengono eliminati e la chat riparte da qui.',
          ),
          const SizedBox(height: 16),
          TextField(
            autofocus: true,
            controller: text,
            minLines: 2,
            maxLines: 5,
            decoration: const InputDecoration(labelText: 'Messaggio'),
          ),
          if (prompt.hasAttachments)
            Text('Allegati mantenuti: ${prompt.attachments.length}'),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Annulla'),
        ),
        ValueListenableBuilder<TextEditingValue>(
          valueListenable: text,
          builder: (_, value, _) => FilledButton(
            onPressed: prompt.accepts(value.text)
                ? () => Navigator.pop(context, value.text)
                : null,
            child: const Text('Invia modifica'),
          ),
        ),
      ],
    );
  }
}

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
