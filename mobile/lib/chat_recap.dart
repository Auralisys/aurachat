import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import 'companion.dart';
import 'git_changes.dart';
import 'turn_history.dart';
import 'ui.dart';

Map<String, dynamic>? _object(Object? value) {
  if (value is String) {
    try {
      value = jsonDecode(value);
    } on FormatException {
      return null;
    }
  }
  return value is Map ? Map<String, dynamic>.from(value) : null;
}

class ChatRecap {
  ChatRecap(List<Map<String, dynamic>> messages) {
    final urls = <String>{};
    final published = <String, Map<String, dynamic>>{};
    final agentMap = <String, Map<String, dynamic>>{};
    void source(String value) {
      final url = Uri.tryParse(value);
      if (url == null ||
          !['http', 'https'].contains(url.scheme) ||
          url.host.isEmpty) {
        return;
      }
      if (urls.add(value)) sources.add({'name': url.host, 'url': value});
    }

    void visit(Map event) {
      if (event['kind'] == 'agent') {
        if (event['id'] is String) {
          agentMap[event['id']] = Map<String, dynamic>.from(event);
        }
        for (final child
            in (event['activity'] as List? ?? []).whereType<Map>()) {
          visit(child);
        }
      }
      if (event['kind'] != 'tool' || event['status'] != 'completed') return;
      final result = _object(event['output']);
      if (event['action'] == 'fetch_web_page' && result?['url'] is String) {
        source(result!['url']);
      }
      if (event['action'] == 'publish_project_output' &&
          result?['final_output'] == true &&
          result?['path'] is String &&
          result?['written_bytes'] is num) {
        published[result!['path']] = result;
      }
    }

    for (final message in messages) {
      if (message['role'] == 'user') {
        for (final match in RegExp(
          r'''https?://[^\s<>()\[\]]+''',
        ).allMatches(message['content'] as String? ?? '')) {
          source(match.group(0)!.replaceAll(RegExp(r'''[.,;!'"»]+$'''), ''));
        }
        for (final file
            in (message['attachments'] as List? ?? []).whereType<Map>()) {
          sources.add(Map<String, dynamic>.from(file));
        }
      }
      for (final event
          in (message['activity'] as List? ?? []).whereType<Map>()) {
        visit(event);
        if (event['kind'] != 'agent') {
          activity.add(Map<String, dynamic>.from(event));
        }
      }
    }
    outputs.addAll(published.values);
    agents.addAll(agentMap.values);
  }

  final List<Map<String, dynamic>> sources = [],
      outputs = [],
      agents = [],
      activity = [];
}

typedef RecapRequest =
    Future<Map<String, dynamic>> Function(
      String action,
      Map<String, dynamic> arguments,
    );

class ChatRecapPage extends StatefulWidget {
  const ChatRecapPage({
    super.key,
    required this.title,
    required this.conversationId,
    required this.pcName,
    required this.messages,
    required this.request,
    required this.online,
    required this.protocol,
    required this.hasProject,
    this.liveTurn,
    this.messagesStream,
    this.liveStream,
    this.deviceStream,
    this.anyRunning = false,
  });

  final String title, pcName, conversationId;
  final List<Map<String, dynamic>> messages;
  final RecapRequest request;
  final bool online, hasProject;
  final bool anyRunning;
  final int protocol;
  final Map<String, dynamic>? liveTurn;
  final Stream<List<Map<String, dynamic>>>? messagesStream;
  final Stream<List<Map<String, dynamic>>>? liveStream;
  final Stream<Map<String, dynamic>>? deviceStream;

  @override
  State<ChatRecapPage> createState() => _ChatRecapPageState();
}

class _ChatRecapPageState extends State<ChatRecapPage> {
  late List<Map<String, dynamic>> messages = widget.messages;
  late Map<String, dynamic>? live = widget.liveTurn;
  late bool online = widget.online;
  late int protocol = widget.protocol;
  late bool running = widget.anyRunning;
  bool loading = false, truncated = false;
  String? error;
  Map<String, dynamic>? latestDevice;
  Timer? clock;
  List<Map<String, dynamic>> shells = [];
  final subscriptions = <StreamSubscription<dynamic>>[];

