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
  image: {label:'activity.kind_image'},
  document: {label:'activity.kind_document'},
  data: {label:'activity.kind_data'},
  code: {label:'activity.kind_code'},
  log: {label:'activity.kind_log'},
  file: {label:'activity.kind_file'},
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
  const fileSource = (id, file, summary) => isImageAttachment(file)
    ? {id, title: file.name, summary, kind: 'image', image: file}
    : isLinkedAttachment(file)
      ? {id: `file:${file.path}`, title: file.name, summary: t('activity.linked'), path: file.path}
      : {id, title: file.name, summary, content: file.content, plain: true};
  state.messages.forEach((message, index) => {
    if (message.role !== 'user') return;
    for (const [fileIndex, file] of (message.attachments || []).entries()) {
      sources.push(fileSource(`attachment-${index}-${fileIndex}`, file, t('activity.attachment')));
    }
    const text = document.createElement('div');text.innerHTML = markdownHTML(message.content || '');
    text.querySelectorAll('a[href]').forEach(link => {if (/^https?:$/.test(link.protocol)) links.add(link.href);});
  });
  for (const url of links) sources.push({id:`link:${url}`, title:url, summary:t('activity.user_link'), url});
  state.attachments.forEach((file, index) => sources.push(fileSource(`draft-${index}`, file, t('activity.draft'))));
  sources.push(...(record?.sources.values() || []));
  // The same linked file can be attached, mentioned and previewed: keep one row, preferring the loaded preview.
  const uniqueSources = new Map();
  for (const source of sources) uniqueSources.set(source.id, source);
  return { outputs: activityArtifacts(record), agents: [...activityAgentMap().values()], sources: [...uniqueSources.values()], shells: activityShells(record) };
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
  if (item.final_output !== true) return null;
  if (!item.path && !item.url && !['image','document'].includes(item.kind)) return null;
  return item;
}

function artifactFromTool(item, agent) {
  if (item?.kind !== 'tool' || item.action !== 'publish_project_output' || item.status !== 'completed') return null;
  try {
    const output = JSON.parse(item.output);
    if (output?.final_output !== true || typeof output.path !== 'string' || !Number.isFinite(output.written_bytes)) return null;
    const path = output.path;
    return { id:`file:${path}`, title:path.split(/[\\/]/).at(-1) || path, kind:'file', path,
      bytes:output.written_bytes, sha256:output.file_sha256, action:item.action, agent };
  } catch (_) { /* Non-file tool output is not an artifact. */ }
  return null;
}

