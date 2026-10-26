// Native progress is scoped to each conversation, including background turns.
const progressMotion = matchMedia('(prefers-reduced-motion: reduce)');

function progressIcon(item) {
  const name = item?.action === 'ask_user' ? 'MessageCircle' : item?.kind === 'approval' ? 'ShieldCheck' : item?.kind === 'agent' ? 'Bot' : item?.kind === 'reasoning' ? 'Brain' : /search/.test(item?.action) ? 'Search' : /write|edit/.test(item?.action) ? 'FilePenLine' : /read/.test(item?.action) ? 'FileText' : /list/.test(item?.action) ? 'FolderSearch' : 'Terminal';
  return lucide.createElement(lucide.icons[name], {class:'ui-icon', 'aria-hidden':'true'});
}

function progressLabel(item) {
  if (item.kind === 'approval') return `${approvalLabel(item)}${item.action?.path ? ` · ${item.action.path}` : ''}`;
  if (item.kind === 'agent') return item.title || t('activity.agent');
  if (item.kind === 'reasoning') return t('progress.reasoned');
  const key = `progress.${item.action}`;
  return `${t(key) === key ? item.action || t('progress.command') : t(key)}${item.path ? ` · ${item.path}` : ''}`;
}

function reconcileChildren(parent, nodes) {
  nodes.forEach((node,index) => {if (parent.children[index] !== node) parent.insertBefore(node,parent.children[index] || null);});
  while (parent.children.length > nodes.length) parent.lastElementChild.remove();
}

// Resolve command activity against the latest native shell snapshot, including events
// arriving before the tool result. This is a display overlay; it never starts commands.
function shellProgressItem(item) {
  if (!['execute_project_command','inspect_project_command'].includes(item.action)) return item;
  let output;
  try {output = JSON.parse(item.output || '{}');} catch (_) {output = {};}
  const id = item.shell_id || output.id;
  if (typeof id !== 'string') return item;
  const snapshot = activity.conversations.get(state.activeConversationId)?.shells.get(id);
  if (!snapshot) return item;
  if (Number.isFinite(output.revision) && Number.isFinite(snapshot.revision) && output.revision > snapshot.revision) return item;
  if (['completed','failed','cancelled'].includes(output.status) && ['running','stopping'].includes(snapshot.status)) return item;
  return {...item, shell_id:id, status:snapshot.status, output:JSON.stringify(snapshot)};
}

function updateProgressRow(row, original, live, last) {
  row._progressItem = original;row._progressLive = live;row._progressLast = last;
  const item = shellProgressItem(original);
    row.querySelector('.turn-step__label').textContent = progressLabel(item);
    const status = item.status || (live && last && item.kind === 'reasoning' ? 'running' : 'completed');
    row.dataset.status = status;row.dataset.kind = item.kind;
    row.querySelector('.turn-step__status').textContent = item.kind === 'approval' ? approvalLabel(item) : t(`progress.${status}`);
    row.querySelector('.turn-step__label').classList.toggle('is-working-text',live && ['running','reviewing'].includes(status));
    const text = item.kind === 'reasoning' ? item.text || '' : item.kind === 'approval' ? [item.reason && (item.reason === 'review_unavailable' ? t('permissions.review_unavailable') : item.reason),JSON.stringify(item.action,null,2)].filter(Boolean).join('\n\n') : [item.arguments && JSON.stringify(item.arguments,null,2),item.output].filter(Boolean).join('\n\n');
    if (row.lastElementChild.textContent !== text) row.lastElementChild.textContent = text;
}

function refreshShellProgress(conversationId) {
  if (conversationId !== state.activeConversationId) return;
  document.querySelectorAll('#messages .turn-step').forEach(row => {
    if (row._progressItem) updateProgressRow(row, row._progressItem, row._progressLive, row._progressLast);
  });
}

