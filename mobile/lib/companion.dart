import 'dart:async';
import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

/// Opzioni dell'app Android. Non usarle su iOS: un appId `:android:` è
/// invalido per Firebase iOS e fa terminare l'app all'avvio.
const androidFirebaseOptions = FirebaseOptions(
  apiKey: 'AIzaSyB-fMMzxv-83F3s-1uY0wtUk4SCv3QmT44',
  appId: '1:840348621130:android:7b61fb11b72a72b25e09b3',
  messagingSenderId: '840348621130',
  projectId: 'auralisys-chat',
);

@pragma('vm:entry-point')
Future<void> backgroundMessage(RemoteMessage message) async {
  if (Firebase.apps.isNotEmpty) {
    return;
  }
  // Vedi startAuraChat: le opzioni esplicite valgono solo per Android.
  if (defaultTargetPlatform == TargetPlatform.android) {
    await Firebase.initializeApp(options: androidFirebaseOptions);
  } else {
    await Firebase.initializeApp();
  }
}

String friendlyError(Object error) {
  if (error.toString().contains('GoogleService-Info.plist')) {
    return 'Configurazione iOS mancante: aggiungi GoogleService-Info.plist al target Runner.';
  }
  if (error is FirebaseException) {
    return switch (error.code) {
      'invalid-credential' ||
      'wrong-password' ||
      'user-not-found' => 'Email o password non corretta.',
      'invalid-email' => 'Controlla l’indirizzo email.',
      'too-many-requests' => 'Troppi tentativi. Attendi prima di riprovare.',
      'network-request-failed' ||
      'unavailable' => 'Connessione assente. Controlla la rete e riprova.',
      'permission-denied' =>
        'Accesso ai dati negato. Controlla le regole Firebase.',
      _ => 'Operazione non riuscita (${error.code}). Riprova.',
    };
  }
  return 'Operazione non riuscita. Riprova.';
}

bool deviceOnline(Map<String, dynamic> device, [int? now]) =>
    device['remote_enabled'] == true &&
    (now ?? DateTime.now().millisecondsSinceEpoch) -
            ((device['last_seen'] as num?)?.toInt() ?? 0) <
        45000;

String? onlineDeviceReplacement(
  List<Map<String, dynamic>> devices,
  String? selected, [
  int? now,
]) {
  final current = devices
      .where((device) => device['id'] == selected)
      .firstOrNull;
  if (current == null || deviceOnline(current, now)) return null;
  final name = (current['name'] as String? ?? '').trim().toLowerCase();
  if (name.isEmpty) return null;
  final matches = devices
      .where(
        (device) =>
            device['id'] != selected &&
            device['identity_version'] == 2 &&
            (device['name'] as String? ?? '').trim().toLowerCase() == name &&
            deviceOnline(device, now),
      )
      .toList();
  return matches.length == 1 ? matches.single['id'] as String : null;
}

/// A live turn is shown only while it is running and the desktop keeps it fresh.
bool liveTurnRunning(Map<String, dynamic>? turn, [int? now]) =>
    turn != null &&
    turn['status'] == 'running' &&
    (now ?? DateTime.now().millisecondsSinceEpoch) -
            ((turn['updated_at'] as num?)?.toInt() ?? 0) <
        20000;

List<Map<String, dynamic>> chatIndex(Map<String, dynamic> tree) {
  final chats = Map<String, dynamic>.from(tree['conversations'] ?? {});
  final projects = Map<String, dynamic>.from(tree['projects'] ?? {});
  return chats.entries.map((entry) {
    final project = projects.entries
        .where(
          (p) => ((p.value as Map)['conversation_ids'] as List? ?? []).contains(
            entry.key,
          ),
        )
        .firstOrNull;
    return <String, dynamic>{
      ...Map<String, dynamic>.from(entry.value),
      'id': entry.key,
      'project_id': project?.key,
      'project_name': (project?.value as Map?)?['name'],
    };
  }).toList()..sort(
    (a, b) => ((b['updated_at'] as num?) ?? 0).compareTo(
      (a['updated_at'] as num?) ?? 0,
    ),
  );
}

/// Error reported by the desktop speech model during remote dictation.
class DictationException implements Exception {
  DictationException(this.code);
  final String code;
  @override
  String toString() => code;
}

