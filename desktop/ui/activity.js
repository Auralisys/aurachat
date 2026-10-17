// Conversation-scoped activity. Sources come only from user-supplied material;
// native activity events are retained for the current app session.
const activity = { conversations: new Map(), visible: true, section: null, selected: null, conversationId: null };

function activityRecord(id) {
  if (!activity.conversations.has(id)) activity.conversations.set(id, { agents: new Map(), sources: new Map(), outputs: new Map(), shells: new Map() });
  return activity.conversations.get(id);
}

function activityItems() {
  const record = activity.conversations.get(state.activeConversationId);
  const sources = [], links = new Set();
  state.messages.forEach((message, index) => {
    if (message.role !== 'user') return;
    for (const [fileIndex, file] of (message.attachments || []).entries()) {
      sources.push({ id: `attachment-${index}-${fileIndex}`, title: file.name, summary: t('activity.attachment'), content: file.content, plain: true });
    }
    const text = document.createElement('div');text.innerHTML = markdownHTML(message.content || '');
    text.querySelectorAll('a[href]').forEach(link => {if (/^https?:$/.test(link.protocol)) links.add(link.href);});
  });
  for (const url of links) sources.push({id:`link:${url}`, title:url, summary:t('activity.user_link'), url});
  state.attachments.forEach((file, index) => sources.push({ id: `draft-${index}`, title: file.name, summary: t('activity.draft'), content: file.content, plain: true }));
  sources.push(...(record?.sources.values() || []));
  const outputs = new Map();
  for (const message of state.messages) {
    const events = (message.activity || []).flatMap(item => item.kind === 'agent' ? item.activity || [] : [item]);
    for (const item of events) {
      if (item.kind !== 'tool' || !['write_project_file','edit_project_file'].includes(item.action) || item.status !== 'completed') continue;
      try {
        const output = JSON.parse(item.output);
        if (typeof output.path !== 'string' || !Number.isFinite(output.written_bytes)) continue;
        const id = `file:${output.path}`;outputs.set(id,{id,title:output.path.split(/[\\/]/).at(-1),kind:'file',path:output.path,summary:`${output.written_bytes} bytes`});
      } catch (_) { /* Non-file tool output is not an artifact. */ }
    }
  }
  for (const [id,item] of record?.outputs || []) outputs.set(id,item);
  return { outputs: [...outputs.values()], agents: [...activityAgentMap().values()], sources,
    shells: [...(record?.shells.values() || [])] };
}

function activityAgentMap() {
  const agents = new Map();
  for (const message of state.messages) {
    if (message.role !== 'assistant') continue;
    for (const item of message.activity || []) if (item.kind === 'agent' && typeof item.id === 'string') agents.set(item.id, item);
  }
  for (const [id, agent] of activity.conversations.get(state.activeConversationId)?.agents || []) agents.set(id, agent);
  return agents;
}

function activityText(tag, text, className) {
  const el = document.createElement(tag);el.textContent = text;
  if (className) el.className = className;
  return el;
}

function activityButton(label, glyph, action) {
  const button = document.createElement('button');button.type = 'button';button.className = 'icon-button';
  button.title = label;button.setAttribute('aria-label', label);button.append(icon(glyph));button.onclick = action;return button;
}

function activityStatus(agent) { return t(`activity.${agent.status}`); }

function activityRow(item, section, compact = false) {
  const row = document.createElement('button');row.type = 'button';row.className = 'activity-row';
  row.dataset.activityFocus = `${section}:${item.id}`;
  if (section === 'agents') {
    const orb = activityText('span', '', `agent-orb agent-orb--${item.status}`);orb.append(icon('agents'));orb.setAttribute('aria-hidden', 'true');row.append(orb);
  } else row.append(icon(section === 'sources' ? 'file' : section === 'shells' ? 'terminal' : 'compose'));
  const text = activityText('span', '', 'activity-row__text');
  const title = activityText('span',item.title,'activity-row__title');title.classList.toggle('is-working-text',section === 'agents' && item.status === 'running');text.append(title);
  if (!compact) text.append(activityText('span', item.summary || (['agents','shells'].includes(section) ? activityStatus(item) : ''), 'activity-row__summary'));
  row.append(text);
  if (section === 'agents' && !compact) {
    const meta = activityText('span', '', 'activity-row__meta');
    meta.append(activityText('span', activityStatus(item)));
    const elapsed = activityText('span', '', 'agent-elapsed');elapsed.dataset.agentId = item.id;meta.append(elapsed);row.append(meta);
  }
  row.onclick = () => openActivity(section, item.id);return row;
}

