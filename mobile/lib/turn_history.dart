import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import 'ui.dart';

/// Assistant body only. Keep MessageView's padding and user bubble unchanged.
/// Offsets use UTF-16 units, matching desktop JavaScript's string slicing.
class TurnHistory extends StatelessWidget {
  const TurnHistory({
    super.key,
    required this.message,
    this.live = false,
    this.onStopAgent,
    this.onStopShell,
  });

  final Map<String, dynamic> message;
  final bool live;
  final ValueChanged<String>? onStopAgent, onStopShell;

  @override
  Widget build(BuildContext context) {
    final content = message['content'] is String
        ? message['content'] as String
        : '';
    final events =
        (message['activity'] is List ? message['activity'] as List : const [])
            .whereType<Map>()
            .where(
              (e) => const [
                'reasoning',
                'tool',
                'agent',
                'approval',
              ].contains(e['kind']),
            )
            .toList();
    // Older snapshots supply aggregate reasoning without positional events.
    // Never duplicate that aggregate or infer reasoning from tool summaries.
    final reasoning = message['reasoning'] ?? message['reasoning_content'];
    if (!events.any((e) => e['kind'] == 'reasoning') &&
        reasoning is String &&
        reasoning.trim().isNotEmpty) {
      events.insert(0, {'kind': 'reasoning', 'text': reasoning, 'offset': 0});
    }
    final parts = <Widget>[];
    var cursor = 0;
    var groupOffset = 0;
    var group = <Map>[];
    void prose(int end) {
      if (end == cursor) return;
      parts.add(
        MarkdownBody(
          key: ValueKey('text-$cursor'),
          data: content.substring(cursor, end),
          selectable: true,
          styleSheet: MarkdownStyleSheet(
            p: const TextStyle(fontSize: 16, height: 1.6, color: textColor),
            code: const TextStyle(color: orchid, fontSize: 14),
            blockquoteDecoration: BoxDecoration(
              color: panel,
              borderRadius: BorderRadius.circular(12),
            ),
            codeblockDecoration: BoxDecoration(
              color: sidebar,
              borderRadius: BorderRadius.circular(12),
            ),
          ),
        ),
      );
    }

    void flush() {
      if (group.isEmpty) return;
      parts.add(
        _HistoryGroup(
          key: ValueKey('group-$groupOffset'),
          events: group,
          live: live && groupOffset >= content.length,
          liveSnapshot: live,
          onStopAgent: onStopAgent,
          onStopShell: onStopShell,
        ),
      );
      group = <Map>[];
    }

    for (final event in events) {
      final raw = event['offset'];
      var position = (raw is num && raw.isFinite ? raw.toInt() : 0).clamp(
        cursor,
        content.length,
      );
      // Malformed offsets must not split an emoji's surrogate pair.
      if (position > 0 &&
          position < content.length &&
          content.codeUnitAt(position - 1) >= 0xd800 &&
          content.codeUnitAt(position - 1) <= 0xdbff &&
          content.codeUnitAt(position) >= 0xdc00 &&
          content.codeUnitAt(position) <= 0xdfff) {
        position++;
      }
      if (position > cursor) {
        flush();
        prose(position);
        cursor = position;
      }
      if (group.isEmpty) groupOffset = position;
      group.add(event);
    }
    flush();
    prose(content.length);
    if (message['truncated'] == true) {
      parts.add(
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 12),
          child: Text(
            'Anteprima live ridotta. La cronologia completa sarà disponibile a fine turno.',
            style: TextStyle(color: muted, fontSize: 13, height: 1.5),
          ),
        ),
      );
    }
    if (live && events.isEmpty) {
      parts.add(
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 12),
          child: Text('In corso…', style: TextStyle(color: muted)),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: parts,
    );
  }
}

class _HistoryGroup extends StatelessWidget {
  const _HistoryGroup({
    super.key,
    required this.events,
    required this.live,
    required this.liveSnapshot,
    this.onStopAgent,
    this.onStopShell,
  });
  final List<Map> events;
  final bool live;
  final bool liveSnapshot;
  final ValueChanged<String>? onStopAgent, onStopShell;

  @override
  Widget build(BuildContext context) => _Disclosure(
    title: 'Attività · ${events.length}${live ? ' · In corso' : ''}',
    icon: Icons.history_rounded,
    initiallyExpanded: live,
    children: [
      for (var i = 0; i < events.length; i++)
        _HistoryStep(
          key: ValueKey(events[i]['id'] ?? 'step-$i'),
          event: events[i],
          live: liveSnapshot,
          onStopAgent: onStopAgent,
          onStopShell: onStopShell,
        ),
    ],
  );
}

class _HistoryStep extends StatelessWidget {
  const _HistoryStep({
    super.key,
    required this.event,
    required this.live,
    this.onStopAgent,
    this.onStopShell,
  });
  final Map event;
  final bool live;
  final ValueChanged<String>? onStopAgent, onStopShell;

