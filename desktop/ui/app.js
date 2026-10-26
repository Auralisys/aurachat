// AuraChat — frontend statico (nessun bundler). Parla col backend Tauri
// tramite il global `__TAURI__` (withGlobalTauri: true).

const { invoke } = window.__TAURI__.core;
const appWindow = window.__TAURI__.window.getCurrentWindow();

// Il backend sopprime le notifiche di fine turno solo se questa chat è aperta
// e la finestra è a fuoco; in tray/minimizzata la notifica arriva comunque.
function reportViewingChat(id) {
  invoke('set_viewing_chat', { conversation_id: id ?? null }).catch(() => {});
}

let skillsChooser = null;

const DEFAULT_CONFIG = {
  firebase_project_id: '',
  firebase_api_key: '',
  firebase_email: '',
  firebase_auth_set: false,
  api_key_set: false,
  models: [],
  active_model: '',
};

const state = {
  config: { ...DEFAULT_CONFIG },
  data: { projects: [] },
  activeConversationId: null,
  activeConversationSection: null,
  pendingProjectId: null,
  messages: [],
  attachments: [],
  editingMessageIndex: null,
  failedSend: null,
  runs: new Map(),
  unread: new Set(),
  drafts: new Map(),
  queues: new Map(),
  persistedData: null,
  resultEpoch: 0,
  get busy() { return !!this.runs.get(this.activeConversationId)?.pending; },
  preparing: false,
  loadingConversation: false,
  preloaded: new Map(),
  conversationLoadEpoch: 0,
  changingModel: false,
  navigation: [],
  navigationIndex: -1,
  navigating: false,
  busySince: 0,
  lastUsage: null,
  timer: null,
};

const $ = (sel) => document.querySelector(sel);

// ===== i18n =====
let lang = 'en';
let strings = {};

function detectLang() {
  const n = (navigator.language || 'en').toLowerCase();
  return n.startsWith('it') ? 'it' : 'en';
}

async function loadLocales() {
  lang = detectLang();
  try {
    strings = JSON.parse(await invoke('get_locale', { lang }));
  } catch (_) {
    strings = {};
  }
}

function t(key) {
  if (strings[key] != null && strings[key] !== '') return strings[key];
  return key;
}

function applyTranslations() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const value = t(el.dataset.i18nPlaceholder);
    if (el.isContentEditable) el.setAttribute('data-placeholder', value);
    else el.setAttribute('placeholder', value);
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => el.setAttribute('title', t(el.dataset.i18nTitle)));
}

// ===== Form =====
function formHTML(submitLabel) {
  return `
    <form class="form" data-form novalidate>
      <label class="field">
        <span class="field__label">${t('form.api_key')}</span>
        <input class="field__input" name="api_key" type="password" placeholder="••••••••" autocomplete="off" spellcheck="false" />
        <span class="field__note">${t('form.api_key_note')}</span>
      </label>

      <p class="form__error" data-role="error" hidden></p>

      <button type="submit" class="btn btn--primary">${submitLabel}</button>
    </form>`;
}

function fillForm(form) {
  form.elements.api_key.value = '';
}

async function handleSubmit(form) {
  const payload = {
    firebase_project_id: state.config.firebase_project_id,
    firebase_api_key: state.config.firebase_api_key,
    firebase_email: state.config.firebase_email,
    firebase_password: null,
    api_key: form.elements.api_key.value.trim() || null,
  };
  const error = form.querySelector('[data-role="error"]');
  error.hidden = true;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    state.config = await invoke('save_config', { input: payload });
    updateAccount();
    populateModelSelect();
    return true;
  } catch (e) {
    error.textContent = localizeError(e);
    error.hidden = false;
    return false;
  } finally {
    submit.disabled = false;
  }
}

// ===== Albero (progetti → cartelle → conversazioni) =====
function uid() {
  return crypto.randomUUID();
}

function findConversation(id) {
  const standalone = (state.data.conversations || []).find(c => c.id === id);
  if (standalone) return { project: null, folder: null, conversation: standalone };
  for (const project of state.data.projects) {
    const conversation = project.conversations.find(c => c.id === id);
    if (conversation) return { project, conversation };
  }
  return null;
}

function activeConversation() {
  return state.activeConversationId ? findConversation(state.activeConversationId) : null;
}

function allConversations() {
  const out = [...(state.data.conversations || [])];
  for (const project of state.data.projects) out.push(...project.conversations);
  return out;
}

function conversationInData(data, id) {
  return [...(data.conversations || []), ...(data.projects || []).flatMap(p => p.conversations)].find(c => c.id === id);
}

function saveChatDraft() {
  state.drafts.set(state.activeConversationId, {text:composerText(), attachments:structuredClone(state.attachments), editing:state.editingMessageIndex});
}

function restoreChatDraft(id) {
  const draft = state.drafts.get(id);
  setComposerText(draft?.text || '');autoGrow();
  state.attachments = structuredClone(draft?.attachments || []);state.editingMessageIndex = draft?.editing ?? null;renderDraft();
}

async function persist() {
  try {
    const epoch = state.resultEpoch;
    const data = await invoke('save_data', { data: state.data, base: state.persistedData });
    // A background answer can arrive before this older save response.
    for (const [id, run] of state.runs) {
      if (run.completedEpoch > epoch && run.saved) {
        const target = conversationInData(data, id);if (target) Object.assign(target, run.saved);
      }
    }
    state.data = data;state.persistedData = structuredClone(data);
    renderSidebar();
    updateContextInfo();
    return true;
  } catch (e) {
    try {
      state.data = await invoke('get_data');
    } catch (_) {
      state.data = { projects: [] };
    }
    renderSidebar();
    showError(localizeError(e));
    return false;
  }
}

// ===== Sidebar =====
function renderSidebar() {
  closeTreeMenu();
  hideProjectPreview();
  const tree = $('#sidebar-tree');
  const collapsed = new Set([...tree.querySelectorAll('details:not([open])')].map(el => el.dataset.projectId));
  tree.innerHTML = '';
  if (state.data.projects.length === 0) {
    const create = document.createElement('button');create.className = 'tree-empty-action';create.textContent = t('project.create');create.onclick = newProject;tree.appendChild(create);
  }
  for (const project of state.data.projects) {
    const element = projectEl(project);element.open = !collapsed.has(project.id);tree.appendChild(element);
  }
  const recent = $('#recent-chats');
  recent.replaceChildren(...allConversations().slice().sort((a,b) => b.updated_at-a.updated_at).slice(0,12).map(conv => conversationEl(conv, 'recents')));
  if (!recent.children.length) {
    const create = document.createElement('button');create.className = 'tree-empty-action';create.textContent = t('sidebar.new_chat');create.onclick = () => newChat();
    recent.appendChild(create);
  }
  populateProjectMenu();
}

const ICONS = {
  "shield-alert": '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z"/><path d="M12 8v4"/><circle cx="12" cy="16" r=".5" fill="currentColor" stroke="none"/>',
  "shield": '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  "terminal": '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  "back": "<path d=\"m10 6-6 6 6 6M4 12h16\"/>",
  "forward": "<path d=\"m14 6 6 6-6 6M4 12h16\"/>",
  "sidebar": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"4\"/><path d=\"M9 4v16m-3-10 0 4\"/>",
  "home": "<path d=\"m3.5 10 7.3-6a2 2 0 0 1 2.4 0l7.3 6M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M9 21v-7h6v7\"/>",
  "settings": "<path d=\"M4 7h7m4 0h5M4 17h3m4 0h9\"/><circle cx=\"13\" cy=\"7\" r=\"2\"/><circle cx=\"9\" cy=\"17\" r=\"2\"/>",
  "plus": "<path d=\"M12 5v14M5 12h14\"/>",
  "close": "<path d=\"m6 6 12 12M18 6 6 18\"/>",
  "minimize": "<path d=\"M5 12h14\"/>",
  "chevron": "<path d=\"m8 10 4 4 4-4\"/>",
  "send": "<path d=\"M12 19V5m-6 6 6-6 6 6\"/>",
  "project": "<path d=\"M3 8V6a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.6L13 7h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z\"/><path d=\"M3 10h18\"/>",
  "folder": "<path d=\"M3 8V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z\"/>",
  "folderPlus": "<path d=\"M3 8V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z\"/><path d=\"M12 11v6m-3-3h6\"/>",
  "chat": "<path d=\"M7 4h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-6l-6 3v-4a4 4 0 0 1-2-3V8a4 4 0 0 1 4-4Z\"/>",
  "more": "<circle cx=\"5\" cy=\"12\" r=\".8\"/><circle cx=\"12\" cy=\"12\" r=\".8\"/><circle cx=\"19\" cy=\"12\" r=\".8\"/>",
  "rename": "<path d=\"m14 5 3-3 5 5-3 3M14 5l-9 9-1 6 6-1 9-9M14 5l5 5\"/>",
  "delete": "<path d=\"M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5\"/>",
  "copy": '<rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  "speaker": '<path d="m11 5-6 4H2v6h3l6 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  "thumbUp": '<path d="M8 10v10H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h4Zm0 0 5-8a3 3 0 0 1 2 3l-1 4h5a3 3 0 0 1 3 3l-2 7a2 2 0 0 1-2 1H8"/>',
  "thumbDown": '<path d="M8 14V4H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h4Zm0 0 5 8a3 3 0 0 0 2-3l-1-4h5a3 3 0 0 0 3-3l-2-7a2 2 0 0 0-2-1H8"/>',
  "retry": '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 2M4 17l2 2a7 7 0 0 0 12-2"/>',
  "mic": '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  "stop": '<rect x="6" y="6" width="12" height="12" rx="3"/>',
  "file": '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8m-8 4h6"/>',
  "usage": '<path d="M4 19h16M7 15v-4m5 4V5m5 10V8"/>',
  "check": "<path d=\"m5 12 4 4L19 6\"/>"
};