function openActivity(section, selected = null) {
  if (activity.section !== section || activity.selected !== selected) $('#activity-panel-content').scrollTop = 0;
  activity.visible = true;activity.section = section;activity.selected = selected;renderActivity();
  $('#activity-panel-title').focus();
}

function closeActivityPanel() {
  activity.section = null;activity.selected = null;renderActivity();$('#activity-toggle').focus();
}

function renderActivity() {
  if (!$('#activity-dock')) return;
  const focusKey = document.activeElement?.dataset.activityFocus;
  const restoreFocus = () => {
    if (focusKey) [...$('#activity-dock').querySelectorAll('[data-activity-focus]')].find(el => el.dataset.activityFocus === focusKey)?.focus({preventScroll:true});
  };
  if (activity.conversationId !== state.activeConversationId) {
    activity.conversationId = state.activeConversationId;activity.selected = null;
    if (activity.section === 'shells') activity.section = null;
    if (state.activeConversationId) {refreshActivityShells(state.activeConversationId);refreshPermissionRequests(state.activeConversationId);}
  }
  const dock = $('#activity-dock'), items = activityItems();
  const hasActivity = state.messages.some(m => ['user','assistant'].includes(m.role)) || state.busy || Object.values(items).some(list => list.length);
  const visible = activity.visible && hasActivity && !$('#view-chat').hidden;
  dock.hidden = $('#view-chat').hidden;
  dock.classList.toggle('is-visible', visible);dock.inert = !visible;
  dock.setAttribute('aria-hidden', String(!visible));
  $('#activity-toggle').hidden = !hasActivity;
  $('#activity-toggle').setAttribute('aria-expanded', String(visible));
  dock.classList.toggle('is-panel', !!activity.section);
  $('#activity-card').hidden = !!activity.section;$('#activity-panel').hidden = !activity.section;
  const card = $('#activity-card');card.replaceChildren();
  const heading = activityText('div', '', 'activity-card__header');
  heading.append(activityText('span', t('activity.title')), activityButton(t('activity.hide'), 'minimize', () => {
    activity.visible = false;renderActivity();$('#activity-toggle').focus();
  }));card.append(heading);
  const sections = ['outputs', 'agents', 'sources'];
  const runningShells = items.shells.filter(s => ['running','stopping'].includes(s.status));
  if (runningShells.length || activity.section === 'shells') sections.push('shells');
  for (const section of sections) {
    const group = activityText('section', '', 'activity-group');
    const title = activityText('button', '', 'activity-group__title');title.type = 'button';
    title.dataset.activityFocus = `group:${section}`;
    const groupItems = section === 'shells' ? runningShells : items[section];
    title.append(activityText('span', t(`activity.${section}`)), activityText('span', String(groupItems.length)));
    title.onclick = () => openActivity(section);group.append(title);
    if (section === 'agents' && items.agents.length) {
      const active = items.agents.filter(a => ['running','waiting'].includes(a.status)).length;
      const summary = activityText('button', '', 'activity-agents-summary');summary.type = 'button';
      summary.dataset.activityFocus = 'agents-summary';
      const glyph = activityText('span','',`agent-orb${active ? ' agent-orb--running' : ''}`);glyph.append(icon('agents'));
      summary.append(glyph, document.createTextNode(`${active} ${t('activity.running_count')} · ${items.agents.length} ${t('activity.total')}`));
      summary.onclick = () => openActivity('agents');group.append(summary);
    } else {
      for (const item of groupItems.slice(-3)) group.append(activityRow(item, section, section !== 'shells'));
    }
    if (!items[section].length) group.append(activityText('p', t(`activity.empty_${section}`), 'activity-empty'));
    if ((section === 'sources' && items.sources.length) || (section === 'outputs' && items.outputs.length > 3)) {
      const all = activityText('button', t('activity.view_all'), 'activity-view-all');all.type = 'button';all.onclick = () => openActivity(section);group.append(all);
      all.dataset.activityFocus = `all:${section}`;
    }
    card.append(group);
  }
  if (!activity.section) {restoreFocus();return;}
  const section = activity.section, selected = items[section].find(item => item.id === activity.selected);
  $('#activity-panel-title').textContent = selected?.title || t(`activity.${section}`);
  $('#activity-back').hidden = !selected;
  const tabs = $('#activity-tabs');tabs.replaceChildren();tabs.hidden = !!selected;
  for (const name of sections) {
    const tab = activityText('button', `${t(`activity.${name}`)} · ${items[name].length}`);tab.type = 'button';
    tab.dataset.activityFocus = `tab:${name}`;
    tab.setAttribute('aria-current', String(name === section));tab.onclick = () => openActivity(name);tabs.append(tab);
  }
  const content = $('#activity-panel-content');const scroll = content.scrollTop;
  if (section === 'agents' && selected) {renderAgentDetail(content,selected);content.scrollTop = scroll;updateAgentTimers();restoreFocus();return;}
  content.dataset.agentId = '';content.replaceChildren();
  if (selected) {
    if (section === 'agents') {
      const meta = activityText('div', '', 'activity-detail-meta');
      meta.append(activityText('span', activityStatus(selected)), activityText('span', [selected.model, selected.reasoning].filter(Boolean).join(' · ')));content.append(meta);
      if (selected.summary) content.append(activityText('p', selected.summary, 'activity-detail-summary'));
      if (selected.task) {content.append(activityText('h3', t('activity.task')), activityText('p', selected.task, 'activity-task'));}
    } else if (section === 'shells') {
      const meta = activityText('div', '', 'activity-detail-meta');
      meta.append(activityText('span', activityStatus(selected)));
      if (selected.exit_code != null) meta.append(activityText('span', `${t('activity.exit_code')}: ${selected.exit_code}`));
      if (['running','stopping'].includes(selected.status)) {
        const stop = activityText('button', t(selected.status === 'stopping' ? 'activity.stopping' : 'activity.stop_shell'), 'activity-stop');stop.type = 'button';
        stop.dataset.activityFocus = `stop:${selected.id}`;stop.disabled = selected.status === 'stopping';
        stop.onclick = () => stopActivityShell(selected);meta.append(stop);
      }
      content.append(meta, activityText('pre', selected.command || '', 'activity-shell-command'));
      if (selected.cwd) content.append(activityText('p', selected.cwd, 'activity-detail-meta'));
      if (selected.stop_error) content.append(activityText('p', selected.stop_error, 'activity-shell-error'));
    } else content.append(activityText('p', selected.summary || '', 'activity-detail-meta'));
    if (selected.path) content.append(activityText('p', selected.path, 'activity-detail-meta'));
    if (selected.url) {
      const url = safeActivityURL(selected.url);
      if (url) {
        if (selected.kind === 'image') {
          const img = document.createElement('img');img.className = 'activity-image';img.alt = selected.title;img.src = url;content.append(img);
        }
        if (/^https?:/.test(url)) {
          const open = activityText('button', t('activity.open_link'), 'activity-open-link');open.type = 'button';
          open.onclick = async () => {try {await invoke('open_external_url', {url});} catch (_) {composerStatus(t('chat.link_failed'));}};content.append(open);
        }
      }
    }
    if (selected.content || section === 'shells') {
      if (section === 'shells') {
        content.append(activityText('pre', selected.output || t('activity.no_shell_output'), 'activity-terminal'));
      } else {
      const body = activityText('div', '', selected.plain ? 'activity-source-content' : 'markdown');
      if (selected.plain) body.textContent = selected.content;
      else body.innerHTML = markdownHTML(selected.content);
      body.querySelectorAll('a').forEach(link => link.onclick = async e => {
        e.preventDefault();if (!/^https?:$/.test(new URL(link.href).protocol)) return;
        try {await invoke('open_external_url', {url: link.href});} catch (_) {composerStatus(t('chat.link_failed'));}
      });content.append(body);
      }
    } else if (!selected.url && !selected.path) content.append(activityText('p', t('activity.no_updates'), 'activity-empty'));
  } else {
    if (!items[section].length) content.append(activityText('p', t(`activity.empty_${section}`), 'activity-empty'));
    if (section === 'agents') {
      for (const [key, agents] of [['active', items.agents.filter(a => a.status === 'running' || a.status === 'waiting')], ['finished', items.agents.filter(a => a.status !== 'running' && a.status !== 'waiting')]]) {
        if (!agents.length) continue;
        content.append(activityText('h3', `${t(`activity.${key}`)} · ${agents.length}`, 'activity-list-heading'));
        for (const agent of agents) content.append(activityRow(agent, section));
      }
    } else for (const item of items[section]) content.append(activityRow(item, section));
  }
  content.scrollTop = scroll;updateAgentTimers();restoreFocus();
}

