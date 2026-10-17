import 'dart:async';
import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';
import 'companion.dart';
import 'ui.dart';

final push = PushNotifications();
void startAuraChat() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const AuraChat());
}

class AuraChat extends StatefulWidget {
  const AuraChat({super.key});
  @override
  State<AuraChat> createState() => _AuraChatState();
}

class _AuraChatState extends State<AuraChat> {
  late Future<void> startup;
  @override
  void initState() {
    super.initState();
    startup = initialize();
  }

  Future<void> initialize() async {
    if (Firebase.apps.isEmpty) {
      // androidFirebaseOptions contiene l'app Android: su iOS è invalida e
      // Firebase termina il processo. Su iOS si usa GoogleService-Info.plist.
      if (defaultTargetPlatform == TargetPlatform.android) {
        await Firebase.initializeApp(options: androidFirebaseOptions);
      } else {
        await Firebase.initializeApp();
      }
    }
    FirebaseFirestore.instance.settings = const Settings(
      persistenceEnabled: false,
    );
    try {
      await push.initialize();
    } catch (error) {
      push.warning.value = 'Notifiche: ${friendlyError(error)}';
    }
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'AuraChat',
    debugShowCheckedModeBanner: false,
    theme: auraTheme(),
    home: FutureBuilder<void>(
      future: startup,
      builder: (context, snapshot) {
        if (snapshot.hasError) {
          return Scaffold(
            body: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(friendlyError(snapshot.error!)),
                  FilledButton(
                    onPressed: () => setState(() => startup = initialize()),
                    child: const Text('Riprova'),
                  ),
                ],
              ),
            ),
          );
        }
        if (snapshot.connectionState != ConnectionState.done) {
          return const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          );
        }
        return StreamBuilder<User?>(
          stream: FirebaseAuth.instance.authStateChanges(),
          builder: (context, auth) {
            if (auth.connectionState == ConnectionState.waiting) {
              return const Scaffold(
                body: Center(child: CircularProgressIndicator()),
              );
            }
            return auth.data == null
                ? const Login()
                : Workspace(key: ValueKey(auth.data!.uid), user: auth.data!);
          },
        );
      },
    ),
  );
}

class Login extends StatefulWidget {
  const Login({super.key});
  @override
  State<Login> createState() => _LoginState();
}