class Companion {
  Companion(this.uid);
  final String uid;
  final db = FirebaseFirestore.instance;
  DocumentReference<Map<String, dynamic>> get user =>
      db.collection('users').doc(uid);
  CollectionReference<Map<String, dynamic>> get devices =>
      user.collection('devices');
  Stream<DocumentSnapshot<Map<String, dynamic>>> get index =>
      user.collection('companion').doc('state').snapshots();
  Stream<QuerySnapshot<Map<String, dynamic>>> liveTurns(String device) =>
      devices.doc(device).collection('live_turns').snapshots();
  Stream<QuerySnapshot<Map<String, dynamic>>> messages(String id) => user
      .collection('conversations')
      .doc(id)
      .collection('messages')
      .orderBy('sequence')
      .snapshots();
  CollectionReference<Map<String, dynamic>> requests(String device) =>
      devices.doc(device).collection('requests');
  Future<String> send(
    String device,
    String conversation,
    String content, {
    bool newConversation = false,
    String? project,
    String action = 'chat',
    Map<String, dynamic> extra = const {},
  }) async {
    final request = requests(device).doc();
    // A unique request is written once; ambiguous outcomes are never auto-replayed.
    await request.set({
      'conversation_id': conversation,
      'content': content,
      'new_conversation': newConversation,
      'project_id': project,
      'action': action,
      'created_at': DateTime.now().millisecondsSinceEpoch,
      'status': 'pending',
      ...extra,
    });
    return request.id;
  }

  Future<Map<String, dynamic>> control(
    String device,
    String conversation,
    String action,
    Map<String, dynamic> arguments,
  ) async {
    final id = await send(
      device,
      conversation,
      '',
      action: action,
      extra: arguments,
    );
    final snapshot = await requests(device)
        .doc(id)
        .snapshots()
        .firstWhere(
          (s) => [
            'completed',
            'failed',
            'cancelled',
          ].contains(s.data()?['status']),
        )
        .timeout(
          Duration(seconds: action == 'skill_install' ? 210 : 45),
          onTimeout: () => throw StateError(
            'Esito non confermato. Controlla sul PC prima di riprovare.',
          ),
        );
    final data = snapshot.data();
    if (data?['status'] != 'completed') {
      throw StateError(
        (data?['error'] ?? 'Operazione annullata sul PC').toString(),
      );
    }
    final result = data?['result'];
    if (result == null) return {};
    if (result is! Map) throw StateError('Risposta del PC non valida.');
    return Map<String, dynamic>.from(result);
  }

  /// Uploads a 16 kHz mono WAV in Firestore-sized parts, asks the desktop to
  /// transcribe it and returns the recognised text.
  Future<String> transcribe(
    String device,
    String conversation,
    Uint8List audio,
    String language,
  ) async {
    const partBytes = 500000;
    final parts = <String>[];
    var terminal = false;
    try {
      for (var offset = 0; offset < audio.length; offset += partBytes) {
        final end = offset + partBytes < audio.length
            ? offset + partBytes
            : audio.length;
        final part = requests(device).doc();
        await part.set({
          'conversation_id': conversation,
          'content': '',
          'action': 'audio',
          'status': 'audio',
          'created_at': DateTime.now().millisecondsSinceEpoch,
          'audio': base64Encode(audio.sublist(offset, end)),
        });
        parts.add(part.id);
      }
      final request = requests(device).doc();
      await request.set({
        'conversation_id': conversation,
        'content': '',
        'new_conversation': false,
        'action': 'transcribe',
        'created_at': DateTime.now().millisecondsSinceEpoch,
        'status': 'pending',
        'audio_parts': parts,
        'language': language,
      });
      final snapshot = await request
          .snapshots()
          .firstWhere(
            (value) =>
                ['completed', 'failed'].contains(value.data()?['status']),
          )
          .timeout(const Duration(seconds: 180));
      terminal = true;
      final data = snapshot.data() ?? {};
      if (data['status'] != 'completed') {
        throw DictationException(
          (data['error'] ?? 'transcription_failed').toString(),
        );
      }
      final result = data['result'];
      final text = result is Map ? result['text'] : null;
      if (text is! String || text.trim().isEmpty) {
        throw DictationException('speech_silence');
      }
      return text.trim();
    } finally {
      // On timeout the desktop may still be reading the parts: leave them.
      if (terminal) {
        for (final id in parts) {
          try {
            await requests(device).doc(id).delete();
          } catch (_) {}
        }
      }
    }
  }

