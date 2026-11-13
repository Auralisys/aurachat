// Local queues never replay after reload. Native history owns consumed guidance.
const queuedTurns = {steering:new Map(), preparing:new Map(), paused:new Set()};

function sameGuidance(a, b) {
  return a?.content === b?.content && JSON.stringify(a?.attachments || []) === JSON.stringify(b?.attachments || []);
}

function removeQueuedMessage(id, message) {
  const queue = state.queues.get(id);
  const index = queue?.indexOf(message) ?? -1;
  if (index < 0) return;
  queue.splice(index, 1);
  if (!queue.length) {state.queues.delete(id);queuedTurns.paused.delete(id);}
}

function queueLocked(id) {return queuedTurns.steering.has(id) || queuedTurns.preparing.has(id);}
function clearQueuedStatus(id) {
  if (id === state.activeConversationId && !state.queues.get(id)?.length && $('#composer-status')?.textContent === t('chat.queued')) composerStatus();
}
function refreshQueue(id) {clearQueuedStatus(id);if (id === state.activeConversationId) {renderMessages();updateComposerControls();}}

function editQueuedMessage(id, message) {
  if (queueLocked(id) || !state.queues.get(id)?.includes(message)) return;
  removeQueuedMessage(id,message);
  const input = $('#composer-input');
  restoreMessageDraft(message, true);
  if (message.attachments?.length) state.attachments = [...state.attachments, ...structuredClone(message.attachments)];
  state.editingMessageIndex = null;
  autoGrow(input);renderDraft();input.focus();composerStatus();refreshQueue(id);
}

// Sends the draft now: as guidance into the running turn, otherwise ahead of
// the rest of the queue as a normal turn.
function sendQueuedNow(id, message) {
  if (queueLocked(id) || !state.queues.get(id)?.includes(message)) return;
  const run = state.runs.get(id);
  if (run?.pending) {steerQueuedMessage(id,message);return;}
  const queue = state.queues.get(id), index = queue.indexOf(message);
  if (index > 0) {queue.splice(index,1);queue.unshift(message);}
  queuedTurns.paused.delete(id);
  refreshQueue(id);flushQueue(id);
}

function queuedMessageEl(id, message) {
  const el = messageEl({...message, role:'user'}, -1);el.classList.add('msg--queued');
  el.dataset.queueId = message.queue_id;
  const meta = document.createElement('div');meta.className = 'msg__queue-meta';
  const label = document.createElement('span');label.className = 'msg__state';
  const preparing = queuedTurns.preparing.get(id) === message;
  label.textContent = t(preparing ? 'queue.preparing' : 'queue.queued');
  if (preparing) label.setAttribute('role','status');
  el.querySelector('.msg-actions')?.remove();
  const locked = queueLocked(id) || state.preparing || state.loadingConversation;
  const more = messageAction('more','queue.actions', () => {
    if (queueLocked(id)) return;
    showTreeMenu(el, more, t('queue.queued'), [
      ['send','queue.send_now',()=>sendQueuedNow(id,message)],
      ['rename','queue.edit',()=>editQueuedMessage(id,message)],
      ['delete','queue.delete',()=>{if (queueLocked(id)) return;removeQueuedMessage(id,message);refreshQueue(id);}],
    ]);
    if (state.runs.get(id)?.stopping) $('#tree-menu button:first-of-type')?.setAttribute('disabled','');
  });
  configureMenuTrigger(more);more.disabled = locked;
  meta.append(label, more);el.prepend(meta);
  if (message.steer_error) {
    const error = document.createElement('p');error.className = 'queue-note';error.setAttribute('role','status');error.textContent = t('queue.steer_failed');el.append(error);
  }
  if (message.prepare_error) {
    const error = document.createElement('p');error.className = 'queue-note';error.setAttribute('role','alert');error.textContent = message.prepare_error;el.append(error);
  }
  return el;
}

