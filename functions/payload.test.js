const { test } = require('node:test');
const assert = require('node:assert/strict');
const { notificationPayload, notificationExpired } = require('./payload');

test('retries recent events but drops expired and invalid events', () => {
  const now = Date.parse('2026-10-17T22:00:00Z');
  assert.equal(notificationExpired('2026-10-17T21:00:00Z', now), false);
  assert.equal(notificationExpired('2026-10-16T22:00:00Z', now), true);
  assert.equal(notificationExpired('invalid', now), true);
});
test('routes completion to the correct account and conversation, with stable retry tag', () => {
  const event = { title: 'Risposta pronta', body: 'Completata', conversation_id: 'chat1', device_id: 'pc1', api_key: 'never-copy-this' };
  const result = notificationPayload('owner', 'event1', event);
  assert.equal(result.data.uid, 'owner');
  assert.equal(result.data.conversation_id, 'chat1');
  assert.equal(result.android.notification.tag, 'event1');
  assert.equal(result.android.notification.channelId, 'aurachat_completion');
  assert.ok(!JSON.stringify(result).includes('never-copy-this'));
  assert.throws(() => notificationPayload('owner', 'event1', {}));
});
