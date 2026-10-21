// Conversation-scoped activity. Sources come only from user-supplied material;
// native activity events are retained for the current app session.
const activity = { conversations: new Map(), visible: true, section: null, selected: null, conversationId: null, filter: 'all' };

// Artifacts are what the model produced. Model prose and raw tool output are not.
const ARTIFACT_TYPES = [
  ['image', /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico|tiff?)$/i],
  ['document', /\.(md|markdown|txt|rst|pdf|docx?|odt|rtf|epub)$/i],
  ['data', /\.(json|jsonl|csv|tsv|ya?ml|toml|ini|xml)$/i],
  ['code', /\.(m?jsx?|cjs|tsx?|py|rs|go|java|cs|cpp|cxx|cc|h|hpp|css|scss|less|html?|sh|bash|ps1|bat|cmd|rb|php|sql|lua|kt|swift|dart|vue|svelte)$/i],
  ['log', /\.log$/i],
];
const ARTIFACT_META = {
  image: {label:'activity.kind_image', glyph:'image'},
  document: {label:'activity.kind_document', glyph:'file'},
  data: {label:'activity.kind_data', glyph:'fileData'},
  code: {label:'activity.kind_code', glyph:'fileCode'},
  log: {label:'activity.kind_log', glyph:'terminal'},
  file: {label:'activity.kind_file', glyph:'file'},
};
const SHELL_STATUS_LABELS = {
  waiting:'activity.shell_waiting', reviewing:'activity.shell_reviewing', running:'activity.running',
  stopping:'activity.stopping', completed:'activity.completed', failed:'activity.failed', cancelled:'activity.cancelled',
};
const SHELL_ACTIVE = ['waiting','reviewing','running','stopping'];

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
  return { outputs: activityArtifacts(record), agents: [...activityAgentMap().values()], sources, shells: activityShells(record) };
}

// ===== Artifacts =====

function artifactType(item) {
  if (item?.kind === 'image') return 'image';
  if (item?.kind === 'document') return 'document';
  const name = String(item?.path || item?.title || '');
  for (const [type, pattern] of ARTIFACT_TYPES) if (pattern.test(name)) return type;
  return 'file';
}

function artifactMeta(item) { return ARTIFACT_META[artifactType(item)] || ARTIFACT_META.file; }

// An artifact references something the model produced; inline prose has no path or link.
function nativeArtifact(item) {
  if (!item || typeof item.title !== 'string' || !item.title) return null;
  if (!item.path && !item.url && !['image','document'].includes(item.kind)) return null;
  return item;
}

function artifactFromTool(item, agent) {
  if (item?.kind !== 'tool' || !['write_project_file','edit_project_file'].includes(item.action) || item.status !== 'completed') return null;
  try {
    const output = JSON.parse(item.output);
    if (typeof output?.path !== 'string' || !Number.isFinite(output.written_bytes)) return null;
    const path = output.path;
    return { id:`file:${path}`, title:path.split(/[\\/]/).at(-1) || path, kind:'file', path,
      bytes:output.written_bytes, sha256:output.file_sha256, action:item.action, agent };
  } catch (_) { /* Non-file tool output is not an artifact. */ }
  return null;
}

// Files the running turn is writing right now, so the panel answers "what is it doing".
function activityLiveTools() {
  const run = state.runs?.get(state.activeConversationId);
  if (!run?.pending) return [];
  return (run.stream?.activity || []).filter(item => item?.kind === 'tool');
}

function artifactName(item) { return (item?.path || '').split(/[\\/]/).at(-1) || ''; }