// Completed publication tools are visible before the full turn is saved.
function activityLiveTools() {
  const run = state.runs?.get(state.activeConversationId);
  if (!run?.pending) return [];
  return (run.stream?.activity || []).filter(item => item?.kind === 'tool');
}

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
  for (const item of activityLiveTools()) {
    if (item.status === 'completed') add(artifactFromTool(item, null));
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
  glyph.append(fileIcon(item));
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

// Matches the 15s after which the native runner hands a command back as a background process.
const SHELL_BACKGROUND_MS = 15000;

// Commands waiting for approval belong to the same trail as running processes; short finished commands are noise.
function activityShells(record) {
  const shells = [...(record?.shells.values() || [])].filter(shell => (panelShows('shells') && shell.id === activity.selected) || SHELL_ACTIVE.includes(shell.status) || (shellDuration(shell) ?? 0) >= SHELL_BACKGROUND_MS);
  for (const request of permissionRequests.get(state.activeConversationId)?.values() || []) {
    if (!['pending','reviewing'].includes(request.status) || request.action?.kind !== 'command') continue;
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

function activityRowBase(section, {id}) {
  const row = document.createElement('button');row.type = 'button';row.className = 'activity-row';
  row.dataset.activityFocus = `${section}:${id}`;
  row.onclick = () => openActivity(section, id);
  return row;
}

function activityRow(item, section, compact = false) {
  if (section === 'shells') return shellRow(item, compact);
  if (section === 'outputs') return artifactRow(item, compact);
  return sourceRow(item, compact);
}

function sourceRow(item, compact = false) {
  const row = activityRowBase('sources', item);
  const web = /^https?:/.test(safeActivityURL(item.url) || '') && item.kind !== 'image';
  if (item.path) {row.title = displayFilePath(item.path);row.onclick = () => openProjectFile(item.path);}
  if (web) {
    row.classList.add('activity-row--link');row.title = item.url;
    row.onclick = event => openLink(item.url, event);
  }
  row.append(web ? icon('globe') : fileIcon(item));
  const text = activityText('span', '', 'activity-row__text');
  text.append(activityText('span', item.title, 'activity-row__title'));
  if (!compact) text.append(activityText('span', web ? `${item.summary || ''} · ${new URL(item.url).hostname}` : item.summary || '', 'activity-row__summary'));
  row.append(text);
  if (web) row.append(icon('external'));
  return row;
}

function artifactRow(item, compact = false) {
  const row = activityRowBase('outputs', item);
  row.title = item.path ? displayFilePath(item.path) : item.title;
  if (item.path && !item.pending) row.onclick = () => openProjectFile(item.path);
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

function agentOrb(status) {
  const orb = activityText('span', '', `agent-orb agent-orb--${status}`);
  orb.setAttribute('aria-hidden', 'true');
  return orb;
}

function agentElapsed(agent, className = '') {
  const elapsed = activityText('span', '', `agent-elapsed ${className}`.trim());
  elapsed.dataset.agentId = agent.id;
  return elapsed;
}

// The orb carries the state visually; assistive tech reads the label instead.
function agentRow(agent, compact, previous) {
  const row = previous.get(`agents:${agent.id}`) || activityRowBase('agents', agent);
  if (!row.firstChild) {
    row.classList.add('activity-row--agent');
    const text = activityText('span', '', 'activity-row__text');
    text.append(activityText('span', '', 'activity-row__title'), activityText('span', '', 'sr-only'));
    row.append(agentOrb(agent.status), text);
    if (!compact) row.append(agentElapsed(agent));
  }
  const [orb, text] = row.children, [title, status] = text.children;
  const name = agent.title || t('activity.agent'), label = activityStatus(agent), orbClass = `agent-orb agent-orb--${agent.status}`;
  if (orb.className !== orbClass) orb.className = orbClass;
  if (title.textContent !== name) title.textContent = name;
  if (status.textContent !== label) status.textContent = label;
  title.classList.toggle('is-working-text', agent.status === 'running');
  return row;
}

function countLabel(key, count) {
  return t(`${key}_${count === 1 ? 'one' : 'many'}`).replace('{count}', String(count));
}

function activityRowMap(parent) {
  return new Map(Array.from(parent.children, el => [el.dataset.activityFocus, el]));
}

function renderAgentSummary(group, header, agents) {
  const previous = activityRowMap(group);
  const active = agents.filter(agent => ['running','waiting'].includes(agent.status));
  const nodes = [group.firstElementChild?.isEqualNode(header) ? group.firstElementChild : header,
    ...active.slice(0, 2).map(agent => agentRow(agent, true, previous))];
  const lines = [];
  if (active.length > 2) lines.push(['running', t('activity.more_running').replace('{count}', String(active.length - 2))]);
  for (const status of ['completed','failed','cancelled']) {
    const count = agents.filter(agent => agent.status === status).length;
    if (count) lines.push([status, countLabel(`activity.${status}`, count)]);
  }
  if (lines.length) {
    const summary = activityText('button', '', 'activity-agents-summary');summary.type = 'button';
    summary.dataset.activityFocus = 'all:agents';summary.onclick = () => openActivity('agents');
    for (const [status, label] of lines) {
      const line = activityText('span', '', 'agent-status-line');
      line.append(agentOrb(status), activityText('span', label));
      summary.append(line);
    }
    const old = previous.get('all:agents');
    if (old) syncActivityChildren(old, summary);
    nodes.push(old || summary);
  }
  reconcileActivityList(group, nodes);
}

// Images read faster as thumbnails; documents and links keep their rows.
function renderSourceSummary(group, sources) {
  const images = sources.filter(item => item.kind === 'image' && (item.image || safeActivityURL(item.url)));
  if (images.length) {
    const strip = activityText('div', '', 'activity-thumbs');
    for (const item of images.slice(0, 4)) {
      const thumb = activityText('button', '', 'activity-thumbs__item');thumb.type = 'button';
      thumb.dataset.activityFocus = `sources:${item.id}`;thumb.title = item.title;thumb.setAttribute('aria-label', item.title);
      thumb.onclick = () => openActivity('sources', item.id);
      const img = document.createElement('img');img.alt = '';img.decoding = 'async';
      img.src = item.image ? imageURL(item.image) || '' : safeActivityURL(item.url);
      thumb.append(img);strip.append(thumb);
    }
    if (images.length > 4) strip.append(activityText('span', `+${images.length - 4}`, 'activity-thumbs__more'));
    group.append(strip);
  }
  for (const item of sources.filter(item => !images.includes(item)).slice(0, 3)) group.append(sourceRow(item, true));
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
  openPanelSection(section, selected);
}

function closeActivityPanel() {
  closePanelTab();
}

// Remove obsolete siblings first so a surviving, pressed button need not move.
function reconcileActivityList(parent, nodes) {
  const keep = new Set(nodes);
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
  reconcileChildren(parent, nodes);
}

// Reconcile the small, button-based activity lists by identity, not by position.
// A sibling arriving, a changing counter or shell output must not cancel a press.
function syncActivityChildren(parent, next) {
  const key = el => el.dataset.activityFocus || el.dataset.activityGroup || `${el.tagName}:${el.classList[0] || ''}`;
  const previous = new Map();
  for (const el of parent.children) {
    const k = key(el);
    if (!previous.has(k)) previous.set(k, []);
    previous.get(k).push(el);
  }
  const nodes = [...next.children].map(el => {
    const old = previous.get(key(el))?.shift();
    if (!old || old.tagName !== el.tagName || old.namespaceURI !== el.namespaceURI) return el;
    if (el.onclick) old.onclick = el.onclick;
    if (old.isEqualNode(el)) return old;
    for (const attr of [...old.attributes]) if (!el.hasAttribute(attr.name)) old.removeAttribute(attr.name);
    for (const attr of el.attributes) if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value);
    if (el.childElementCount) syncActivityChildren(old, el);
    else if (!old.matches('.shell-elapsed,.agent-elapsed')) old.textContent = el.textContent;
    return old;
  });
  reconcileActivityList(parent, nodes);
}

function renderActivity() {
  if (!$('#activity-dock')) return;
  resetPanelAccount();
  if (activity.press?.button.isConnected && activity.press.conversation === state.activeConversationId && activity.press.owner === browserPage.owner) {
    activity.press.refresh = true;return;
  }
  if (treeMenuTrigger?.closest('.activity-card, .git-panel') && !$('#tree-menu').hidden) return;
  const focused = document.activeElement, focusKey = focused?.dataset.activityFocus;
  const restoreFocus = () => {
    if (!focusKey || document.activeElement === focused) return;
    const target = focused.isConnected ? focused : [...document.querySelectorAll('#activity-dock [data-activity-focus], #activity-panel [data-activity-focus]')].find(el => el.dataset.activityFocus === focusKey);
    target?.focus({preventScroll:true});
  };
  if (activity.conversationId !== state.activeConversationId) {
    activity.conversationId = state.activeConversationId;activity.selected = null;activity.filter = 'all';
    activity.visible = true;
    for (const tab of browserPage.tabs.filter(tab => tab.section)) {tab.selected = null;tab.filter = 'all';tab.scroll = 0;}
    if (state.activeConversationId) {refreshActivityShells(state.activeConversationId);refreshPermissionRequests(state.activeConversationId);refreshQuestions(state.activeConversationId);}
  }
  activity.section = activePanelTab()?.section || null;
  renderBrowser();
  const dock = $('#activity-dock'), items = activityItems();
  const hasActivity = !!gitProject() || state.messages.some(m => ['user','assistant'].includes(m.role)) || state.busy || Object.values(items).some(list => list.length);
  const visible = activity.visible && hasActivity && !$('#view-chat').hidden;
  dock.hidden = !visible;
  dock.classList.toggle('is-visible', visible);dock.inert = !visible || $('.main').inert;
  dock.setAttribute('aria-hidden', String(!visible));
  $('#activity-toggle').hidden = !hasActivity;
  $('#activity-toggle').setAttribute('aria-expanded', String(visible));
  $('#activity-toggle').classList.toggle('is-active', visible);
  const card = document.createDocumentFragment();
  const heading = activityText('div', '', 'activity-card__header');
  const scope = activityText('span', gitProject()?.name || t('activity.title'));scope.title = scope.textContent;
  const more = activityButton(t('activity.more'), 'more', event => showTreeMenu(event.currentTarget.parentElement, event.currentTarget, t('activity.title'), [
    ['sources', 'activity.sources', () => openActivity('sources')],
    ['file', 'activity.outputs', () => openActivity('outputs')],
    ['minimize', 'activity.hide', () => {activity.visible = false;renderActivity();$('#activity-toggle').focus();}],
  ]));
  configureMenuTrigger(more, 'tree-menu');
  heading.append(scope, more);card.append(heading);
  renderGitCard(card);
  const sections = ['outputs', 'sources'];
  if (items.agents.length) sections.push('agents');
  if (items.shells.length) sections.push('shells');
  for (const section of sections) {
    const group = activityText('section', '', 'activity-group');
    group.dataset.activityGroup = section;
    const header = activityText('div', '', 'activity-group__header');
    const title = activityText('button', '', 'activity-group__title');title.type = 'button';
    title.dataset.activityFocus = `group:${section}`;
    title.append(activityText('span', t(`activity.${section}`)));
    title.onclick = () => openActivity(section);header.append(title);
    if (section === 'sources') header.append(activityButton(t('activity.add_source'), 'plus', () => $('#composer-attach').click()));
    if (section === 'outputs') header.append(activityButton(t('activity.create_output'), 'plus', () => {
      if (!composerText().trim()) setComposerText(t('activity.output_prompt'));
      autoGrow();$('#composer-input').focus();
      composerStatus(t('activity.output_hint'));
    }));
    group.append(header);
    if (section === 'sources') renderSourceSummary(group, items.sources);
    else if (section !== 'agents') for (const item of orderedItems(section, items).slice(0, 3)) group.append(activityRow(item, section, true));
    if (!items[section].length) group.append(activityText('p', t(`activity.empty_${section}`), 'activity-empty'));
    if ((section === 'sources' && items[section].length) || (['outputs','shells'].includes(section) && items[section].length > 3)) {
      const all = activityText('button', t('activity.view_all'), 'activity-view-all');all.type = 'button';all.onclick = () => openActivity(section);group.append(all);
      all.dataset.activityFocus = `all:${section}`;
    }
    card.append(group);
  }
  const mounted = $('#activity-card');
  const groupKey = el => el.dataset.activityGroup || el.className;
  const groups = new Map(Array.from(mounted.children, el => [groupKey(el), el]));
  reconcileActivityList(mounted, Array.from(card.children, el => {
    const old = groups.get(groupKey(el));
    if (el.dataset.activityGroup === 'agents') {
      renderAgentSummary(old || el, el.firstElementChild, items.agents);
      return old || el;
    }
    if (!old) return el;
    syncActivityChildren(old, el);
    return old;
  }));
  const header = $('#activity-panel .activity-panel__header');
  if (!activity.section || !browserPage.open) {restoreFocus();return;}
  const content = $('#activity-panel-content');
  if (activity.section === 'git') {
    content._reference = null;
    header.hidden = true;
    renderGitPanel($('#activity-panel-content'));restoreFocus();return;
  }
  const section = activity.section, selected = items[section].find(item => item.id === activity.selected);
  // Lists are titled by their tab; only a detail view needs its own header.
  header.hidden = !selected;
  $('#activity-panel-title').textContent = selected
    ? (section === 'shells' ? shellCommand(selected) : selected.title || t(`activity.${section}`))
    : t(`activity.${section}`);
  $('#activity-back').hidden = !selected;
  const agent = section === 'agents' ? selected : null;
  $('#activity-panel-orb').hidden = !agent;
  if (agent) $('#activity-panel-orb').className = `agent-orb agent-orb--${agent.status}`;
  const meta = $('#activity-panel-meta');
  meta.textContent = agent ? [agent.model, agent.reasoning].filter(Boolean).join(' · ') : '';
  meta.hidden = !meta.textContent;
  const stop = $('#activity-panel-stop');
  stop.hidden = !agent || !['running','waiting'].includes(agent.status);
  if (agent) {
    const label = t(agent.stop_pending ? 'activity.stopping' : 'activity.stop_agent');
    stop.disabled = !!agent.stop_pending;stop.title = label;stop.setAttribute('aria-label', label);
    stop.dataset.activityFocus = `stop-agent:${agent.id}`;stop.onclick = () => stopActivityAgent(agent);
  }
  const scroll = content.scrollTop;
  if (agent) {content._reference = null;renderAgentDetail(content,agent);content.scrollTop = scroll;updateActivityTimers();restoreFocus();return;}
  content.dataset.agentId = '';
  const next = document.createDocumentFragment();
  if (selected) {
    if (section === 'shells') {
      renderShellDetail(next, selected);syncActivityChildren(content, next);
      if (SHELL_ACTIVE.includes(selected.status)) {
        const terminal = content.querySelector('.activity-terminal');terminal.scrollTop = terminal.scrollHeight;
      }
    } else {
      const signature = [activity.conversationId, section, selected.id, selected.title, selected.path, selected.content, selected.url, selected.image, selected.note, selected.summary, selected.pending, selected.kind, artifactSummary(selected)];
      if (!content.firstChild || !signature.every((value,i) => content._reference?.[i] === value)) {
        content.replaceChildren();
        if (section === 'outputs') renderArtifactDetail(content, selected);
        else renderReferenceDetail(content, selected);
      }
      content._reference = signature;
    }
  } else {
    if (!items[section].length && section !== 'agents') next.append(activityText('p', t(`activity.empty_${section}`), 'activity-empty'));
    if (section === 'outputs') {
      if (items.outputs.length) next.append(artifactFilterBar(items.outputs));
      const artifacts = items.outputs.filter(item => activity.filter === 'all' || artifactType(item) === activity.filter);
      for (const item of [...artifacts].reverse()) next.append(artifactRow(item));
    } else if (section === 'agents') {
      const list = [], previous = activityRowMap(content);
      const active = items.agents.filter(a => ['running','waiting'].includes(a.status));
      const finished = items.agents.filter(a => !['running','waiting'].includes(a.status));
      list.push(activityText('h3', `${t('activity.active')} · ${active.length}`, 'activity-list-heading'));
      if (!active.length) list.push(activityText('p', t('activity.no_active_agents'), 'activity-empty activity-empty--list'));
      for (const item of active) list.push(agentRow(item, false, previous));
      if (finished.length) {
        list.push(activityText('h3', `${t('activity.finished')} · ${finished.length}`, 'activity-list-heading'));
        for (const item of finished) list.push(agentRow(item, false, previous));
      }
      reconcileActivityList(content, list);
    } else if (section === 'shells') {
      const groups = sortShells(items.shells);
      for (const [key, shells] of [['active', groups.active], ['finished', groups.finished]]) {
        if (!shells.length) continue;
        next.append(activityText('h3', `${t(`activity.${key}`)} · ${shells.length}`, 'activity-list-heading'));
        for (const shell of shells) next.append(shellRow(shell));
      }
    } else for (const item of items.sources) next.append(sourceRow(item));
    if (section !== 'agents') syncActivityChildren(content, next);
  }
  if (!selected || section === 'shells') content._reference = null;
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
  if (item.note) content.append(activityText('p', item.note, 'activity-empty activity-empty--note'));
  if (item.image) {
    const open = imageThumb([item.image], 0, 'activity-image-open');
    open.querySelector('img').className = 'activity-image';content.append(open);
  }
  if (item.url) {
    const url = safeActivityURL(item.url);
    if (url) {
      if (item.kind === 'image') {
        const img = document.createElement('img');img.className = 'activity-image';img.alt = item.title;img.src = url;content.append(img);
      }
      if (/^https?:/.test(url)) {
        const open = activityText('button', t('activity.open_link'), 'activity-open-link');open.type = 'button';
        open.onclick = event => openLink(url, event);content.append(open);
      }
    }
  }
  if (item.content) {
    const body = activityText('div', '', item.plain ? 'activity-source-content' : 'markdown');
    if (item.plain) body.textContent = item.content;
    else body.innerHTML = markdownHTML(item.content);
    body.querySelectorAll('a').forEach(link => link.onclick = async e => {
      e.preventDefault();if (!/^https?:$/.test(new URL(link.href).protocol)) return;
      await openLink(link.href, e);
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
}

let activityRenderFrame = null, needsFullActivityRender = false;
function scheduleActivityRender(detailOnly = false) {
  needsFullActivityRender ||= !detailOnly;
  if (activityRenderFrame !== null) return;
  activityRenderFrame = requestAnimationFrame(() => {
    activityRenderFrame = null;
    if (needsFullActivityRender) {needsFullActivityRender = false;renderActivity();return;}
    const content = $('#activity-panel-content');
    if (!panelShows('agents') || !activity.selected || content.dataset.agentId !== activity.selected) return;
    const agent = activity.conversations.get(state.activeConversationId)?.agents.get(activity.selected);
    if (agent) renderAgentDetail(content, agent);
  });
}

async function stopActivityAgent(agent) {
  if (!['running','waiting'].includes(agent.status) || agent.stop_pending) return;
  const conversationId = state.activeConversationId;
  agent.stop_pending = true;renderActivity();
  try {await conversationCommand('stop_subagent',{conversation_id:conversationId,id:agent.id});}
  catch(e) {agent.stop_pending = false;composerStatus(localizeError(e));if (state.activeConversationId === conversationId) renderActivity();}
}

function renderAgentDetail(content, agent) {
  if (content.dataset.agentId !== agent.id) {
    content.dataset.agentId = agent.id;content.replaceChildren();
    // Built once per agent so the disclosure keeps its open state across live updates.
    const work = document.createElement('details');work.className = 'agent-work';
    const summary = document.createElement('summary');
    summary.append(activityText('span','','agent-work__label'), agentElapsed(agent), activityText('span','','agent-detail-status'), icon('chevron'));
    const body = activityText('div','','agent-work__body');
    const task = activityText('div','','agent-work__task');
    task.append(activityText('span',t('activity.task'),'agent-work__caption'), activityText('p','','activity-task'));
    body.append(task, activityText('div','','agent-detail-history'), activityText('p','','agent-work__tools'));
    work.append(summary, body);
    const actions = activityText('div','','agent-detail-actions');
    const current = () => activityAgentMap().get(agent.id)?.content || '';
    actions.append(messageAction('copy','chat.copy',button => copyText(current(),button)), messageAction('speaker','chat.read_aloud',button => readMessage(current(),button)));
    content.append(work, activityText('p','','activity-detail-summary'), activityText('div','','markdown agent-stream-content'), actions);
  }
  const live = ['running','waiting'].includes(agent.status);
  content.querySelector('.agent-work__label').textContent = live ? `${t('activity.working')} · ` : t('activity.work_duration');
  const status = content.querySelector('.agent-detail-status');
  status.textContent = activityStatus(agent);status.dataset.status = agent.status;
  status.className = `agent-detail-status activity-status activity-status--${agent.status}${['running','completed'].includes(agent.status) ? ' sr-only' : ''}`;
  const task = content.querySelector('.agent-work__task');
  task.hidden = !agent.task;task.querySelector('.activity-task').textContent = agent.task || '';
  const tools = (agent.activity || []).filter(item => item.kind === 'tool').length;
  const toolsLine = content.querySelector('.agent-work__tools');
  toolsLine.textContent = tools ? `${tools} ${t('activity.tools')}` : '';toolsLine.hidden = !tools;
  const summary = content.querySelector('.activity-detail-summary');
  summary.textContent = agent.summary === 'agent_cancelled' ? t('activity.cancelled') : agent.summary || agentLine(agent);
  summary.classList.toggle('is-working-text', agent.status === 'running');
  // The final answer speaks for itself; live and failed runs keep their latest step in view.
  summary.hidden = agent.status === 'completed' && !!agent.content;
  const list = [...(agent.reasoning_content ? [{kind:'reasoning',text:agent.reasoning_content}] : []),...(agent.activity || [])];
  const history = content.querySelector('.agent-detail-history');
  if (list.length) {const details = progressHistory(list,live,history.firstElementChild);if (!details.parentElement) history.append(details);}
  else history.replaceChildren();
  const body = content.querySelector('.agent-stream-content');
  if (body._raw !== (agent.content || '')) {body._raw = agent.content || '';body.innerHTML = markdownHTML(body._raw);
    body.querySelectorAll('a').forEach(link => link.onclick = async event => {event.preventDefault();if (!/^https?:$/.test(link.protocol)) return;try {await invoke('open_external_url',{url:link.href});}catch(_){composerStatus(t('chat.link_failed'));}});
  }
  content.querySelector('.agent-detail-actions').hidden = !agent.content || live;
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
    const remote = remoteTarget(conversationId);
    const result = remote ? await conversationCommand('list_shells', {conversation_id:conversationId})
      : await invoke('list_shells', {conversation_id:conversationId});
    const shells = remote ? result?.shells : result;
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
    const result = await conversationCommand('stop_shell', {id:shell.id, conversation_id:conversationId});
    if (result?.id === shell.id) {
      if (result.revision == null || shell.revision == null || result.revision >= shell.revision) Object.assign(shell, result);
    }
    else throw new Error(t('activity.stop_unconfirmed'));
  } catch (e) {if (shell.status === 'stopping') shell.status = 'running';shell.stop_error = localizeError(e);}
  renderActivity();
}

async function setupActivity() {
  await setupGitEvents();
  // A new top result can move the hovered row even when its DOM node survives.
  // Finish the physical click before reordering; streaming data still accumulates.
  const release = () => {
    const refresh = activity.press?.refresh;activity.press = null;
    if (refresh) scheduleActivityRender();
  };
  for (const list of [$('#activity-card'),$('#activity-panel-content')]) list.addEventListener('pointerdown', event => {
    const button = event.target.closest('button');
    if (event.isPrimary && event.button === 0 && button) activity.press = {button, conversation:state.activeConversationId, owner:browserPage.owner};
  });
  window.addEventListener('pointerup',release,true);window.addEventListener('pointercancel',release,true);window.addEventListener('blur',release);
  for (const [event, collection] of [['artifact-created','outputs'], ['user-source','sources']]) {
    await appWindow.listen(event, ({payload}) => {
      if (!payload?.conversation_id || typeof payload.id !== 'string' || typeof payload.title !== 'string') return;
      const item = {id:payload.id, title:payload.title};
      item.final_output = payload.final_output === true;
      if (Number.isFinite(payload.bytes)) item.bytes = payload.bytes;
      for (const key of ['summary','content','path','kind']) if (typeof payload[key] === 'string') item[key] = payload[key];
      if (typeof payload.url === 'string' && /^file:/i.test(payload.url)) item.path ||= payload.url;
      else if (payload.url) item.url = safeActivityURL(payload.url);
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
  // Explicit final publications are shown while the turn is still running.
  await appWindow.listen('chat-progress', ({payload}) => {
    if (payload?.conversation_id !== state.activeConversationId || ['__delta','__reasoning','__usage'].includes(payload?.kind)) return;
    scheduleActivityRender();
  });
  $('#activity-toggle').onclick = () => {
    activity.visible = !activity.visible;renderActivity();
  };
  $('#activity-back').onclick = () => openActivity(activity.section);
  $('#activity-dock').onkeydown = e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();activity.visible = false;renderActivity();$('#activity-toggle').focus();
  };
  $('#activity-panel').onkeydown = e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();e.preventDefault();
    if (activity.selected) openActivity(activity.section);
    else closeActivityPanel();
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
    if (payload.conversation_id !== state.activeConversationId) return;
    // Streamed text and tool history appear only in the open agent detail.
    if (previous?.status === agent.status && previous.title === agent.title) {
      if (panelShows('agents') && activity.selected === agent.id) {
        scheduleActivityRender(previous.model === agent.model && previous.reasoning === agent.reasoning);
      }
      return;
    }
    if (['completed','failed','cancelled'].includes(agent.status)) renderActivity();else scheduleActivityRender();
  });
  setInterval(updateActivityTimers, 1000);
}