function icon(name) {
  if (importedIcons[name]) {
    const template = document.createElement('template');
    template.innerHTML = importedIcons[name];
    const svg = template.content.firstElementChild;
    svg.classList.add('ui-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    // Preserve filled glyphs and source strokes against the legacy outline icon rules.
    for (const [property, fallback] of Object.entries({fill:'black', stroke:'none', 'stroke-width':'1', 'stroke-linecap':'butt', 'stroke-linejoin':'miter'})) {
      svg.style.setProperty(property, svg.getAttribute(property) || fallback);
    }
    return svg;
  }
  const glyph = {computer:'Monitor', gear:'Settings', person:'UserRound', cpu:'Cpu', microphone:'Mic', search:'Search', back:'ArrowLeft', trash:'Trash2', compose:'MessageCirclePlus', chat:'MessageSquare', project:'Folder', file:'FileText', image:'Image', fileCode:'FileCode', fileData:'FileJson', shield:'ShieldCheck', agents:'Bot', settings:'Settings2', terminal:'SquareTerminal', check:'Check', more:'Ellipsis', chevron:'ChevronDown', globe:'Globe', external:'ExternalLink'}[name];
  if (glyph && lucide.icons[glyph]) return lucide.createElement(lucide.icons[glyph], {class:'ui-icon','aria-hidden':'true'});
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ui-icon');
  svg.innerHTML = ICONS[name];
  return svg;
}

function actionBtn(iconName, i18nKey, onClick, danger) {
  const b = document.createElement('button');
  b.className = 'tree-action' + (danger ? ' tree-action--danger' : '');
  b.appendChild(icon(iconName));
  b.title = t(i18nKey);
  b.setAttribute('aria-label', t(i18nKey));
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

function projectHeadEl(project) {
  const el = document.createElement('summary');
  el.className = 'tree-project__head';
  const disclosure = icon('chevron');
  disclosure.classList.add('tree-disclosure');
  const folder = icon('project');
  folder.classList.add('tree-icon', 'tree-icon--closed');
  const openFolder = icon('projectOpen');
  openFolder.classList.add('tree-icon', 'tree-icon--open');
  const name = document.createElement('span');
  name.className = 'tree-project__name';
  name.textContent = project.name;
  name.addEventListener('dblclick', () => renameInline(name, project.name, value => renameProject(project.id, value)));
  const actions = document.createElement('div');
  actions.className = 'tree-actions';
  const more = actionBtn('more', 'sidebar.options', () => {
    if (more.getAttribute('aria-expanded') === 'true') closeTreeMenu();
    else openProjectMenu(el, project, name, more);
  });
  configureMenuTrigger(more);
  actions.append(more, actionBtn('compose', 'sidebar.new_chat', () => newChat(project.id)));
  el.append(disclosure, folder, openFolder, name, actions);
  el.addEventListener('contextmenu', e => {
    if (e.target.closest('input')) return;
    e.preventDefault();
    openProjectMenu(el, project, name, more, { x:e.clientX, y:e.clientY });
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();openProjectMenu(el, project, name, more);
    }
  });
  el.addEventListener('pointerenter', () => scheduleProjectPreview(el, project.id));
  el.addEventListener('pointerleave', deferHideProjectPreview);
  el.addEventListener('focusin', () => scheduleProjectPreview(el, project.id));
  el.addEventListener('focusout', deferHideProjectPreview);
  return el;
}

function configureMenuTrigger(button) {
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'tree-menu');
}

let treeMenuTrigger = null;
let previewTimer = null;
let previewRow = null;

function positionTreeOverlay(panel, row, point) {
  const rect = row.getBoundingClientRect();
  const width = panel.offsetWidth, height = panel.offsetHeight;
  let left = point ? point.x : rect.right + 8;
  if (left + width > innerWidth - 8) left = point ? innerWidth - width - 8 : rect.left - width - 8;
  panel.style.left = `${Math.max(8, left)}px`;
  panel.style.top = `${Math.max(8, Math.min(point ? point.y : rect.top, innerHeight - height - 8))}px`;
}

function closeTreeMenu(restoreFocus = false) {
  const resumeTurn = !!treeMenuTrigger?.closest('.msg--queued');
  const resumeGit = !!treeMenuTrigger?.closest('.git-group, .git-panel');
  $('#tree-menu').hidden = true;
  treeMenuTrigger?.setAttribute('aria-expanded', 'false');
  treeMenuTrigger?.closest('.tree-project__head, .tree-conv, .sidebar__section-head, .chat-header')?.classList.remove('is-menu-open');
  if (restoreFocus) treeMenuTrigger?.focus();
  treeMenuTrigger = null;
  if (resumeTurn) requestAnimationFrame(() => updateLiveTurn());
  if (resumeGit) scheduleActivityRender();
}

function showTreeMenu(row, trigger, heading, entries, point) {
  closeTreeMenu();hideProjectPreview();closeChoiceMenus();
  const panel = $('#tree-menu');
  const title = document.createElement('p');
  title.className = 'tree-menu__title';title.textContent = heading;
  panel.replaceChildren(title);
  for (const [glyph, key, action, disabled = false] of entries) {
    const button = document.createElement('button');
    button.className = 'tree-menu__item' + (glyph === 'delete' ? ' tree-menu__item--danger' : '');
    button.setAttribute('role', 'menuitem');
    const conversationId = row.closest('.tree-conv')?.dataset.conversationId;
    const projectId = row.closest('.tree-project')?.dataset.projectId;
    button.disabled = disabled || state.preparing || !!state.runs.get(conversationId)?.pending || !!state.data.projects.find(p => p.id === projectId)?.conversations.some(c => state.runs.get(c.id)?.pending);
    const label = document.createElement('span');label.textContent = t(key);
    button.append(icon(glyph), label);
    button.onclick = () => { closeTreeMenu(true);action(); };
    panel.appendChild(button);
  }
  treeMenuTrigger = trigger;trigger.setAttribute('aria-expanded', 'true');
  row.classList.add('is-menu-open');panel.setAttribute('aria-label', heading);
  panel.hidden = false;
  const bounds = row.getBoundingClientRect();
  positionTreeOverlay(panel, row, point || {x:bounds.right - panel.offsetWidth,y:bounds.bottom + 4});
  panel.querySelector('button:not(:disabled)')?.focus();
}

function openProjectMenu(row, project, name, trigger, point) {
  showTreeMenu(row, trigger, `${project.name} · ${project.conversations.length} ${t(project.conversations.length === 1 ? 'sidebar.chat_one' : 'sidebar.chat_many')}`, [
    ['settings', 'project.edit', () => openProjectEditor(project.id)],
    ['rename', 'sidebar.rename', () => renameInline(name, project.name, value => renameProject(project.id, value))],
    ['delete', 'sidebar.delete_project', () => deleteProject(project.id)],
  ], point);
}

function hideProjectPreview() {
  clearTimeout(previewTimer);
  $('#project-preview').hidden = true;
  previewRow?.removeAttribute('aria-describedby');
  previewRow = null;
}

function deferHideProjectPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(hideProjectPreview, 120);
}

function scheduleProjectPreview(row, id) {
  hideProjectPreview();
  if (treeMenuTrigger) return;
  previewTimer = setTimeout(() => {
    const project = state.data.projects.find(p => p.id === id);
    if (!row.isConnected || !project || treeMenuTrigger || row.querySelector('input')) return;
    const panel = $('#project-preview');
    const title = document.createElement('strong');
    title.append(icon('project'), document.createTextNode(project.name));
    const count = document.createElement('p');
    count.className = 'project-preview__count';
    const total = project.conversations.length;
    count.append(icon('chat'), document.createTextNode(`${total} ${t(total === 1 ? 'sidebar.chat_one' : 'sidebar.chat_many')}`));
    const folders = document.createElement('div');
    folders.className = 'project-preview__folders';
    for (const path of project.source_folders) {
      const entry = document.createElement('p');
      const name = document.createElement('span');name.textContent = path;name.title = path;
      entry.append(icon('folder'), name);folders.appendChild(entry);
    }
    if (!project.source_folders.length) folders.textContent = t('project.no_source');
    panel.replaceChildren(title, count, folders);
    panel.hidden = false;
    previewRow = row;
    row.setAttribute('aria-describedby', 'project-preview');
    positionTreeOverlay(panel, row);
  }, 250);
}

function setupTreeOverlays() {
  const menu = $('#tree-menu'), preview = $('#project-preview');
  menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTreeMenu(true); }
    if (e.key === 'Tab') closeTreeMenu(true);
  });
  preview.addEventListener('pointerenter', () => clearTimeout(previewTimer));
  preview.addEventListener('pointerleave', hideProjectPreview);
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('#tree-menu, [aria-controls="tree-menu"]')) closeTreeMenu();
    hideProjectPreview();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideProjectPreview(); });
  document.addEventListener('scroll', e => {
    if (e.target === $('#messages') && treeMenuTrigger?.closest('.msg--queued')) return;
    if (!e.target.closest?.('#tree-menu, #project-preview')) { closeTreeMenu(); hideProjectPreview(); }
  }, true);
  $('#messages').addEventListener('wheel', () => {
    if (treeMenuTrigger?.closest('.msg--queued')) closeTreeMenu();
  }, {passive:true});
  window.addEventListener('resize', () => { closeTreeMenu(); hideProjectPreview(); });
}

function projectEl(project) {
  const el = document.createElement('details');el.open = true;
  el.className = 'tree-project';el.dataset.projectId = project.id;
  el.appendChild(projectHeadEl(project));
  const chats = document.createElement('div');chats.className = 'tree-project__chats';
  for (const conversation of project.conversations) chats.appendChild(conversationEl(conversation, 'projects'));
  if (!project.conversations.length) {
    const empty = document.createElement('button');empty.className = 'tree-empty-action';
    empty.textContent = t('project.first_chat');empty.onclick = () => newChat(project.id);
    chats.appendChild(empty);
  }
  el.appendChild(chats);return el;
}

