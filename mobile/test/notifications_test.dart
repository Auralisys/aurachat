import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:aurachat_mobile/companion.dart';

void main() {
  const data = <String, dynamic>{
    'uid': 'account-a',
    'conversation_id': 'chat-b',
    'device_id': 'pc-b',
    'kind': 'chat',
  };

  test('remote and local taps preserve account, device and conversation', () {
    final remote = NotificationTarget.fromData(data)!;
    final local = NotificationTarget.fromPayload(remote.payload)!;
    expect(local.uid, 'account-a');
    expect(local.device, 'pc-b');
    expect(local.conversation, 'chat-b');
    expect(jsonDecode(local.payload)['uid'], 'account-a');
    expect(NotificationTarget.fromData({...data, 'device_id': ''})!.device, '');
  });

  test(
    'all tap paths retain their target before authentication and index loading',
    () {
      final notifications = PushNotifications();
      // The same entry point receives FCM cold/warm and local launch/response taps.
      for (final target in [
        NotificationTarget.fromData(data),
        NotificationTarget.fromPayload(jsonEncode(data)),
      ]) {
        notifications.open(target);
        expect(notifications.target.value, target);
        expect(notifications.target.value!.uid, 'account-a');
      }
      final pending = notifications.target.value;
      notifications.open(null);
      expect(notifications.target.value, same(pending));
      var taps = 0;
      notifications.target.addListener(() => taps++);
      notifications.open(NotificationTarget.fromData(data));
      notifications.open(NotificationTarget.fromData(data));
      expect(
        taps,
        2,
        reason: 'Repeated taps on the same chat must still navigate',
      );
    },
  );

  test(
    'unscoped legacy, malformed and transcription payloads cannot route',
    () {
      for (final payload in ['chat-b', '{}', '[]', 'null', '{"uid":5}']) {
        expect(NotificationTarget.fromPayload(payload), isNull);
      }
      for (final change in <Map<String, dynamic>>[
        {'uid': ''},
        {'conversation_id': ''},
        {'conversation_id': '../other'},
        {'conversation_id': 4},
        {
          'device_id': ['pc-b'],
        },
        {'kind': 'transcription'},
      ]) {
        expect(NotificationTarget.fromData({...data, ...change}), isNull);
      }
      expect(
        NotificationTarget.fromData({...data, 'uid': 'account-b'})!.uid,
        'account-b',
        reason: 'A cold tap keeps its owner for workspace verification',
      );
    },
  );

  bool show(
    Map<String, dynamic> event, {
    String? uid = 'account-a',
    bool foreground = true,
    String? conversation = 'chat-a',
    String? device = 'pc-a',
  }) => showForegroundNotification(
    event,
    uid: uid,
    foreground: foreground,
    visibleConversation: conversation,
    visibleDevice: device,
  );

  test(
    'other chats and PCs notify while the app is open; visible chat does not',
    () {
      expect(show(data), isTrue);
      expect(show(data, conversation: 'chat-b', device: 'pc-b'), isFalse);
      expect(show(data, conversation: 'chat-b', device: 'pc-a'), isTrue);
      expect(show(data, conversation: null), isTrue);
      expect(
        show(data, foreground: false, conversation: 'chat-b', device: 'pc-b'),
        isTrue,
      );
      expect(
        show(
          {...data, 'kind': 'approval-requested'},
          conversation: 'chat-b',
          device: 'pc-b',
        ),
        isTrue,
      );
    },
  );

  test('dictation and other-account events do not show foreground banners', () {
    expect(show({...data, 'kind': 'transcription'}), isFalse);
    expect(show(data, uid: null), isFalse);
    expect(show(data, uid: 'account-b'), isFalse);
  });
}