  @override
  void initState() {
    super.initState();
    void fail(Object e) {
      if (mounted) setState(() => error = e.toString());
    }

    final messageStream = widget.messagesStream;
    if (messageStream != null) {
      subscriptions.add(
        messageStream.listen((items) {
          if (mounted) setState(() => messages = items);
        }, onError: fail),
      );
    }
    final liveStream = widget.liveStream;
    if (liveStream != null) {
      subscriptions.add(
        liveStream.listen((turns) {
          if (!mounted) return;
          final previous = running;
          setState(() {
            live = turns
                .where((t) => t['conversation_id'] == widget.conversationId)
                .firstOrNull;
            running = turns.any(liveTurnRunning);
          });
          if (previous && !running && online && protocol >= 5) refresh();
        }, onError: fail),
      );
    }
    final deviceStream = widget.deviceStream;
    if (deviceStream != null) {
      subscriptions.add(
        deviceStream.listen((device) {
          if (!mounted) return;
          final wasOnline = online;
          final previousProtocol = protocol;
          setState(() {
            online = deviceOnline(device);
            latestDevice = device;
            protocol = (device['protocol'] as num? ?? 0).toInt();
          });
          if (online && protocol >= 5 && (!wasOnline || previousProtocol < 5)) {
            refresh();
          }
        }, onError: fail),
      );
    }
    clock = Timer.periodic(const Duration(seconds: 5), (_) {
      if (!mounted || latestDevice == null) return;
      final current = deviceOnline(latestDevice!);
      if (current != online) setState(() => online = current);
    });
    if (online && protocol >= 5) refresh();
  }

  @override
  void dispose() {
    clock?.cancel();
    for (final subscription in subscriptions) {
      subscription.cancel();
    }
    super.dispose();
  }

  Future<Map<String, dynamic>> request(
    String action,
    Map<String, dynamic> arguments,
  ) {
    if (!online) throw StateError('PC offline. Ricollegalo e riprova.');
    if (protocol < 5) {
      throw StateError(
        'Aggiorna AuraChat sul PC per usare i cambiamenti e le shell.',
      );
    }
    return widget.request(action, arguments);
  }