function conversationEl(conv, section) {
  const el = document.createElement('div');
  const active = conv.id === state.activeConversationId && section === state.activeConversationSection;
  el.className = 'tree-conv' + (active ? ' is-active' : '');
  el.dataset.conversationId = conv.id;
  const computer = remoteComputerIcon(conv.id);
  if (computer) el.append(computer);
  const title = document.createElement('span');
  title.className = 'tree-conv__title';
  title.tabIndex = 0;
  title.setAttribute('role', 'button');
  if (active) title.setAttribute('aria-current', 'page');
  title.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openConversation(conv.id, true, section); } });
  title.textContent = conv.title || t('sidebar.new_chat');
  el.addEventListener('click', e => { if (!e.target.closest('button, input')) openConversation(conv.id, true, section); });
  title.addEventListener('dblclick', () => renameInline(title, conv.title, (n) => renameConversation(conv.id, n)));
  el.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'tree-actions';
  const more = actionBtn('more', 'sidebar.options', () => openMenu());
  configureMenuTrigger(more);
  const openMenu = point => showTreeMenu(el, more, conv.title || t('sidebar.new_chat'), [
    ['rename','sidebar.rename',() => renameInline(title, conv.title, value => renameConversation(conv.id, value))],
    ['delete','sidebar.delete',() => deleteConversation(conv.id)],
  ], point);
  actions.appendChild(more);
  el.addEventListener('contextmenu', e => {
    if (e.target.closest('input')) return;
    e.preventDefault();openMenu({x:e.clientX,y:e.clientY});
  });
  title.addEventListener('keydown', e => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault();openMenu(); }
  });
  el.appendChild(actions);
  if (state.runs.get(conv.id)?.pending || (state.loadingConversation && conv.id === state.activeConversationId)) {
    const spinner = document.createElement('span');
    const questionWaiting = pendingQuestions(conv.id).length > 0;
    const waiting = questionWaiting || [...(permissionRequests.get(conv.id)?.values() || [])].some(r => r.status === 'pending');
    spinner.className = `tree-conv__spinner${waiting ? ' is-waiting' : ''}`;
    spinner.setAttribute('role', 'status');
    spinner.setAttribute('aria-label', t(questionWaiting ? 'questions.waiting' : waiting ? 'permissions.waiting' : 'chat.thinking'));
    spinner.title = spinner.getAttribute('aria-label');
    el.appendChild(spinner);
  } else if (state.unread.has(conv.id)) {
    const dot = document.createElement('span');dot.className = 'tree-conv__unread';
    dot.setAttribute('role','status');dot.setAttribute('aria-label',t('chat.unread'));dot.title=t('chat.unread');el.append(dot);
  }
  return el;
}

function renameInline(nameEl, current, commit) {
  const input = document.createElement('input');
  input.className = 'tree-input';
  input.value = current;
  nameEl.parentElement.replaceChild(input, nameEl);
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = current;
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    const v = input.value.trim();
    input.replaceWith(nameEl);
    if (v && v !== current) commit(v);
    renderSidebar();
  });
}

// ===== Project editor and local source folders =====
let projectDraft = null;
let projectEditorBusy = false;

function projectEditorError(error) {
  const element = $('#project-error');element.textContent = localizeError(error);element.hidden = false;
}

function updateProjectEditor() {
  const list = $('#project-sources');list.replaceChildren();
  for (const path of projectDraft.source_folders) {
    const row = document.createElement('div');row.className = 'project-source';
    const text = document.createElement('div');
    const name = document.createElement('strong');name.textContent = path.split(/[\\/]/).filter(Boolean).at(-1) || path;
    const full = document.createElement('span');full.textContent = path;full.title = path;
    const status = document.createElement('small');
    status.textContent = t(projectDraft.allowed.includes(path) ? 'project.allowed' : 'project.not_allowed');
    text.append(name,full,status);
    const remove = actionBtn('close','project.remove_source',() => {
      projectDraft.source_folders = projectDraft.source_folders.filter(p => p !== path);
      updateProjectEditor();
    });
    remove.disabled = projectEditorBusy;
    row.append(icon('folder'),text,remove);
    if (!projectDraft.allowed.includes(path)) {
      const authorize = document.createElement('button');
      authorize.type = 'button';
      authorize.className = 'project-source__authorize';
      authorize.textContent = t('project.authorize');
      authorize.disabled = projectEditorBusy;
      authorize.onclick = () => authorizeDraftFolder(path);
      row.append(authorize);
    }
    list.appendChild(row);
  }
  $('#project-source-empty').hidden = projectDraft.source_folders.length > 0;
  $('#project-save').disabled = projectEditorBusy || !$('#project-name-input').value.trim() || !projectDraft.source_folders.length;
  $('#project-add-source').disabled = projectEditorBusy;
  $('#project-cancel').disabled = projectEditorBusy;
  $('#project-dialog-close').disabled = projectEditorBusy;
  $('#project-name-input').disabled = projectEditorBusy;
}

async function openProjectEditor(id = null) {
  if (state.preparing) return;
  closeTreeMenu();hideProjectPreview();
  const project = state.data.projects.find(p => p.id === id);
  projectDraft = { id:project?.id || uid(), source_folders:[...(project?.source_folders || [])], allowed:[], editing:!!project };
  $('#project-editor-title').textContent = t(project ? 'project.edit' : 'project.create');
  $('#project-save').textContent = t(project ? 'project.save' : 'project.create');
  $('#project-name-input').value = project?.name || '';
  $('#project-error').hidden = true;
  updateProjectEditor();$('#project-dialog').showModal();
  try { projectDraft.allowed = await invoke('project_folder_access',{project_id:projectDraft.id}); }
  catch (e) { projectEditorError(e); }
  updateProjectEditor();
}

async function addProjectSource() {
  if (!projectDraft || projectEditorBusy) return;
  projectEditorBusy = true;$('#project-error').hidden = true;updateProjectEditor();
  try {
    const path = await invoke('choose_project_folder',{project_id:projectDraft.id,lang});
    if (path) {
      if (!projectDraft.source_folders.includes(path)) projectDraft.source_folders.push(path);
      if (!projectDraft.allowed.includes(path)) projectDraft.allowed.push(path);
      if (!$('#project-name-input').value.trim()) $('#project-name-input').value = path.split(/[\\/]/).filter(Boolean).at(-1) || path;
    }
  } catch (e) { projectEditorError(e); }
  finally { projectEditorBusy = false;updateProjectEditor();$('#project-name-input').focus(); }
}

async function authorizeDraftFolder(oldPath) {
  if (!projectDraft || projectEditorBusy) return;
  projectEditorBusy = true;$('#project-error').hidden = true;updateProjectEditor();
  try {
    const path = await invoke('choose_project_folder',{project_id:projectDraft.id,lang});
    if (path) {
      const index = projectDraft.source_folders.indexOf(oldPath);
      if (index >= 0) projectDraft.source_folders[index] = path;
      if (!projectDraft.allowed.includes(path)) projectDraft.allowed.push(path);
    }
  } catch (e) { projectEditorError(e); }
  finally { projectEditorBusy = false;updateProjectEditor();$('#project-name-input').focus(); }
}

async function closeProjectEditor() {
  if (projectEditorBusy) return;
  try { await invoke('prune_folder_access'); }
  catch (e) { projectEditorError(e);return; }
  $('#project-dialog').close();projectDraft = null;
}

function setupProjectEditor() {
  $('#project-add-source').onclick = addProjectSource;
  $('#project-name-input').oninput = updateProjectEditor;
  $('#project-cancel').onclick = closeProjectEditor;
  $('#project-dialog-close').onclick = closeProjectEditor;
  $('#project-dialog').addEventListener('cancel', e => {e.preventDefault();closeProjectEditor();});
  $('#project-form').onsubmit = async e => {
    e.preventDefault();if (!projectDraft || projectEditorBusy) return;
    const name = $('#project-name-input').value.trim();
    if (!name || !projectDraft.source_folders.length) return;
    projectEditorBusy = true;$('#project-error').hidden = true;updateProjectEditor();
    const project = state.data.projects.find(p => p.id === projectDraft.id);
    if (project) { project.name = name;project.source_folders = [...projectDraft.source_folders]; }
    else state.data.projects.push({id:projectDraft.id,name,source_folders:[...projectDraft.source_folders],conversations:[]});
    const ok = await persist();projectEditorBusy = false;updateProjectEditor();
    if (ok) { $('#projects-section').open = true;await closeProjectEditor(); }
    else projectEditorError(t('project.save_failed'));
  };
}

function setupSidebarSections() {
  for (const prefix of ['projects','recents']) {
    const section = $(`#${prefix}-section`), row = section.querySelector('summary');
    const more = $(`#${prefix}-options`);configureMenuTrigger(more);
    more.onclick = e => {
      e.preventDefault();e.stopPropagation();
      if (more.getAttribute('aria-expanded') === 'true') {closeTreeMenu();return;}
      showTreeMenu(row,more,t(prefix === 'projects' ? 'ui.projects' : 'ui.recents'),[
        [prefix === 'projects' ? 'folderPlus' : 'compose',prefix === 'projects' ? 'sidebar.new_project' : 'sidebar.new_chat',() => prefix === 'projects' ? newProject() : newChat()],
        ['chevron',section.open ? 'sidebar.collapse_section' : 'sidebar.expand_section',() => {section.open = !section.open;}],
      ]);
    };
  }
  $('#btn-new-recent-chat').onclick = e => {e.preventDefault();e.stopPropagation();newChat();};
}

// ===== Mutazioni =====
async function newProject(e) {
  e?.preventDefault();
  if (state.preparing) return;
  await openProjectEditor();
  await addProjectSource();
}

function newChat(projectId = null) {
  if (state.preparing) return;
  clearChat();
  state.pendingProjectId = state.data.projects.some(p => p.id === projectId) ? projectId : null;
  populateProjectMenu();renderSidebar();$('#composer-input').focus();
}

function deleteProject(id) {
  if (state.data.projects.find(p => p.id === id)?.conversations.some(c => state.runs.get(c.id)?.pending)) return;
  state.data.projects = state.data.projects.filter((p) => p.id !== id);
  if (!findConversation(state.activeConversationId)) clearChat();
  persist();
}

