import 'package:flutter/material.dart';
import 'ui.dart';

class SkillPicker extends StatelessWidget {
  const SkillPicker({
    super.key,
    required this.controller,
    required this.focus,
    required this.skills,
    required this.enabled,
    this.hasProject = true,
  });
  final TextEditingController controller;
  final FocusNode focus;
  final List<Map<String, dynamic>> skills;
  final bool enabled, hasProject;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([controller, focus]),
    builder: (context, _) {
      final text = controller.text;
      if (!enabled || !focus.hasFocus || !RegExp(r'^/[\w-]*$').hasMatch(text)) {
        return const SizedBox.shrink();
      }
      final query = text.substring(1).toLowerCase();
      final available = skills
          .where((s) => s['enabled'] != false && s['shadowed'] != true)
          .toList();
      final matches = available
          .where(
            (s) => '${s['name']} ${s['description'] ?? ''}'
                .toLowerCase()
                .contains(query),
          )
          .toList();
      return ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 200),
        child: Material(
          color: panel,
          borderRadius: BorderRadius.circular(12),
          child: matches.isEmpty
              ? Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    'Nessuna skill disponibile. Gestiscile da Menu > Skill.',
                    style: const TextStyle(color: muted),
                  ),
                )
              : ListView(
                  shrinkWrap: true,
                  padding: EdgeInsets.zero,
                  children: [
                    for (final skill in matches)
                      ListTile(
                        dense: true,
                        title: Text('/${skill['name']}'),
                        subtitle: Text(
                          '${skill['description'] ?? ''}${skill['scope'] == 'global' ? '\nGlobale sul PC' : ''}',
                          maxLines: 3,
                          overflow: TextOverflow.ellipsis,
                        ),
                        enabled:
                            available
                                .where((s) => s['name'] == skill['name'])
                                .length ==
                            1,
                        trailing:
                            available
                                    .where((s) => s['name'] == skill['name'])
                                    .length >
                                1
                            ? const Tooltip(
                                message:
                                    'Nome duplicato nelle cartelle del progetto',
                                child: Icon(Icons.warning_amber_rounded),
                              )
                            : null,
                        onTap: () {
                          controller.value = TextEditingValue(
                            text: '/${skill['name']} ',
                            selection: TextSelection.collapsed(
                              offset: skill['name'].toString().length + 2,
                            ),
                          );
                          focus.requestFocus();
                        },
                      ),
                  ],
                ),
        ),
      );
    },
  );
}