  Future<void> refresh() async {
    if (loading) return;
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final result = await request('chat_recap', {});
      if (mounted) {
        setState(() {
          shells = (result['shells'] as List)
              .map((s) => Map<String, dynamic>.from(s as Map))
              .toList();
          truncated = result['truncated'] == true;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> openSource(Map<String, dynamic> source) async {
    final url = source['url'];
    if (url is String) {
      try {
        if (!await launchUrl(
          Uri.parse(url),
          mode: LaunchMode.externalApplication,
        )) {
          throw StateError('Impossibile aprire il link.');
        }
      } catch (e) {
        if (mounted) setState(() => error = e.toString());
      }
    } else {
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(source['name']?.toString() ?? 'Allegato'),
          content: SingleChildScrollView(
            child: SelectableText(
              source['content']?.toString() ??
                  'Contenuto non disponibile nella cronologia sincronizzata.',
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Chiudi'),
            ),
          ],
        ),
      );
    }
  }

  Future<void> copyPath(String path) async {
    await Clipboard.setData(ClipboardData(text: path));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Percorso del file sul PC copiato')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final currentLive = liveTurnRunning(live) ? live : null;
    final recap = ChatRecap([
      ...messages,
      if (currentLive != null) ...[
        ...((currentLive['segments'] as List? ?? []).whereType<Map>().map(
          (s) => Map<String, dynamic>.from(s),
        )),
        {...currentLive, 'role': 'assistant'},
      ],
    ]);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Attività e cambiamenti'),
        actions: [
          IconButton(
            tooltip: 'Aggiorna attività',
            onPressed: online && protocol >= 5 && !loading ? refresh : null,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 32),
          children: [
            Text(widget.title, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 4),
            Text(
              '${widget.pcName} · ${online ? 'Collegato' : 'Offline'}',
              style: const TextStyle(color: muted),
            ),
            const SizedBox(height: 24),
            if (error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Text(
                  error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            if (protocol < 5)
              const Padding(
                padding: EdgeInsets.only(bottom: 16),
                child: Text(
                  'Aggiorna AuraChat sul PC per gestire Git e le shell. Fonti e attività sincronizzate restano consultabili.',
                ),
              ),
            if (widget.hasProject && protocol >= 5) ...[
              GitChanges(
                request: (operation, arguments) => request('project_git', {
                  'operation': operation,
                  ...arguments,
                }),
                online: online,
                canMutate: !running && currentLive == null,
              ),
              const Divider(height: 40),
            ],
            ExpansionTile(
              key: const PageStorageKey('recap-outputs'),
              title: Text('Output · ${recap.outputs.length}'),
              leading: const Icon(Icons.insert_drive_file_outlined),
              tilePadding: EdgeInsets.zero,
              children: [
                if (recap.outputs.isEmpty)
                  const ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text('Nessun file finale pubblicato.'),
                  ),
                for (final output in recap.outputs)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(
                      (output['path'] as String).split(RegExp(r'[/\\]')).last,
                    ),
                    subtitle: Text(
                      '${output['path']}\nFile sul PC · ${output['written_bytes']} byte',
                    ),
                    trailing: const Icon(Icons.copy_outlined),
                    onTap: () => copyPath(output['path'] as String),
                  ),
              ],
            ),
            ExpansionTile(
              key: const PageStorageKey('recap-sources'),
              title: Text('Fonti · ${recap.sources.length}'),
              leading: const Icon(Icons.language_rounded),
              tilePadding: EdgeInsets.zero,
              children: [
                if (recap.sources.isEmpty)
                  const ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text('Nessuna fonte in questa chat.'),
                  ),
                for (final source in recap.sources)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(
                      source['url'] == null
                          ? Icons.attach_file_rounded
                          : Icons.language_rounded,
                    ),
                    title: Text(source['name']?.toString() ?? 'Allegato'),
                    subtitle: source['url'] is String
                        ? Text(
                            source['url'] as String,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          )
                        : null,
                    trailing: source['url'] is String
                        ? const Icon(Icons.open_in_new_rounded)
                        : null,
                    onTap: () => openSource(source),
                  ),
              ],
            ),
            ExpansionTile(
              key: const PageStorageKey('recap-shells'),
              title: Text('Shell · ${shells.length}'),
              leading: const Icon(Icons.terminal_rounded),
              tilePadding: EdgeInsets.zero,
              children: [
                if (loading) const LinearProgressIndicator(),
                if (shells.isEmpty && !loading)
                  const ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text('Nessun processo in background disponibile.'),
                  ),
                if (truncated)
                  const Text('Mostrati solo i 20 processi più recenti.'),
                if (!online)
                  const Text(
                    'PC offline: lo stato dei processi potrebbe non essere aggiornato.',
                  ),
                for (final shell in shells)
                  ExpansionTile(
                    title: Text(shell['title']?.toString() ?? 'Comando'),
                    subtitle: Text(
                      shell['status'] == 'running'
                          ? 'In corso sul PC'
                          : 'Terminato · ${shell['status']}',
                    ),
                    children: [
                      SelectableText(
                        '${shell['command']}\n${shell['cwd']}\n\n${shell['output']}',
                      ),
                    ],
                  ),
              ],
            ),
            ExpansionTile(
              key: const PageStorageKey('recap-agents'),
              title: Text('Agenti · ${recap.agents.length}'),
              leading: const Icon(Icons.smart_toy_outlined),
              tilePadding: EdgeInsets.zero,
              children: [
                if (recap.agents.isEmpty)
                  const ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text('Nessun agente in questa chat.'),
                  ),
                if (recap.agents.isNotEmpty)
                  TurnHistory(
                    message: {'activity': recap.agents},
                    live: currentLive != null,
                  ),
              ],
            ),
            if (recap.activity.isNotEmpty)
              TurnHistory(
                message: {'activity': recap.activity},
                live: currentLive != null,
              ),
          ],
        ),
      ),
    );
  }
}