function deleteConversation(id) {
  if (state.runs.get(id)?.pending) return;
  state.data.conversations = (state.data.conversations || []).filter(c => c.id !== id);
  for (const project of state.data.projects) project.conversations = project.conversations.filter(c => c.id !== id);
  if (state.activeConversationId === id) clearChat();
  persist();
}

function renameProject(id, name) {
  const p = state.data.projects.find((p) => p.id === id);
  if (p) {
    p.name = name;
    persist();
  }
}

function renameConversation(id, title) {
  const c = findConversation(id);
  if (c) {
    c.conversation.title = title;
    persist();
  }
}

function clearChat() {
  releaseRemoteTurn(state.activeConversationId);
  saveChatDraft();
  state.conversationLoadEpoch++;state.loadingConversation=false;
  cancelVoice();
  state.attachments=[];state.editingMessageIndex=null;state.failedSend=null;renderDraft();composerStatus();
  window.speechSynthesis?.cancel();
  state.activeConversationId = null;
  reportViewingChat(null);
  state.activeConversationSection = null;
  state.pendingProjectId = null;
  state.messages = [];
  clearComposer();autoGrow();
  state.lastUsage = null;
  renderMessages();
  updateContextInfo();
  populateProjectMenu();
  rememberNavigation(null);
  populateModelSelect();
  renderSidebar();
  voiceUi();
}

async function openConversation(id, refresh = true, section = null) {
  saveChatDraft();
  if (id !== state.activeConversationId) releaseRemoteTurn(state.activeConversationId);
  const epoch=++state.conversationLoadEpoch;
  state.loadingConversation=false;
  cancelVoice();
  state.attachments=[];state.editingMessageIndex=null;renderDraft();composerStatus();window.speechSynthesis?.cancel();
  state.activeConversationId = id;
  reportViewingChat(id);
  state.unread.delete(id);
  const run = state.runs.get(id);
  const found = findConversation(id);
  state.activeConversationSection = section || (found?.project ? 'projects' : 'recents');
  const freshPreload = state.preloaded.get(id) != null && Date.now() - state.preloaded.get(id) < 60000;
  const needsLoad=found && !run?.pending && (found.conversation.messages_loaded===false || (refresh && found.conversation.revision != null && !freshPreload));
  state.loadingConversation=!!needsLoad;
  state.messages = run?.pending ? run.messages.slice() : found ? (found.conversation.messages || []).slice() : [];
  state.lastUsage = run?.usage || null;state.failedSend = run?.failedSend || null;
  restoreChatDraft(id);
  renderSidebar();
  renderMessages();
  updateContextInfo();
  rememberNavigation(id);
  populateModelSelect();
  voiceUi();
  if (needsLoad) {
    state.loadingConversation=true;voiceUi();
    try {
      const conversation=await invoke('get_conversation',{conversation_id:id});
      if (epoch !== state.conversationLoadEpoch) return;
      const target=findConversation(id);if(!target)return;
      Object.assign(target.conversation,conversation);
      const baseline = state.persistedData && conversationInData(state.persistedData, id);if (baseline) Object.assign(baseline, structuredClone(conversation));
      state.messages=(conversation.messages || []).slice();renderMessages();updateContextInfo();
    } catch(e) {
      if(epoch===state.conversationLoadEpoch) composerStatus(localizeError(e));
    } finally {
      if(epoch===state.conversationLoadEpoch){state.loadingConversation=false;renderSidebar();renderMessages();voiceUi();}
    }
  }
  if (epoch === state.conversationLoadEpoch) refreshRemoteTurn();
}

function preloadRecentConversations(excludeId) {
  const byProject = new Map();
  const standalone = [];
  for (const conv of allConversations().slice().sort((a, b) => b.updated_at - a.updated_at)) {
    if (conv.id === excludeId) continue;
    const project = state.data.projects.find(p => p.conversations.some(c => c.id === conv.id));
    if (project) {
      const list = byProject.get(project.id) || [];
      if (list.length < 5) { list.push(conv.id); byProject.set(project.id, list); }
    } else if (standalone.length < 5) {
      standalone.push(conv.id);
    }
  }
  const ids = [];
  const seen = new Set([excludeId]);
  for (const list of byProject.values()) for (const id of list) if (!seen.has(id)) { seen.add(id); ids.push(id); }
  for (const id of standalone) if (!seen.has(id)) { seen.add(id); ids.push(id); }
  (async () => {
    for (const id of ids) {
      try { await preloadConversation(id); } catch (_) { /* background preload failure is non-fatal */ }
    }
  })();
}

async function preloadConversation(id) {
  const found = findConversation(id);
  if (!found || found.conversation.messages_loaded === true) return;
  const conversation = await invoke('get_conversation', { conversation_id: id });
  const target = findConversation(id);
  if (!target) return;
  Object.assign(target.conversation, conversation);
  const baseline = state.persistedData && conversationInData(state.persistedData, id);
  if (baseline) Object.assign(baseline, structuredClone(conversation));
  state.preloaded.set(id, Date.now());
}

function rememberNavigation(id) {
  const current = state.navigation[state.navigationIndex];
  const section = state.activeConversationSection;
  if (!state.navigating && (!current || current.id !== id || current.section !== section)) {
    state.navigation = state.navigation.slice(0, state.navigationIndex + 1);
    state.navigation.push({id, section});
    state.navigationIndex = state.navigation.length - 1;
  }
  $('#nav-back').disabled = state.navigationIndex <= 0;
  $('#nav-forward').disabled = state.navigationIndex >= state.navigation.length - 1;
}

function navigateHistory(direction) {
  if (state.preparing) return;
  let i = state.navigationIndex + direction;
  while (i >= 0 && i < state.navigation.length) {
    const {id, section} = state.navigation[i];
    if (id === null || findConversation(id)) {
      state.navigationIndex = i;
      state.navigating = true;
      try { if (id === null) clearChat(); else openConversation(id, true, section); }
      finally { state.navigating = false; }
      return;
    }
    i += direction;
  }
}

async function ensureConversation() {
  if (state.activeConversationId) return;
  const project = state.data.projects.find(p => p.id === state.pendingProjectId);
  const now = Date.now();
  const conversation = { id:uid(), title:t('sidebar.new_chat'), messages:[], created_at:now, updated_at:now, context_tokens:0 };
  (project ? project.conversations : (state.data.conversations ||= [])).push(conversation);
  if (await persist()) await openConversation(conversation.id,false);
}

// ===== Chat =====
function emptyHTML() {
  return `
    <div class="empty">
      <img class="empty__logo" src="assets/logo-auralisys.svg" alt="" />
      <h2 class="empty__title">${t('chat.empty_title')}</h2>
      <p class="empty__hint">${t('chat.empty_hint')}</p>
    </div>`;
}

function markdownHTML(content) {
  return DOMPurify.sanitize(marked.parse(content, {gfm:true, breaks:false}), {
    ALLOWED_TAGS:['p','br','strong','em','del','blockquote','ul','ol','li','h1','h2','h3','h4','pre','code','a','table','thead','tbody','tr','th','td','hr','details','summary'],
    ALLOWED_ATTR:['href','title','start','class'], ALLOW_DATA_ATTR:false,
  });
}

async function copyText(text, button) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const input = document.createElement('textarea');input.value = text;input.className = 'sr-only';
      document.body.appendChild(input);input.select();
      const copied = document.execCommand('copy');input.remove();
      if (!copied) throw new Error('clipboard');
    }
    if (button) {button.replaceChildren(icon('check'));button.setAttribute('aria-label',t('chat.copied'));}
  } catch (_) { composerStatus(t('chat.copy_failed')); }
}

function messageAction(glyph, key, action) {
  const button = document.createElement('button');button.className = 'message-action';button.type = 'button';
  button.title = t(key);button.setAttribute('aria-label',t(key));button.appendChild(icon(glyph));
  button.onclick = () => action(button);return button;
}

async function setMessageFeedback(index, value) {
  const conversation = activeConversation()?.conversation;
  if (!conversation || state.busy) return;
  conversation.messages[index].feedback = conversation.messages[index].feedback === value ? null : value;
  await persist();state.messages = activeConversation()?.conversation.messages.slice() || [];
  renderMessages();
}

function readMessage(content, button) {
  if (speechSynthesis.speaking) {speechSynthesis.cancel();button.replaceChildren(icon('speaker'));return;}
  const text = document.createElement('div');text.innerHTML = markdownHTML(content);
  const utterance = new SpeechSynthesisUtterance(text.textContent);utterance.lang = lang;
  utterance.onend = () => button.replaceChildren(icon('speaker'));
  utterance.onerror = event => {button.replaceChildren(icon('speaker'));if (!['canceled','interrupted'].includes(event.error)) composerStatus(t('chat.voice_unavailable'));};
  button.replaceChildren(icon('stop'));speechSynthesis.speak(utterance);
}

function editMessage(index) {
  if (state.busy || state.preparing) return;
  const message = state.messages[index];state.editingMessageIndex = index;
  state.attachments = structuredClone(message.attachments || []);
  setComposerText(message.content);autoGrow();renderDraft();$('#composer-input').focus();
}