function progressHistory(items, live = false, existing = null) {
  const details = existing || document.createElement('details');details.className = 'turn-history';
  if (!existing) {
    const summary = document.createElement('summary');
    const timer = document.createElement('span');timer.className = 'thinking__timer';timer.hidden = true;
    summary.append(progressIcon({kind:'reasoning'}), document.createElement('span'), timer, icon('chevron'));
    summary.onclick = event => {if (!details.lastElementChild.children.length) event.preventDefault();};
    const list = document.createElement('div');list.className = 'turn-history__list';details.append(summary,list);
  }
  details.querySelector(':scope > summary > span').textContent = t('progress.history') + (items.length ? ` · ${items.length}` : '');
  details.querySelector(':scope > summary').setAttribute('aria-disabled', String(!items.length));
  details.querySelector('.thinking__timer').hidden = true;
  const list = details.lastElementChild;
  const rows = items.map((item,index) => {
    const key = item.id || `reasoning-${index}`;
    let row = [...list.children].find(el => el.dataset.stepId === key);
    if (!row) {
      row = document.createElement('details');row.className = 'turn-step';row.dataset.stepId = key;
      const title = document.createElement('summary');
      const label = document.createElement('span');label.className = 'turn-step__label';
      const status = document.createElement('span');status.className = 'turn-step__status';title.append(progressIcon(item),label,status);row.append(title,document.createElement(item.kind === 'reasoning' ? 'p' : 'pre'));
    }
    updateProgressRow(row, item, live, index === items.length - 1);
    return row;
  });
  reconcileChildren(list,rows);details.toggleAttribute('data-live-history',live);return details;
}

function renderTurnBody(body, message, live = false) {
  const existing = new Map([...body.children].map(el => [el.dataset.partKey,el]));
  let offset = 0, group = [], groupOffset = 0;
  const nodes = [];
  const appendText = text => {
    if (!text) return;
    const key = `text-${offset}`;
    const part = existing.get(key) || document.createElement('div');part.className = 'turn-text';part.dataset.partKey = key;
    if (part._raw !== text) {
      part._raw = text;part.innerHTML = markdownHTML(text);
      part.querySelectorAll('a').forEach(link => {
        link.rel = 'noopener noreferrer';
        link.onclick = async event => {event.preventDefault();if (!/^https?:$/.test(link.protocol)) return;
          try {await invoke('open_external_url',{url:link.href});} catch (_) {composerStatus(t('chat.link_failed'));}};
      });
    }
    nodes.push(part);
  };
  const flush = () => {
    if (!group.length) return;
    const key = `group-${groupOffset}`;
    const history = progressHistory(group,live && message.content.length <= groupOffset,existing.get(key));history.dataset.partKey = key;
    history.dataset.historyKey = key;nodes.push(history);group = [];
  };
  for (const item of message.activity || []) {
    if (!['tool','reasoning','approval'].includes(item.kind)) continue;
    const position = Math.max(offset,Math.min(message.content.length,item.offset || 0));
    if (position > offset) {flush();appendText(message.content.slice(offset,position));offset = position;}
    if (!group.length) groupOffset = position;
    group.push(item);
  }
  flush();appendText(message.content.slice(offset));
  if (live) {
    let history = nodes.findLast(node => node.classList.contains('turn-history'));
    if (!history) {
      history = progressHistory([], true, existing.get('group-0'));history.dataset.partKey = 'group-0';
      nodes.unshift(history);
    }
    history.toggleAttribute('data-live-history', true);
    const latest = message.activity?.at(-1);
    history.dataset.phase = latest?.kind === 'approval' && latest.status === 'pending' ? 'waiting' : 'working';
    history.querySelector('.thinking__timer').hidden = false;
  }
  reconcileChildren(body,nodes);
  if (live) updateThinkingTimer();
}

function renderThinkingStatus() {
  renderPermissionRequests();
  updateThinkingTimer();
}

function updateLiveTurn() {
  // Keep queued-message actions stationary; incoming deltas remain buffered.
  if (treeMenuTrigger?.closest('.msg--queued')) return;
  const run = state.runs.get(state.activeConversationId);
  if (!run?.pending) return;
  const stream = run.stream ||= {content:'', shown:0, activity:[], frame:null};
  const body = $('#messages .msg--stream .msg__text');
  if (!stream || !body) return;
  const box = $('#messages'), follow = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  renderTurnBody(body, {content:stream.content.slice(0, stream.shown), activity:stream.activity.filter(item => (item.offset || 0) <= stream.shown)}, true);
  if (follow) box.scrollTop = box.scrollHeight;
}