function activityArtifacts(record) {
  const artifacts = new Map();
  const add = item => {
    if (!item) return;
    const previous = artifacts.get(item.id);
    artifacts.set(item.id, previous ? {...previous, ...item} : item);
  };
  for (const message of state.messages) {
    if (message.role !== 'assistant') continue;
    for (const entry of message.activity || []) {
      if (entry.kind === 'agent') {
        for (const item of entry.activity || []) add(artifactFromTool(item, entry.title));
        continue;
      }
      add(artifactFromTool(entry, null));
    }
  }
  for (const [, item] of record?.outputs || []) add(nativeArtifact(item));
  const known = new Set([...artifacts.values()].map(artifactName).filter(Boolean));
  for (const item of activityLiveTools()) {
    if (item.status === 'completed') { add(artifactFromTool(item, null)); continue; }
    const relative = typeof item.arguments?.path === 'string' ? item.arguments.path : '';
    if (!relative) continue;
    const title = relative.split(/[\\/]/).at(-1) || relative;
    if (known.has(title)) continue;
    add({ id:`live:${item.id}`, title, kind:'file', path:relative, action:item.action, pending:true });
  }
  return [...artifacts.values()];
}

function formatNumber(value, digits = 1) {
  const text = Number(value).toFixed(digits);
  return typeof lang === 'string' && lang.startsWith('it') ? text.replace('.', ',') : text;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${formatNumber(bytes / 1024)} KB`;
  return `${formatNumber(bytes / 1048576)} MB`;
}

function artifactBytes(item) {
  if (Number.isFinite(item?.bytes)) return item.bytes;
  const match = /^(\d+)\s*bytes$/i.exec(item?.summary || '');
  return match ? Number(match[1]) : null;
}

function artifactSummary(item) {
  if (item.pending) return t('activity.creating');
  const parts = [];
  if (item.action === 'edit_project_file') parts.push(t('activity.action_updated'));
  else if (item.action === 'write_project_file') parts.push(t('activity.action_created'));
  const size = formatBytes(artifactBytes(item));
  if (size) parts.push(size);
  if (item.agent) parts.push(`${t('activity.created_by')} ${item.agent}`);
  if (!parts.length) parts.push(t(artifactMeta(item).label));
  return parts.join(' · ');
}

function artifactLead(item) {
  if (artifactType(item) === 'image' && item.url) {
    const url = safeActivityURL(item.url);
    if (url) {
      const thumb = document.createElement('img');
      thumb.className = 'activity-thumb';thumb.alt = '';thumb.src = url;thumb.setAttribute('aria-hidden', 'true');
      return thumb;
    }
  }
  const glyph = activityText('span', '', 'activity-glyph');
  glyph.dataset.kind = artifactType(item);glyph.setAttribute('aria-hidden', 'true');
  glyph.append(icon(artifactMeta(item).glyph));
  return glyph;
}

function artifactFilters(outputs) {
  const counts = new Map();
  for (const item of outputs) { const type = artifactType(item); counts.set(type, (counts.get(type) || 0) + 1); }
  const order = ['image','document','code','data','log','file'];
  const filters = outputs.length ? [{key:'all', label:t('activity.filter_all'), count:outputs.length}] : [];
  for (const [type, count] of [...counts].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))) {
    filters.push({key:type, label:t(ARTIFACT_META[type].label), count});
  }
  return filters;
}

function artifactFilterBar(outputs) {
  const filters = artifactFilters(outputs);
  if (!filters.some(filter => filter.key === activity.filter)) activity.filter = 'all';
  const bar = activityText('div', '', 'activity-filters');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', t('activity.outputs'));
  for (const filter of filters) {
    const button = activityText('button', `${filter.label} ${filter.count}`, 'activity-filter');
    button.type = 'button';
    button.dataset.activityFocus = `filter:${filter.key}`;
    button.setAttribute('aria-pressed', String(activity.filter === filter.key));
    button.onclick = () => {activity.filter = filter.key;renderActivity();};
    bar.append(button);
  }
  return bar;
}

// ===== Shells: the session debug trail =====

function shellCommand(shell) {
  const raw = shell?.command || '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const args = Array.isArray(parsed.arguments)
        ? parsed.arguments.map(value => (/[\s"']/.test(String(value)) ? JSON.stringify(String(value)) : String(value))) : [];
      const line = [parsed.program, ...args].filter(value => typeof value === 'string' && value).join(' ');
      if (line) return line;
    }
  } catch (_) { /* Older snapshots already store a command line. */ }
  return raw;
}

function shellStatusLabel(shell) { return t(SHELL_STATUS_LABELS[shell?.status] || 'activity.running'); }

function shellDuration(shell) {
  if (!Number.isFinite(shell?.started_at)) return null;
  const finished = Number.isFinite(shell.finished_at) ? shell.finished_at : (SHELL_ACTIVE.includes(shell.status) ? Date.now() : null);
  return finished == null ? null : Math.max(0, finished - shell.started_at);
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

// Commands waiting for approval belong to the same trail as running processes.
function activityShells(record) {
  const shells = [...(record?.shells.values() || [])];
  for (const request of permissionRequests.get(state.activeConversationId)?.values() || []) {
    if (!['pending','reviewing'].includes(request.status) || request.action?.kind === 'write') continue;
    const args = Array.isArray(request.action?.arguments) ? request.action.arguments : [];
    shells.push({
      id:`approval:${request.id}`, approval:true, agent_id:request.agent_id || null, cwd:request.action?.path || '', output:'',
      status:request.status === 'reviewing' ? 'reviewing' : 'waiting',
      command:[request.action?.program, ...args].filter(Boolean).join(' '),
    });
  }
  return shells;
}

function sortShells(shells) {
  const active = shells.filter(item => SHELL_ACTIVE.includes(item.status)).sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
  const finished = shells.filter(item => !SHELL_ACTIVE.includes(item.status)).sort((a, b) => (b.finished_at || b.started_at || 0) - (a.finished_at || a.started_at || 0));
  return {active, finished, all:[...active, ...finished]};
}

// ===== Shared rendering =====

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

function activityDot(status) {
  const dot = activityText('span', '', `activity-dot activity-dot--${status}`);
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

function activityStatusPill(label, status) { return activityText('span', label, `activity-status activity-status--${status}`); }

function activityRowBase(section, item) {
  const row = document.createElement('button');row.type = 'button';row.className = 'activity-row';
  row.dataset.activityFocus = `${section}:${item.id}`;
  row.onclick = () => openActivity(section, item.id);
  return row;
}

function activityRow(item, section, compact = false) {
  if (section === 'agents') return agentRow(item, compact);
  if (section === 'shells') return shellRow(item, compact);
  if (section === 'outputs') return artifactRow(item, compact);
  return sourceRow(item, compact);
}

function sourceRow(item, compact = false) {
  const row = activityRowBase('sources', item);
  row.append(icon('file'));
  const text = activityText('span', '', 'activity-row__text');
  text.append(activityText('span', item.title, 'activity-row__title'));
  if (!compact) text.append(activityText('span', item.summary || '', 'activity-row__summary'));
  row.append(text);
  return row;
}

function artifactRow(item, compact = false) {
  const row = activityRowBase('outputs', item);
  row.classList.add('activity-row--artifact');
  if (item.pending) row.classList.add('is-pending');
  row.append(artifactLead(item));
  const text = activityText('span', '', 'activity-row__text');
  const title = activityText('span', item.title || t('activity.artifact'), 'activity-row__title');
  if (item.pending) title.classList.add('is-working-text');
  text.append(title);
  if (!compact) text.append(activityText('span', artifactSummary(item), 'activity-row__summary'));
  row.append(text);
  if (!compact) row.append(activityText('span', t(artifactMeta(item).label), 'activity-pill'));
  return row;
}

function agentLine(agent) {
  const summary = agent.summary === 'agent_cancelled' ? t('activity.cancelled') : agent.summary;
  if (summary) return summary;
  const last = agent.activity?.at(-1) || (agent.reasoning_content ? {kind:'reasoning'} : null);
  if (!last) return activityStatus(agent);
  return typeof progressLabel === 'function' ? progressLabel(last) : activityStatus(agent);
}

function agentRow(agent, compact = false) {
  const row = activityRowBase('agents', agent);
  row.classList.add('activity-row--agent');
  const orb = activityText('span', '', `agent-orb agent-orb--${agent.status}`);
  orb.append(icon('agents'));orb.setAttribute('aria-hidden', 'true');
  row.append(orb);
  const text = activityText('span', '', 'activity-row__text');
  const title = activityText('span', agent.title || t('activity.agent'), 'activity-row__title');
  title.classList.toggle('is-working-text', agent.status === 'running');
  text.append(title);
  if (!compact) text.append(activityText('span', agentLine(agent), 'activity-row__summary'));
  row.append(text);
  if (!compact) {
    const meta = activityText('span', '', 'activity-row__meta');
    meta.append(activityStatusPill(activityStatus(agent), agent.status));
    const elapsed = activityText('span', '', 'agent-elapsed');elapsed.dataset.agentId = agent.id;meta.append(elapsed);
    row.append(meta);
  }
  return row;
}

function shellRow(shell, compact = false) {
  const row = activityRowBase('shells', shell);
  row.classList.add('activity-row--shell');
  row.append(activityDot(shell.status));
  const text = activityText('span', '', 'activity-row__text');
  text.append(activityText('span', shellCommand(shell) || t('activity.shells'), 'activity-row__title activity-row__command'));
  // The status dot is decorative; assistive tech still gets the state in the compact card.
  if (compact) text.append(activityText('span', shellStatusLabel(shell), 'sr-only'));
  if (!compact) {
    const meta = activityText('span', '', 'activity-row__meta');
    meta.append(activityStatusPill(shellStatusLabel(shell), shell.status));
    const elapsed = activityText('span', '', 'shell-elapsed');elapsed.dataset.shellId = shell.id;meta.append(elapsed);
    text.append(meta);
  }
  row.append(text);
  return row;
}

function orderedItems(section, items) {
  if (section === 'outputs') return [...items.outputs].reverse();
  if (section === 'shells') return sortShells(items.shells).all;
  return items[section];
}

function openActivity(section, selected = null) {
  if (activity.section !== section || activity.selected !== selected) $('#activity-panel-content').scrollTop = 0;
  if (section !== 'outputs') activity.filter = 'all';
  activity.visible = true;activity.section = section;activity.selected = selected;renderActivity();
  $('#activity-panel-title').focus();
}

function closeActivityPanel() {
  activity.section = null;activity.selected = null;activity.filter = 'all';renderActivity();$('#activity-toggle').focus();
}

function renderActivity() {
  if (!$('#activity-dock')) return;
  const focusKey = document.activeElement?.dataset.activityFocus;
  const restoreFocus = () => {
    if (focusKey) [...$('#activity-dock').querySelectorAll('[data-activity-focus]')].find(el => el.dataset.activityFocus === focusKey)?.focus({preventScroll:true});
  };
  if (activity.conversationId !== state.activeConversationId) {
    activity.conversationId = state.activeConversationId;activity.selected = null;activity.filter = 'all';
    if (activity.section === 'shells') activity.section = null;
    if (state.activeConversationId) {refreshActivityShells(state.activeConversationId);refreshPermissionRequests(state.activeConversationId);refreshQuestions(state.activeConversationId);}
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
  if (items.shells.length || activity.section === 'shells') sections.push('shells');
  for (const section of sections) {
    const group = activityText('section', '', 'activity-group');
    const title = activityText('button', '', 'activity-group__title');title.type = 'button';
    title.dataset.activityFocus = `group:${section}`;
    title.append(activityText('span', t(`activity.${section}`)), activityText('span', String(items[section].length)));
    title.onclick = () => openActivity(section);group.append(title);
    if (section === 'agents' && items.agents.length) {
      const active = items.agents.filter(a => ['running','waiting'].includes(a.status));
      group.append(activityText('p', `${active.length} ${t('activity.running_count')} · ${items.agents.length} ${t('activity.total')}`, 'activity-agents-summary'));
      for (const agent of active.slice(0, 2)) group.append(agentRow(agent, true));
    } else {
      for (const item of orderedItems(section, items).slice(0, 3)) group.append(activityRow(item, section, true));
    }
    if (!items[section].length) group.append(activityText('p', t(`activity.empty_${section}`), 'activity-empty'));
    if ((['sources','agents'].includes(section) && items[section].length) || (['outputs','shells'].includes(section) && items[section].length > 3)) {
      const all = activityText('button', t(section === 'agents' ? 'activity.view_all_agents' : 'activity.view_all'), 'activity-view-all');all.type = 'button';all.onclick = () => openActivity(section);group.append(all);
      all.dataset.activityFocus = `all:${section}`;
    }
    card.append(group);
  }
  if (!activity.section) {restoreFocus();return;}
  const section = activity.section, selected = items[section].find(item => item.id === activity.selected);
  $('#activity-panel-title').textContent = selected
    ? (section === 'shells' ? shellCommand(selected) : selected.title || t(`activity.${section}`))
    : t(`activity.${section}`);
  $('#activity-back').hidden = !selected;
  const tabs = $('#activity-tabs');tabs.replaceChildren();tabs.hidden = !!selected;
  for (const name of sections) {
    const tab = activityText('button', `${t(`activity.${name}`)} · ${items[name].length}`);tab.type = 'button';
    tab.dataset.activityFocus = `tab:${name}`;
    tab.setAttribute('aria-current', String(name === section));tab.onclick = () => openActivity(name);tabs.append(tab);
  }
  const content = $('#activity-panel-content');const scroll = content.scrollTop;
  if (section === 'agents' && selected) {renderAgentDetail(content,selected);content.scrollTop = scroll;updateActivityTimers();restoreFocus();return;}
  content.dataset.agentId = '';content.replaceChildren();
  if (selected) {
    if (section === 'shells') renderShellDetail(content, selected);
    else if (section === 'outputs') renderArtifactDetail(content, selected);
    else renderReferenceDetail(content, selected);
  } else {
    if (!items[section].length) content.append(activityText('p', t(`activity.empty_${section}`), 'activity-empty'));
    if (section === 'outputs') {
      if (items.outputs.length) content.append(artifactFilterBar(items.outputs));
      const artifacts = items.outputs.filter(item => activity.filter === 'all' || artifactType(item) === activity.filter);
      for (const item of [...artifacts].reverse()) content.append(artifactRow(item));
    } else if (section === 'agents') {
      for (const [key, agents] of [['active', items.agents.filter(a => a.status === 'running' || a.status === 'waiting')], ['finished', items.agents.filter(a => a.status !== 'running' && a.status !== 'waiting')]]) {
        if (!agents.length) continue;
        content.append(activityText('h3', `${t(`activity.${key}`)} · ${agents.length}`, 'activity-list-heading'));
        for (const agent of agents) content.append(agentRow(agent));
      }
    } else if (section === 'shells') {
      const groups = sortShells(items.shells);
      for (const [key, shells] of [['active', groups.active], ['finished', groups.finished]]) {
        if (!shells.length) continue;
        content.append(activityText('h3', `${t(`activity.${key}`)} · ${shells.length}`, 'activity-list-heading'));
        for (const shell of shells) content.append(shellRow(shell));
      }
    } else for (const item of items.sources) content.append(sourceRow(item));
  }
  content.scrollTop = scroll;updateActivityTimers();restoreFocus();
}

function renderArtifactDetail(content, item) {
  const meta = activityText('div', '', 'activity-detail-meta activity-artifact-meta');
  meta.append(activityText('span', t(artifactMeta(item).label), 'activity-pill'));
  const summary = artifactSummary(item);
  if (summary) meta.append(activityText('span', summary));
  content.append(meta);
  if (item.pending) {content.append(activityText('p', t('activity.creating'), 'activity-empty'));return;}
  renderReferenceDetail(content, {...item, summary:''});
}

function renderReferenceDetail(content, item) {
  if (item.path) content.append(activityText('p', item.path, 'activity-detail-meta'));
  if (item.url) {
    const url = safeActivityURL(item.url);
    if (url) {
      if (item.kind === 'image') {
        const img = document.createElement('img');img.className = 'activity-image';img.alt = item.title;img.src = url;content.append(img);
      }
      if (/^https?:/.test(url)) {
        const open = activityText('button', t('activity.open_link'), 'activity-open-link');open.type = 'button';
        open.onclick = async () => {try {await invoke('open_external_url', {url});} catch (_) {composerStatus(t('chat.link_failed'));}};content.append(open);
      }
    }
  }
  if (item.content) {
    const body = activityText('div', '', item.plain ? 'activity-source-content' : 'markdown');
    if (item.plain) body.textContent = item.content;
    else body.innerHTML = markdownHTML(item.content);
    body.querySelectorAll('a').forEach(link => link.onclick = async e => {
      e.preventDefault();if (!/^https?:$/.test(new URL(link.href).protocol)) return;
      try {await invoke('open_external_url', {url: link.href});} catch (_) {composerStatus(t('chat.link_failed'));}
    });content.append(body);
  } else if (!item.url && !item.path) content.append(activityText('p', t('activity.no_updates'), 'activity-empty'));
}

function renderShellDetail(content, shell) {
  const meta = activityText('div', '', 'activity-detail-meta');
  meta.append(activityStatusPill(shellStatusLabel(shell), shell.status));
  const duration = shellDuration(shell);
  if (duration != null) meta.append(activityText('span', `${t('activity.duration')} ${formatDuration(duration)}`));
  if (shell.exit_code != null) meta.append(activityText('span', `${t('activity.exit_code')}: ${shell.exit_code}`));
  if (shell.agent_id) meta.append(activityText('span', `${t('activity.agent')} ${shell.agent_id}`));
  if (['running','stopping'].includes(shell.status)) {
    const stop = activityText('button', t(shell.status === 'stopping' ? 'activity.stopping' : 'activity.stop_shell'), 'activity-stop');stop.type = 'button';
    stop.dataset.activityFocus = `stop:${shell.id}`;stop.disabled = shell.status === 'stopping';
    stop.onclick = () => stopActivityShell(shell);meta.append(stop);
  }
  content.append(meta, activityText('pre', `$ ${shellCommand(shell)}`, 'activity-shell-command'));
  if (shell.cwd) content.append(activityText('p', shell.cwd, 'activity-detail-meta'));
  if (shell.approval) content.append(activityText('p', t('activity.shell_pending_note'), 'activity-detail-meta'));
  if (shell.stop_error) content.append(activityText('p', shell.stop_error, 'activity-shell-error'));
  const terminal = activityText('pre', shell.output || t('activity.no_shell_output'), 'activity-terminal');
  content.append(terminal);
  if (SHELL_ACTIVE.includes(shell.status)) requestAnimationFrame(() => {terminal.scrollTop = terminal.scrollHeight;});
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
    const head = activityText('div','','agent-detail-head');
    const orb = activityText('span','',`agent-orb agent-orb--${agent.status}`);
    orb.append(icon('agents'));orb.setAttribute('aria-hidden','true');
    const titles = activityText('div','','agent-detail-titles');
    titles.append(activityText('span', agent.title || t('activity.agent'), 'agent-detail-title'), activityText('span','','agent-detail-status'));
    head.append(orb, titles);
    const chips = activityText('div','','agent-detail-chips');
    const meta = activityText('div','','activity-detail-meta');
    const stop = activityText('button',t('activity.stop_agent'),'activity-stop');stop.type = 'button';stop.dataset.activityFocus = `stop-agent:${agent.id}`;
    meta.append(stop);
    const summary = activityText('p','','activity-detail-summary');
    const taskTitle = activityText('h3',t('activity.task'),'activity-section-title');
    const task = activityText('p',agent.task || '','activity-task');
    const historyTitle = activityText('h3',t('activity.history'),'activity-section-title agent-history-title');
    const history = activityText('div','','agent-detail-history');
    const bodyTitle = activityText('h3',t('activity.result'),'activity-section-title');
    const body = activityText('div','','markdown agent-stream-content');
    content.append(head,chips,meta,summary,taskTitle,task,historyTitle,history,bodyTitle,body);
  }
  const head = content.querySelector('.agent-detail-head');
  head.querySelector('.agent-orb').className = `agent-orb agent-orb--${agent.status}`;
  head.querySelector('.agent-detail-title').textContent = agent.title || t('activity.agent');
  const status = content.querySelector('.agent-detail-status');
  status.textContent = activityStatus(agent);status.dataset.status = agent.status;
  status.className = `agent-detail-status activity-status activity-status--${agent.status}`;
  const chips = content.querySelector('.agent-detail-chips');chips.replaceChildren();
  const tools = (agent.activity || []).filter(item => item.kind === 'tool').length;
  for (const value of [agent.model, agent.reasoning, tools ? `${tools} ${t('activity.tools')}` : '']) {
    if (value) chips.append(activityText('span', value, 'activity-chip'));
  }
  const elapsed = activityText('span','','agent-elapsed agent-detail-elapsed');elapsed.dataset.agentId = agent.id;chips.append(elapsed);
  const summary = content.querySelector('.activity-detail-summary');
  summary.textContent = agent.summary === 'agent_cancelled' ? t('activity.cancelled') : agent.summary || agentLine(agent);
  summary.classList.toggle('is-working-text',agent.status === 'running');
  const stop = content.querySelector('.activity-stop');
  stop.hidden = !['running','waiting'].includes(agent.status);stop.disabled = !!agent.stop_pending;
  stop.textContent = t(agent.stop_pending ? 'activity.stopping' : 'activity.stop_agent');stop.onclick = () => stopActivityAgent(agent);
  const list = [...(agent.reasoning_content ? [{kind:'reasoning',text:agent.reasoning_content}] : []),...(agent.activity || [])];
  const history = content.querySelector('.agent-detail-history');
  content.querySelector('.agent-history-title').hidden = !list.length;
  if (list.length) {const details = progressHistory(list,['running','waiting'].includes(agent.status),history.firstElementChild);if (!details.parentElement) history.append(details);}
  else history.replaceChildren();
  const body = content.querySelector('.agent-stream-content');
  if (body._raw !== (agent.content || '')) {body._raw = agent.content || '';body.innerHTML = markdownHTML(body._raw);
    body.querySelectorAll('a').forEach(link => link.onclick = async event => {event.preventDefault();if (!/^https?:$/.test(link.protocol)) return;try {await invoke('open_external_url',{url:link.href});}catch(_){composerStatus(t('chat.link_failed'));}});
  }
}

function updateActivityTimers() {
  const agents = activityAgentMap();
  document.querySelectorAll('.agent-elapsed').forEach(el => {
    const agent = agents?.get(el.dataset.agentId);if (!agent?.started_at) return;
    const seconds = Math.max(0, Math.floor(((agent.finished_at || Date.now()) - agent.started_at) / 1000));
    el.textContent = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  });
  const shells = activityShells(activity.conversations.get(state.activeConversationId));
  document.querySelectorAll('.shell-elapsed').forEach(el => {
    const shell = shells.find(item => item.id === el.dataset.shellId);
    const duration = shell ? shellDuration(shell) : null;
    el.textContent = duration == null ? '' : formatDuration(duration);
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
    for (const shell of shells) {
      const previous = record.shells.get(shell.id);
      if (previous && Number.isFinite(previous.revision) && Number.isFinite(shell.revision) && previous.revision > shell.revision) continue;
      record.shells.set(shell.id, Object.assign(previous || {}, shell));
    }
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
      if (collection === 'outputs' && !nativeArtifact(item)) return;
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
    refreshShellProgress(payload.conversation_id);
    if (payload.conversation_id === state.activeConversationId) renderActivity();
  });
  // Live writes become artifacts while the turn is still running.
  await appWindow.listen('chat-progress', ({payload}) => {
    if (payload?.conversation_id !== state.activeConversationId || ['__delta','__reasoning'].includes(payload?.kind)) return;
    scheduleActivityRender();
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
  setInterval(updateActivityTimers, 1000);
}