  @override
  Widget build(BuildContext context) {
    final kind = event['kind'];
    final action = event['action'];
    final title =
        event['title'] ??
        switch (kind) {
          'reasoning' => 'Ragionamento',
          'agent' => 'Agente',
          'approval' => 'Approvazione',
          _ =>
            _actionLabels[action] ?? (action is String ? action : 'Strumento'),
        };
    final status = switch (event['status']) {
      'running' => 'In corso',
      'reviewing' => 'In revisione',
      'waiting' || 'pending' => 'In attesa',
      'completed' => 'Completato',
      'approved' => 'Approvato',
      'denied' => 'Negato',
      'failed' => 'Errore',
      'cancelled' || 'stopped' => 'Interrotto',
      final String value => value,
      _ => '',
    };
    final nested = kind == 'agent';
    final running = live && event['status'] == 'running';
    final agentId = event['id'];
    final shellId = _shellId(event);
    return _Disclosure(
      title: '$title${status.isEmpty ? '' : ' · $status'}',
      initiallyExpanded:
          live && kind == 'reasoning' && event['status'] == 'running',
      icon: switch (kind) {
        'reasoning' => Icons.psychology_outlined,
        'agent' => Icons.smart_toy_outlined,
        'approval' => Icons.verified_user_outlined,
        _ => Icons.terminal_rounded,
      },
      children: [
        if (running &&
            nested &&
            onStopAgent != null &&
            agentId is String &&
            agentId.isNotEmpty)
          TextButton(
            onPressed: () => onStopAgent!(agentId),
            style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
            child: const Text('Interrompi agente'),
          ),
        if (running &&
            kind == 'tool' &&
            onStopShell != null &&
            const [
              'execute_project_command',
              'inspect_project_command',
            ].contains(action) &&
            shellId != null)
          TextButton(
            onPressed: () => onStopShell!(shellId),
            style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
            child: const Text('Interrompi comando'),
          ),
        if (kind == 'reasoning')
          _Detail(value: event['text'])
        else ...[
          for (final field in const {
            'task': 'Compito',
            'model': 'Modello',
            'command': 'Comando',
            'path': 'Percorso',
            'summary': 'Riepilogo',
            'reason': 'Motivo',
            'arguments': 'Argomenti',
            'output': 'Output',
            'result': 'Risultato',
            'error': 'Errore',
          }.entries)
            if (event[field.key] != null)
              _Detail(label: field.value, value: event[field.key]),
          if (kind == 'approval') _Detail(label: 'Azione', value: action),
          if (nested)
            TurnHistory(
              message: Map<String, dynamic>.from(event),
              live: live && event['status'] == 'running',
              onStopAgent: onStopAgent,
              onStopShell: onStopShell,
            ),
        ],
      ],
    );
  }
}

String? _shellId(Map event) {
  Object? output = event['output'];
  if (output is String) {
    try {
      output = jsonDecode(output);
    } on FormatException {
      output = null;
    }
  }
  final id =
      event['shell_id'] ??
      (output is Map ? output['shell_id'] ?? output['id'] : null);
  return id is String && id.isNotEmpty ? id : null;
}

class _Disclosure extends StatelessWidget {
  const _Disclosure({
    required this.title,
    required this.icon,
    required this.children,
    this.initiallyExpanded = false,
  });
  final String title;
  final IconData icon;
  final List<Widget> children;
  final bool initiallyExpanded;

  @override
  Widget build(BuildContext context) => ExpansionTile(
    initiallyExpanded: initiallyExpanded,
    minTileHeight: 48,
    tilePadding: EdgeInsets.zero,
    childrenPadding: const EdgeInsets.only(left: 16, bottom: 8),
    shape: const Border(),
    collapsedShape: const Border(),
    expansionAnimationStyle: MediaQuery.disableAnimationsOf(context)
        ? AnimationStyle.noAnimation
        : null,
    leading: Icon(icon, size: 20, color: muted),
    title: Text(title, style: const TextStyle(color: muted, fontSize: 13)),
    children: children,
  );
}

class _Detail extends StatelessWidget {
  const _Detail({this.label, required this.value});
  final String? label;
  final Object? value;

  @override
  Widget build(BuildContext context) {
    if (value == null || value == '') return const SizedBox.shrink();
    final text = value is String
        ? value as String
        : const JsonEncoder.withIndent('  ').convert(value);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (label != null)
            Text(label!, style: const TextStyle(color: muted, fontSize: 12)),
          SelectableText(
            text,
            style: const TextStyle(fontSize: 13, height: 1.5),
          ),
        ],
      ),
    );
  }
}

const _actionLabels = {
  'read_project_file': 'Leggi file',
  'list_project_files': 'Elenca file',
  'search_project_files': 'Cerca nei file',
  'write_project_file': 'Scrivi file',
  'edit_project_file': 'Modifica file',
  'execute_project_command': 'Esegui comando',
  'inspect_project_command': 'Controlla comando',
  'create_subagent': 'Crea agente',
};