  Future<List<Map<String, dynamic>>> decodeMessages(
    List<QueryDocumentSnapshot<Map<String, dynamic>>> docs,
  ) async {
    final result = <Map<String, dynamic>>[];
    for (final doc in docs) {
      final value = doc.data();
      if (value['chunked'] == true) {
        final parts = await doc.reference
            .collection('parts')
            .orderBy(FieldPath.documentId)
            .get();
        if (parts.docs.length != value['part_count']) {
          throw StateError('incomplete_message');
        }
        result.add(
          Map<String, dynamic>.from(
            jsonDecode(
              parts.docs.map((p) => p.data()['data'] as String).join(),
            ),
          ),
        );
      } else {
        result.add(value);
      }
    }
    return result;
  }
}

class NotificationTarget {
  const NotificationTarget({
    required this.uid,
    required this.conversation,
    required this.device,
  });
  final String uid, conversation, device;

  static NotificationTarget? fromData(Map<String, dynamic> data) {
    final uid = data['uid'], conversation = data['conversation_id'];
    final device = data['device_id'] ?? '';
    bool valid(Object? value) =>
        value is String &&
        value.isNotEmpty &&
        value.length <= 1500 &&
        !value.contains('/') &&
        value != '.' &&
        value != '..';
    if (!valid(uid) ||
        !valid(conversation) ||
        device is! String ||
        device.isNotEmpty && !valid(device) ||
        data['kind'] == 'transcription') {
      return null;
    }
    return NotificationTarget(
      uid: uid as String,
      conversation: conversation as String,
      device: device,
    );
  }

  static NotificationTarget? fromPayload(String? payload) {
    if (payload == null) return null;
    try {
      final data = jsonDecode(payload);
      return data is Map<String, dynamic> ? fromData(data) : null;
    } on FormatException {
      return null;
    }
  }

  String get payload => jsonEncode({
    'uid': uid,
    'conversation_id': conversation,
    'device_id': device,
  });
}

bool showForegroundNotification(
  Map<String, dynamic> data, {
  required String? uid,
  required bool foreground,
  required String? visibleConversation,
  required String? visibleDevice,
}) =>
    uid != null &&
    data['uid'] == uid &&
    data['kind'] != 'transcription' &&
    !(foreground &&
        data['kind'] == 'chat' &&
        visibleConversation != null &&
        data['conversation_id'] == visibleConversation &&
        (data['device_id'] == null ||
            data['device_id'] == '' ||
            data['device_id'] == visibleDevice));

class PushNotifications {
  final target = ValueNotifier<NotificationTarget?>(null);
  final warning = ValueNotifier<String?>(null);
  final local = FlutterLocalNotificationsPlugin();
  final _subscriptions = <StreamSubscription<dynamic>>[];
  String? _uid, _installation;
  String? _fid;
  Completer<void>? _registration;
  bool _binding = false;
  String? visibleConversation, visibleDevice;
  bool foreground = true;
  final _shown = <String>{};
  void open(NotificationTarget? notification) {
    if (notification != null) target.value = notification;
  }

