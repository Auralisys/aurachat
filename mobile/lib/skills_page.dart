import 'package:flutter/material.dart';
import 'ui.dart';

typedef SkillRequest =
    Future<Map<String, dynamic>> Function(
      String action,
      Map<String, dynamic> arguments,
    );

class SkillsPage extends StatefulWidget {
  const SkillsPage({
    super.key,
    required this.pcName,
    required this.projects,
    required this.request,
    this.initialProject,
  });
  final String pcName;
  final Map<String, dynamic> projects;
  final String? initialProject;
  final SkillRequest request;

  @override
  State<SkillsPage> createState() => _SkillsPageState();
}

class _SkillsPageState extends State<SkillsPage> {
  final query = TextEditingController();
  String? project, error, status;
  bool busy = false;
  List<Map<String, dynamic>> skills = [], results = [];
  int version = 0;

  @override
  void initState() {
    super.initState();
    project = widget.initialProject;
    refresh();
  }

  @override
  void dispose() {
    query.dispose();
    super.dispose();
  }

  Future<void> run(Future<void> Function() operation) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
      status = null;
    });
    try {
      await operation();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  List<Map<String, dynamic>> entries(Map<String, dynamic> result) {
    final rows = result['skills'];
    if (rows is! List) throw StateError('Catalogo skill non valido. Riprova.');
    return rows
        .whereType<Map>()
        .map((s) => Map<String, dynamic>.from(s))
        .toList();
  }

  Future<void> load() async {
    final data = await widget.request('skills_catalog', {
      'project_id': project,
    });
    if (!mounted) return;
    setState(() {
      skills = entries(data);
      status = data['truncated'] == true
          ? 'Catalogo incompleto. Restringi il progetto sul PC.'
          : null;
    });
  }

  Future<void> refresh() => run(load);

  Future<void> search() => run(() async {
    final text = query.text.trim(), request = ++version;
    final data = await widget.request('skills_search', {'query': text});
    if (!mounted || version != request) return;
    setState(() {
      results = entries(data);
      status = results.isEmpty
          ? 'Nessun risultato su skills.sh. Prova un altro nome.'
          : 'Risultati da skills.sh: controlla la sorgente.';
    });
  });

  Future<void> install(Map<String, dynamic> skill) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Installare ${skill['name']}?'),
        content: Text(
          'Sorgente: ${skill['source']}\n\nAuraChat eseguirà npx skills sul PC ${widget.pcName}, scaricando software di terze parti. La skill sarà globale per l’utente del PC, anche negli editor compatibili. Richiede Node.js 22.20+ e Git. Installa solo da sorgenti affidabili.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Annulla'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Installa sul PC'),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true) return;
    await run(() async {
      setState(() => status = 'Installazione sul PC…');
      await widget.request('skill_install', {
        'source': skill['source'],
        'name': skill['name'],
        'confirm_install': true,
      });
      if (!mounted) return;
      query.clear();
      setState(() => results = []);
      await load();
      if (mounted) {
        setState(() => status = '${skill['name']} installata e attiva.');
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final text = query.text.trim().toLowerCase();
    final filtered = skills
        .where(
          (s) =>
              '${s['name']} ${s['description']}'.toLowerCase().contains(text),
        )
        .toList();
    return Scaffold(
      appBar: AppBar(
        title: const Text('Skill'),
        actions: [
          IconButton(
            onPressed: busy ? null : refresh,
            tooltip: 'Aggiorna skill',
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Text(
                  'Skill su ${widget.pcName}',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                const Text(
                  'Richiamale con /nome. Gli interruttori valgono solo per i prossimi richiami in AuraChat, non per gli altri editor o i turni già avviati.',
                  style: TextStyle(color: muted),
                ),
                const SizedBox(height: 24),
                DropdownButtonFormField<String>(
                  initialValue: project ?? '',
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Ambito sul PC'),
                  items: [
                    const DropdownMenuItem(
                      value: '',
                      child: Text('Solo skill globali'),
                    ),
                    for (final p in widget.projects.entries)
                      DropdownMenuItem(
                        value: p.key,
                        child: Text(
                          p.value['name'].toString(),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                  onChanged: busy
                      ? null
                      : (value) {
                          setState(() {
                            project = value == '' ? null : value;
                            results = [];
                          });
                          refresh();
                        },
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: query,
                  maxLength: 100,
                  enabled: !busy,
                  decoration: const InputDecoration(
                    labelText: 'Cerca skill',
                    hintText: 'Nome o descrizione',
                    prefixIcon: Icon(Icons.search_rounded),
                    counterText: '',
                  ),
                  onChanged: (_) => setState(() {
                    version++;
                    results = [];
                    status = null;
                  }),
                  onSubmitted: text.length < 2 || busy ? null : (_) => search(),
                ),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  onPressed: busy || text.length < 2 ? null : search,
                  icon: const Icon(Icons.add_rounded),
                  label: const Text('Cerca su skills.sh'),
                ),
                if (busy)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 12),
                    child: LinearProgressIndicator(),
                  ),
                if (status != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(status!, style: const TextStyle(color: muted)),
                  ),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(
                      error!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
                if (!busy && filtered.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 20),
                    child: Text(
                      'Nessuna skill installata corrispondente. Cerca un nome per aggiungerla da skills.sh.',
                      style: TextStyle(color: muted),
                    ),
                  ),
                for (final skill in filtered)
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text('/${skill['name']}'),
                    subtitle: Text(
                      '${skill['description'] ?? ''}\n${skill['scope'] == 'global' ? 'Globale' : 'Progetto'}${skill['shadowed'] == true ? ' · Il progetto ha precedenza' : ''}',
                    ),
                    value: skill['enabled'] != false,
                    onChanged: busy
                        ? null
                        : (enabled) => run(() async {
                            await widget.request('skill_enabled', {
                              'project_id': project,
                              'id': skill['id'],
                              'enabled': enabled,
                            });
                            if (mounted) {
                              setState(() => skill['enabled'] = enabled);
                            }
                          }),
                  ),
                if (results.isNotEmpty)
                  const Padding(
                    padding: EdgeInsets.only(top: 24, bottom: 8),
                    child: Text(
                      'Su skills.sh',
                      style: TextStyle(fontWeight: FontWeight.w600),
                    ),
                  ),
                for (final skill in results)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(skill['name'].toString()),
                    subtitle: Text(skill['source'].toString()),
                    trailing: TextButton(
                      onPressed: busy ? null : () => install(skill),
                      child: const Text('Installa'),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
