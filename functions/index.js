'use strict';
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { createHash } = require('node:crypto');
const { notificationPayload, notificationExpired } = require('./payload');
initializeApp();

exports.completionPush = onDocumentCreated({
  document: 'users/{uid}/notifications/{eventId}', region: 'europe-west3', retry: true,
  minInstances: 0, maxInstances: 3, concurrency: 1,
  memory: '256MiB', cpu: 'gcf_gen1', timeoutSeconds: 60,
}, async (event) => {
  // Stop retrying after a day, including persistent provider errors.
  if (notificationExpired(event.time)) return;
  const { uid, eventId } = event.params;
  let payload;
  try {
    payload = notificationPayload(uid, eventId, event.data?.data());
  } catch {
    // Invalid documents cannot succeed on retry.
    console.warn('Ignoring invalid completion event', eventId);
    return;
  }
  const db = getFirestore();
  const phones = await db.collection(`users/${uid}/phones`).get();
  await Promise.all(phones.docs.map(async (phone) => {
    const fid = phone.get('fid');
    if (typeof fid !== 'string' || !fid) return;
    const fingerprint = createHash('sha256').update(fid).digest('hex');
    const delivery = event.data.ref.collection('deliveries').doc(fingerprint);
    if ((await delivery.get()).exists) return;
    try {
      await getMessaging().send({ ...payload, fid });
      // FCM is at-least-once. The stable Android tag replaces a possible retry
      // notification if the process dies between send and this receipt.
      await delivery.set({ sent_at: Date.now() });
    } catch (error) {
      if (['messaging/installation-id-not-registered', 'messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error.code)) {
        await db.runTransaction(async (transaction) => {
          const current = await transaction.get(phone.ref);
          if (current.get('fid') === fid) transaction.delete(phone.ref);
        });
        return;
      }
      throw error;
    }
  }));
});