function revealTurn(run) {
  const stream = run.stream;
  if (!stream || stream.frame) return;
  let previous = performance.now();
  const tick = now => {
    stream.frame = null;
    const remaining = stream.content.length - stream.shown;
    const step = progressMotion.matches ? remaining : Math.max(1, Math.ceil(Math.min(now - previous, 64) * Math.max(0.12, remaining / 700)));
    stream.shown = Math.min(stream.content.length, stream.shown + step);
    // Do not render half of a surrogate pair.
    if (stream.shown < stream.content.length && /[\uD800-\uDBFF]/.test(stream.content[stream.shown - 1])) stream.shown++;
    previous = now;
    if (state.runs.get(state.activeConversationId) === run && (!stream.lastPaint || now - stream.lastPaint >= 40 || stream.shown === stream.content.length)) {updateLiveTurn();stream.lastPaint = now;}
    if (stream.shown < stream.content.length) stream.frame = requestAnimationFrame(tick);
    else {stream.resolve?.();stream.resolve = null;}
  };
  stream.frame = requestAnimationFrame(tick);
}

async function finishLiveTurn(run) {
  if (!run.stream || run.stream.shown >= run.stream.content.length) return;
  if (document.hidden) {cancelAnimationFrame(run.stream.frame);run.stream.frame = null;run.stream.shown = run.stream.content.length;return;}
  await new Promise(resolve => {run.stream.resolve = resolve;revealTurn(run);});
}

const remoteTurnSync = {busy:false};

function releaseRemoteTurn(id) {
  if (!state.runs.get(id)?.remote) return;
  state.runs.delete(id);
  stopTimer();
}

async function refreshRemoteTurn() {
  const id = state.activeConversationId, owner = state.config?.firebase_email;
  const current = state.runs.get(id);
  if (!id || !owner || remoteTurnSync.busy || state.loadingConversation || (current?.pending && !current.remote)) return;
  remoteTurnSync.busy = true;
  const stillActive = () => state.activeConversationId === id && state.config?.firebase_email === owner;
  try {
    const snapshot = await invoke('remote_chat_snapshot', {conversation_id:id});
    if (!stillActive()) return;
    let run = state.runs.get(id);
    if (run?.pending && !run.remote) return;
    if (snapshot?.status === 'running') {
      if (!run?.remote || run.turnId !== snapshot.turn_id) {
        const saved = await invoke('get_conversation', {conversation_id:id});
        if (!stillActive()) return;
        if (saved.updated_at > snapshot.started_at) return;
        run = {pending:true, remote:true, turnId:snapshot.turn_id, since:snapshot.started_at,
          initialMessages:structuredClone(saved.messages || []), messages:[], usage:null};
        state.runs.set(id, run);
      }
      composerStatus(t('chat.remote_running').replace('{device}', snapshot.device_name || 'AuraChat'));
      if (run.remoteUpdatedAt === snapshot.updated_at) return;
      run.remoteUpdatedAt = snapshot.updated_at;
      const base = run.initialMessages;
      const prefix = Number.isInteger(snapshot.keep_count) ? base.slice(0, snapshot.keep_count) : base;
      const user = snapshot.user_message || (snapshot.user_content ? {role:'user',content:snapshot.user_content,attachments:[]} : null);
      run.messages = [...prefix, ...(user ? [user] : []), ...(snapshot.segments || [])];
      if (run.stream?.frame) cancelAnimationFrame(run.stream.frame);
      run.stream = {content:snapshot.content || '', shown:(snapshot.content || '').length, activity:snapshot.activity || [], frame:null};
      state.messages = run.messages;
      startTimer();renderSidebar();renderMessages();updateComposerControls();
    } else if (run?.remote || (snapshot && snapshot.started_at > (findConversation(id)?.conversation.updated_at || 0))) {
      const saved = await invoke('get_conversation', {conversation_id:id});
      if (!stillActive()) return;
      const target = findConversation(id)?.conversation;if (target) Object.assign(target, saved);
      const baseline = state.persistedData && conversationInData(state.persistedData, id);
      if (baseline) Object.assign(baseline, structuredClone(saved));
      state.runs.delete(id);
      state.messages = saved.messages || [];
      if (!snapshot && run?.stream && saved.updated_at < run.since) {
        state.messages = [...run.messages, {role:'assistant',content:run.stream.content,activity:run.stream.activity}];
        composerStatus(t('chat.remote_offline'));
      } else composerStatus();
      stopTimer();renderSidebar();renderMessages();updateContextInfo();updateComposerControls();
    }
  } catch (error) {
    console.error('Remote chat sync failed', error);
    if (stillActive()) composerStatus(localizeError(error));
  } finally {
    remoteTurnSync.busy = false;
  }
}