function messageEl(m, index) {
  const role = m.role === 'user' ? 'user' : m.role === 'error' ? 'error' : 'assistant';
  const el = document.createElement('article');el.className = 'msg msg--' + role;
  el.setAttribute('aria-label',t(role === 'user' ? 'chat.you' : role === 'assistant' ? 'chat.assistant' : 'chat.error_label'));
  if (m.guidance) {const guide = document.createElement('span');guide.className = 'msg__state msg__state--guide';guide.textContent = t('chat.guide');el.prepend(guide);}
  const text = document.createElement('div');text.className = 'msg__text';
  if (role === 'assistant') {
    text.classList.add('markdown');renderTurnBody(text, m);
    text.querySelectorAll('a').forEach(link => {
      link.rel = 'noopener noreferrer';
      link.onclick = async e => {e.preventDefault();try {await invoke('open_external_url',{url:link.href});}catch (_) {composerStatus(t('chat.link_failed'));}};
    });
    text.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code');
      if (code) pre.appendChild(messageAction('copy','chat.copy_code',button => copyText(code.textContent,button)));
    });
    text.querySelectorAll('table').forEach(table => {const scroll = document.createElement('div');scroll.className='markdown-table';table.replaceWith(scroll);scroll.appendChild(table);});
  } else text.textContent = m.content;
  if (m.content || m.activity?.length) el.appendChild(text);
  if (m.attachments?.length) {
    const attachments = document.createElement('div');attachments.className = 'message-attachments';
    for (const file of m.attachments) {const chip = document.createElement('span');chip.className = 'attachment-chip';chip.append(icon('file'),document.createTextNode(file.name));attachments.appendChild(chip);}
    el.appendChild(attachments);
  }
  const actions = document.createElement('div');actions.className = 'msg-actions';
  actions.appendChild(messageAction('copy','chat.copy',button => copyText(m.content,button)));
  if (role === 'assistant') {
    if ('speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function') actions.appendChild(messageAction('speaker','chat.read_aloud',button => readMessage(m.content,button)));
    for (const [glyph,key,value] of [['thumbUp','chat.helpful',true],['thumbDown','chat.not_helpful',false]]) {
      const button = messageAction(glyph,key,() => setMessageFeedback(index,value));
      button.setAttribute('aria-pressed',String(m.feedback === value));button.disabled = state.busy;actions.appendChild(button);
    }
    const latest = state.messages.findLastIndex(message => message.role === 'assistant') === index;
    if (latest) {const retry = messageAction('retry','chat.regenerate',() => regenerateReply());retry.disabled = state.busy;actions.appendChild(retry);}
    const more = messageAction('more','sidebar.options',button => showTreeMenu(actions,button,t('chat.message_options'),[
      ['copy','chat.copy',() => copyText(m.content)],
      ...(latest ? [['retry','chat.regenerate',regenerateReply]] : []),
    ]));configureMenuTrigger(more);actions.appendChild(more);
  } else if (role === 'user') {
    const edit = messageAction('rename','chat.edit',() => editMessage(index));edit.disabled = state.busy;actions.appendChild(edit);
  } else if (state.failedSend) actions.appendChild(messageAction('retry','chat.retry',() => {
    setComposerText(state.failedSend.content);state.attachments = structuredClone(state.failedSend.attachments);renderDraft();autoGrow();send();
  }));
  el.appendChild(actions);return el;
}

function renderMessages() {
  renderQuestions();
  $('#model-select').disabled = state.busy || state.changingModel;
  $('#composer-attach').disabled = state.preparing || state.loadingConversation;
  voiceUi();
  renderActivity();
  const box = $('#messages');
  const follow = box.dataset.conversation !== String(state.activeConversationId) || box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  box.dataset.conversation = String(state.activeConversationId);
  $('.composer__project').hidden = state.activeConversationId !== null;
  $('#view-chat').classList.toggle('is-empty', state.messages.length === 0 && !state.loadingConversation && !state.busy);
  $('#conversation-title').textContent = activeConversation()?.conversation.title || t('sidebar.new_chat');
  $('#conversation-remote')?.remove();
  const computer = remoteComputerIcon(state.activeConversationId);
  if (computer) {computer.id = 'conversation-remote';$('#conversation-title').before(computer);}
  $('#conversation-options').disabled = !state.activeConversationId || state.busy;
  box.innerHTML = '';
  renderThinkingStatus();
  if (state.messages.length === 0 && !state.busy && !state.loadingConversation) {
    box.innerHTML = emptyHTML();
    return;
  }
  state.messages.forEach((message,index) => box.appendChild(messageEl(message,index)));
  if (state.busy) {
    const pending = document.createElement('article');pending.className = 'msg msg--assistant msg--stream';
    pending.setAttribute('aria-label', t('chat.assistant'));
    const body = document.createElement('div');body.className = 'msg__text markdown';pending.append(body);box.append(pending);
    updateLiveTurn();
  }
  renderQueuedMessages(box, state.activeConversationId);
  renderThinkingStatus();
  if (follow) box.scrollTop = box.scrollHeight;
  updateThinkingTimer();
}

function showError(msg) {
  state.messages.push({ role: 'error', content: msg });
  renderMessages();
}

function startTimer() {
  if (!state.timer) state.timer = setInterval(updateThinkingTimer, 1000);
}

