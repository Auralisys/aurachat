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
    this.onGuide,
    this.onResume,
  });

  final String text;
  final String status;
  final bool locked;
  final String? warning;
  final VoidCallback? onEdit, onDelete, onGuide, onResume;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Padding(
            padding: const EdgeInsets.only(right: 6, bottom: 6),
            child: Text(
              status,
              style: const TextStyle(
                fontSize: 12,
                height: 1.3,
                fontWeight: FontWeight.w600,
                color: muted,
              ),
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
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                _action(context, Icons.edit_outlined, 'Modifica', onEdit),
                _action(
                  context,
                  Icons.delete_outline_rounded,
                  'Elimina',
                  onDelete,
                ),
                if (onGuide != null)
                  _action(context, Icons.bolt_rounded, 'Usa come guida', onGuide),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _action(
    BuildContext context,
    IconData icon,
    String label,
    VoidCallback? onTap,
  ) {
    return TextButton.icon(
      onPressed: locked || onTap == null ? null : onTap,
      icon: Icon(icon, size: 16),
      label: Text(label),
      style: TextButton.styleFrom(
        foregroundColor: orchid,
        disabledForegroundColor: muted.withValues(alpha: .5),
        minimumSize: const Size(48, 48),
        padding: const EdgeInsets.symmetric(horizontal: 8),
        textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
      ),
    );
  }
}