async function setupChatProgress() {
  const pollRemote = async () => {
    if (!document.hidden) await refreshRemoteTurn();
    const watching = state.runs.get(state.activeConversationId)?.remote && state.busy;
    setTimeout(pollRemote, watching ? 3000 : 15000);
  };
  setTimeout(pollRemote, 3000);
  document.addEventListener('visibilitychange', () => {
    document.documentElement.classList.toggle('is-backgrounded',document.hidden);
    if (!document.hidden) return;
    for (const run of state.runs.values()) {
      const stream = run.stream;if (!stream) continue;
      cancelAnimationFrame(stream.frame);stream.frame = null;stream.shown = stream.content.length;
      stream.resolve?.();stream.resolve = null;
    }
  });
  await appWindow.listen('chat-progress', ({payload}) => {
    if (!payload || typeof payload.text !== 'string') return;
    const run = state.runs.get(payload.conversation_id);if (!run?.pending) return;
    const stream = run.stream ||= {content:'', shown:0, activity:[], frame:null};
    if (payload.kind === '__delta') {stream.content += payload.text;revealTurn(run);}
    else if (payload.kind === '__reasoning') {
      let item = stream.activity.at(-1);
      if (item?.kind !== 'reasoning' || item.offset !== stream.content.length) {item = {kind:'reasoning', text:'', offset:stream.content.length};stream.activity.push(item);}
      item.text += payload.text;
    } else if (payload.kind === '__activity') {
      try {
        const item = JSON.parse(payload.text);if (item.kind !== 'tool' || typeof item.id !== 'string') return;
        const previous = stream.activity.find(entry => entry.kind === 'tool' && entry.id === item.id);
        if (previous) Object.assign(previous, item);else stream.activity.push({...item, offset:stream.content.length});
      } catch (_) {return;}
    }
    else if (payload.kind === '__question_summary') {
      let message;
      try {message = JSON.parse(payload.text);} catch (_) {return;}
      if (message.role !== 'user' || typeof message.content !== 'string') return;
      if (stream.frame) {cancelAnimationFrame(stream.frame);stream.frame=null;}
      if (stream.content || stream.activity.length) {
        run.messages.push({role:'assistant',content:stream.content,activity:stream.activity});
      }
      run.messages.push(message);
      stream.content='';stream.shown=0;stream.activity=[];
    }
    else if (payload.kind === '__steering') {
      let message;
      try { message = JSON.parse(payload.text); } catch (_) { return; }
      if (!consumeQueuedGuidance(payload.conversation_id, message)) return;
      if (stream.frame) { cancelAnimationFrame(stream.frame); stream.frame = null; }
      // Keep the partial answer and show the guidance as a normal user turn in chronology.
      if (stream.content || stream.activity.length) run.messages.push({role:'assistant',content:stream.content,activity:stream.activity});
      run.messages.push({...message, guidance:true});
      stream.content = ''; stream.shown = 0; stream.activity = [];
    }
    if (state.activeConversationId === payload.conversation_id) {renderThinkingStatus();if (['__steering','__question_summary'].includes(payload.kind)) {renderMessages();} else if (payload.kind !== '__delta') {updateLiveTurn();}}
  });
  // Retain compatibility with native project events emitted by older builds.
  await appWindow.listen('project-tool-activity', ({payload}) => {
    const run = state.runs.get(payload?.conversation_id);if (!run?.pending) return;
    run.activity = `${t(payload.action === 'read_project_file' ? 'chat.reading_file' : 'chat.listing_folder')}: ${payload.path}`;
    if (state.activeConversationId === payload.conversation_id) renderThinkingStatus();
  });
}