function updateThinkingTimer() {
  const el = $('#messages .turn-history[data-live-history] .thinking__timer'), run = state.runs.get(state.activeConversationId);
  if (!el || !run?.pending) return;
  const secs = Math.floor((Date.now() - run.since) / 1000);
  el.textContent = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function stopTimer() {
  if (state.timer && ![...state.runs.values()].some(run => run.pending)) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

async function requestChat(payload) {
  const id = payload.conversation_id;
  if (state.runs.get(id)?.pending || voice.pending || voice.recording || voice.transcribing || voice.nativeOperation) return false;
  // A queue can start a background conversation: never seed it (or the UI)
  // with the messages of the chat that happens to be open.
  const isActive = id === state.activeConversationId;
  const seed = isActive ? state.messages : (findConversation(id)?.conversation?.messages || []);
  const run = {pending:true, since:Date.now(), messages:structuredClone(seed), usage:null, failedSend:null, stopping:false, initialMessageCount:seed.length, pendingGuidance:[], guidanceEvents:[]};
  state.runs.set(id, run);if (isActive) {state.messages = run.messages;state.failedSend = null;}state.unread.delete(id);
  closeChoiceMenus();startTimer();if (isActive) renderMessages();renderSidebar();
  try {
    const result = remoteTarget(id) ? await requestRemoteChat(payload,run) : await invoke('chat',payload);
    await finishLiveTurn(run);
    run.messages = markGuidanceHistory(run, result.messages);run.usage = result.usage;run.completedEpoch = ++state.resultEpoch;run.queueOutcome = result.cancelled ? 'cancelled' : 'completed';
    const saved = conversationInData(result.data, id);
    run.saved = {...saved, messages:result.messages, messages_loaded:true};
    const target = findConversation(id)?.conversation;if (target) Object.assign(target, run.saved);
    const baseline = state.persistedData && conversationInData(state.persistedData, id);if (baseline) Object.assign(baseline, structuredClone(run.saved));
    if (result.cancelled && state.activeConversationId === id) composerStatus(t('chat.stopped'));
    return true;
  } catch (e) {
    await finishLiveTurn(run);
    if (run.stream?.content || run.stream?.activity.length) run.messages.push({role:'assistant', content:run.stream.content, activity:run.stream.activity});
    run.messages.push({role:'error',content:localizeError(e)});
    run.queueOutcome = 'failed';
    if (!payload.retry) run.failedSend = {content:payload.content, attachments:payload.attachments || []};
    return false;
  }
  finally {
    run.pending = false;run.submitting = false;stopTimer();
    if (state.activeConversationId !== id && findConversation(id)) state.unread.add(id);
    if (state.activeConversationId === id) {
      state.messages = run.messages;state.lastUsage = run.usage;state.failedSend = run.failedSend;
      renderMessages();updateContextInfo();
    }
    renderSidebar();updateComposerControls();
    // Completed or stopped: the user's drafts continue in FIFO order. Only an
    // unknown failure pauses the queue to avoid replaying a lost request.
    if (run.queueOutcome === 'failed') {if (state.queues.get(id)?.length) queuedTurns.paused.add(id);}
    else flushQueue(id);
  }
}

async function regenerateReply() {
  if (state.busy || state.preparing || state.loadingConversation || !state.activeConversationId) return;
  try {await discoverRemoteTarget(state.activeConversationId);}
  catch (error) {composerStatus(localizeError(error));return;}
  if (state.busy) return;
  await requestChat({conversation_id:state.activeConversationId,content:'',retry:true});
}

// ===== Nome della chat =====
// Il titolo nasce dal primo messaggio, subito: non a risposta conclusa.
function titleFromMessage(text, attachments) {
  const source = text.trim() ? text : (attachments?.[0]?.name || 'Chat');
  const title = Array.from(source.replace(/\s+/g, ' ').trim()).slice(0, 40).join('');
  return title || 'Chat';
}

function nameConversationFromMessage(id, text, attachments, editIndex) {
  const found = findConversation(id);
  if (!found || editIndex !== null || state.messages.length) return;
  const title = titleFromMessage(text, attachments);
  if (found.conversation.title === title) return;
  found.conversation.title = title;
  renderMessages();
  renderSidebar();
  persist();
}

// ===== Invio, coda e stop =====
function composerHasContent() {
  return !!composerText().trim() || state.attachments.length > 0;
}

function updateComposerControls() {
  const send = $('#composer-send'), stop = $('#composer-stop');
  const dictating = voice.pending || voice.transcribing || (!!voice.nativeOperation && !voice.recording);
  const recording = !!voice.recording;
  const notReady = state.preparing || state.loadingConversation || state.changingModel || activeConversation()?.conversation.messages_loaded === false;
  const busy = state.busy, run = state.runs.get(state.activeConversationId);
  // Composer vuoto durante un turno: solo Stop. Con un messaggio scritto: Stop e Invia (accodato).
  // Durante la registrazione vocale lo stop del modello non ha senso: resta solo Invia (trascrivi e invia).
  stop.hidden = !busy || recording;
  stop.disabled = !busy || notReady || dictating || recording || !!run?.stopping;
  send.hidden = busy && !composerHasContent() && !recording;
  send.disabled = notReady || dictating;
  const label = t(busy ? 'chat.queue_send' : 'titlebar.send');
  send.setAttribute('aria-label', label);
  send.title = label;
  skillsChooser?.sync();
}

function canStartRequest(id) {
  return !!id && !state.runs.get(id)?.pending && !state.preparing && !voice.pending && !voice.recording && !voice.transcribing && !voice.nativeOperation;
}

async function dispatchMessage(id, message) {
  if (id === state.activeConversationId) {
    composerStatus();
    if (message.edit_index !== null && message.edit_index !== undefined) state.messages = state.messages.slice(0, message.edit_index);
    state.messages.push({role:'user', content:message.content, attachments:message.attachments});
    renderMessages();
  }
  await requestChat({conversation_id:id, content:message.content, attachments:message.attachments, edit_index:message.edit_index});
}

// I messaggi accodati partono uno alla volta, appena la conversazione torna libera.
function flushQueue(id = state.activeConversationId) {
  const queue = state.queues.get(id);
  if (queuedTurns.paused.has(id) || !queue?.length || !canStartRequest(id)) return;
  const [message] = queue.splice(0, 1);
  if (!queue.length) state.queues.delete(id);
  clearQueuedStatus(id);
  dispatchMessage(id, message);
}

async function stopChat() {
  const id = state.activeConversationId, run = state.runs.get(id);
  if (!id || !run?.pending || run.stopping) return;
  run.stopping = true;
  composerStatus(t('chat.stopping'));
  updateComposerControls();
  try { await conversationCommand('stop_chat', {conversation_id:id}); }
  catch (e) {run.stopping = false;updateComposerControls();if (!errText(e).includes('chat_not_running')) composerStatus(localizeError(e));}
}

async function missingActiveProjectFolder() {
  if (remoteTarget(state.activeConversationId)) return null;
  try {
    const project = activeConversation()?.project;
    if (!project) return null;
    if (!project.source_folders.length) return {project, path:null};
    const granted = await invoke('project_folder_access',{project_id:project.id});
    const path = project.source_folders.find(p => !granted.includes(p));
    return path ? { project, path } : null;
  } catch (_) { return null; }
}

async function send() {
  if (voice.recording) return stopVoice(true);
  if (state.preparing || state.loadingConversation || activeConversation()?.conversation.messages_loaded === false || state.changingModel || voice.pending || voice.transcribing || voice.nativeOperation) return;
  const input = $('#composer-input'), text = composerText().trim();
  const attachments = structuredClone(state.attachments), editIndex = state.editingMessageIndex;
  if (!text && !attachments.length) return;
  if (!state.activeConversationId) {
    state.preparing = true;$('#project-select').disabled = true;updateComposerControls();
    try {await ensureConversation();}
    finally {state.preparing=false;$('#project-select').disabled=false;updateComposerControls();}
  }
  const id = state.activeConversationId;
  if (!id) return;
  state.preparing = true;updateComposerControls();
  try {await discoverRemoteTarget(id);}
  catch (error) {composerStatus(localizeError(error));return;}
  finally {state.preparing = false;updateComposerControls();}
  if (id !== state.activeConversationId) return;
  const missingFolder = await missingActiveProjectFolder();
  if (missingFolder) {
    composerStatus(t('project.consent_required'));
    try {
      const path = await invoke('choose_project_folder',{project_id:missingFolder.project.id,lang});
      if (!path) return;
      const index = missingFolder.project.source_folders.indexOf(missingFolder.path);
      if (index >= 0) missingFolder.project.source_folders[index] = path;
      else missingFolder.project.source_folders.push(path);
      if (!await persist()) return;
      composerStatus();
    } catch (e) { composerStatus(localizeError(e)); return; }
  }
  setComposerText('');autoGrow();state.attachments=[];state.editingMessageIndex=null;renderDraft();composerStatus();
  nameConversationFromMessage(id, text, attachments, editIndex);
  input.focus();
  const message = {content:text, attachments, edit_index:editIndex};
  const existing = state.queues.get(id) || [];
  if (existing.length || state.runs.get(id)?.pending) {
    existing.push(message);state.queues.set(id, existing);
    composerStatus(t('chat.queued'));
    refreshQueue(id);
    // Drain older drafts first; a new message never jumps the FIFO queue.
    if (!state.runs.get(id)?.pending) flushQueue(id);
    return;
  }
  await dispatchMessage(id, message);
}

function composerStatus(message = '') {$('#composer-status').textContent=message;$('#composer-status').hidden=!message;}

function renderDraft() {
  renderActivity();
  const list = $('#composer-attachments');list.replaceChildren();
  for (const [index,file] of state.attachments.entries()) {
    const chip=document.createElement('span');chip.className='attachment-chip';
    const name=document.createElement('span');name.textContent=file.name;
    chip.append(icon('file'),name,messageAction('close','chat.remove_attachment',()=>{state.attachments.splice(index,1);renderDraft();}));list.appendChild(chip);
  }
  list.hidden=!state.attachments.length;$('#attachment-note').hidden=!state.attachments.length;
  $('#editing-message').hidden=state.editingMessageIndex===null;updateComposerControls();
}

async function attachFiles() {
  if (state.preparing || state.loadingConversation) return;
  $('#composer-attach').disabled=true;composerStatus();
  try {
    const files=await invoke('choose_chat_files');
    const next=[...state.attachments,...files];
    if(next.length>4 || next.reduce((sum,file)=>sum+new TextEncoder().encode(file.content).length,0)>262144) throw new Error('invalid_attachments');
    state.attachments=next;renderDraft();
  } catch(e){composerStatus(localizeError(e));}
  finally{$('#composer-attach').disabled=false;}
}

function setupComposerExtras() {
  const options=$('#conversation-options');configureMenuTrigger(options);
  options.onclick=()=>{
    const found=activeConversation();if(!found)return;
    showTreeMenu($('.chat-header'),options,found.conversation.title,[
      ['rename','sidebar.rename',()=>renameInline($('#conversation-title'),found.conversation.title,name=>{renameConversation(found.conversation.id,name);renderMessages();})],
      ['copy','chat.copy_conversation',()=>copyText(state.messages.map(m=>`${m.role === 'user' ? t('chat.you') : t('chat.assistant')}:\n${m.content}`).join('\n\n'))],
      ['delete','sidebar.delete',()=>deleteConversation(found.conversation.id)],
    ]);
  };
  $('#composer-attach').onclick=attachFiles;
  $('#cancel-edit').onclick=()=>{state.editingMessageIndex=null;state.attachments=[];clearComposer();autoGrow();renderDraft();};
  setupLocalVoice();
}

function autoGrow() {
  // The composer is a contenteditable element that auto-sizes via CSS.
}

function activeModel() {
  const conversation = activeConversation()?.conversation;
  return conversation?.model || state.config.active_model;
}

// ===== Modello =====
function populateModelSelect() {
  const cur = activeModel();
  const models = new Map((state.config.providers || []).flatMap(provider => provider.models.map(model => [model.id, { provider, model }])));
  const label = id => models.has(id) ? `${models.get(id).provider.name} · ${models.get(id).model.model}` : id || t('chat.model');
  const contents = id => {
    const info = models.get(id);
    const text = document.createElement('span');
    text.textContent = info?.provider.kind === 'deepseek' ? info.model.model : label(id);
    if (info?.provider.kind !== 'deepseek') return [text];
    const logo = document.createElement('img');
    logo.src = 'assets/providers/deepseek.svg'; logo.alt = ''; logo.className = 'model-provider-logo';
    return [logo, text];
  };
  $('#model-name').replaceChildren(...contents(cur));
  $('#model-select').title = `${t('chat.model')}: ${label(cur)}`;
  $('#model-select').setAttribute('aria-label', `${t('chat.model')}: ${label(cur)}`);
  const menu = $('#model-menu');
  menu.replaceChildren();
  for (const m of state.config.models) {
    const option = choiceOption(label(m), m === cur, () => onModelChange(m));
    option.firstElementChild.replaceChildren(...contents(m));
    option.setAttribute('aria-label', label(m));
    menu.appendChild(option);
  }
  const manage = document.createElement('button');
  manage.className = 'model-menu__option';
  manage.setAttribute('role', 'menuitem');
  manage.textContent = t('settings.manage_providers');
  manage.onclick = () => { closeChoiceMenus(); openSettings(); selectSettingsTab('inference'); };
  menu.append(manage);
}

async function onModelChange(model) {
  if (state.busy || state.changingModel) return;
  const conversation = activeConversation()?.conversation;
  const current = activeModel();
  if (model === current) return;
  if (conversation) {
    if (!(await confirmModelChange())) { populateModelSelect(); return; }
    await applyConversationModel(model);
    return;
  }
  const trigger = $('#model-select');
  state.changingModel = true;
  trigger.disabled = true;
  $('#composer-send').disabled = true;
  try {
    state.config = await invoke('set_model', { model });
  } catch (e) {
    showError(localizeError(e));
  } finally {
    populateModelSelect();
    trigger.disabled = false;
    state.changingModel = false;
    $('#composer-send').disabled = false;
    trigger.focus();
  }
}

async function applyConversationModel(model) {
  const id = state.activeConversationId;
  const trigger = $('#model-select');
  state.changingModel = true;
  trigger.disabled = true;
  $('#composer-send').disabled = true;
  try {
    const data = await invoke('set_conversation_model', { conversation_id: id, model });
    state.data = data;
    state.persistedData = structuredClone(data);
    const found = findConversation(id);
    if (found && state.activeConversationId === id) {
      state.messages = (found.conversation.messages || []).slice();
      renderMessages(); updateContextInfo();
    }
  } catch (e) {
    showError(localizeError(e));
  } finally {
    populateModelSelect();
    trigger.disabled = state.busy;
    state.changingModel = false;
    $('#composer-send').disabled = false;
    trigger.focus();
  }
}

function confirmModelChange() {
  const dialog = $('#model-confirm');
  return new Promise(resolve => {
    dialog.onclose = () => resolve(dialog.returnValue === 'switch');
    dialog.returnValue = 'stay';
    dialog.showModal();
  });
}

function choiceOption(label, checked, onSelect) {
  const button = document.createElement('button');
  button.className = 'model-menu__option';
  button.setAttribute('role', 'menuitemradio');
  button.setAttribute('aria-checked', String(checked));
  const text = document.createElement('span');
  text.textContent = label;
  button.append(text, icon('check'));
  button.onclick = () => { closeChoiceMenus(); onSelect(); };
  return button;
}

function populateProjectMenu() {
  refreshPermissions();
  const project = state.data.projects.find(p => p.id === state.pendingProjectId);
  if (!project) state.pendingProjectId = null;
  skillsChooser?.sync();
  $('#project-name').textContent = project?.name || t('chat.no_project');
  const menu = $('#project-menu');
  const choose = id => {
    state.pendingProjectId = id;
    populateProjectMenu();
    $('#project-select').focus();
  };
  menu.replaceChildren(choiceOption(t('chat.no_project'), !project, () => choose(null)));
  for (const p of state.data.projects) menu.appendChild(choiceOption(p.name, p.id === state.pendingProjectId, () => choose(p.id)));
}

let permissionEpoch = 0;
const permissionModes = new Map();
async function refreshPermissions() {
  const epoch = ++permissionEpoch;
  const project = activeConversation()?.project || state.data.projects.find(p => p.id === state.pendingProjectId);
  const control = $('#permission-control'), trigger = $('#permission-select'), menu = $('#permission-menu');
  control.hidden = !project;
  if (!project) { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); return; }
  trigger.disabled = true;
  const cacheKey = `${state.config.firebase_email}:${project.id}`;
  $('#permission-name').textContent = permissionModes.has(cacheKey) ? t(`permissions.${permissionModes.get(cacheKey)}`) : t('ui.loading');
  try {
    const mode = await invoke('project_permission_mode', { project_id:project.id });
    if (epoch !== permissionEpoch) return;
    if (!['ask', 'auto', 'full'].includes(mode)) throw new Error(t('permissions.unavailable'));
    permissionModes.set(cacheKey,mode);$('#permission-name').textContent = t(`permissions.${mode}`);
    control.dataset.mode = mode;
    trigger.querySelector('svg').replaceWith(icon(mode === 'full' ? 'shield-alert' : 'shield'));
    menu.replaceChildren();
    for (const value of ['ask', 'auto', 'full']) {
      const option = choiceOption(t(`permissions.${value}`), value === mode, async () => {
        if (value === 'full' && mode !== 'full' && !await confirmFullAccess(project)) return;
        trigger.disabled = true;
        try { await invoke('project_permission_mode', { project_id:project.id, mode:value }); }
        catch(e) { if (epoch === permissionEpoch) composerStatus(localizeError(e)); }
        finally { if (epoch === permissionEpoch) { await refreshPermissions(); trigger.focus(); } }
      });
      const description = document.createElement('small');description.textContent = t(`permissions.${value}_description`);
      option.querySelector('span').append(description);menu.append(option);
    }
    trigger.disabled = project.conversations.some(c => state.runs.get(c.id)?.pending) || state.preparing;
  } catch(e) {
    if (epoch === permissionEpoch) { $('#permission-name').textContent = t('permissions.unavailable'); trigger.title = localizeError(e); }
  }
}

function closeChoiceMenus() {
  for (const id of ['model', 'project', 'permission']) {
    $(`#${id}-menu`).hidden = true;
    $(`#${id}-select`).setAttribute('aria-expanded', 'false');
  }
}

function setupChoiceMenu(id) {
  const trigger = $(`#${id}-select`), menu = $(`#${id}-menu`);
  function open(last = false) {
    closeTreeMenu();
    hideProjectPreview();
    closeChoiceMenus();
    menu.hidden = false;
    if (id === 'permission') {
      const rect = trigger.getBoundingClientRect();
      menu.style.left = `${Math.max(16, Math.min(rect.left, innerWidth - Math.min(350, innerWidth - 32) - 16))}px`;
      menu.style.bottom = `${innerHeight - rect.top + 8}px`;
    }
    trigger.setAttribute('aria-expanded', 'true');
    const options = menu.querySelectorAll('button');
    (last ? options[options.length - 1] : menu.querySelector('[aria-checked="true"]') || options[0])?.focus();
  }
  trigger.onclick = () => { if (menu.hidden) open(); else closeChoiceMenus(); };
  trigger.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(e.key === 'ArrowUp'); }
  };
  menu.onkeydown = e => {
    const options = [...menu.querySelectorAll('button')];
    const i = options.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeChoiceMenus(); trigger.focus(); }
    if (e.key === 'Tab') closeChoiceMenus();
  };
}

