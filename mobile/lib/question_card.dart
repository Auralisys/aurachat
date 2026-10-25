import 'package:flutter/material.dart';

import 'ui.dart';

class _AnswerDraft {
  String action = 'answer';
  final Set<String> selected = {};
}

/// Interactive question card, mirroring `desktop/ui/questions.js`. Supports a
/// single question or a flat batch (up to twelve), single/multiple choice,
/// a free-text custom answer and the Discuss / Skip / close (cancel) actions.
class QuestionCard extends StatefulWidget {
  const QuestionCard({
    super.key,
    required this.question,
    required this.onSubmit,
  });

  final Map<String, dynamic> question;
  final Future<void> Function(Map<String, dynamic> answer) onSubmit;

  @override
  State<QuestionCard> createState() => _QuestionCardState();
}

class _QuestionCardState extends State<QuestionCard> {
  late final bool batch;
  late final List<Map<String, dynamic>> items;
  late final List<_AnswerDraft> drafts;
  late final List<TextEditingController> customControllers;
  int index = 0;
  bool submitting = false;
  String? error;

  @override
  void initState() {
    super.initState();
    final raw = widget.question['questions'];
    if (raw is List && raw.isNotEmpty) {
      batch = true;
      items = raw
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
    } else {
      batch = false;
      items = [widget.question];
    }
    drafts = List.generate(items.length, (_) => _AnswerDraft());
    customControllers = List.generate(
      items.length,
      (_) => TextEditingController(),
    );
  }

  @override
  void dispose() {
    for (final controller in customControllers) {
      controller.dispose();
    }
    super.dispose();
  }

  Map<String, dynamic> get current => items[index];
  _AnswerDraft get draft => drafts[index];
  bool get isLast => index == items.length - 1;

  Map<String, dynamic>? get step {
    if (batch) {
      return {'current': index + 1, 'total': items.length};
    }
    final value = widget.question['step'];
    return value is Map ? Map<String, dynamic>.from(value) : null;
  }

  String get stepLabel {
    final value = step;
    if (value == null) return 'Domanda';
    return 'Domanda ${value['current']} di ${value['total']}';
  }

  Future<void> respond(String action) async {
    if (submitting) return;
    final selected = action == 'answer'
        ? List<String>.from(drafts[index].selected)
        : <String>[];
    final custom = customControllers[index].text;
    if (action == 'answer' && selected.isEmpty && custom.trim().isEmpty) {
      setState(() => error = 'Seleziona una risposta o scrivi un testo.');
      return;
    }
    if (action != 'cancel') {
      drafts[index].action = action;
      drafts[index]
        ..selected.clear()
        ..selected.addAll(selected);
      if (action == 'skip') customControllers[index].clear();
      if (batch && !isLast && action != 'discuss') {
        setState(() {
          index++;
          error = null;
        });
        return;
      }
    }
    final Map<String, dynamic> answer;
    if (batch) {
      final end = action == 'cancel' ? index : index + 1;
      answer = {
        'action': action == 'discuss'
            ? 'discuss'
            : action == 'cancel'
                ? 'cancel'
                : 'answer',
        'answers': [
          for (var i = 0; i < end; i++)
            {
              'action': drafts[i].action,
              'selected': List<String>.from(drafts[i].selected),
              'custom': customControllers[i].text,
            },
        ],
      };
    } else {
      answer = {
        'action': action,
        'selected': selected,
        'custom': action == 'skip' || action == 'cancel' ? '' : custom,
      };
    }
    setState(() {
      submitting = true;
      error = null;
    });
    try {
      await widget.onSubmit(answer);
    } catch (e) {
      if (mounted) {
        setState(() {
          submitting = false;
          error = e.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final question = current;
    final questionText = (question['question'] ?? '').toString();
    final multi = question['multi_select'] == true;
    final choices = (question['choices'] as List? ?? const [])
        .whereType<String>()
        .toList();
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: panel,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: violet.withValues(alpha: .5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  stepLabel,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
              IconButton(
                tooltip: 'Chiudi',
                onPressed: submitting ? null : () => respond('cancel'),
                icon: const Icon(Icons.close_rounded),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(questionText, style: const TextStyle(height: 1.4)),
          const SizedBox(height: 8),
          Text(
            multi ? 'Puoi selezionare più opzioni.' : 'Seleziona una risposta.',
            style: const TextStyle(color: muted, fontSize: 12),
          ),
          if (choices.isNotEmpty) ...[
            const SizedBox(height: 8),
            if (multi)
              ...choices.map((choice) {
                final checked = draft.selected.contains(choice);
                return CheckboxListTile(
                  value: checked,
                  onChanged: submitting
                      ? null
                      : (value) => setState(() {
                            if (value == true) {
                              draft.selected.add(choice);
                            } else {
                              draft.selected.remove(choice);
                            }
                            error = null;
                          }),
                  title: Text(choice),
                  dense: true,
                  controlAffinity: ListTileControlAffinity.leading,
                  contentPadding: EdgeInsets.zero,
                );
              })
            else
              RadioGroup<String>(
                groupValue: draft.selected.isEmpty
                    ? null
                    : draft.selected.first,
                onChanged: (value) {
                  if (submitting || value == null) return;
                  setState(() {
                    draft.selected
                      ..clear()
                      ..add(value);
                    error = null;
                  });
                },
                child: Column(
                  children: [
                    for (final choice in choices)
                      RadioListTile<String>(
                        value: choice,
                        title: Text(choice),
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                      ),
                  ],
                ),
              ),
          ],
          const SizedBox(height: 8),
          TextField(
            controller: customControllers[index],
            enabled: !submitting,
            maxLines: null,
            minLines: 1,
            maxLength: 16000,
            decoration: const InputDecoration(
              labelText: 'Risposta personalizzata',
              hintText: 'Scrivi qui la tua risposta…',
              counterText: '',
            ),
            onChanged: (_) => setState(() => error = null),
          ),
          if (error != null) ...[
            const SizedBox(height: 8),
            Text(
              error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ],
          const SizedBox(height: 12),
          Wrap(
            alignment: WrapAlignment.end,
            spacing: 8,
            runSpacing: 8,
            children: [
              TextButton(
                onPressed: submitting ? null : () => respond('discuss'),
                child: const Text('Discuti'),
              ),
              if (index > 0)
                TextButton(
                  onPressed: submitting
                      ? null
                      : () => setState(() {
                            index--;
                            error = null;
                          }),
                  child: const Text('Indietro'),
                ),
              TextButton(
                onPressed: submitting ? null : () => respond('skip'),
                child: const Text('Salta'),
              ),
              FilledButton(
                onPressed: submitting ? null : () => respond('answer'),
                child: Text(
                  submitting
                      ? 'Invio…'
                      : batch && !isLast
                          ? 'Avanti'
                          : 'Invia',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
