import 'package:flutter/material.dart';

import 'ui.dart';

/// Draft della coda mostrato come bolla utente, con stato e azioni.
class QueuedMessageBubble extends StatelessWidget {
  const QueuedMessageBubble({
    super.key,
    required this.text,
    required this.status,
    this.locked = false,
    this.warning,
    this.onEdit,
    this.onDelete,
    this.onSendNow,
    this.onResume,
  });

  final String text;
  final String status;
  final bool locked;
  final String? warning;
  final VoidCallback? onEdit, onDelete, onSendNow, onResume;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Padding(
            padding: const EdgeInsets.only(right: 2, bottom: 2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                Text(
                  status,
                  style: const TextStyle(
                    fontSize: 12,
                    height: 1.3,
                    fontWeight: FontWeight.w600,
                    color: muted,
                  ),
                ),
                PopupMenuButton<_QueueAction>(
                  tooltip: 'Azioni messaggio in coda',
                  icon: const Icon(
                    Icons.more_horiz_rounded,
                    size: 20,
                    color: muted,
                  ),
                  color: panel,
                  surfaceTintColor: Colors.transparent,
                  padding: EdgeInsets.zero,
                  onSelected: (value) {
                    if (locked) return;
                    switch (value) {
                      case _QueueAction.sendNow:
                        onSendNow?.call();
                      case _QueueAction.edit:
                        onEdit?.call();
                      case _QueueAction.delete:
                        onDelete?.call();
                    }
                  },
                  itemBuilder: (context) => [
                    PopupMenuItem(
                      value: _QueueAction.sendNow,
                      enabled: !locked && onSendNow != null,
                      child: const Text('Manda subito'),
                    ),
                    PopupMenuItem(
                      value: _QueueAction.edit,
                      enabled: !locked && onEdit != null,
                      child: const Text('Modifica'),
                    ),
                    PopupMenuItem(
                      value: _QueueAction.delete,
                      enabled: !locked && onDelete != null,
                      child: const Text('Cancella'),
                    ),
                  ],
                ),
              ],
            ),
          ),
          LayoutBuilder(
            builder: (context, constraints) => Align(
              alignment: Alignment.centerRight,
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxWidth: constraints.maxWidth * .88,
                ),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 18,
                    vertical: 13,
                  ),
                  decoration: BoxDecoration(
                    color: bubble,
                    borderRadius: BorderRadius.circular(24),
                    border: Border.all(color: orchid.withValues(alpha: .28)),
                  ),
                  child: Text(
                    text,
                    style: const TextStyle(
                      fontSize: 16,
                      height: 1.6,
                      color: textColor,
                    ),
                  ),
                ),
              ),
            ),
          ),
          if (warning != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  Flexible(
                    child: Text(
                      warning!,
                      textAlign: TextAlign.right,
                      style: const TextStyle(
                        fontSize: 12,
                        height: 1.4,
                        color: muted,
                      ),
                    ),
                  ),
                  if (onResume != null) ...[
                    const SizedBox(width: 8),
                    TextButton(
                      onPressed: locked ? null : onResume,
                      style: TextButton.styleFrom(
                        minimumSize: const Size(48, 48),
                      ),
                      child: const Text('Riprendi'),
                    ),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }
}

enum _QueueAction { sendNow, edit, delete }
