// Local queues never replay after reload. Native history owns consumed guidance.
const queuedTurns = {steering:new Map(), editing:new Map(), paused:new Set()};

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

function queueLocked(id) {return queuedTurns.steering.has(id) || queuedTurns.editing.has(id);}
function refreshQueue(id) {if (id === state.activeConversationId) {renderMessages();updateComposerControls();}}

function queuedMessageEl(id, message) {
  const el = messageEl({...message, role:'user'}, -1);el.classList.add('msg--queued');
  el.dataset.queueId = message.queue_id;
  const label = document.createElement('span');label.className = 'msg__state';label.textContent = t('queue.queued');el.prepend(label);
  const actions = el.querySelector('.msg-actions');actions.replaceChildren();
  const locked = queueLocked(id) || state.preparing || state.loadingConversation;
  const edit = messageAction('rename','chat.edit', () => {
    if (queueLocked(id)) return;
    queuedTurns.editing.set(id, {message, content:message.content});refreshQueue(id);
    document.querySelector('.queue-editor textarea')?.focus();
  });
  const remove = messageAction('delete','queue.delete', () => {
    if (queueLocked(id)) return;
    removeQueuedMessage(id,message);refreshQueue(id);
  });
  const steer = document.createElement('button');steer.type = 'button';steer.className = 'queue-steer';
  steer.textContent = t(queuedTurns.steering.get(id)?.message === message ? 'queue.sending' : 'queue.steer');
  steer.onclick = () => steerQueuedMessage(id,message);
  edit.disabled = remove.disabled = locked;
  steer.disabled = locked || !state.runs.get(id)?.pending || !!state.runs.get(id)?.stopping;
  actions.append(edit,remove,steer);
  const editing = queuedTurns.editing.get(id);
  if (editing?.message === message) {
    const form = document.createElement('form');form.className = 'queue-editor';
    const input = document.createElement('textarea');input.value = editing.content;input.rows = 3;input.setAttribute('aria-label',t('queue.edit'));
    input.oninput = () => {editing.content = input.value;};
    const save = document.createElement('button');save.type = 'submit';save.textContent = t('queue.save');
    const cancel = document.createElement('button');cancel.type = 'button';cancel.textContent = t('project.cancel');
    const finish = () => {queuedTurns.editing.delete(id);refreshQueue(id);flushQueue(id);};
    form.onsubmit = event => {
      event.preventDefault();
      if (!editing.content.trim() && !message.attachments?.length) return;
      message.content = editing.content.trim();delete message.steer_error;finish();
    };
    cancel.onclick = finish;
    input.onkeydown = event => {if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();finish();}};
    form.append(input,save,cancel);el.append(form);
  }
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