let activityRenderFrame = null;
function scheduleActivityRender() {
  if (activityRenderFrame) return;
  activityRenderFrame = requestAnimationFrame(() => {activityRenderFrame = null;renderActivity();});
}

async function stopActivityAgent(agent) {
  if (!['running','waiting'].includes(agent.status) || agent.stop_pending) return;
  const conversationId = state.activeConversationId;
  agent.stop_pending = true;renderActivity();
  try {await invoke('stop_subagent',{conversation_id:conversationId,id:agent.id});}
  catch(e) {agent.stop_pending = false;composerStatus(localizeError(e));if (state.activeConversationId === conversationId) renderActivity();}
}

function renderAgentDetail(content, agent) {
  if (content.dataset.agentId !== agent.id) {
    content.dataset.agentId = agent.id;content.replaceChildren();
    const meta = activityText('div','','activity-detail-meta');
    meta.append(activityText('span','','agent-detail-status'),activityText('span',agent.model || ''));
    const stop = activityText('button',t('activity.stop_agent'),'activity-stop');stop.type = 'button';stop.dataset.activityFocus = `stop-agent:${agent.id}`;meta.append(stop);
    const summary = activityText('p','','activity-detail-summary');
    const taskTitle = activityText('h3',t('activity.task'));
    const task = activityText('p',agent.task || '','activity-task');
    const history = activityText('div','','agent-detail-history');
    const body = activityText('div','','markdown agent-stream-content');content.append(meta,summary,taskTitle,task,history,body);
  }
  const status = content.querySelector('.agent-detail-status');status.textContent = activityStatus(agent);status.dataset.status = agent.status;
  const summary = content.querySelector('.activity-detail-summary');summary.textContent = agent.summary === 'agent_cancelled' ? t('activity.cancelled') : agent.summary || t('activity.no_updates');summary.classList.toggle('is-working-text',agent.status === 'running');
  const stop = content.querySelector('.activity-stop');stop.hidden = !['running','waiting'].includes(agent.status);stop.disabled = !!agent.stop_pending;stop.textContent = t(agent.stop_pending ? 'activity.stopping' : 'activity.stop_agent');stop.onclick = () => stopActivityAgent(agent);
  const list = [...(agent.reasoning_content ? [{kind:'reasoning',text:agent.reasoning_content}] : []),...(agent.activity || [])];
  const history = content.querySelector('.agent-detail-history');
  if (list.length) {const details = progressHistory(list,['running','waiting'].includes(agent.status),history.firstElementChild);if (!details.parentElement) history.append(details);}
  else history.replaceChildren();
  const body = content.querySelector('.agent-stream-content');
  if (body._raw !== (agent.content || '')) {body._raw = agent.content || '';body.innerHTML = markdownHTML(body._raw);
    body.querySelectorAll('a').forEach(link => link.onclick = async event => {event.preventDefault();if (!/^https?:$/.test(link.protocol)) return;try {await invoke('open_external_url',{url:link.href});}catch(_){composerStatus(t('chat.link_failed'));}});
  }
}