  static const channel = AndroidNotificationChannel(
    'aurachat_completion',
    'Attività completate',
    description: 'Risposte e richieste di approvazione',
    importance: Importance.high,
  );
  Future<void> initialize() async {
    await local.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('ic_notification'),
        // Il permesso viene chiesto solo dopo il login, in bind().
        iOS: DarwinInitializationSettings(
          requestAlertPermission: false,
          requestSoundPermission: false,
          requestBadgePermission: false,
        ),
      ),
      onDidReceiveNotificationResponse: (response) =>
          open(NotificationTarget.fromPayload(response.payload)),
    );
    await local
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.createNotificationChannel(channel);
    final launch = await local.getNotificationAppLaunchDetails();
    if (launch?.didNotificationLaunchApp == true) {
      open(
        NotificationTarget.fromPayload(launch?.notificationResponse?.payload),
      );
    }
    FirebaseMessaging.onBackgroundMessage(backgroundMessage);
    _subscriptions.add(
      FirebaseMessaging.onMessage.listen((message) async {
        if (!showForegroundNotification(
          message.data,
          uid: _uid,
          foreground: foreground,
          visibleConversation: visibleConversation,
          visibleDevice: visibleDevice,
        )) {
          return;
        }
        final id =
            message.data['event_id'] ?? message.messageId ?? const Uuid().v4();
        if (_shown.contains(id)) return;
        _shown.add(id);
        if (_shown.length > 500) _shown.remove(_shown.first);
        try {
          await local.show(
            id: id.hashCode & 0x7fffffff,
            title: message.notification?.title ?? 'AuraChat',
            body: message.notification?.body,
            notificationDetails: NotificationDetails(
              android: AndroidNotificationDetails(
                'aurachat_completion',
                'Attività completate',
                importance: Importance.high,
                priority: Priority.high,
                tag: id,
              ),
              iOS: const DarwinNotificationDetails(),
            ),
            payload: NotificationTarget.fromData(message.data)?.payload,
          );
        } catch (error) {
          _shown.remove(id);
          warning.value = 'Visualizzazione notifiche: ${friendlyError(error)}';
        }
      }),
    );
    _subscriptions.add(
      FirebaseMessaging.onMessageOpenedApp.listen((message) {
        // A tap can precede auth restoration; the workspace checks ownership.
        open(NotificationTarget.fromData(message.data));
      }),
    );
    final initial = await FirebaseMessaging.instance.getInitialMessage();
    if (initial != null && target.value == null) {
      open(NotificationTarget.fromData(initial.data));
    }
    _subscriptions.add(
      FirebaseMessaging.instance.onRegistered.listen((fid) async {
        _fid = fid;
        try {
          await _register(fid);
          if (_registration?.isCompleted == false) _registration!.complete();
        } catch (error) {
          warning.value = 'Registrazione notifiche: ${friendlyError(error)}';
          if (_registration?.isCompleted == false) {
            _registration!.completeError(error);
          }
        }
      }),
    );
  }

  Future<void> bind(String uid) async {
    if (_binding) return;
    _binding = true;
    _uid = uid;
    try {
      final prefs = await SharedPreferences.getInstance();
      _installation = prefs.getString('installation_id') ?? const Uuid().v4();
      await prefs.setString('installation_id', _installation!);
      final permission = await FirebaseMessaging.instance.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );
      // Foreground delivery uses our local native notification on both platforms.
      await FirebaseMessaging.instance
          .setForegroundNotificationPresentationOptions(
            alert: false,
            badge: false,
            sound: false,
          );
      if (permission.authorizationStatus == AuthorizationStatus.denied) {
        warning.value =
            'Notifiche disattivate. Abilitale nelle impostazioni di sistema di AuraChat.';
        return;
      }
      if (defaultTargetPlatform == TargetPlatform.iOS) {
        // FCM non può registrare l'installazione senza il token APNs. Il primo
        // token può arrivare qualche istante dopo il consenso.
        for (var attempt = 0; attempt < 40; attempt++) {
          if (await FirebaseMessaging.instance.getAPNSToken() != null) {
            break;
          }
          await Future<void>.delayed(const Duration(milliseconds: 500));
        }
        if (await FirebaseMessaging.instance.getAPNSToken() == null) {
          warning.value =
              'Registrazione Apple non disponibile. Riapri l’app e riprova; verifica Push Notifications e il profilo di firma iOS.';
          return;
        }
      }
      _registration = Completer<void>();
      final confirmed = _registration!.future.timeout(
        const Duration(seconds: 20),
      );
      // Attach the error handler before native registration can emit an event.
      final confirmation = confirmed.then<Object?>(
        (_) => null,
        onError: (Object e) => e,
      );
      await FirebaseMessaging.instance.register();
      if (_fid != null) {
        await _register(_fid!);
        if (!_registration!.isCompleted) _registration!.complete();
      }
      final failure = await confirmation;
      if (failure != null) throw failure;
      warning.value = null;
    } catch (error) {
      if (kDebugMode) {
        debugPrint('FCM registration failed: $error');
      }
      warning.value = 'Notifiche: ${friendlyError(error)}';
    } finally {
      _registration = null;
      _binding = false;
    }
  }

  Future<void> _register(String fid) async {
    final uid = _uid;
    if (uid == null || _installation == null) {
      return;
    }
    await FirebaseFirestore.instance
        .collection('users')
        .doc(uid)
        .collection('phones')
        .doc(_installation)
        .set({
          'fid': fid,
          'platform': defaultTargetPlatform == TargetPlatform.iOS
              ? 'ios'
              : 'android',
          'updated_at': DateTime.now().millisecondsSinceEpoch,
        });
  }

  Future<void> signOut() async {
    final uid = _uid;
    if (uid != null && _installation != null) {
      await FirebaseFirestore.instance
          .collection('users')
          .doc(uid)
          .collection('phones')
          .doc(_installation)
          .delete();
    }
    await FirebaseMessaging.instance.unregister();
    await local.cancelAll();
    _uid = null;
    _fid = null;
    visibleConversation = null;
    visibleDevice = null;
    target.value = null;
    await FirebaseAuth.instance.signOut();
  }
}
