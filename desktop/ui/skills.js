// Catalogs come only from the authenticated native project_skills command.
function setupProjectSkills() {
  const input = document.querySelector('#composer-input');
  const panel = document.querySelector('#skill-chooser');
  const list = document.querySelector('#skill-options');
  const status = document.querySelector('#skill-status');
  const retry = document.querySelector('#skill-retry');
  let context = '', epoch = 0, catalog = null, pending = false, failed = false;
  let dismissed = false, rows = [], selected = 0, lastQuery = '';

  function projectId() {
    return findConversation(state.activeConversationId)?.project?.id || state.pendingProjectId || null;
  }
  function contextKey() {
    return JSON.stringify([state.config.firebase_email, state.activeConversationId, projectId()]);
  }
  function query() {
    if (document.activeElement !== input || state.preparing || state.loadingConversation || state.changingModel ||
        input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length) return null;
    return /^\s*\/([a-zA-Z0-9_-]*)$/.exec(input.value)?.[1].toLowerCase() ?? null;
  }
  function close() {
    panel.hidden = true;list.replaceChildren();rows = [];
    input.setAttribute('aria-expanded', 'false');input.removeAttribute('aria-activedescendant');
    epoch++;catalog = null;pending = false;failed = false;
  }
  function highlight() {
    [...list.children].forEach((row, index) => row.setAttribute('aria-selected', String(index === selected)));
    const active = list.children[selected];
    if (active) {
      input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({block:'nearest'});
    } else input.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    if (context !== contextKey() || query() === null) {sync();return;}
    const skill = rows[index];
    if (!skill) return;
    if (skill.duplicate) {status.textContent = t('skills.duplicate');return;}
    input.value = `/${skill.name} `;
    input.setSelectionRange(input.value.length, input.value.length);
    close();input.dispatchEvent(new Event('input', {bubbles:true}));input.focus();
  }
  function render() {
    const search = query();
    if (search === null || dismissed) {close();return;}
    panel.hidden = false;input.setAttribute('aria-expanded', 'true');
    retry.hidden = !failed;list.replaceChildren();rows = [];
    if (!projectId()) status.textContent = t('skills.no_project');
    else if (pending) status.textContent = t('skills.loading');
    else if (failed) status.textContent = t('skills.failed');
    else if (catalog) {
      const counts = new Map();
      for (const skill of catalog.skills) counts.set(skill.name, (counts.get(skill.name) || 0) + 1);
      rows = catalog.skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(search))
        .map(skill => ({...skill, duplicate:counts.get(skill.name) > 1}));
      status.textContent = !rows.length ? t('skills.no_match') : rows.some(skill => skill.duplicate) ? t('skills.duplicate') : t('skills.keys');
      if (catalog.truncated) status.textContent += ` ${t('skills.truncated')}`;
      rows.forEach((skill, index) => {
        const row = document.createElement('button');row.type = 'button';row.tabIndex = -1;
        row.className = 'skill-option';row.id = `skill-option-${index}`;row.setAttribute('role', 'option');
        row.setAttribute('aria-disabled', String(skill.duplicate));
        const name = document.createElement('span');name.className = 'skill-option__name';name.textContent = `/${skill.name}`;
        const description = document.createElement('span');description.textContent = skill.description;
        const source = document.createElement('span');source.className = 'skill-option__source';
        source.textContent = `${t('skills.root')} ${skill.root} · ${skill.path}${skill.duplicate ? ` · ${t('skills.duplicate_short')}` : ''}`;
        row.append(name, description, source);
        row.addEventListener('pointerdown', event => event.preventDefault());
        row.addEventListener('click', () => choose(index));list.append(row);
      });
    }
    if (search !== lastQuery) selected = 0;
    lastQuery = search;selected = Math.min(selected, Math.max(0, rows.length - 1));highlight();
  }
  async function fetchCatalog() {
    const request = ++epoch, key = context, id = projectId();pending = true;failed = false;render();
    try {
      const result = await invoke('project_skills', {project_id:id});
      if (request !== epoch || key !== contextKey() || key !== context || query() === null || dismissed) return;
      if (!result || !Array.isArray(result.skills)) throw new Error('invalid skill catalog');
      catalog = {truncated:!!result.truncated, skills:result.skills.filter(skill =>
        typeof skill.name === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(skill.name) &&
        Number.isSafeInteger(skill.root) && skill.root >= 0 && typeof skill.description === 'string' &&
        ['.agents', '.codex', '.aurachat'].some(base => skill.path === `${base}/skills/${skill.name}/SKILL.md`))};
    } catch (_) {
      if (request !== epoch || key !== contextKey() || key !== context) return;
      failed = true;
    }
    if (request !== epoch) return;
    pending = false;render();
  }
  function sync() {
    const key = contextKey();
    if (key !== context) {close();context = key;dismissed = false;selected = 0;}
    if (query() === null || dismissed) {if (!panel.hidden) close();return;}
    if (projectId() && !catalog && !pending && !failed) {fetchCatalog();return;}
    render();
  }
  function invalidate() {close();context = '';sync();}
  input.addEventListener('input', () => {dismissed = false;sync();});
  input.addEventListener('focus', () => {dismissed = false;sync();});
  input.addEventListener('click', sync);
  input.addEventListener('blur', event => {if (!panel.contains(event.relatedTarget)) close();});
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    // Recheck context before consuming Enter; an old catalog must never select in a new project.
    sync();
    if (panel.hidden || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault();event.stopImmediatePropagation();
    if (event.key === 'Escape') {dismissed = true;close();}
    else if (event.key === 'Enter') choose(selected);
    else if (rows.length) {selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;highlight();}
  });
  retry.addEventListener('click', () => {input.focus();failed = false;sync();});
  document.addEventListener('pointerdown', event => {if (event.target !== input && !panel.contains(event.target)) {dismissed = true;close();}});
  return {sync, invalidate};
}