// ===== Contesto =====
function updateContextInfo() {
  const details=$('#context-info'),found=activeConversation();
  const total=found?.conversation.context_tokens || state.lastUsage?.total_tokens || 0;
  details.hidden=!total&&!state.lastUsage;
  $('#context-summary').textContent=t('chat.usage');
  $('#context-details').textContent=state.lastUsage
    ? `${t('chat.input_tokens')}: ${state.lastUsage.prompt_tokens} · ${t('chat.output_tokens')}: ${state.lastUsage.completion_tokens}`
    : `${total} ${t('chat.tokens')}`;
}

// ===== Viste / modal =====
function showView(name) {
  $('#view-onboarding').hidden = name !== 'onboarding';
  $('#view-chat').hidden = name !== 'chat';
  $('#app-rail').hidden = name !== 'chat';
  $('#sidebar-collapse').disabled = name !== 'chat';
  renderActivity();
}

function openSettings() {
  closeTreeMenu();
  hideProjectPreview();
  $('#settings-overlay').hidden = false;
  $('.app').inert = true;
  $('#account-menu').hidden = true;
  $('#account-button').setAttribute('aria-expanded', 'false');
  renderSettingsAccount();
  $('#settings-search').value = '';
  filterSettings();
  selectSettingsTab('general');
  $('#modal-close').focus();
}
function closeSettings() {
  if (!discardProviderEditor()) return;
  $('#settings-overlay').hidden = true;
  $('.app').inert = false;
  $('#btn-settings').focus();
}

// ===== Utility =====
function errText(e) {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    if (typeof e.message === 'string') return e.message;
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

function localizeError(e) {
  const raw = errText(e);
  const key = 'errors.' + raw;
  if (t(key) !== key) return t(key);
  return t('chat.error_prefix') + raw;
}

// Native events only start after the splash has finished restoring normal bounds.
let windowSaveTimer = null;
let windowSaveQueue = Promise.resolve();
let windowExpanded = false;

function saveWindowState() {
  windowSaveQueue = windowSaveQueue.then(() => invoke('save_window_state')).catch(() => {
    showError(t('errors.window_save'));
  });
}

async function prepareWindow(restoreSaved) {
  clearTimeout(windowSaveTimer);
  await windowSaveQueue;
  await invoke('restore_window', { restore_saved: restoreSaved });
  windowExpanded = true;
}

// ===== Init =====
async function init() {
  await loadLocales();
  applyTranslations();
  document.querySelectorAll('[data-icon]').forEach(el => {
    el.replaceWith(icon(el.dataset.icon));
  });
  setupTreeOverlays();
  setupProjectEditor();
  setupComposerExtras();
  setupSidebarSections();
  await setupActivity();
  await appWindow.listen('companion-permissions', () => {refreshPermissions();skillsChooser?.invalidate();if(settingsTab==='skills')refreshSkillSettings();});
  await appWindow.listen('companion-started', async ({payload}) => {
    const id = payload?.conversation_id;if (!id || state.runs.get(id)?.pending) return;
    const run = {pending:true, external:true, since:Date.now(), messages:[], usage:null};
    state.runs.set(id,run);
    try {
      state.data = await invoke('get_data');state.persistedData = structuredClone(state.data);
      const saved = findConversation(id)?.conversation;
      const history = saved?.messages || [];
      const prefix = Number.isInteger(payload.keep_count) ? history.slice(0,payload.keep_count) : history;
      run.messages = [...prefix, payload.message || {role:'user',content:payload.content,attachments:[]}];
      if (state.activeConversationId === id) {state.messages=run.messages;startTimer();renderMessages();updateComposerControls();}
      renderSidebar();
    } catch (error) { showError(localizeError(error)); }
  });
  await appWindow.listen('companion-updated', async ({payload}) => {
    const run = state.runs.get(payload?.conversation_id);
    if (run?.external) {run.pending=false;await finishLiveTurn(run);}
    if (state.preparing || [...state.runs.values()].some(run => run.pending && !run.external)) return;
    try {
      const data = await invoke('get_data');
      state.data = data;state.persistedData = structuredClone(data);
      if (state.activeConversationId && !findConversation(state.activeConversationId)) clearChat();
      const active = findConversation(state.activeConversationId)?.conversation;
      if (active?.messages_loaded) { state.messages = active.messages;renderMessages();updateContextInfo(); }
      if (run?.external) {run.messages=conversationInData(data,payload.conversation_id)?.messages || run.messages;stopTimer();}
      if (run?.external && state.activeConversationId !== payload.conversation_id) state.unread.add(payload.conversation_id);
      renderSidebar();updateComposerControls();
      // The turn ended elsewhere: continue this chat's local FIFO queue.
      if (run?.external) flushQueue(payload.conversation_id);
    } catch (error) { showError(localizeError(error)); }
  });
  await appWindow.listen('open-conversation', ({payload}) => {
    if (typeof payload === 'string' && findConversation(payload)) {showView('chat');openConversation(payload);}
  });
  await appWindow.listen('window-geometry-changed', () => {
    clearTimeout(windowSaveTimer);
    windowSaveTimer = setTimeout(saveWindowState, 1000);
  });
  await setupChatProgress();
  await setupPermissions();
  await setupQuestions();
  setupShell();

  $('#btn-settings').addEventListener('click', openSettings);
  $('#modal-close').addEventListener('click', closeSettings);
  $('#settings-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  // Form
  $('#onboarding-form-slot').innerHTML = formHTML(t('form.submit_onboarding'));
  setupSettings();

  // Sidebar
  $('#btn-new-project').addEventListener('click', newProject);
  $('#btn-new-chat').addEventListener('click', () => newChat());

  // Composer
  skillsChooser = setupProjectSkills();
  const input = $('#composer-input');
  input.addEventListener('input', () => {autoGrow();updateComposerControls();});
  input.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        insertComposerText('\n');
        notifyComposerInput();
      } else {
        send();
      }
    }
  });
  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') || '';
    insertComposerText(text);
    notifyComposerInput();
  });
  $('#composer-send').addEventListener('click', send);
  $('#composer-stop').addEventListener('click', stopChat);
  setupChoiceMenu('model');
  setupChoiceMenu('project');
  setupChoiceMenu('permission');

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    const ok = await handleSubmit(form);
    if (!ok) return;
    if (form.closest('#onboarding-form-slot')) {
      await routeAccount();
    } else {
      closeSettings();
    }
  });

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.currentTarget;
    const error = $('#login-error');
    const button = form.querySelector('button');
    error.hidden = true;
    button.disabled = true;
    try {
      state.config = await invoke('login', { email: form.elements.email.value.trim(), password: form.elements.password.value });
      form.elements.password.value = '';
      await routeAccount();
    } catch (e) {
      error.textContent = localizeError(e);
      error.hidden = false;
    } finally { button.disabled = false; }
  });
  $('#retry-session').addEventListener('click', restoreSession);
  await restoreSession();
}

