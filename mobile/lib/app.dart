import 'dart:async';
import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';
import 'companion.dart';

final push = PushNotifications();
const ink = Color(0xff0d081f),
    panel = Color(0xff15102a),
    violet = Color(0xff8b3fe0),
    orchid = Color(0xffbb93fb),
    textColor = Color(0xfff5f0ff),
    muted = Color(0xffb79fde);
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
      await Firebase.initializeApp(options: firebaseOptions);
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
    theme: ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: ink,
      colorScheme: const ColorScheme.dark(
        primary: orchid,
        secondary: violet,
        surface: panel,
        onSurface: textColor,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: ink,
        foregroundColor: textColor,
        centerTitle: false,
      ),
      dividerColor: orchid.withValues(alpha: .16),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: panel,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide.none,
        ),
        contentPadding: const EdgeInsets.all(18),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: violet,
          foregroundColor: Colors.white,
          minimumSize: const Size(48, 52),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
        ),
      ),
    ),
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
  final scroll = ScrollController();
  late final StreamSubscription<QuerySnapshot<Map<String, dynamic>>>
  deviceSubscription;
  late final StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>
  indexSubscription;
  StreamSubscription<QuerySnapshot<Map<String, dynamic>>>? messageSubscription,
      approvalSubscription;
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>?
  requestSubscription;
  final List<Map<String, dynamic>> devices = [];
  List<Map<String, dynamic>> chats = [], messages = [], approvals = [];
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
  Map<String, dynamic>? get device =>
      devices.where((d) => d['id'] == deviceId).firstOrNull;
  bool get online => device != null && deviceOnline(device!);
  @override
  void initState() {
    super.initState();
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
    requestSubscription?.cancel();
    push.target.removeListener(openNotification);
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
  }

  void selectChat(Map<String, dynamic>? chat) {
    final version = ++loadVersion;
    messageSubscription?.cancel();
    setState(() {
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
        setState(() {
          messages = decoded;
          loadingMessages = false;
        });
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (scroll.hasClients) {
            scroll.animateTo(
              scroll.position.maxScrollExtent,
              duration: const Duration(milliseconds: 200),
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
    if (busy || text.isEmpty || !online) {
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
    final id = action == 'stop' ? requestConversation : conversationId;
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
  @override
  Widget build(BuildContext context) {
    final activeChat = chats
        .where((c) => c['id'] == conversationId)
        .firstOrNull;
    final activeRequest = busy && requestConversation == conversationId;
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: InkWell(
          onTap: chooseDevice,
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  device?['name'] ?? 'Scegli un PC',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  device?['remote_enabled'] == false
                      ? 'Collegamento da abilitare'
                      : online
                      ? 'Collegato al desktop'
                      : 'Desktop non raggiungibile',
                  style: const TextStyle(color: muted, fontSize: 12),
                ),
              ],
            ),
          ),
        ),
        actions: [
          PopupMenuButton<String>(
            tooltip: 'Scegli modello',
            enabled: online && !busy,
            icon: const Icon(Icons.tune_rounded),
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
          ),
          IconButton(
            tooltip: 'Nuova chat',
            onPressed: busy ? null : () => selectChat(null),
            icon: const Icon(Icons.edit_square),
          ),
        ],
      ),
      drawer: Drawer(
        backgroundColor: panel,
        child: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.all(24),
                child: Row(
                  children: [
                    SvgPicture.asset('assets/logo.svg', width: 28),
                    const SizedBox(width: 12),
                    const Text(
                      'AuraChat',
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              ListTile(
                leading: const Icon(Icons.add),
                title: const Text('Nuova chat'),
                onTap: () {
                  Navigator.pop(context);
                  selectChat(null);
                },
              ),
              Expanded(
                child: chats.isEmpty
                    ? const Padding(
                        padding: EdgeInsets.all(24),
                        child: Text(
                          'Le tue conversazioni appariranno qui.',
                          style: TextStyle(color: muted),
                        ),
                      )
                    : ListView.builder(
                        itemCount: chats.length,
                        itemBuilder: (context, i) {
                          final chat = chats[i];
                          return ListTile(
                            selected: chat['id'] == conversationId,
                            selectedColor: orchid,
                            title: Text(
                              chat['title'] ?? 'Chat',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            subtitle: chat['project_name'] == null
                                ? null
                                : Text(chat['project_name']),
                            onTap: () {
                              Navigator.pop(context);
                              selectChat(chat);
                            },
                          );
                        },
                      ),
              ),
              const Divider(),
              ListTile(
                title: Text(
                  widget.user.email ?? '',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: IconButton(
                  tooltip: 'Esci dall’account',
                  icon: const Icon(Icons.logout),
                  onPressed: () async {
                    try {
                      await push.signOut();
                    } catch (e) {
                      fail(e);
                    }
                  },
                ),
              ),
            ],
          ),
        ),
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            ValueListenableBuilder<String?>(
              valueListenable: push.warning,
              builder: (context, warning, _) => warning == null
                  ? const SizedBox.shrink()
                  : MaterialBanner(
                      content: Text(warning),
                      actions: [
                        TextButton(
                          onPressed: () => push.bind(widget.user.uid),
                          child: const Text('Riprova'),
                        ),
                      ],
                    ),
            ),
            if (!online && !loading)
              MaterialBanner(
                content: Text(
                  device?['remote_enabled'] == false
                      ? 'Aggiorna le regole Firebase per abilitare il collegamento remoto.'
                      : 'Apri AuraChat sul PC per inviare messaggi.',
                ),
                actions: [
                  TextButton(
                    onPressed: chooseDevice,
                    child: const Text('Scegli PC'),
                  ),
                ],
              ),
            if (error != null)
              MaterialBanner(
                content: Text(error!),
                actions: [
                  TextButton(
                    onPressed: () => setState(() => error = null),
                    child: const Text('Chiudi'),
                  ),
                ],
              ),
            Expanded(
              child: loading || loadingMessages
                  ? const Center(child: CircularProgressIndicator())
                  : messages.isEmpty && !activeRequest
                  ? Center(
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.all(32),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            SvgPicture.asset(
                              'assets/logo.svg',
                              width: 52,
                              height: 52,
                            ),
                            const SizedBox(height: 24),
                            const Text(
                              'Da dove cominciamo?',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                fontSize: 26,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 12),
                            const Text(
                              'Scrivi qui. Il tuo PC si occupa del resto.',
                              textAlign: TextAlign.center,
                              style: TextStyle(color: muted, height: 1.5),
                            ),
                            if (conversationId == null &&
                                (tree['projects'] as Map?)?.isNotEmpty == true)
                              Padding(
                                padding: const EdgeInsets.only(top: 24),
                                child: DropdownButton<String?>(
                                  value: projectId,
                                  hint: const Text('Chat libera o progetto'),
                                  isExpanded: true,
                                  items: [
                                    const DropdownMenuItem<String?>(
                                      value: null,
                                      child: Text('Chat libera'),
                                    ),
                                    ...(tree['projects'] as Map).entries.map(
                                      (p) => DropdownMenuItem<String?>(
                                        value: p.key as String,
                                        child: Text(p.value['name'] as String),
                                      ),
                                    ),
                                  ],
                                  onChanged: (value) =>
                                      setState(() => projectId = value),
                                ),
                              ),
                          ],
                        ),
                      ),
                    )
                  : ListView(
                      controller: scroll,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 20,
                        vertical: 24,
                      ),
                      children: [
                        if (activeChat != null)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 24),
                            child: Text(
                              activeChat['title'] ?? 'Chat',
                              style: const TextStyle(
                                color: muted,
                                fontSize: 13,
                              ),
                            ),
                          ),
                        ...messages.map(
                          (message) => MessageView(message: message),
                        ),
                        if (activeRequest && pendingText != null)
                          MessageView(
                            message: {'role': 'user', 'content': pendingText},
                          ),
                        if (activeRequest)
                          Padding(
                            padding: const EdgeInsets.symmetric(vertical: 16),
                            child: Row(
                              children: [
                                const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Text(
                                    requestStatus == 'pending'
                                        ? 'In attesa del desktop…'
                                        : 'Il desktop sta lavorando…',
                                    style: const TextStyle(color: muted),
                                  ),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
            ),
            ...approvals
                .where((a) => a['conversation_id'] == conversationId)
                .map(
                  (approval) => Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Text(
                          'Il desktop richiede la tua approvazione',
                          style: TextStyle(fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(height: 8),
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxHeight: 140),
                          child: SingleChildScrollView(
                            child: SelectableText(
                              const JsonEncoder.withIndent(
                                '  ',
                              ).convert(approval['action']),
                              style: const TextStyle(fontSize: 12),
                            ),
                          ),
                        ),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.end,
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
                              child: const Text('Consenti una volta'),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      controller: composer,
                      minLines: 1,
                      maxLines: 6,
                      maxLength: 25000,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: const InputDecoration(
                        hintText: 'Scrivi un messaggio',
                        counterText: '',
                      ),
                      onChanged: (_) => setState(() {}),
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 52,
                    height: 52,
                    child: FilledButton(
                      style: FilledButton.styleFrom(padding: EdgeInsets.zero),
                      onPressed: busy
                          ? () => action('stop')
                          : online && composer.text.trim().isNotEmpty
                          ? send
                          : null,
                      child: Icon(
                        busy ? Icons.stop_rounded : Icons.arrow_upward_rounded,
                        semanticLabel: busy
                            ? 'Interrompi risposta'
                            : 'Invia messaggio',
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String remoteError(String? error) => switch (error) {
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

class MessageView extends StatelessWidget {
  const MessageView({super.key, required this.message});
  final Map<String, dynamic> message;
  @override
  Widget build(BuildContext context) {
    final user = message['role'] == 'user';
    final activity = (message['activity'] as List? ?? [])
        .whereType<Map>()
        .toList();
    return Padding(
      padding: const EdgeInsets.only(bottom: 28),
      child: Column(
        crossAxisAlignment: user
            ? CrossAxisAlignment.end
            : CrossAxisAlignment.start,
        children: [
          if (activity.isNotEmpty)
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: Text(
                '${activity.length} attività del desktop',
                style: const TextStyle(color: muted, fontSize: 13),
              ),
              children: activity
                  .map(
                    (event) => ListTile(
                      dense: true,
                      title: Text(
                        (event['title'] ??
                                event['action'] ??
                                event['kind'] ??
                                'Attività')
                            .toString(),
                      ),
                      subtitle: Text(
                        (event['status'] ?? event['text'] ?? '').toString(),
                        maxLines: 4,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  )
                  .toList(),
            ),
          Container(
            padding: user
                ? const EdgeInsets.symmetric(horizontal: 18, vertical: 14)
                : EdgeInsets.zero,
            decoration: user
                ? BoxDecoration(
                    color: panel,
                    borderRadius: BorderRadius.circular(16),
                  )
                : null,
            child: MarkdownBody(
              data: message['content'] as String? ?? '',
              selectable: true,
              styleSheet: MarkdownStyleSheet(
                p: const TextStyle(
                  fontSize: 15,
                  height: 1.55,
                  color: textColor,
                ),
                code: const TextStyle(color: orchid, fontSize: 13),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
