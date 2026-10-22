import 'package:flutter/material.dart';

import 'ui.dart';

typedef GitRequest =
    Future<Map<String, dynamic>> Function(
      String operation,
      Map<String, dynamic> arguments,
    );

class GitChanges extends StatefulWidget {
  const GitChanges({
    super.key,
    required this.request,
    required this.online,
    required this.canMutate,
  });

  final GitRequest request;
  final bool online, canMutate;

  @override
  State<GitChanges> createState() => _GitChangesState();
}

class _GitChangesState extends State<GitChanges>
    with AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => true;
  final message = TextEditingController();
  List<String> repositories = [];
  String? root, error, notice;
  Map<String, dynamic>? data, preview;
  bool busy = false, manual = false, withPush = false, truncated = false;
  bool confirmingPush = false;

  @override
  void initState() {
    super.initState();
    if (widget.online) refresh();
  }

  @override
  void didUpdateWidget(covariant GitChanges oldWidget) {
    super.didUpdateWidget(oldWidget);
    if ((!oldWidget.online && widget.online) ||
        (!oldWidget.canMutate && widget.canMutate)) {
      refresh();
    }
  }

  @override
  void dispose() {
    message.dispose();
    super.dispose();
  }

  Future<Map<String, dynamic>> request(
    String operation, [
    Map<String, dynamic> extra = const {},
  ]) {
    if (!widget.online) throw StateError('PC offline. Ricollegalo e riprova.');
    return widget.request(operation, {'root': root ?? '', ...extra});
  }

  Future<void> run(Future<void> Function() action) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
      notice = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> load({bool discover = false, bool select = true}) async {
    if (discover) {
      final result = await request('discover');
      if (!mounted) return;
      repositories = (result['repositories'] as List).cast<String>();
      truncated = result['truncated'] == true;
      if (!repositories.contains(root)) {
        root = repositories.firstOrNull;
        manual = false;
        data = null;
        preview = null;
        message.clear();
      }
    }
    if (root == null) return;
    if (select && !manual && preview == null && message.text.isEmpty) {
      final statuses = await Future.wait(
        repositories.map(
          (repository) async => (
            root: repository,
            data: await request('status', {'root': repository}),
          ),
        ),
      );
      if (!mounted) return;
      var best = statuses.firstWhere((s) => s.root == root);
      for (final item in statuses) {
        final count =
            (item.data['added'] as num) + (item.data['removed'] as num);
        final bestCount =
            (best.data['added'] as num) + (best.data['removed'] as num);
        if (count > bestCount ||
            (count == bestCount &&
                (item.data['files'] as List).length >
                    (best.data['files'] as List).length)) {
          best = item;
        }
      }
      root = best.root;
      data = best.data;
    } else {
      final result = await request('status');
      if (!mounted) return;
      data = result;
    }
    if (preview != null && preview!['index_revision'] != data!['revision']) {
      preview = null;
      notice = 'Lo stage è cambiato. Riapri l’anteprima prima di confermare.';
    }
  }

  Future<void> refresh() => run(() => load(discover: true));

  List<Map> files(String side) => (data?['files'] as List? ?? [])
      .whereType<Map>()
      .where((file) => file[side] != null)
      .toList();

  Future<void> stage(String side, List<String> paths) => run(() async {
    preview = null;
    await request(side == 'staged' ? 'unstage' : 'stage', {
      'paths': paths,
      'revision': data!['revision'],
    });
    if (!mounted) return;
    await load(select: false);
  });

  Future<void> prepare(bool push) => run(() async {
    final result = await request('preview');
    if (!mounted) return;
    preview = result;
    withPush = push;
  });

  Future<void> generate() => run(() async {
    final result = await request('generate');
    if (!mounted) return;
    preview = result;
    message.text = result['message'] as String;
  });

  Future<void> push() async {
    final target = await request('push_preview');
    if (!mounted) return;
    setState(() => confirmingPush = true);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Confermare il push?'),
        content: SingleChildScrollView(
          child: SelectableText(
            '$root\n\n${target['remote']} → ${target['target']}\n${target['head']}\n\nIl commit sarà pubblicato sul remoto indicato.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Annulla'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Conferma push'),
          ),
        ],
      ),
    );
    if (!mounted) return;
    setState(() => confirmingPush = false);
    if (confirmed != true || !widget.canMutate) return;
    await request('push', {'revision': target['revision'], 'confirmed': true});
    if (!mounted) return;
    notice = 'Push completato.';
    await load(select: false);
  }

  Future<void> commit() => run(() async {
    await request('commit', {
      'revision': preview!['revision'],
      'message': message.text.trim(),
      'confirmed': true,
    });
    if (!mounted) return;
    preview = null;
    message.clear();
    notice = 'Commit creato sul PC. Nessun push eseguito.';
    await load(select: false);
    if (mounted && withPush) await push();
  });

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final enabled = widget.online && widget.canMutate && !busy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            const Expanded(
              child: Text(
                'Cambiamenti',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
              ),
            ),
            IconButton(
              tooltip: 'Aggiorna cambiamenti',
              onPressed: widget.online && !busy ? refresh : null,
              icon: const Icon(Icons.refresh_rounded),
            ),
          ],
        ),
        if (busy && !confirmingPush)
          const LinearProgressIndicator(minHeight: 2),
        if (!widget.online)
          const Text(
            'PC offline. I cambiamenti locali richiedono il PC collegato.',
            style: TextStyle(color: muted),
          ),
        if (!widget.canMutate && widget.online)
          const Text(
            'Attendi la fine delle conversazioni prima di modificare lo stage o creare un commit.',
            style: TextStyle(color: muted),
          ),
        if (error != null)
          Text(
            error!,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        if (notice != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(notice!),
          ),
        if (truncated)
          const Text(
            'Ricerca repository incompleta. Collega una cartella più specifica sul PC.',
          ),
        if (repositories.isEmpty && !busy && error == null && widget.online)
          const Text(
            'Nessun repository nelle cartelle autorizzate.',
            style: TextStyle(color: muted),
          ),
        if (repositories.length > 1)
          DropdownButtonFormField<String>(
            initialValue: root,
            key: ValueKey(root),
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Repository'),
            items: repositories
                .map(
                  (repository) => DropdownMenuItem(
                    value: repository,
                    child: Text(
                      repository,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                )
                .toList(),
            onChanged: widget.online && !busy
                ? (value) {
                    root = value;
                    manual = true;
                    data = null;
                    preview = null;
                    message.clear();
                    run(load);
                  }
                : null,
          ),
        if (data != null) ...[
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Wrap(
              spacing: 12,
              runSpacing: 4,
              children: [
                Text(data!['branch']?.toString() ?? 'HEAD scollegato'),
                Text(
                  '+${data!['added']}',
                  style: const TextStyle(color: Color(0xff8ed7a5)),
                ),
                Text(
                  '−${data!['removed']}',
                  style: const TextStyle(color: Color(0xffffa3a3)),
                ),
                Text(
                  '${(data!['files'] as List).length} file',
                  style: const TextStyle(color: muted),
                ),
              ],
            ),
          ),
          if (repositories.length == 1)
            SelectableText(root!, style: const TextStyle(color: muted)),
          if ((data!['files'] as List).isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Text('Nessun cambiamento da salvare.'),
            ),
          for (final side in ['unstaged', 'staged'])
            if (files(side).isNotEmpty)
              ExpansionTile(
                key: PageStorageKey('git-$root-$side'),
                initiallyExpanded: true,
                tilePadding: EdgeInsets.zero,
                title: Text(
                  '${side == 'staged' ? 'Staged' : 'Da aggiungere'} · ${files(side).length}',
                ),
                children: [
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton(
                      onPressed: enabled
                          ? () => stage(
                              side,
                              files(
                                side,
                              ).map((f) => f['path'] as String).toList(),
                            )
                          : null,
                      child: Text(
                        side == 'staged'
                            ? 'Rimuovi tutti dallo stage'
                            : 'Aggiungi tutti allo stage',
                      ),
                    ),
                  ),
                  for (final file in files(side))
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text(file['path'] as String),
                      subtitle: Text(
                        '+${(file[side] as Map)['added']}  −${(file[side] as Map)['removed']}',
                      ),
                      trailing: IconButton(
                        tooltip:
                            '${side == 'staged' ? 'Rimuovi dallo stage' : 'Aggiungi allo stage'} · ${file['path']}',
                        onPressed: enabled
                            ? () => stage(side, [file['path'] as String])
                            : null,
                        icon: Icon(
                          side == 'staged'
                              ? Icons.remove_rounded
                              : Icons.add_rounded,
                        ),
                      ),
                    ),
                ],
              ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton(
                onPressed: enabled && files('staged').isNotEmpty
                    ? () => prepare(false)
                    : null,
                child: const Text('Commit…'),
              ),
              OutlinedButton(
                onPressed:
                    enabled &&
                        files('staged').isNotEmpty &&
                        data!['upstream'] != null
                    ? () => prepare(true)
                    : null,
                child: const Text('Commit e push…'),
              ),
              TextButton(
                onPressed:
                    enabled &&
                        data!['upstream'] != null &&
                        (data!['ahead'] as num? ?? 0) > 0
                    ? () => run(push)
                    : null,
                child: const Text('Push…'),
              ),
            ],
          ),
          if (files('staged').isEmpty && (data!['files'] as List).isNotEmpty)
            const Text(
              'Aggiungi allo stage solo i file da includere nel commit.',
              style: TextStyle(color: muted),
            ),
        ],
        if (preview != null) ...[
          const SizedBox(height: 16),
          Text(
            withPush ? 'Anteprima commit e push' : 'Anteprima commit',
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          const Text(
            'Il commit include tutto lo stage, anche i file aggiunti dal PC.',
            style: TextStyle(color: muted),
          ),
          const SizedBox(height: 8),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 240),
            child: SingleChildScrollView(
              child: SelectableText(
                preview!['diff'] as String,
                style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
              ),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: message,
            enabled: enabled,
            minLines: 2,
            maxLines: 5,
            decoration: const InputDecoration(
              labelText: 'Messaggio del commit',
            ),
            onChanged: (_) => setState(() {}),
          ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              TextButton(
                onPressed: enabled ? generate : null,
                child: const Text('Genera con AI'),
              ),
              TextButton(
                onPressed: busy ? null : () => setState(() => preview = null),
                child: const Text('Chiudi anteprima'),
              ),
              FilledButton(
                onPressed: enabled && message.text.trim().isNotEmpty
                    ? commit
                    : null,
                child: Text(
                  withPush ? 'Conferma commit, poi push…' : 'Conferma commit',
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }
}
