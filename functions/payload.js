'use strict';
function notificationExpired(time, now = Date.now()) {
  const created = Date.parse(time);
  return !Number.isFinite(created) || now - created >= 24 * 60 * 60 * 1000;
}
function notificationPayload(uid, eventId, event) {
  if (!uid || !eventId || !event || typeof event.title !== 'string' || typeof event.body !== 'string') {
    throw new Error('Invalid completion event');
  }
  return {
    notification: { title: event.title.slice(0, 120), body: event.body.slice(0, 400) },
    data: { uid, event_id: eventId, conversation_id: String(event.conversation_id || ''), device_id: String(event.device_id || '') },
    android: { priority: 'high', notification: { channelId: 'aurachat_completion', tag: eventId, icon: 'ic_notification', sound: 'default' } },
    apns: { payload: { aps: { sound: 'default' } } },
  };
}
module.exports = { notificationPayload, notificationExpired };