function updateAgentTimers() {
  const agents = activityAgentMap();
  document.querySelectorAll('.agent-elapsed').forEach(el => {
    const agent = agents?.get(el.dataset.agentId);if (!agent?.started_at) return;
    const seconds = Math.max(0, Math.floor(((agent.finished_at || Date.now()) - agent.started_at) / 1000));
    el.textContent = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  });
}

function safeActivityURL(value) {
  if (typeof value !== 'string') return null;
  if (/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value)) return value;
  try {const url = new URL(value);return ['http:','https:'].includes(url.protocol) ? url.href : null;} catch (_) {return null;}
}

async function refreshActivityShells(conversationId) {
  try {
    const shells = await invoke('list_shells', {conversation_id:conversationId});
    if (!Array.isArray(shells)) return;
    const record = activityRecord(conversationId);
    for (const shell of shells) if (!record.shells.has(shell.id)) record.shells.set(shell.id, shell);
    if (state.activeConversationId === conversationId) renderActivity();
  } catch (_) { /* Native events remain available if a session is restoring. */ }
}

async function stopActivityShell(shell) {
  if (shell.status !== 'running') return;
  const conversationId = state.activeConversationId;
  shell.status = 'stopping';shell.stop_error = '';renderActivity();
  try {
    const result = await invoke('stop_shell', {id:shell.id, conversation_id:conversationId});
    if (result?.id === shell.id) {
      if (result.revision == null || shell.revision == null || result.revision >= shell.revision) Object.assign(shell, result);
    }
    else throw new Error(t('activity.stop_unconfirmed'));
  } catch (e) {if (shell.status === 'stopping') shell.status = 'running';shell.stop_error = localizeError(e);}
  renderActivity();
}

