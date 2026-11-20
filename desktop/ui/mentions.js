// `@` file mentions and files linked by path. A mention is a chip in the composer, but the message text
// carries the absolute path: that is what the model receives. Candidates come only from the authenticated
// search_project_paths command, which stays inside the project's authorized folders.

function pathName(path) {
  const text = String(path ?? '');
  return text.split(/[\\/]/).filter(Boolean).at(-1) || text;
}

// A linked attachment carries only a path: the file stays where it is and is never copied into the chat.
function isLinkedAttachment(file) {
  return typeof file?.path === 'string' && file.path.length > 0 && typeof file.data !== 'string';
}

function attachmentChip(file) {
  const chip = document.createElement('span');chip.className = 'attachment-chip';
  const name = document.createElement('span');name.textContent = file.name;
  chip.append(icon('file'), name);
  return chip;
}

function linkedAttachmentChip(file) {
  const chip = document.createElement('span');chip.className = 'attachment-chip attachment-chip--linked';
  const open = document.createElement('button');open.type = 'button';open.className = 'attachment-chip__open';
  open.title = file.path;open.setAttribute('aria-label', `${t('mentions.open')}: ${file.path}`);
  const name = document.createElement('span');name.textContent = file.name;
  open.append(icon('link'), name);
  open.onclick = () => openMentionedPath(file.path);
  chip.append(open);
  return chip;
}

function mentionProjectId() {
  return findConversation(state.activeConversationId)?.project?.id || state.pendingProjectId || null;
}

// Shows a mentioned or linked file in the side panel. Only files inside the project folders can be previewed.
async function openMentionedPath(path) {
  if (typeof path !== 'string' || !path) return;
  const id = `file:${path}`, record = activityRecord(state.activeConversationId);
  const source = {id, title: pathName(path), summary: t('mentions.file'), path, plain: true, note: t('mentions.loading')};
  record.sources.set(id, source);
  openActivity('sources', id);
  const projectId = mentionProjectId();
  try {
    if (!projectId) throw new Error('outside_project');
    const preview = await invoke('preview_project_path', {project_id: projectId, path});
    if (record.sources.get(id) !== source) return;
    delete source.note;
    if (preview?.kind === 'image' && typeof preview.data === 'string') {
      source.kind = 'image';source.image = {name: source.title, mime_type: preview.mime_type, data: preview.data, content: ''};
    } else if (preview?.kind === 'text') {
      source.content = preview.content;
      if (!preview.content) source.note = t('mentions.empty');
      else if (preview.truncated) source.note = t('mentions.truncated');
    } else source.note = t('mentions.binary');
  } catch (error) {
    if (record.sources.get(id) !== source) return;
    source.note = String(error?.message || error) === 'file_unavailable' ? t('mentions.unavailable') : t('mentions.outside');
  }
  scheduleActivityRender();
}

