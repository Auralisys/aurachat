// Local queues never replay after reload. Native history owns consumed guidance.
const queuedTurns = {steering:new Map(), paused:new Set()};

function sameGuidance(a, b) {
  return a?.content === b?.content && JSON.stringify(a?.attachments || []) === JSON.stringify(b?.attachments || []);
}

function removeQueuedMessage(id, message) {
  const queue = state.queues.get(id);
  const index = queue?.indexOf(message) ?? -1;
  if (index < 0) return;
  queue.splice(index, 1);
  if (!queue.length) state.queues.delete(id);
}

function queueLocked(id) {return queuedTurns.steering.has(id);}
function refreshQueue(id) {if (id === state.activeConversationId) {renderMessages();updateComposerControls();}}

function editQueuedMessage(id, message) {
  if (queueLocked(id) || !state.queues.get(id)?.includes(message)) return;
  removeQueuedMessage(id,message);
  const input = $('#composer-input');
  const text = (message.content || '').trim();
  input.value = input.value.trim() ? `${input.value.replace(/\s+$/,'')}\n${text}` : text;
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
  const label = document.createElement('span');label.className = 'msg__state';label.textContent = t('queue.queued');
  el.querySelector('.msg-actions')?.replaceChildren();
  const locked = queueLocked(id) || state.preparing || state.loadingConversation;
  const more = messageAction('more','sidebar.options', () => {
    if (queueLocked(id)) return;
    const run = state.runs.get(id);
    showTreeMenu(el, more, t('queue.queued'), [
      ['send','queue.send_now', () => sendQueuedNow(id,message)],
      ['rename','queue.edit', () => editQueuedMessage(id,message)],
      ['delete','queue.delete', () => {if (queueLocked(id)) return;removeQueuedMessage(id,message);refreshQueue(id);}],
    ]);
    if (run?.pending && run.stopping) $('#tree-menu button:first-of-type')?.setAttribute('disabled','');
  });
  more.disabled = locked;
  meta.append(label, more);el.prepend(meta);
  if (message.steer_error) {
    const error = document.createElement('p');error.className = 'queue-note';error.setAttribute('role','status');error.textContent = t('queue.steer_failed');el.append(error);
  }
  return el;
}

function renderQueuedMessages(box, id) {
  const run = state.runs.get(id);
  for (const pending of run?.pendingGuidance || []) {
    if (pending.accepted && !pending.consumed) box.append(messageEl({...pending.message,role:'user',guidance:true},-1));
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
    await invoke('steer_chat',{conversation_id:id,content:message.content,attachments:message.attachments || []});
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
  const pending = run.pendingGuidance?.find(item => !item.consumed && sameGuidance(item.message,message));
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