async function setupActivity() {
  for (const [event, collection] of [['artifact-created','outputs'], ['user-source','sources']]) {
    await appWindow.listen(event, ({payload}) => {
      if (!payload?.conversation_id || typeof payload.id !== 'string' || typeof payload.title !== 'string') return;
      const item = {id:payload.id, title:payload.title};
      for (const key of ['summary','content','path','kind']) if (typeof payload[key] === 'string') item[key] = payload[key];
      if (payload.url) item.url = safeActivityURL(payload.url);
      item.plain = payload.kind !== 'document';
      activityRecord(payload.conversation_id)[collection].set(item.id, item);
      if (payload.conversation_id === state.activeConversationId) renderActivity();
    });
  }
  await appWindow.listen('shell-activity', ({payload}) => {
    if (!payload?.conversation_id || typeof payload.id !== 'string' || !['running','stopping','completed','failed','cancelled'].includes(payload.status)) return;
    const shells = activityRecord(payload.conversation_id).shells;
    const previous = shells.get(payload.id) || {};
    if (payload.revision != null && previous.revision != null && payload.revision < previous.revision) return;
    shells.set(payload.id, Object.assign(previous, payload));
    if (payload.conversation_id === state.activeConversationId) renderActivity();
  });
  $('#activity-toggle').onclick = () => {activity.visible = !activity.visible;renderActivity();};
  $('#activity-close').onclick = closeActivityPanel;
  $('#activity-back').onclick = () => openActivity(activity.section);
  $('#activity-dock').onkeydown = e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (activity.selected) openActivity(activity.section);
    else if (activity.section) closeActivityPanel();
    else {activity.visible = false;renderActivity();$('#activity-toggle').focus();}
  };
  await appWindow.listen('agent-activity', ({payload}) => {
    if (!payload?.conversation_id || typeof payload.id !== 'string' || !['running','waiting','completed','failed','cancelled'].includes(payload.status)) return;
    const record = activityRecord(payload.conversation_id), previous = record.agents.get(payload.id);
    const agent = {...previous, id: payload.id, status: payload.status};
    if (previous && ['completed','failed','cancelled'].includes(previous.status) && ['running','waiting'].includes(payload.status)) return;
    for (const key of ['title','summary','task','content','model','reasoning','reasoning_content']) if (typeof payload[key] === 'string') agent[key] = payload[key];
    if (Array.isArray(payload.activity)) agent.activity = payload.activity;
    agent.title ||= t('activity.agent');agent.started_at = previous?.started_at || (Number.isFinite(payload.started_at) ? payload.started_at : Date.now());
    agent.finished_at = ['completed','failed','cancelled'].includes(agent.status) ? (Number.isFinite(payload.finished_at) ? payload.finished_at : previous?.finished_at || Date.now()) : null;
    record.agents.set(agent.id, agent);
    if (payload.conversation_id === state.activeConversationId) {if (['completed','failed','cancelled'].includes(agent.status)) renderActivity();else scheduleActivityRender();}
  });
  setInterval(updateAgentTimers, 1000);
}