function setupFileMentions() {
  const input = document.querySelector('#composer-input');
  const panel = document.querySelector('#mention-chooser');
  const list = document.querySelector('#mention-options');
  const status = document.querySelector('#mention-status');
  const CONTROLS = input.getAttribute('aria-controls');
  let context = '', epoch = 0, timer = null, pending = false, failed = false, dismissed = false;
  let results = null, rows = [], selected = 0, lastQuery = '';

  function contextKey() {
    return JSON.stringify([state.config.firebase_email, state.activeConversationId, mentionProjectId()]);
  }
  // The last `@` before the caret that starts a word, with no chip or whitespace after it.
  function currentToken() {
    if (document.activeElement !== input || state.preparing || state.loadingConversation || state.changingModel) return null;
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed) return null;
    const cursor = caretOffset();
    // Chips count as opaque characters so that a path inside one is never read as typed text.
    let masked = '';
    for (const part of composerNodes()) masked += part.pasted ? '\u0000'.repeat(part.text.length) : part.text;
    const before = masked.slice(0, cursor);
    const at = before.lastIndexOf('@');
    if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
    const query = before.slice(at + 1);
    if (query.length > 120 || /[\s@\u0000]/.test(query)) return null;
    return {at, query};
  }
  function closePanel() {
    clearTimeout(timer);
    panel.hidden = true;list.replaceChildren();rows = [];
    if (input.getAttribute('aria-controls') === 'mention-options') {
      input.setAttribute('aria-controls', CONTROLS);input.setAttribute('aria-expanded', 'false');input.removeAttribute('aria-activedescendant');
    }
  }
  function highlightRow() {
    [...list.children].forEach((row, index) => row.setAttribute('aria-selected', String(index === selected)));
    const active = list.children[selected];
    if (active) {
      input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({block: 'nearest'});
    } else input.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    const token = currentToken(), file = rows[index];
    if (!token || !file || context !== contextKey() || results?.query !== token.query) {sync();return;}
    const selection = window.getSelection();
    selection.removeAllRanges();selection.addRange(composerRange(token.at, token.at + 1 + token.query.length));
    closePanel();
    if (!insertPastedNode(mentionToken(file.path))) return;
    if (!/^\s/.test(composerText().slice(caretOffset()))) insertComposerText(' ');
    notifyComposerInput();
    input.focus();
  }
  function render() {
    const token = currentToken();
    if (!token || dismissed) {closePanel();return;}
    const fresh = results?.query === token.query;
    if (!mentionProjectId()) {
      if (token.query) {closePanel();return;}
      rows = [];status.textContent = t('mentions.no_project');
    } else if (failed) {
      rows = [];status.textContent = t('mentions.failed');
    } else if (!results || (!fresh && !results.files.length)) {
      rows = [];status.textContent = t('mentions.loading');
    } else if (fresh && results.noFolders) {
      // Unlike a plain search with no hits, an empty `@` explains why nothing can be suggested.
      if (token.query) {closePanel();return;}
      rows = [];status.textContent = t('mentions.no_folders');
    } else if (fresh && !results.files.length) {
      if (token.query) {closePanel();return;}
      rows = [];status.textContent = t('mentions.empty_project');
    } else {
      rows = results.files;
      status.textContent = `${t('mentions.keys')}${results.truncated ? ` ${t('mentions.truncated_list')}` : ''}`;
    }
    panel.hidden = false;input.setAttribute('aria-expanded', 'true');input.setAttribute('aria-controls', 'mention-options');
    list.replaceChildren();
    rows.forEach((file, index) => {
      const row = document.createElement('button');row.type = 'button';row.tabIndex = -1;
      row.className = 'skill-option mention-option';row.id = `mention-option-${index}`;row.setAttribute('role', 'option');
      row.title = file.path;
      const name = document.createElement('span');name.className = 'skill-option__name';name.textContent = file.name;
      const where = document.createElement('span');where.className = 'skill-option__source';where.textContent = file.relative;
      row.append(name, where);
      row.addEventListener('pointerdown', event => event.preventDefault());
      row.addEventListener('click', () => choose(index));list.append(row);
    });
    if (token.query !== lastQuery) selected = 0;
    lastQuery = token.query;selected = Math.min(selected, Math.max(0, rows.length - 1));highlightRow();
  }
  async function search(query, key) {
    const request = ++epoch;
    pending = true;failed = false;
    try {
      const result = await invoke('search_project_paths', {project_id: mentionProjectId(), query: query.replace(/\\/g, '/')});
      if (request !== epoch || key !== contextKey()) return;
      if (!result || !Array.isArray(result.files)) throw new Error('invalid file search');
      results = {query, truncated: !!result.truncated, noFolders: result.no_folders === true,
        files: result.files.filter(file => typeof file?.path === 'string' && typeof file.name === 'string' && typeof file.relative === 'string')};
    } catch (_) {
      if (request !== epoch || key !== contextKey()) return;
      failed = true;results = null;
    }
    pending = false;
    render();
  }
  function sync() {
    const key = contextKey();
    if (key !== context) {
      context = key;results = null;pending = false;failed = false;
      epoch++;dismissed = false;selected = 0;lastQuery = '';
      closePanel();
    }
    const token = currentToken();
    if (!token || dismissed) {if (!panel.hidden) closePanel();return;}
    if (mentionProjectId() && !failed) {
      clearTimeout(timer);
      if (results?.query === token.query) {epoch++;pending = false;}
      else {
        // Debounce typing: the previous rows stay visible but cannot be chosen until the new ones arrive.
        pending = true;
        timer = setTimeout(() => {if (currentToken()?.query === token.query && context === contextKey()) search(token.query, context);}, results ? 120 : 0);
      }
    }
    render();
  }

  input.addEventListener('input', () => {dismissed = false;failed = false;sync();});
  input.addEventListener('focus', () => {dismissed = false;sync();});
  input.addEventListener('click', sync);
  input.addEventListener('blur', event => {if (!panel.contains(event.relatedTarget)) closePanel();});
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    // A caret move changes the token without an input event.
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) setTimeout(sync, 0);
    if (panel.hidden || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
    if (event.key === 'Tab' && !rows.length) return;
    event.preventDefault();event.stopImmediatePropagation();
    const current = results?.query === currentToken()?.query && !pending;
    if (event.key === 'Escape') {dismissed = true;closePanel();}
    else if (event.key === 'Enter' || event.key === 'Tab') {if (current && rows.length) choose(selected);}
    else if (rows.length) {selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;highlightRow();}
  });
  document.addEventListener('pointerdown', event => {if (event.target !== input && !panel.contains(event.target)) {dismissed = true;closePanel();}});
  return {sync};
}
