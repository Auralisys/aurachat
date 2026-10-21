import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:record/record.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';
import 'companion.dart';
import 'ui.dart';
import 'turn_history.dart';
import 'skill_picker.dart';
import 'aura_icons.dart';
import 'message_queue.dart';
import 'queued_bubble.dart';

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

class _WorkspaceState extends State<Workspace> with WidgetsBindingObserver {
  late final Companion api;
  // Session-only: queued drafts are not persisted across app restarts.
  final outbox = <(String, String), ConversationQueue>{};
  final queueSubscriptions = <StreamSubscription<dynamic>>[];
  ConversationQueue? get currentQueue => outbox[(deviceId, conversationId)];
  final composer = TextEditingController();
  final composerFocus = FocusNode();
  final scaffoldKey = GlobalKey<ScaffoldState>();
  final recorder = AudioRecorder();
  bool micActive = false, micTranscribing = false;
  String? micPath;
  Timer? micTimer;
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
  bool notificationIndexReady = false, notificationDevicesReady = false;
  Timer? notificationWait;
  NotificationTarget? waitingNotification;
  int loadVersion = 0;
  Timer? clock;
  bool get busy =>
      sending || requestStatus == 'pending' || requestStatus == 'running';
  Map<String, dynamic>? get activeLive =>
      liveTurnRunning(liveTurns[conversationId])
      ? liveTurns[conversationId]
      : null;
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
    WidgetsBinding.instance.addObserver(this);
    push.foreground =
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
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
        if (!busy) {
          deviceId = onlineDeviceReplacement(devices, deviceId) ?? deviceId;
        }
        push.visibleDevice = deviceId;
        loading = false;
        notificationDevicesReady = true;
      });
      if (previous != deviceId) {
        if (deviceId != null) {
          await prefs.setString('device_${widget.user.uid}', deviceId!);
        }
        watchApprovals();
        watchLiveTurns();
        restoreRequest();
      }
      openNotification();
    }, onError: fail);
    indexSubscription = api.index.listen((snapshot) {
      if (!mounted) {
        return;
      }
      setState(() {
        tree = Map<String, dynamic>.from(snapshot.data()?['tree'] ?? {});
        chats = chatIndex(tree);
        notificationIndexReady = true;
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
    WidgetsBinding.instance.removeObserver(this);
    push.visibleConversation = null;
    push.visibleDevice = null;
    notificationWait?.cancel();
    clock?.cancel();
    for (final subscription in queueSubscriptions) {
      subscription.cancel();
    }
    deviceSubscription.cancel();
    indexSubscription.cancel();
    messageSubscription?.cancel();
    approvalSubscription?.cancel();
    liveSubscription?.cancel();
    requestSubscription?.cancel();
    push.target.removeListener(openNotification);
    micTimer?.cancel();
    if (micActive) recorder.cancel();
    unawaited(recorder.dispose());
    final recording = micPath;
    if (recording != null) {
      final file = File(recording);
      unawaited(
        file.exists().then((exists) async {
          if (exists) await file.delete();
        }),
      );
    }
    composerFocus.dispose();
    composer.dispose();
    scroll.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    push.foreground = state == AppLifecycleState.resumed;
    if (push.foreground) push.bind(widget.user.uid);
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
    if (target == null || !mounted) {
      notificationWait?.cancel();
      notificationWait = null;
      waitingNotification = null;
      return;
    }
    if (waitingNotification != target) {
      notificationWait?.cancel();
      notificationWait = null;
      waitingNotification = target;
    }
    if (target.uid != widget.user.uid) {
      push.target.value = null;
      push.warning.value =
          'Questa notifica appartiene a un altro account. Accedi con l’account che l’ha ricevuta.';
      return;
    }
    final chat = chats.where((c) => c['id'] == target.conversation).firstOrNull;
    if (!notificationIndexReady || !notificationDevicesReady || chat == null) {
      // A completion may reach FCM before the desktop publishes the updated index.
      notificationWait ??= Timer(const Duration(seconds: 20), () {
        if (!mounted || push.target.value != target) return;
        push.target.value = null;
        push.warning.value =
            'La chat della notifica non è disponibile. Controlla la connessione o riaprila dall’elenco chat.';
      });
      return;
    }
    if (target.device.isNotEmpty &&
        !devices.any((device) => device['id'] == target.device)) {
      push.target.value = null;
      push.warning.value =
          'Il PC della notifica non è più disponibile per questo account.';
      return;
    }
    push.target.value = null;
    Navigator.of(context).popUntil((route) => route.isFirst);
    scaffoldKey.currentState?.closeDrawer();
    composerFocus.unfocus();
    if (target.device.isNotEmpty && target.device != deviceId) {
      unawaited(
        selectDevice(target.device, fromNotification: true).catchError(fail),
      );
    }
    selectChat(chat);
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
    final watchedDevice = deviceId!;
    liveTurns = {};
    for (final lane in outbox.values.where((q) => q.device == watchedDevice)) {
      lane.liveKnown = false;
    }
    liveSubscription = api.liveTurns(watchedDevice).listen((snapshot) {
      if (!mounted || deviceId != watchedDevice) return;
      setState(() {
        liveTurns = {for (final doc in snapshot.docs) doc.id: doc.data()};
        for (final lane in outbox.values.where(
          (q) => q.device == watchedDevice,
        )) {
          lane.observeLive(liveTurns[lane.conversation]);
        }
      });
      flushQueues();
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
    final watchedDevice = deviceId!;
    requestSubscription = api
        .requests(watchedDevice)
        .doc(id)
        .snapshots()
        .listen((snapshot) {
          if (!mounted ||
              deviceId != watchedDevice ||
              activeRequestId != id ||
              snapshot.data() == null) {
            return;
          }
          final data = snapshot.data()!;
          setState(() {
            final previous = requestStatus;
            requestStatus = data['status'];
            requestConversation = data['conversation_id'];
            pendingText = busy ? data['content'] : null;
            for (final lane in outbox.values.where(
              (q) => q.device == watchedDevice,
            )) {
              lane.observeRequest(id, data['status'] as String?);
            }
            if (requestStatus == 'failed' && previous != 'failed') {
              error = remoteError(data['error'] as String?);
            }
          });
          flushQueues();
        }, onError: fail);
  }

  Future<void> selectDevice(String id, {bool fromNotification = false}) async {
    if (busy && !fromNotification) {
      return;
    }
    setState(() {
      deviceId = id;
      push.visibleDevice = id;
      requestStatus = null;
      activeRequestId = null;
      pendingText = null;
    });
    requestSubscription?.cancel();
    watchApprovals();
    watchLiveTurns();
    restoreRequest();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('device_${widget.user.uid}', id);
  }

  void selectChat(Map<String, dynamic>? chat) {
    push.target.value = null;
    if (micActive) {
      micTimer?.cancel();
      micActive = false;
      micPath = null;
      unawaited(recorder.cancel().catchError(fail));
    }
    push.visibleConversation = chat?['id'] as String?;
    push.visibleDevice = deviceId;
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
    // Same as desktop: sending while dictating stops, transcribes, then sends.
    if (micActive) {
      await finishDictation(true);
      return;
    }
    final text = composer.text.trim();
    if (text.isEmpty || !online) {
      return;
    }
    if (turnBusy || (currentQueue?.drafts.isNotEmpty ?? false)) {
      final target = conversationId;
      if (target == null) return;
      setState(() {
        final lane = outbox.putIfAbsent((
          deviceId!,
          target,
        ), () => ConversationQueue(deviceId!, target, projectId));
        if (lane.drafts.isEmpty && lane.operation == null) {
          lane.completed = false;
          lane.paused = null;
          lane.waitingRequest = busy ? activeRequestId : null;
          lane.waitingTurn = null;
          lane.observeLive(liveTurns[target]);
          // A failed request cannot authorize a later automatic retry.
          if (requestStatus == 'failed') {
            lane.paused = 'Controlla la chat prima di inviare la coda.';
          }
        }
        lane.drafts.add(QueuedDraft(const Uuid().v4(), text));
        composer.clear();
      });
      flushQueues();
      return;
    }
    final isNew = conversationId == null;
    final id = conversationId ?? const Uuid().v4();
    final targetDevice = deviceId!;
    final targetProject = projectId;
    setState(() {
      sending = true;
      error = null;
      pendingText = text;
      requestConversation = id;
    });
    try {
      final request = await api.send(
        targetDevice,
        id,
        text,
        newConversation: isNew,
        project: targetProject,
        extra: {if (isNew && chosenModel != null) 'model': chosenModel},
      );
      if (!mounted) {
        return;
      }
      if (composer.text.trim() == text) composer.clear();
      for (final lane in outbox.values.where(
        (q) =>
            q.device == targetDevice &&
            q.waitingRequest == null &&
            !q.completed,
      )) {
        lane.waitingRequest = request;
      }
      if (isNew && conversationId == null && deviceId == targetDevice) {
        selectChat({'id': id, 'project_id': targetProject});
      }
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        'request_${widget.user.uid}',
        '$targetDevice/$request',
      );
      if (!mounted) {
        return;
      }
      if (deviceId == targetDevice) {
        setState(() => requestStatus = 'pending');
        watchRequest(request);
      }
    } catch (e) {
      fail(e);
    } finally {
      if (mounted) {
        setState(() => sending = false);
        flushQueues();
      }
    }
  }

  void flushQueues() {
    if (!mounted || busy || !online) return;
    for (final lane in outbox.values) {
      if (lane.device != deviceId || !lane.canFlush) continue;
      if (liveTurnRunning(liveTurns[lane.conversation])) continue;
      dispatchQueued(lane, lane.drafts.first);
      return;
    }
  }

  Future<void> dispatchQueued(
    ConversationQueue lane,
    QueuedDraft draft, {
    bool guide = false,
  }) async {
    if (!mounted || lane.device != deviceId || !online) return;
    if (guide &&
        (!liveTurnRunning(liveTurns[lane.conversation]) ||
            busy && requestConversation != lane.conversation)) {
      return;
    }
    if (!guide && busy) return;
    if (!lane.begin(draft, asGuide: guide)) return;
    setState(() {
      if (!guide) sending = true;
    });
    try {
      final request = await api.send(
        lane.device,
        lane.conversation,
        draft.text,
        project: lane.project,
        action: guide ? 'steer' : 'chat',
      );
      if (!mounted) return;
      if (!guide) {
        lane.waitingRequest = request;
        requestConversation = lane.conversation;
        pendingText = draft.text;
        requestStatus = 'pending';
        activeRequestId = request;
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString(
          'request_${widget.user.uid}',
          '${lane.device}/$request',
        );
      }
      // Keep watching late terminal receipts even if the user changes chat/device.
      late final StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>
      receipt;
      receipt = api
          .requests(lane.device)
          .doc(request)
          .snapshots()
          .listen(
            (snapshot) {
              if (!mounted) return;
              final status = snapshot.data()?['status'] as String?;
              if (!['completed', 'failed', 'cancelled'].contains(status)) {
                return;
              }
              setState(() {
                if (guide) {
                  lane.finishGuide(draft, accepted: status == 'completed');
                } else {
                  lane.observeRequest(request, status);
                  if (activeRequestId == request) {
                    requestStatus = status;
                    pendingText = null;
                  }
                }
                if (status != 'completed') {
                  error = remoteError(snapshot.data()?['error'] as String?);
                }
              });
              receipt.cancel();
              queueSubscriptions.remove(receipt);
              flushQueues();
            },
            onError: (Object e) {
              // Unknown outcome: retain the draft, unlock the queue and require
              // an explicit resume; never replay automatically.
              if (mounted) {
                setState(() {
                  lane.operation = null;
                  lane.steering = false;
                  lane.paused =
                      'Esito da verificare sul PC. Il messaggio non verrà reinviato.';
                });
              }
            },
          );
      queueSubscriptions.add(receipt);
    } catch (e) {
      if (mounted) {
        setState(() {
          lane.operation = null;
          lane.steering = false;
          lane.paused =
              'Esito da verificare sul PC. Il messaggio non verrà reinviato.';
          error = friendlyError(e);
        });
      }
    } finally {
      if (mounted && !guide) setState(() => sending = false);
    }
  }

  /// Removes the draft from the queue and returns it to the composer for
  /// editing, like reopening your own queued message.
  void editQueued(ConversationQueue lane, QueuedDraft draft) {
    if (lane.operation != null || !lane.remove(draft)) return;
    final base = composer.text.trimRight();
    final merged = base.isEmpty ? draft.text : '$base\n${draft.text}';
    setState(() {
      composer.value = TextEditingValue(
        text: merged,
        selection: TextSelection.collapsed(offset: merged.length),
      );
    });
    composerFocus.requestFocus();
  }

  /// Sends this draft now: as guidance while its turn is running, otherwise
  /// immediately (ahead of the rest of the queue).
  Future<void> sendQueuedNow(ConversationQueue lane, QueuedDraft draft) async {
    if (!mounted ||
        lane.operation != null ||
        !online ||
        lane.device != deviceId) {
      return;
    }
    if (liveTurnRunning(liveTurns[lane.conversation])) {
      await dispatchQueued(lane, draft, guide: true);
      return;
    }
    if (busy) {
      setState(
        () => error =
            'Attendi che il turno corrente termini, poi riprova a inviare subito.',
      );
      return;
    }
    if (!lane.drafts.remove(draft)) return;
    lane.drafts.insert(0, draft);
    lane.paused = null;
    lane.completed = true;
    await dispatchQueued(lane, draft);
  }

  Future<void> resumeQueue(ConversationQueue lane) async {
    if (lane.operation != null || lane.running || busy || !online) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Inviare la coda?'),
        content: const Text(
          'Controlla sul PC che questi messaggi non siano già stati elaborati. Verranno inviati in ordine.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Annulla'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Invia'),
          ),
        ],
      ),
    );
    if (!mounted ||
        confirmed != true ||
        lane.operation != null ||
        lane.running) {
      return;
    }
    setState(() {
      lane.paused = null;
      lane.completed = true;
    });
    flushQueues();
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
              title: Text(d['name'] ?? 'Computer'),
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
  String? get selectedModelId {
    final chat = chats.where((c) => c['id'] == conversationId).firstOrNull;
    return chat?['model'] as String? ??
        chosenModel ??
        device?['active_model'] as String?;
  }

  String get modelName {
    final id = selectedModelId;
    return ((device?['models'] as List?) ?? [])
                .where((m) => m['id'] == id)
                .firstOrNull?['name']
            as String? ??
        'Scegli modello';
  }

  List<ComposerChoice> get modelChoices => ((device?['models'] as List?) ?? [])
      .whereType<Map>()
      .map(
        (m) => ComposerChoice(
          value: m['id'] as String,
          label: (m['name'] ?? m['id']).toString(),
        ),
      )
      .toList();

  String? get projectName => projects[projectId]?['name']?.toString();

  List<ComposerChoice> get permissionChoices => [
    if (projectId == null)
      const ComposerChoice(
        value: 'project',
        label: 'Scegli progetto',
        description:
            'I permessi di file e comandi si gestiscono nelle chat di progetto.',
      ),
    if (projectId != null && permissionMode == null)
      const ComposerChoice(
        value: 'unsupported',
        label: 'Collega un desktop aggiornato',
        description:
            'Serve AuraChat aggiornato sul PC per modificare i permessi.',
        enabled: false,
      ),
    ComposerChoice(
      value: 'ask',
      label: 'Richiedi approvazione',
      description: 'Chiede conferma prima di scrivere file o eseguire comandi.',
      enabled: permissionMode != null && !changingPermission,
    ),
    ComposerChoice(
      value: 'auto',
      label: 'Approva per me',
      description:
          'Revisiona automaticamente i comandi e chiede conferma per azioni rischiose o incerte.',
      enabled: permissionMode != null && !changingPermission,
    ),
    ComposerChoice(
      value: 'full',
      label: 'Accesso completo',
      description: 'File e comandi senza conferme, anche fuori dal progetto.',
      enabled: permissionMode != null && !changingPermission,
    ),
  ];

  void selectModel(String id) {
    setState(() => chosenModel = id);
    if (conversationId != null) {
      action('model', extra: {'model': id});
    }
  }

  Future<void> applyPermission(String mode) async {
    final project = projectId;
    if (mode == 'project') {
      await chooseProject();
      return;
    }
    if (permissionMode == null || mode == permissionMode) return;
    var confirmed = false;
    if (mode == 'full') {
      confirmed =
          await showDialog<bool>(
            context: context,
            builder: (context) => AlertDialog(
              title: const Text('Consentire accesso completo?'),
              content: Text(
                'Per ${projects[project]?['name'] ?? 'questo progetto'}, AuraChat potrà modificare file ed eseguire comandi senza conferme, anche fuori dal progetto, con accesso alla rete e i permessi del tuo account di sistema.',
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

  static const speechLanguages = {
    'ar',
    'de',
    'el',
    'en',
    'es',
    'fr',
    'it',
    'ja',
    'ko',
    'nl',
    'pl',
    'pt',
    'vi',
    'zh',
  };

  String get dictationLanguage {
    final code = WidgetsBinding.instance.platformDispatcher.locale.languageCode
        .toLowerCase();
    return speechLanguages.contains(code) ? code : 'en';
  }

  String dictationError(Object failure) {
    final code = failure is DictationException
        ? failure.code
        : failure.toString();
    if (code.contains('speech_model_missing')) {
      return 'Scarica prima il modello vocale da AuraChat sul PC (Impostazioni › Voce).';
    }
    if (code.contains('speech_busy') || code.contains('speech_loading')) {
      return 'Il modello vocale sul PC è occupato. Riprova tra poco.';
    }
    if (code.contains('speech_silence')) {
      return 'Non ho sentito nulla. Riprova parlando più vicino al microfono.';
    }
    if (code.contains('speech_invalid_audio') ||
        code.contains('invalid_audio') ||
        code.contains('audio_missing')) {
      return 'L’audio registrato non è valido. Riprova.';
    }
    if (code.contains('audio_too_large')) {
      return 'La dettatura è troppo lunga. Registra un messaggio più breve.';
    }
    if (code.contains('speech_language')) {
      return 'La lingua del telefono non è supportata dal modello vocale del PC.';
    }
    if (code.contains('TimeoutException')) {
      return 'La trascrizione sta impiegando troppo tempo. Riprova tra poco.';
    }
    return 'Trascrizione non riuscita. Controlla che il PC sia collegato.';
  }

  Future<void> toggleMic() async {
    if (micTranscribing) return;
    if (micActive) {
      await finishDictation(false);
      return;
    }
    if (!online) return;
    final speech = device?['speech'];
    if (speech is! Map) {
      setState(
        () => error = 'Aggiorna AuraChat sul PC per dettare dal telefono.',
      );
      return;
    }
    if (speech['ready'] != true) {
      setState(
        () => error =
            'Scarica prima il modello vocale da AuraChat sul PC (Impostazioni › Voce).',
      );
      return;
    }
    if (speech['busy'] == true || speech['loading'] == true) {
      setState(
        () => error = 'Il modello vocale sul PC è occupato. Riprova tra poco.',
      );
      return;
    }
    try {
      if (!await recorder.hasPermission()) {
        if (mounted) {
          setState(
            () => error =
                'Consenti l’accesso al microfono nelle impostazioni di sistema.',
          );
        }
        return;
      }
      final path =
          '${Directory.systemTemp.path}/aurachat-dictation-${DateTime.now().millisecondsSinceEpoch}.wav';
      await recorder.start(
        const RecordConfig(
          encoder: AudioEncoder.wav,
          sampleRate: 16000,
          numChannels: 1,
          echoCancel: true,
          noiseSuppress: true,
        ),
        path: path,
      );
      micPath = path;
      micTimer?.cancel();
      // The desktop model accepts up to two minutes; keep the upload small.
      micTimer = Timer(const Duration(seconds: 60), () {
        if (micActive) unawaited(finishDictation(false));
      });
      if (mounted) setState(() => micActive = true);
    } catch (_) {
      if (mounted) {
        setState(() => error = 'Impossibile avviare la registrazione.');
      }
    }
  }

  Future<void> finishDictation(bool sendAfter) async {
    if (!micActive || micTranscribing) return;
    final version = loadVersion;
    final target = deviceId;
    final targetConversation = conversationId ?? const Uuid().v4();
    micTimer?.cancel();
    setState(() {
      micActive = false;
      micTranscribing = true;
    });
    final path = micPath;
    micPath = null;
    try {
      final stopped = await recorder.stop();
      final file = File(stopped ?? path ?? '');
      if (!await file.exists()) throw DictationException('audio_missing');
      final audio = await file.readAsBytes();
      try {
        await file.delete();
      } catch (_) {}
      if (audio.length <= 44) throw DictationException('speech_silence');
      if (target == null) throw DictationException('device_missing');
      final text = await api.transcribe(
        target,
        targetConversation,
        audio,
        dictationLanguage,
      );
      if (!mounted || version != loadVersion) return;
      setState(() => micTranscribing = false);
      final base = composer.text.trimRight();
      final merged = base.isEmpty ? text : '$base $text';
      composer.value = TextEditingValue(
        text: merged,
        selection: TextSelection.collapsed(offset: merged.length),
      );
      composerFocus.requestFocus();
      if (sendAfter) await send();
    } catch (failure) {
      if (mounted && version == loadVersion) {
        setState(() => error = dictationError(failure));
      }
    } finally {
      if (mounted && micTranscribing) {
        setState(() => micTranscribing = false);
      }
    }
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
          toolbarHeight: 64,
          leadingWidth: 72,
          leading: Padding(
            padding: const EdgeInsets.only(left: 12, top: 8, bottom: 8),
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
          // The bar has a fixed height, so two lines clamp very large text.
          title: MediaQuery.withClampedTextScaling(
            maxScaleFactor: 1.4,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Text(
                  libraryVisible
                      ? 'AuraChat'
                      : activeChat?['title'] ?? 'Nuova chat',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: libraryVisible ? 20 : 17,
                    height: 1.25,
                    fontWeight: FontWeight.w600,
                    color: textColor,
                  ),
                ),
                const SizedBox(height: 2),
                ChatContextLabel(
                  project: libraryVisible ? null : projectName,
                  pc: device?['name']?.toString(),
                  online: online,
                  onTap: busy ? null : chooseDevice,
                ),
              ],
            ),
          ),
          actions: [
            Padding(
              padding: const EdgeInsets.only(right: 16),
              child: RoundButton(
                glyph: libraryVisible ? null : const AuraGlyph('new_chat'),
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
                            icon: const AuraGlyph('new_chat', size: 20),
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
                                activeLiveTurn == null &&
                                (currentQueue?.drafts.isEmpty ?? true)
                          ? const Center(
                              child: Padding(
                                padding: EdgeInsets.all(32),
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Text(
                                      'Da dove iniziamo?',
                                      textAlign: TextAlign.center,
                                      style: TextStyle(
                                        fontSize: 24,
                                        fontWeight: FontWeight.w600,
                                        letterSpacing: -.5,
                                      ),
                                    ),
                                    SizedBox(height: 10),
                                    Text(
                                      'Scrivi un messaggio per iniziare.',
                                      textAlign: TextAlign.center,
                                      style: TextStyle(
                                        color: muted,
                                        fontSize: 14,
                                        height: 1.5,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            )
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
                                    (activeLiveTurn['user_content']
                                                as String? ??
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
                                if (activeLiveTurn != null)
                                  ...((activeLiveTurn['segments'] as List?) ??
                                          const [])
                                      .whereType<Map>()
                                      .map(
                                        (segment) => MessageView(
                                          message: Map<String, dynamic>.from(
                                            segment,
                                          ),
                                          live: true,
                                        ),
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
                                        ((activeLiveTurn['activity']
                                                    as List?) ??
                                                [])
                                            .isNotEmpty))
                                  MessageView(
                                    live: true,
                                    onStopAgent: (id) => action(
                                      'stop_agent',
                                      extra: {'agent_id': id},
                                    ),
                                    onStopShell: (id) => action(
                                      'stop_shell',
                                      extra: {'shell_id': id},
                                    ),
                                    message: {
                                      'role': 'assistant',
                                      'content':
                                          activeLiveTurn['content'] ?? '',
                                      'reasoning':
                                          activeLiveTurn['reasoning'] ?? '',
                                      'activity':
                                          activeLiveTurn['activity'] ??
                                          const [],
                                      'truncated':
                                          activeLiveTurn['truncated'] == true,
                                    },
                                  ),
                                if (currentQueue case final lane?)
                                  for (final draft in lane.drafts)
                                    QueuedMessageBubble(
                                      key: ValueKey(draft.id),
                                      text: draft.text,
                                      locked: lane.operation != null,
                                      status: lane.operation == draft
                                          ? (lane.paused ??
                                                (lane.steering
                                                    ? 'Invio guida…'
                                                    : 'Invio…'))
                                          : 'In coda',
                                      warning: lane.paused,
                                      onEdit: () => editQueued(lane, draft),
                                      onDelete: () =>
                                          setState(() => lane.remove(draft)),
                                      onSendNow:
                                          online && lane.device == deviceId
                                          ? () => sendQueuedNow(lane, draft)
                                          : null,
                                      onResume:
                                          lane.paused != null &&
                                              !lane.running &&
                                              !busy &&
                                              online
                                          ? () => resumeQueue(lane)
                                          : null,
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
                  Padding(
                    key: const ValueKey('composer-area'),
                    padding: EdgeInsets.fromLTRB(12, 8, 12, keyboard ? 8 : 12),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SkillPicker(
                          controller: composer,
                          focus: composerFocus,
                          enabled: !turnBusy && online,
                          hasProject: projectId != null,
                          skills:
                              (((device?['project_skills'] as Map?)?[projectId]
                                              as Map?)?['skills']
                                          as List? ??
                                      [])
                                  .whereType<Map>()
                                  .map((s) => Map<String, dynamic>.from(s))
                                  .toList(),
                        ),
                        AuraComposer(
                          controller: composer,
                          focusNode: composerFocus,
                          online: online,
                          busy: turnBusy,
                          allowQueue: conversationId != null,
                          onSend: send,
                          onStop: () => action('stop'),
                          onOptions: composerOptions,
                          modelName: modelName,
                          permissionLabel: permissionLabel,
                          models: modelChoices,
                          selectedModel: selectedModelId,
                          onModelSelected: selectModel,
                          permissions: permissionChoices,
                          selectedPermission: permissionMode,
                          onPermissionSelected: applyPermission,
                          micActive: micActive,
                          micBusy: micTranscribing,
                          onMic: online && !micTranscribing ? toggleMic : null,
                        ),
                      ],
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
      final tail = args is List ? args.whereType<String>().join(' ') : '';
      return '$program $tail'.trim();
    }
  }
  return '';
}

class MessageView extends StatelessWidget {
  const MessageView({
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
    final user = message['role'] == 'user';
    if (!user) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 28),
        child: TurnHistory(
          message: message,
          live: live,
          onStopAgent: onStopAgent,
          onStopShell: onStopShell,
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
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