// Guidance accepted by the turn but not read by the model yet: same place and
// look as a queued draft, and it can still be edited or withdrawn.
function pendingGuidanceEl(id, pending) {
  const el = messageEl({...pending.message, role:'user'}, -1);el.classList.add('msg--queued','msg--guide-pending');
  const meta = document.createElement('div');meta.className = 'msg__queue-meta';
  const label = document.createElement('span');label.className = 'msg__state msg__state--guide';
  label.textContent = t(pending.withdrawing ? 'queue.guide_withdrawing' : 'queue.guide_pending');
  el.querySelector('.msg-actions')?.remove();
  const more = messageAction('more','queue.actions', () => {
    if (!guidanceWithdrawable(id,pending)) return;
    showTreeMenu(el, more, t('queue.guide_pending'), [
      ['rename','queue.edit',()=>withdrawPendingGuidance(id,pending,true)],
      ['close','queue.cancel_send',()=>withdrawPendingGuidance(id,pending,false)],
    ]);
  });
  configureMenuTrigger(more);more.disabled = !guidanceWithdrawable(id,pending);
  meta.append(label, more);el.prepend(meta);
  return el;
}

function guidanceWithdrawable(id, pending) {
  return !!pending.id && !pending.withdrawing && !pending.consumed && !!state.runs.get(id)?.pending;
}

function dropPendingGuidance(run, guidanceId) {
  if (!run || !guidanceId) return;
  (run.withdrawnGuidance ||= new Set()).add(guidanceId);
  run.pendingGuidance = (run.pendingGuidance || []).filter(item => item.consumed || item.id !== guidanceId);
}

// Native withdraw is atomic with the model read: either the guide comes back
// whole, or it was already read and stays in the chronology.
async function withdrawPendingGuidance(id, pending, edit) {
  if (!guidanceWithdrawable(id,pending)) return;
  const run = state.runs.get(id);
  pending.withdrawing = true;refreshQueue(id);
  try {
    const returned = await conversationCommand('withdraw_guidance',{conversation_id:id,guidance_id:pending.id});
    dropPendingGuidance(run,pending.id);
    if (edit) {
      const message = typeof returned?.content === 'string' && returned.content.trim() ? returned : pending.message;
      restoreGuidanceDraft(id,message);
    }
  } catch (error) {
    if (id === state.activeConversationId) composerStatus(/guidance_consumed|chat_not_running/.test(String(error?.message || error)) ? t('queue.guide_read') : localizeError(error));
  } finally {
    pending.withdrawing = false;refreshQueue(id);
  }
}

function restoreGuidanceDraft(id, message) {
  if (id !== state.activeConversationId) return;
  const input = $('#composer-input');
  restoreMessageDraft(message, true);
  if (message.attachments?.length) state.attachments = [...state.attachments, ...structuredClone(message.attachments)];
  state.editingMessageIndex = null;state.guidanceDraft = id;
  autoGrow(input);renderDraft();input.focus();composerStatus(t('queue.guide_editing'));
}

// Guides sent from another client (phone, remote viewer) appear like local ones.
function trackQueuedGuidance(run, item) {
  if (typeof item?.id !== 'string' || run.withdrawnGuidance?.has(item.id)) return false;
  const list = run.pendingGuidance ||= [];
  if (list.some(pending => pending.id === item.id)) return false;
  const content = typeof item.content === 'string' ? item.content : '';
  const local = list.find(pending => !pending.id && !pending.consumed && pending.message.content.trim() === content.trim());
  if (local) {local.id = item.id;return true;}
  list.push({message:{role:'user',content,attachments:Array.isArray(item.attachments) ? item.attachments : [],...pasteMetadata(item)},accepted:true,consumed:false,id:item.id,external:true});
  return true;
}