function welcomeHeading(title, sub) {
  $('.onboarding__title').textContent = t(title);
  $('.onboarding__sub').textContent = t(sub);
}
function showLogin(error) {
  showView('onboarding');
  $('#sidebar').hidden = true;
  $('#login-form').hidden = false;
  $('#onboarding-form-slot').hidden = true;
  $('#restore-error').hidden = true;
  $('#login-form').elements.email.value = state.config.firebase_email || '';
  welcomeHeading('auth.welcome', 'auth.login_note');
  $('#login-error').hidden = !error;
  if (error) $('#login-error').textContent = localizeError(error);
}
async function routeAccount() {
  await prepareWindow(state.config.firebase_auth_set);
  updateAccount();
  populateModelSelect();
  fillForm($('#onboarding-form-slot form'));
  if (!state.config.firebase_auth_set) { showLogin(); return; }
  $('#login-form').hidden = true;
  $('#restore-error').hidden = true;
  if (state.config.api_key_set || state.config.providers?.length === 0) {
    $('#onboarding-form-slot').hidden = true;
    await enterChat();
  } else {
    showView('onboarding');
    $('#sidebar').hidden = true;
    $('#onboarding-form-slot').hidden = false;
    welcomeHeading('auth.configure', 'auth.configure_note');
    const form = $('#onboarding-form-slot form');
    form.querySelectorAll('.field').forEach(field => { field.hidden = !field.querySelector('[name="api_key"]'); });
  }
}
async function restoreSession() {
  $('#boot-splash').hidden = false;
  try {
    state.config = await invoke('get_local_config');
    state.config = await invoke('get_config');
    await routeAccount();
  } catch (e) {
    if (errText(e) === 'session_expired' || errText(e) === 'login_required' || errText(e).startsWith('auth signIn 400:')) {
      showLogin(e);
    } else {
      showView('onboarding');
      $('#sidebar').hidden = true;
      $('#login-form').hidden = true;
      $('#onboarding-form-slot').hidden = true;
      $('#restore-error').hidden = false;
      welcomeHeading('auth.restore_failed', 'auth.retry_note');
      $('#restore-error-text').textContent = localizeError(e);
    }
  } finally {
    if (!windowExpanded) {
      try { await prepareWindow(false); } catch (e) { console.error('Window restore failed', e); }
    }
    $('#boot-splash').hidden = true;
  }
}

async function enterChat() {
  try {
    state.data = await invoke('refresh_data');
    state.persistedData = structuredClone(state.data);
  } catch (e) {
    throw e;
  }
  const all = allConversations();
  if (all.length === 0) {
    clearChat();
    renderSidebar();
  } else {
    all.sort((a, b) => b.updated_at - a.updated_at);
    openConversation(all[0].id);
  }
  $('#sidebar').hidden = false;
  showView('chat');
  preloadRecentConversations(state.activeConversationId);
}

init().catch(e => { showView('onboarding'); console.error('UI initialization failed'); }).finally(() => { $('#boot-splash').hidden = true; });

function updateAccount() {
  const email = state.config.firebase_email || t('ui.account');
  $('.account-name').textContent = email;
  $('#account-email').textContent = email;
  $('.avatar').textContent = email.split('@')[0].slice(0, 2).toUpperCase();
  $('#account-button').title = email;
}
function setupAppMenus() {
  let editTarget = null;
  document.addEventListener('focusin', e => {
    if (e.target.matches('input, textarea')) editTarget = e.target;
  });
  const triggers = [...document.querySelectorAll('[data-app-menu]')];
  const close = () => {
    for (const trigger of triggers) {
      trigger.setAttribute('aria-expanded', 'false');
      $(`#${trigger.getAttribute('aria-controls')}`).hidden = true;
    }
  };
  const edit = command => {
    if (!editTarget?.isConnected || !editTarget.getClientRects().length) return;
    editTarget.focus();
    if (command === 'selectAll') editTarget.select();
    else document.execCommand(command);
  };
  const actions = {
    file: [
      ['sidebar.new_chat', 'Ctrl+N', () => $('#btn-new-chat').click()],
      ['sidebar.new_project', '', () => $('#btn-new-project').click()],
      ['titlebar.settings', 'Ctrl+,', openSettings],
    ],
    edit: [
      ['menu.undo', 'Ctrl+Z', () => edit('undo')],
      ['menu.redo', 'Ctrl+Y', () => edit('redo')],
      ['menu.select_all', 'Ctrl+A', () => edit('selectAll')],
    ],
    view: [
      ['menu.toggle_sidebar', 'Ctrl+B', () => $('#sidebar-collapse').click()],
      ['menu.focus_composer', '', () => $('#composer-input').focus()],
    ],
    help: [['help.shortcuts', '', () => $('#help-dialog').showModal()]],
  };
  function open(trigger, last = false) {
    closeTreeMenu();
    hideProjectPreview();
    close();
    closeChoiceMenus();
    const panel = $(`#${trigger.getAttribute('aria-controls')}`);
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const chatVisible = !$('#view-chat').hidden;
    for (const item of panel.querySelectorAll('button')) {
      item.disabled = trigger.dataset.appMenu === 'help' ? false : trigger.dataset.appMenu === 'edit'
        ? !editTarget?.isConnected || !editTarget.getClientRects().length || editTarget.disabled || editTarget.readOnly
        : !chatVisible || state.preparing;
    }
    const items = panel.querySelectorAll('button:not(:disabled)');
    (last ? items[items.length - 1] : items[0])?.focus();
  }
  for (const trigger of triggers) {
    const panel = $(`#${trigger.getAttribute('aria-controls')}`);
    for (const [key, shortcut, action] of actions[trigger.dataset.appMenu]) {
      const button = document.createElement('button');
      button.className = 'app-menu__item';
      button.setAttribute('role', 'menuitem');
      button.setAttribute('aria-label', t(key));
      const label = document.createElement('span');
      label.textContent = t(key);
      button.appendChild(label);
      if (shortcut) {
        button.setAttribute('aria-keyshortcuts', shortcut.replace('Ctrl', 'Control'));
        const kbd = document.createElement('kbd');
        kbd.textContent = shortcut;
        button.appendChild(kbd);
      }
      button.onclick = () => { close(); trigger.focus(); action(); };
      panel.appendChild(button);
    }
    trigger.onclick = () => { if (panel.hidden) open(trigger); else close(); };
    trigger.onkeydown = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(trigger, e.key === 'ArrowUp'); }
    };
    panel.onkeydown = e => {
      const items = [...panel.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        open(triggers[(triggers.indexOf(trigger) + (e.key === 'ArrowRight' ? 1 : -1) + triggers.length) % triggers.length]);
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); trigger.focus(); }
      if (e.key === 'Tab') close();
    };
  }
  document.addEventListener('click', e => { if (!e.target.closest('.app-menu')) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
    if ($('#project-dialog').open) return;
    if ((!e.ctrlKey && !e.metaKey) || e.altKey || e.shiftKey || !$('#settings-overlay').hidden || $('#help-dialog').open || $('#view-chat').hidden) return;
    const command = { n: () => $('#btn-new-chat').click(), b: () => $('#sidebar-collapse').click(), ',': openSettings }[e.key.toLowerCase()];
    if (command) { e.preventDefault(); close(); command(); }
  });
}

function setupShell() {
  window.addEventListener('resize',closeChoiceMenus);
  $('#sidebar-collapse').onclick = () => {
    closeTreeMenu();
    hideProjectPreview();
    const collapsed = $('.content').classList.toggle('sidebar-collapsed');
    const button = $('#sidebar-collapse');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', t(collapsed ? 'ui.sidebar' : 'ui.collapse'));
    button.title = button.getAttribute('aria-label');
  };
  $('#nav-back').onclick = () => navigateHistory(-1);
  $('#nav-forward').onclick = () => navigateHistory(1);
  $('#nav-home').onclick = () => $('#btn-new-chat').click();
  setupAppMenus();
  $('#account-button').onclick = () => {
    const menu = $('#account-menu'); menu.hidden = !menu.hidden;
    $('#account-button').setAttribute('aria-expanded', String(!menu.hidden));
  };
  document.querySelectorAll('[data-settings-tab]').forEach(b => b.onclick = () => {
    if ($('#settings-overlay').hidden) openSettings();
    selectSettingsTab(b.dataset.settingsTab);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.model-select, .composer__project, .permission-control')) closeChoiceMenus();
    if (!e.target.closest('.rail__footer')) {
      $('#account-menu').hidden = true;
      $('#account-button').setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('#settings-overlay').hidden) closeSettings();
      closeChoiceMenus();
      if (!$('#account-menu').hidden) {
        $('#account-menu').hidden = true;
        $('#account-button').setAttribute('aria-expanded', 'false');
        $('#account-button').focus();
      }
    }
    if (e.key === 'Tab' && !$('#settings-overlay').hidden) {
      const items = [...$('.modal').querySelectorAll('button,input,select,textarea,a[href]')].filter(el => el.getClientRects().length && !el.disabled);
      const first = items[0], last = items[items.length-1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}