class _LoginState extends State<Login> {
  final email = TextEditingController(), password = TextEditingController();
  final form = GlobalKey<FormState>();
  bool busy = false, obscured = true;
  String? error;
  @override
  void dispose() {
    email.dispose();
    password.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    if (busy || !form.currentState!.validate()) {
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await FirebaseAuth.instance.signInWithEmailAndPassword(
        email: email.text.trim(),
        password: password.text,
      );
    } catch (e) {
      if (mounted) {
        setState(() => error = friendlyError(e));
      }
    } finally {
      if (mounted) {
        setState(() => busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(28),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: AutofillGroup(
              child: Form(
                key: form,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Align(
                      alignment: Alignment.centerLeft,
                      child: SvgPicture.asset(
                        'assets/logo.svg',
                        width: 48,
                        height: 48,
                      ),
                    ),
                    const SizedBox(height: 28),
                    Text(
                      'Il tuo desktop.\nOvunque sei.',
                      style: Theme.of(context).textTheme.headlineLarge
                          ?.copyWith(fontWeight: FontWeight.w600, height: 1.2),
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      'Accedi con lo stesso account di AuraChat sul PC.',
                      style: TextStyle(color: muted, height: 1.5),
                    ),
                    const SizedBox(height: 32),
                    TextFormField(
                      controller: email,
                      enabled: !busy,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.email],
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(labelText: 'Email'),
                      validator: (v) => v == null || !v.contains('@')
                          ? 'Inserisci la tua email'
                          : null,
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: password,
                      enabled: !busy,
                      obscureText: obscured,
                      autofillHints: const [AutofillHints.password],
                      onFieldSubmitted: (_) => submit(),
                      decoration: InputDecoration(
                        labelText: 'Password',
                        suffixIcon: IconButton(
                          tooltip: obscured
                              ? 'Mostra password'
                              : 'Nascondi password',
                          onPressed: () => setState(() => obscured = !obscured),
                          icon: Icon(
                            obscured
                                ? Icons.visibility_outlined
                                : Icons.visibility_off_outlined,
                          ),
                        ),
                      ),
                      validator: (v) => v == null || v.isEmpty
                          ? 'Inserisci la password'
                          : null,
                    ),
                    if (error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 16),
                        child: Text(
                          error!,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                      ),
                    const SizedBox(height: 24),
                    FilledButton(
                      onPressed: busy ? null : submit,
                      child: busy
                          ? const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('Accedi'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class Workspace extends StatefulWidget {
  const Workspace({super.key, required this.user});
  final User user;
  @override
  State<Workspace> createState() => _WorkspaceState();
}

class _WorkspaceState extends State<Workspace> {
  late final Companion api;
  final composer = TextEditingController();
  final composerFocus = FocusNode();
  final scaffoldKey = GlobalKey<ScaffoldState>();
  final modelMenuKey = GlobalKey<PopupMenuButtonState<String>>();
  bool libraryVisible = true;
  bool changingPermission = false;
  final scroll = ScrollController();
  late final StreamSubscription<QuerySnapshot<Map<String, dynamic>>>
  deviceSubscription;
  late final StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>
  indexSubscription;
  StreamSubscription<QuerySnapshot<Map<String, dynamic>>>? messageSubscription,
      approvalSubscription,
      liveSubscription;
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>?
  requestSubscription;
  final List<Map<String, dynamic>> devices = [];
  List<Map<String, dynamic>> chats = [], messages = [], approvals = [];
  Map<String, Map<String, dynamic>> liveTurns = {};
  Map<String, dynamic> tree = {};
  String? deviceId,
      conversationId,
      projectId,
      chosenModel,
      requestConversation,
      activeRequestId,
      requestStatus,
      error,
      pendingText;
  bool loading = true, sending = false, loadingMessages = false;
  int loadVersion = 0;
  Timer? clock;
  bool get busy =>
      sending || requestStatus == 'pending' || requestStatus == 'running';
  Map<String, dynamic>? get activeLive =>
      liveTurnRunning(liveTurns[conversationId]) ? liveTurns[conversationId] : null;
  bool get liveRunning => activeLive != null;
  bool get turnBusy => busy || liveRunning;
  /// Current step of the live turn, used instead of a generic loader.
  String? get livePhase {
    final turn = activeLive;
    if (turn == null) return null;
    final activity = (turn['activity'] as List? ?? [])
        .whereType<Map>()
        .toList();
    if (activity.isNotEmpty) {
      final last = activity.last;
      final title = _stepLabel(last);
      final command = _stepCommand(last);
      final path = (last['path'] ?? '').toString();
      final status = _stepStatus(last['status']);
      if (title.isNotEmpty) {
        return [
          title,
          if (command.isNotEmpty) command,
          if (path.isNotEmpty) path,
          if (status.isNotEmpty) status,
        ].join(' · ');
      }
    }
    final content = (turn['content'] as String? ?? '').trim();
    final reasoning = (turn['reasoning'] as String? ?? '').trim();
    if (content.isEmpty && reasoning.isNotEmpty) return 'Sto ragionando…';
    if (content.isNotEmpty) return 'Sto scrivendo…';
    return null;
  }
  Set<String> get workingChats => {
    for (final entry in liveTurns.entries)
      if (liveTurnRunning(entry.value)) entry.key,
  };
  Map<String, dynamic>? get device =>
      devices.where((d) => d['id'] == deviceId).firstOrNull;
  bool get online => device != null && deviceOnline(device!);
  @override
  void initState() {
    super.initState();
    composerFocus.addListener(() {
      if (composerFocus.hasFocus && libraryVisible) {
        setState(() => libraryVisible = false);
      }
    });
    api = Companion(widget.user.uid);
    push.bind(widget.user.uid);
    push.target.addListener(openNotification);
    deviceSubscription = api.devices.snapshots().listen((snapshot) async {
      final prefs = await SharedPreferences.getInstance();
      if (!mounted) {
        return;
      }
      final previous = deviceId;
      setState(() {
        devices
          ..clear()
          ..addAll(
            snapshot.docs.map(
              (d) => <String, dynamic>{...d.data(), 'id': d.id},
            ),
          );
        devices.sort(
          (a, b) => ((b['last_seen'] as num?) ?? 0).compareTo(
            (a['last_seen'] as num?) ?? 0,
          ),
        );
        deviceId ??=
            prefs.getString('device_${widget.user.uid}') ??
            devices.firstOrNull?['id'];
        loading = false;
      });
      if (previous != deviceId) {
        watchApprovals();
        watchLiveTurns();
        restoreRequest();
      }
    }, onError: fail);
    indexSubscription = api.index.listen((snapshot) {
      if (!mounted) {
        return;
      }
      setState(() {
        tree = Map<String, dynamic>.from(snapshot.data()?['tree'] ?? {});
        chats = chatIndex(tree);
      });
      openNotification();
    }, onError: fail);
    clock = Timer.periodic(const Duration(seconds: 10), (_) {
      if (mounted) {
        setState(() {});
      }
    });
  }

  @override
  void dispose() {
    clock?.cancel();
    deviceSubscription.cancel();
    indexSubscription.cancel();
    messageSubscription?.cancel();
    approvalSubscription?.cancel();
    liveSubscription?.cancel();
    requestSubscription?.cancel();
    push.target.removeListener(openNotification);
    composerFocus.dispose();
    composer.dispose();
    scroll.dispose();
    super.dispose();
  }

  void fail(Object e) {
    if (mounted) {
      setState(() {
        error = friendlyError(e);
        loading = false;
        loadingMessages = false;
      });
    }
  }

  void openNotification() {
    final target = push.target.value;
    if (target == null || target.isEmpty || !mounted) {
      return;
    }
    final chat = chats.where((c) => c['id'] == target).firstOrNull;
    if (chat != null) {
      push.target.value = null;
      selectChat(chat);
    }
  }

  void watchApprovals() {
    approvalSubscription?.cancel();
    if (deviceId == null) {
      return;
    }
    approvalSubscription = api.devices
        .doc(deviceId)
        .collection('approvals')
        .snapshots()
        .listen((snapshot) {
          if (mounted) {
            setState(
              () => approvals = snapshot.docs
                  .map((d) => d.data())
                  .where(
                    (a) =>
                        (a['status'] == 'waiting' ||
                            a['status'] == 'pending') &&
                        DateTime.now().millisecondsSinceEpoch -
                                ((a['created_at'] as num?)?.toInt() ?? 0) <
                            600000,
                  )
                  .toList(),
            );
          }
        }, onError: fail);
  }

  void watchLiveTurns() {
    liveSubscription?.cancel();
    if (deviceId == null) {
      liveTurns = {};
      return;
    }
    liveSubscription = api.liveTurns(deviceId!).listen((
      snapshot,
    ) {
      if (!mounted) return;
      setState(() {
        liveTurns = {for (final doc in snapshot.docs) doc.id: doc.data()};
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted ||
            !liveRunning ||
            !scroll.hasClients ||
            scroll.positions.length != 1 ||
            scroll.position.extentAfter >= 120) {
          return;
        }
        scroll.jumpTo(scroll.position.maxScrollExtent);
      });
    }, onError: fail);
  }

  Future<void> restoreRequest() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString('request_${widget.user.uid}');
    if (!mounted || saved == null) {
      return;
    }
    final parts = saved.split('/');
    if (parts.length == 2 && parts.first == deviceId) {
      watchRequest(parts.last);
    }
  }

  void watchRequest(String id) {
    requestSubscription?.cancel();
    activeRequestId = id;
    requestSubscription = api.requests(deviceId!).doc(id).snapshots().listen((
      snapshot,
    ) {
      if (!mounted || snapshot.data() == null) {
        return;
      }
      final data = snapshot.data()!;
      setState(() {
        final previous = requestStatus;
        requestStatus = data['status'];
        requestConversation = data['conversation_id'];
        pendingText = busy ? data['content'] : null;
        if (requestStatus == 'failed' && previous != 'failed') {
          error = remoteError(data['error'] as String?);
        }
      });
    }, onError: fail);
  }

  Future<void> selectDevice(String id) async {
    if (busy) {
      return;
    }
    setState(() => deviceId = id);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('device_${widget.user.uid}', id);
    watchApprovals();
    watchLiveTurns();
  }

  void selectChat(Map<String, dynamic>? chat) {
    final version = ++loadVersion;
    messageSubscription?.cancel();
    setState(() {
      libraryVisible = false;
      conversationId = chat?['id'];
      projectId = chat?['project_id'];
      messages = [];
      loadingMessages = chat != null;
      error = null;
    });
    if (chat == null) {
      return;
    }
    messageSubscription = api.messages(conversationId!).listen((
      snapshot,
    ) async {
      try {
        final decoded = await api.decodeMessages(snapshot.docs);
        if (!mounted || version != loadVersion) {
          return;
        }
        final follow =
            loadingMessages ||
            !scroll.hasClients ||
            scroll.positions.length == 1 && scroll.position.extentAfter < 100;
        setState(() {
          messages = decoded;
          loadingMessages = false;
        });
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (follow && scroll.hasClients && scroll.positions.length == 1) {
            scroll.animateTo(
              scroll.position.maxScrollExtent,
              duration: MediaQuery.disableAnimationsOf(context)
                  ? Duration.zero
                  : const Duration(milliseconds: 200),
              curve: Curves.easeOut,
            );
          }
        });
      } catch (e) {
        if (version == loadVersion) {
          fail(e);
        }
      }
    }, onError: fail);
  }

  Future<void> send() async {
    final text = composer.text.trim();
    if (turnBusy || text.isEmpty || !online) {
      return;
    }
    final isNew = conversationId == null;
    final id = conversationId ?? const Uuid().v4();
    setState(() {
      sending = true;
      error = null;
      pendingText = text;
      requestConversation = id;
    });
    try {
      final request = await api.send(
        deviceId!,
        id,
        text,
        newConversation: isNew,
        project: projectId,
        extra: {if (isNew && chosenModel != null) 'model': chosenModel},
      );
      if (!mounted) {
        return;
      }
      composer.clear();
      if (isNew) {
        selectChat({'id': id, 'project_id': projectId});
      }
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('request_${widget.user.uid}', '$deviceId/$request');
      if (!mounted) {
        return;
      }
      setState(() => requestStatus = 'pending');
      watchRequest(request);
    } catch (e) {
      fail(e);
    } finally {
      if (mounted) {
        setState(() => sending = false);
      }
    }
  }

  Future<void> action(
    String action, {
    Map<String, dynamic> extra = const {},
  }) async {
    final id = action == 'stop'
        ? conversationId ?? requestConversation
        : action == 'permission'
        ? conversationId ?? const Uuid().v4()
        : conversationId;
    if (deviceId == null || id == null) {
      return;
    }
    try {
      if (action == 'stop' &&
          requestStatus == 'pending' &&
          activeRequestId != null) {
        final ref = api.requests(deviceId!).doc(activeRequestId);
        final cancelled = await api.db.runTransaction<bool>((
          transaction,
        ) async {
          final snapshot = await transaction.get(ref);
          if (snapshot.data()?['status'] != 'pending') {
            return false;
          }
          transaction.update(ref, {
            'status': 'cancelled',
            'finished_at': DateTime.now().millisecondsSinceEpoch,
          });
          return true;
        });
        if (cancelled) {
          return;
        }
      }
      final request = await api.send(
        deviceId!,
        id,
        '',
        action: action,
        extra: extra,
      );
      final result = await api
          .requests(deviceId!)
          .doc(request)
          .snapshots()
          .firstWhere(
            (s) => ['completed', 'failed'].contains(s.data()?['status']),
          )
          .timeout(const Duration(seconds: 30));
      if (result.data()?['status'] == 'failed' && mounted) {
        setState(() => error = remoteError(result.data()?['error']));
      }
    } catch (e) {
      fail(e);
    }
  }

  Future<void> chooseDevice() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: ListView(
        shrinkWrap: true,
        children: [
          const Padding(
            padding: EdgeInsets.all(24),
            child: Text(
              'Collegati a un PC',
              style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600),
            ),
          ),
          if (devices.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('Apri AuraChat sul PC e accedi con questo account.'),
            ),
          ...devices.map(
            (d) => ListTile(
              leading: const Icon(Icons.computer_outlined),
              title: Text(d['name'] ?? 'PC Windows'),
              subtitle: Text(
                deviceOnline(d) ? 'Disponibile' : 'Non raggiungibile',
              ),
              trailing: d['id'] == deviceId
                  ? const Icon(Icons.check, color: orchid)
                  : null,
              onTap: busy
                  ? null
                  : () {
                      selectDevice(d['id']);
                      Navigator.pop(context);
                    },
            ),
          ),
        ],
      ),
    ),
  );
  void openLibrary() {
    composerFocus.unfocus();
    selectChat(null);
    setState(() => libraryVisible = true);
  }

  void newChat([String? project]) {
    selectChat(null);
    setState(() => projectId = project);
    composerFocus.requestFocus();
  }

  Map<String, dynamic> get projects =>
      Map<String, dynamic>.from(tree['projects'] ?? {});

  String? get permissionMode =>
      (device?['project_permissions'] as Map?)?[projectId] as String?;
  String get permissionLabel => switch (permissionMode) {
    'ask' => 'Richiedi approvazione',
    'auto' => 'Approva per me',
    'full' => 'Accesso completo',
    _ => 'Permessi progetto',
  };
  String get modelName {
    final chat = chats.where((c) => c['id'] == conversationId).firstOrNull;
    final id = chat?['model'] ?? chosenModel ?? device?['active_model'];
    return ((device?['models'] as List?) ?? [])
                .where((m) => m['id'] == id)
                .firstOrNull?['name']
            as String? ??
        'Scegli modello';
  }

  Future<void> chooseModel() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) => SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(sheetContext).height * .7,
        ),
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(24, 8, 24, 16),
              child: Text(
                'Modello',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
              ),
            ),
            ...((device?['models'] as List?) ?? []).map(
              (m) => ListTile(
                title: Text(m['name'] as String),
                trailing: m['name'] == modelName
                    ? const Icon(Icons.check_rounded, color: orchid)
                    : null,
                onTap: () {
                  setState(() => chosenModel = m['id']);
                  Navigator.pop(sheetContext);
                  if (conversationId != null) {
                    action('model', extra: {'model': m['id']});
                  }
                },
              ),
            ),
          ],
        ),
      ),
    ),
  );

  Future<void> choosePermissions() async {
    final project = projectId;
    final mode = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(24, 8, 24, 16),
              child: Text(
                'Permessi',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
              ),
            ),
            if (project == null) ...[
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 24, vertical: 8),
                child: Text(
                  'I permessi di file e comandi si gestiscono nelle chat di progetto.',
                  style: TextStyle(color: muted),
                ),
              ),
              if (conversationId == null)
                ListTile(
                  leading: const Icon(Icons.folder_outlined),
                  title: const Text('Scegli progetto'),
                  onTap: () {
                    Navigator.pop(sheetContext, 'project');
                  },
                ),
            ] else ...[
              if (permissionMode == null)
                const Padding(
                  padding: EdgeInsets.all(24),
                  child: Text(
                    'Collega un desktop aggiornato per modificare i permessi.',
                    style: TextStyle(color: muted),
                  ),
                ),
              ...const [
                (
                  'ask',
                  'Richiedi approvazione',
                  'Chiede conferma prima di scrivere file o eseguire comandi.',
                ),
                (
                  'auto',
                  'Approva per me',
                  'Revisiona automaticamente i comandi e chiede conferma per azioni rischiose o incerte.',
                ),
                (
                  'full',
                  'Accesso completo',
                  'File e comandi senza conferme, anche fuori dal progetto.',
                ),
              ].map(
                (m) => ListTile(
                  title: Text(m.$2),
                  subtitle: Text(m.$3),
                  enabled:
                      online &&
                      !busy &&
                      !changingPermission &&
                      permissionMode != null,
                  trailing: permissionMode == m.$1
                      ? const Icon(Icons.check_rounded, color: orchid)
                      : null,
                  onTap: () => Navigator.pop(sheetContext, m.$1),
                ),
              ),
            ],
            const SizedBox(height: 16),
          ],
        ),
      ),
    );
    if (!mounted || mode == null) return;
    if (mode == 'project') {
      await chooseProject();
      return;
    }
    if (mode == permissionMode) return;
    var confirmed = false;
    if (mode == 'full') {
      confirmed =
          await showDialog<bool>(
            context: context,
            builder: (context) => AlertDialog(
              title: const Text('Consentire accesso completo?'),
              content: Text(
                'Per ${projects[project]?['name'] ?? 'questo progetto'}, AuraChat potrà modificare file ed eseguire comandi senza conferme, anche fuori dal progetto, con accesso alla rete e i permessi del tuo account Windows.',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('Annulla'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(context, true),
                  child: const Text('Consenti accesso completo'),
                ),
              ],
            ),
          ) ??
          false;
      if (!confirmed || !mounted) return;
    }
    setState(() => changingPermission = true);
    await action(
      'permission',
      extra: {
        'project_id': project,
        'mode': mode,
        'confirm_full_access': confirmed,
      },
    );
    if (mounted) setState(() => changingPermission = false);
  }

  Widget library({bool inDrawer = false, String query = ''}) => ChatLibrary(
    projects: projects,
    chats: chats,
    selectedId: conversationId,
    query: query,
    working: workingChats,
    onSelect: (chat) {
      if (inDrawer) Navigator.pop(context);
      composerFocus.unfocus();
      selectChat(chat);
    },
    onNew: (project) {
      if (inDrawer) Navigator.pop(context);
      newChat(project);
    },
  );

  Future<void> searchChats() {
    var query = '';
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetContext) {
        return StatefulBuilder(
          builder: (sheetContext, update) => Padding(
            padding: EdgeInsets.only(
              bottom: MediaQuery.viewInsetsOf(sheetContext).bottom,
            ),
            child: SizedBox(
              height:
                  (MediaQuery.sizeOf(sheetContext).height -
                      MediaQuery.viewInsetsOf(sheetContext).bottom) *
                  .82,
              child: SafeArea(
                top: false,
                child: Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
                      child: TextField(
                        autofocus: true,
                        decoration: const InputDecoration(
                          hintText: 'Cerca nelle chat',
                          prefixIcon: Icon(Icons.search_rounded),
                        ),
                        onChanged: (value) => update(() => query = value),
                      ),
                    ),
                    Expanded(
                      child: ChatLibrary(
                        projects: projects,
                        chats: chats,
                        query: query,
                        working: workingChats,
                        onSelect: (chat) {
                          Navigator.pop(sheetContext);
                          selectChat(chat);
                        },
                        onNew: (project) {
                          Navigator.pop(sheetContext);
                          newChat(project);
                        },
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Future<void> chooseProject() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (sheetContext) => SafeArea(
      child: ListView(
        shrinkWrap: true,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(24, 8, 24, 16),
            child: Text(
              'Progetto',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
            ),
          ),
          ListTile(
            leading: const Icon(Icons.chat_bubble_outline_rounded),
            title: const Text('Chat libera'),
            trailing: projectId == null
                ? const Icon(Icons.check_rounded, color: orchid)
                : null,
            onTap: () {
              setState(() => projectId = null);
              Navigator.pop(sheetContext);
            },
          ),
          ...projects.entries.map(
            (p) => ListTile(
              leading: const Icon(Icons.folder_outlined),
              title: Text(p.value['name'] ?? 'Progetto'),
              trailing: projectId == p.key
                  ? const Icon(Icons.check_rounded, color: orchid)
                  : null,
              onTap: () {
                setState(() => projectId = p.key);
                Navigator.pop(sheetContext);
              },
            ),
          ),
        ],
      ),
    ),
  );

  Future<void> composerOptions() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (sheetContext) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            leading: const Icon(Icons.laptop_mac_outlined),
            title: const Text('Scegli PC'),
            subtitle: Text(device?['name'] ?? 'Nessun PC selezionato'),
            enabled: !busy,
            onTap: () {
              Navigator.pop(sheetContext);
              chooseDevice();
            },
          ),
          if (conversationId == null)
            ListTile(
              leading: const Icon(Icons.folder_outlined),
              title: const Text('Scegli progetto'),
              subtitle: Text(projects[projectId]?['name'] ?? 'Chat libera'),
              enabled: !busy,
              onTap: () {
                Navigator.pop(sheetContext);
                chooseProject();
              },
            ),
          ListTile(
            leading: const Icon(Icons.tune_rounded),
            title: const Text('Scegli modello'),
            enabled: online && !busy,
            onTap: () {
              Navigator.pop(sheetContext);
              modelMenuKey.currentState?.showButtonMenu();
            },
          ),
          const SizedBox(height: 12),
        ],
      ),
    ),
  );

  Widget notice(String message, String action, VoidCallback onTap) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 4),
    child: Row(
      children: [
        const Icon(Icons.info_outline_rounded, size: 18, color: muted),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            message,
            style: const TextStyle(color: muted, fontSize: 13),
          ),
        ),
        TextButton(onPressed: onTap, child: Text(action)),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final activeChat = chats
        .where((c) => c['id'] == conversationId)
        .firstOrNull;
    final activeRequest = busy && requestConversation == conversationId;
    final activeLiveTurn = activeLive;
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final keyboard = MediaQuery.viewInsetsOf(context).bottom > 0;
    return PopScope(
      canPop: libraryVisible,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) openLibrary();
      },
      child: Scaffold(
        key: scaffoldKey,
        appBar: AppBar(
          toolbarHeight: 72,
          leadingWidth: 76,
          leading: Padding(
            padding: const EdgeInsets.only(left: 16, top: 12, bottom: 12),
            child: RoundButton(
              icon: libraryVisible
                  ? Icons.menu_rounded
                  : Icons.arrow_back_rounded,
              label: libraryVisible ? 'Apri menu' : 'Torna alle chat',
              onPressed: libraryVisible
                  ? () => scaffoldKey.currentState?.openDrawer()
                  : openLibrary,
            ),
          ),
          title: PopupMenuButton<String>(
            key: modelMenuKey,
            tooltip: 'Scegli modello',
            enabled: online && !busy,
            position: PopupMenuPosition.under,
            onSelected: (value) {
              setState(() => chosenModel = value);
              if (conversationId != null) {
                action('model', extra: {'model': value});
              }
            },
            itemBuilder: (context) => ((device?['models'] as List?) ?? [])
                .map(
                  (m) => CheckedPopupMenuItem<String>(
                    value: m['id'] as String,
                    checked:
                        m['id'] ==
                        (activeChat?['model'] ??
                            chosenModel ??
                            device?['active_model']),
                    child: Text(m['name'] as String),
                  ),
                )
                .toList(),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Flexible(
                    child: Text(
                      libraryVisible
                          ? 'AuraChat'
                          : activeChat?['title'] ?? 'Nuova chat',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: libraryVisible ? 20 : 17,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  const Icon(
                    Icons.keyboard_arrow_down_rounded,
                    size: 18,
                    color: muted,
                  ),
                ],
              ),
            ),
          ),
          actions: [
            Padding(
              padding: const EdgeInsets.only(right: 16),
              child: RoundButton(
                icon: libraryVisible
                    ? Icons.search_rounded
                    : Icons.edit_outlined,
                label: libraryVisible ? 'Cerca chat' : 'Nuova chat',
                onPressed: libraryVisible
                    ? searchChats
                    : busy
                    ? null
                    : () => newChat(),
              ),
            ),
          ],
        ),
        drawer: Drawer(
          width: MediaQuery.sizeOf(context).width * .87,
          backgroundColor: sidebar,
          surfaceTintColor: Colors.transparent,
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.horizontal(right: Radius.circular(28)),
          ),
          child: SafeArea(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 20, 16, 12),
                  child: Row(
                    children: [
                      SvgPicture.asset(
                        'assets/logo.svg',
                        width: 26,
                        height: 26,
                      ),
                      const SizedBox(width: 10),
                      const Expanded(
                        child: Text(
                          'AuraChat',
                          style: TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      RoundButton(
                        icon: Icons.search_rounded,
                        label: 'Cerca chat',
                        onPressed: () {
                          Navigator.pop(context);
                          searchChats();
                        },
                      ),
                    ],
                  ),
                ),
                Expanded(child: library(inDrawer: true)),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          FilledButton.icon(
                            onPressed: busy
                                ? null
                                : () {
                                    Navigator.pop(context);
                                    newChat();
                                  },
                            icon: const Icon(Icons.edit_outlined, size: 20),
                            label: const Text('Nuova chat'),
                          ),
                          const Spacer(),
                          RoundButton(
                            icon: Icons.logout_rounded,
                            label: 'Esci dall’account',
                            onPressed: () async {
                              try {
                                await push.signOut();
                              } catch (e) {
                                fail(e);
                              }
                            },
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      Text(
                        widget.user.email ?? '',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: muted, fontSize: 12),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        body: SafeArea(
          top: false,
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 760),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (libraryVisible)
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
                        child: DeviceLabel(
                          name: device?['name'] ?? 'Scegli un PC',
                          online: online,
                          onTap: busy ? null : chooseDevice,
                        ),
                      ),
                    ),
                  ValueListenableBuilder<String?>(
                    valueListenable: push.warning,
                    builder: (context, warning, _) => warning == null
                        ? const SizedBox.shrink()
                        : notice(
                            warning,
                            'Riprova',
                            () => push.bind(widget.user.uid),
                          ),
                  ),
                  if (!online && !loading)
                    notice(
                      device?['remote_enabled'] == false
                          ? 'Collegamento remoto da abilitare sul PC.'
                          : 'Apri AuraChat sul PC per inviare messaggi.',
                      'Scegli PC',
                      chooseDevice,
                    ),
                  if (error != null)
                    notice(
                      error!,
                      'Chiudi',
                      () => setState(() => error = null),
                    ),
                  Expanded(
                    child: AnimatedSwitcher(
                      duration: reduceMotion
                          ? Duration.zero
                          : const Duration(milliseconds: 180),
                      switchInCurve: Curves.easeOutCubic,
                      child: loading || loadingMessages
                          ? const Center(
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : libraryVisible
                          ? library()
                          : messages.isEmpty &&
                                !activeRequest &&
                                activeLiveTurn == null
                          ? const SizedBox.expand()
                          : ListView(
                              key: const ValueKey('conversation-messages'),
                              controller: scroll,
                              keyboardDismissBehavior:
                                  ScrollViewKeyboardDismissBehavior.onDrag,
                              padding: const EdgeInsets.fromLTRB(
                                20,
                                20,
                                20,
                                16,
                              ),
                              children: [
                                ...messages.map(
                                  (message) => MessageView(message: message),
                                ),
                                if (activeRequest &&
                                    pendingText != null &&
                                    !messages.any(
                                      (m) =>
                                          m['role'] == 'user' &&
                                          m['content'] == pendingText &&
                                          m == messages.last,
                                    ))
                                  MessageView(
                                    message: {
                                      'role': 'user',
                                      'content': pendingText,
                                    },
                                  ),
                                if (activeLiveTurn != null &&
                                    (activeLiveTurn['user_content'] as String? ??
                                            '')
                                        .trim()
                                        .isNotEmpty &&
                                    !(activeRequest &&
                                        pendingText ==
                                            activeLiveTurn['user_content']) &&
                                    !messages.any(
                                      (m) =>
                                          m['role'] == 'user' &&
                                          m['content'] ==
                                              activeLiveTurn['user_content'],
                                    ))
                                  MessageView(
                                    message: {
                                      'role': 'user',
                                      'content': activeLiveTurn['user_content'],
                                    },
                                  ),
                                if (activeLiveTurn != null &&
                                    ((activeLiveTurn['content'] as String? ??
                                                    '')
                                                .trim()
                                                .isNotEmpty ||
                                        (activeLiveTurn['reasoning']
                                                    as String? ??
                                                '')
                                            .trim()
                                            .isNotEmpty ||
                                        ((activeLiveTurn['activity'] as List?) ??
                                                [])
                                            .isNotEmpty))
                                  MessageView(
                                    live: true,
                                    message: {
                                      'role': 'assistant',
                                      'content':
                                          activeLiveTurn['content'] ?? '',
                                      'reasoning':
                                          activeLiveTurn['reasoning'] ?? '',
                                      'activity':
                                          activeLiveTurn['activity'] ??
                                          const [],
                                    },
                                  ),
                                if (activeRequest || activeLiveTurn != null)
                                  Padding(
                                    padding: const EdgeInsets.symmetric(
                                      vertical: 16,
                                    ),
                                    child: Row(
                                      children: [
                                        const SizedBox(
                                          width: 12,
                                          height: 12,
                                          child: CircularProgressIndicator(
                                            strokeWidth: 1.5,
                                          ),
                                        ),
                                        const SizedBox(width: 12),
                                        Expanded(
                                          child: Text(
                                            activeRequest &&
                                                    requestStatus == 'pending'
                                                ? 'In attesa del PC…'
                                                : livePhase ??
                                                      'AuraChat sta lavorando…',
                                            style: const TextStyle(
                                              color: muted,
                                              fontSize: 14,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                              ],
                            ),
                    ),
                  ),
                  if (approvals.any(
                    (a) => a['conversation_id'] == conversationId,
                  ))
                    ConstrainedBox(
                      constraints: BoxConstraints(
                        maxHeight: MediaQuery.sizeOf(context).height * .35,
                      ),
                      child: SingleChildScrollView(
                        child: Column(
                          children: approvals
                              .where(
                                (a) => a['conversation_id'] == conversationId,
                              )
                              .map(
                                (approval) => Padding(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 20,
                                    vertical: 8,
                                  ),
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.stretch,
                                    children: [
                                      const Text(
                                        'È richiesta la tua approvazione',
                                        style: TextStyle(
                                          fontWeight: FontWeight.w600,
                                        ),
                                      ),
                                      ExpansionTile(
                                        tilePadding: EdgeInsets.zero,
                                        title: const Text(
                                          'Dettagli operazione',
                                        ),
                                        children: [
                                          SelectableText(
                                            const JsonEncoder.withIndent(
                                              '  ',
                                            ).convert(approval['action']),
                                            style: const TextStyle(
                                              fontSize: 12,
                                            ),
                                          ),
                                        ],
                                      ),
                                      Wrap(
                                        alignment: WrapAlignment.end,
                                        spacing: 8,
                                        children: [
                                          TextButton(
                                            onPressed: () => action(
                                              'approve',
                                              extra: {
                                                'approval_id': approval['id'],
                                                'allow': false,
                                              },
                                            ),
                                            child: const Text('Rifiuta'),
                                          ),
                                          FilledButton(
                                            onPressed: () => action(
                                              'approve',
                                              extra: {
                                                'approval_id': approval['id'],
                                                'allow': true,
                                              },
                                            ),
                                            child: const Text(
                                              'Consenti una volta',
                                            ),
                                          ),
                                        ],
                                      ),
                                    ],
                                  ),
                                ),
                              )
                              .toList(),
                        ),
                      ),
                    ),
                  if (!libraryVisible)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          DeviceLabel(
                            name: device?['name'] ?? 'Scegli un PC',
                            online: online,
                            onTap: busy ? null : chooseDevice,
                          ),
                          if (conversationId == null || projectId != null)
                            TextButton.icon(
                              style: TextButton.styleFrom(
                                foregroundColor: muted,
                                minimumSize: const Size(48, 48),
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 12,
                                ),
                              ),
                              onPressed: busy || conversationId != null
                                  ? null
                                  : chooseProject,
                              icon: const Icon(Icons.folder_outlined, size: 20),
                              label: Text(
                                projects[projectId]?['name'] ?? 'Chat libera',
                              ),
                            ),
                        ],
                      ),
                    ),
                  Padding(
                    key: const ValueKey('composer-area'),
                    padding: EdgeInsets.fromLTRB(16, 8, 16, keyboard ? 8 : 12),
                    child: AuraComposer(
                      controller: composer,
                      focusNode: composerFocus,
                      online: online,
                      busy: turnBusy,
                      onSend: send,
                      onStop: () => action('stop'),
                      onOptions: composerOptions,
                      modelName: modelName,
                      permissionLabel: permissionLabel,
                      onModel: chooseModel,
                      onPermissions: changingPermission
                          ? null
                          : choosePermissions,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

String remoteError(String? error) => switch (error) {
  'permissions_in_use' =>
    'Attendi che le chat del progetto abbiano terminato prima di cambiare i permessi.',
  'full_access_confirmation_required' =>
    'Conferma esplicitamente l’accesso completo prima di abilitarlo.',
  'desktop_restarted' =>
    'Il PC si è riavviato durante la richiesta. Controlla la chat prima di inviarla di nuovo.',
  'request_expired' =>
    'Il messaggio è scaduto mentre il PC era offline. Invialo di nuovo.',
  'chat_in_progress' =>
    'Questa chat è già in uso sul desktop. Attendi che termini.',
  'conversation_conflict' =>
    'La chat è cambiata su un altro dispositivo. Riaprila prima di riprovare.',
  'conversation_not_found' => 'Questa conversazione non è più disponibile.',
  'no_api_key' || 'model_not_found' =>
    'Configura un modello sul desktop prima di inviare messaggi.',
  _ => 'Il desktop non ha completato la richiesta. Controlla AuraChat sul PC.',
};

const _actionLabels = {
  'read_project_file': 'Leggi file',
  'list_project_files': 'Elenca file',
  'write_project_file': 'Scrivi file',
  'edit_project_file': 'Modifica file',
  'execute_project_command': 'Esegui comando',
  'inspect_project_command': 'Controlla comando',
};

String _stepLabel(Map event) {
  final title = (event['title'] ?? '').toString().trim();
  if (title.isNotEmpty) return title;
  final action = (event['action'] ?? '').toString();
  if (_actionLabels.containsKey(action)) return _actionLabels[action]!;
  if (action.isNotEmpty) return action;
  return switch (event['kind']) {
    'agent' => 'Agente',
    'approval' => 'Approvazione',
    'tool' => 'Strumento',
    _ => 'Attività',
  };
}

String _stepStatus(Object? status) => switch (status) {
  'running' => 'in corso',
  'reviewing' => 'in revisione',
  'waiting' || 'pending' => 'in attesa',
  'completed' || 'approved' => 'completato',
  'failed' || 'denied' => 'errore',
  'cancelled' || 'stopped' => 'interrotto',
  _ => '',
};

String _stepCommand(Map event) {
  final command = (event['command'] ?? '').toString().trim();
  if (command.isNotEmpty) return command;
  final arguments = event['arguments'];
  if (arguments is Map) {
    final program = arguments['program'];
    if (program is String) {
      final args = arguments['arguments'];
      final tail = args is List
          ? args.whereType<String>().join(' ')
          : '';
      return '$program $tail'.trim();
    }
  }
  return '';
}

String _stepDetail(Map event) => [
  _stepCommand(event),
  event['path'],
  event['summary'],
  _stepStatus(event['status']),
].whereType<Object>().map((value) => value.toString()).where((value) => value.isNotEmpty).join(' · ');

class MessageView extends StatelessWidget {
  const MessageView({super.key, required this.message, this.live = false});
  final Map<String, dynamic> message;
  final bool live;
  @override
  Widget build(BuildContext context) {
    final user = message['role'] == 'user';
    final activity = (message['activity'] as List? ?? [])
        .whereType<Map>()
        .toList();
    final reasoning = [
      (message['reasoning'] as String? ?? '').trim(),
      ...activity
          .where((event) => event['kind'] == 'reasoning')
          .map((event) => (event['text'] ?? '').toString().trim()),
    ].where((text) => text.isNotEmpty).join('\n\n');
    final steps = activity
        .where((event) => event['kind'] != 'reasoning')
        .toList();
    return Padding(
      padding: const EdgeInsets.only(bottom: 28),
      child: Column(
        crossAxisAlignment: user
            ? CrossAxisAlignment.end
            : CrossAxisAlignment.start,
        children: [
          if (reasoning.isNotEmpty)
            live
                ? Padding(
                    padding: const EdgeInsets.only(bottom: 14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Ragionamento',
                          style: TextStyle(
                            color: muted,
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          reasoning,
                          style: const TextStyle(
                            color: muted,
                            fontSize: 13,
                            height: 1.5,
                          ),
                        ),
                      ],
                    ),
                  )
                : ExpansionTile(
                    tilePadding: EdgeInsets.zero,
                    dense: true,
                    shape: const Border(),
                    collapsedShape: const Border(),
                    title: const Text(
                      'Ragionamento',
                      style: TextStyle(color: muted, fontSize: 13),
                    ),
                    children: [
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: Text(
                          reasoning,
                          style: const TextStyle(
                            color: muted,
                            fontSize: 13,
                            height: 1.5,
                          ),
                        ),
                      ),
                    ],
                  ),
          if (steps.isNotEmpty)
            live
                ? Padding(
                    padding: const EdgeInsets.only(bottom: 14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Attività',
                          style: TextStyle(
                            color: muted,
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 6),
                        ...steps.map(
                          (event) => Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Icon(
                                  event['kind'] == 'agent'
                                      ? Icons.smart_toy_outlined
                                      : Icons.terminal_rounded,
                                  size: 16,
                                  color: muted,
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        _stepLabel(event),
                                        style: const TextStyle(
                                          fontSize: 13,
                                          height: 1.4,
                                        ),
                                      ),
                                      if (_stepDetail(event).isNotEmpty)
                                        Text(
                                          _stepDetail(event),
                                          style: const TextStyle(
                                            color: muted,
                                            fontSize: 12,
                                            height: 1.4,
                                          ),
                                        ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  )
                : ExpansionTile(
                    tilePadding: EdgeInsets.zero,
                    dense: true,
                    shape: const Border(),
                    collapsedShape: const Border(),
                    title: Text(
                      '${steps.length} attività',
                      style: const TextStyle(color: muted, fontSize: 13),
                    ),
                    children: steps
                        .map(
                          (event) => ListTile(
                            dense: true,
                            title: Text(_stepLabel(event)),
                            subtitle: Text(
                              _stepDetail(event),
                              maxLines: 4,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        )
                        .toList(),
                  ),
          LayoutBuilder(
            builder: (context, constraints) => Align(
              alignment: user ? Alignment.centerRight : Alignment.centerLeft,
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxWidth: constraints.maxWidth * (user ? .88 : 1),
                ),
                child: Container(
                  padding: user
                      ? const EdgeInsets.symmetric(horizontal: 18, vertical: 13)
                      : EdgeInsets.zero,
                  decoration: user
                      ? BoxDecoration(
                          color: bubble,
                          borderRadius: BorderRadius.circular(24),
                        )
                      : null,
                  child: MarkdownBody(
                    data: message['content'] as String? ?? '',
                    selectable: true,
                    styleSheet: MarkdownStyleSheet(
                      p: const TextStyle(
                        fontSize: 16,
                        height: 1.6,
                        color: textColor,
                      ),
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
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