// Remote turns publish the unread list in their live snapshot.
function syncRemoteGuidance(run, remote) {
  if (!Array.isArray(remote)) return;
  run.pendingGuidance ||= [];
  for (const item of remote) {
    trackQueuedGuidance(run,item);
    const pending = run.pendingGuidance.find(entry => entry.id === item?.id);
    if (pending) pending.seen = true;
  }
  run.pendingGuidance = run.pendingGuidance.filter(pending => pending.consumed || !pending.seen || remote.some(item => item?.id === pending.id));
}

function renderQueuedMessages(box, id) {
  const run = state.runs.get(id);
  for (const pending of run?.pendingGuidance || []) {
    if (pending.accepted && !pending.consumed) box.append(pendingGuidanceEl(id,pending));
  }
  const queue = state.queues.get(id) || [];
  for (const message of queue) box.append(queuedMessageEl(id,message));
  if (queue.length && queuedTurns.paused.has(id)) {
    const bar = document.createElement('div');bar.className = 'queue-paused';
    const label = document.createElement('span');label.textContent = t('queue.paused');label.setAttribute('role','status');
    const resume = document.createElement('button');resume.type = 'button';resume.textContent = t('queue.resume');resume.disabled = queueLocked(id) || !!run?.pending;
    resume.onclick = () => {if (queueLocked(id) || state.runs.get(id)?.pending) return;queuedTurns.paused.delete(id);refreshQueue(id);flushQueue(id);};
    bar.append(label,resume);box.append(bar);
  }
}

async function steerQueuedMessage(id, message) {
  const run = state.runs.get(id);
  if (!run?.pending || run.stopping || queueLocked(id) || !state.queues.get(id)?.includes(message)) return;
  const pending = {message, accepted:false, consumed:false};
  (run.pendingGuidance ||= []).push(pending);queuedTurns.steering.set(id,pending);delete message.steer_error;refreshQueue(id);
  try {
    const result = await conversationCommand('steer_chat',{conversation_id:id,content:message.content,attachments:message.attachments || [],...pasteMetadata(message)});
    if (typeof result?.id === 'string') {
      // The native notice may have arrived first as a separate entry: keep one.
      const twin = run.pendingGuidance.find(item => item !== pending && item.id === result.id);
      if (twin) {pending.consumed ||= twin.consumed;run.pendingGuidance = run.pendingGuidance.filter(item => item !== twin);}
      pending.id = result.id;
    }
    pending.accepted = true;removeQueuedMessage(id,message);
  } catch (_) {
    if (!pending.consumed) {
      run.pendingGuidance = run.pendingGuidance.filter(item => item !== pending);
      message.steer_error = true;
      // An interrupted/failed turn must never replay a guidance request as a new turn.
      if (!run.pending) queuedTurns.paused.add(id);
    }
  } finally {
    queuedTurns.steering.delete(id);
    if (!run.pending && pending.accepted && !pending.consumed) queuedTurns.paused.add(id);
    refreshQueue(id);
    if (run.queueOutcome === 'completed') flushQueue(id);
  }
}

function consumeQueuedGuidance(id, message) {
  const run = state.runs.get(id);if (!run) return false;
  const pending = (message.guidance_id && run.pendingGuidance?.find(item => !item.consumed && item.id === message.guidance_id))
    || run.pendingGuidance?.find(item => !item.consumed && sameGuidance(item.message,message));
  if (pending) {pending.consumed = true;removeQueuedMessage(id,pending.message);}
  else if (run.messages.at(-1)?.guidance && sameGuidance(run.messages.at(-1),message) && !run.stream?.content && !run.stream?.activity.length) return false;
  (run.guidanceEvents ||= []).push(message);
  return true;
}

function markGuidanceHistory(run, messages) {
  let cursor = run.initialMessageCount || 0;
  for (const guidance of run.guidanceEvents || []) {
    const index = messages.findIndex((message,index) => index >= cursor && message.role === 'user' && sameGuidance(message,guidance));
    if (index >= 0) {messages[index] = {...messages[index],guidance:true};cursor = index + 1;}
  }
  return messages;
}
