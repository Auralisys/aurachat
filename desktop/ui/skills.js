// Catalogs come only from the authenticated native project_skills command.
function setupProjectSkills() {
  const input = document.querySelector('#composer-input');
  const panel = document.querySelector('#skill-chooser');
  const list = document.querySelector('#skill-options');
  const status = document.querySelector('#skill-status');
  const retry = document.querySelector('#skill-retry');
  const highlight = document.querySelector('#composer-highlight');
  let context = '', epoch = 0, catalog = null, pending = false, failed = false;
  let dismissed = false, rows = [], selected = 0, lastQuery = '';

  function projectId() {
    return findConversation(state.activeConversationId)?.project?.id || state.pendingProjectId || null;
  }
  function contextKey() {
    return JSON.stringify([state.config.firebase_email, state.activeConversationId, projectId()]);
  }
  // Slash token at the caret, anywhere in the message (start or middle).
  function currentToken() {
    if (document.activeElement !== input || state.preparing || state.loadingConversation || state.changingModel) return null;
    const cursor = input.selectionStart;
    if (cursor !== input.selectionEnd) return null;
    const before = input.value.slice(0, cursor);
    const match = /(?:^|\s)\/([a-zA-Z0-9_-]*)$/.exec(before);
    if (!match) return null;
    return {slash: match.index + 1, name: match[1].toLowerCase()};
  }
  function query() {
    return currentToken()?.name ?? null;
  }
  function closeDropdown() {
    panel.hidden = true;list.replaceChildren();rows = [];
    input.setAttribute('aria-expanded', 'false');input.removeAttribute('aria-activedescendant');
  }
  function highlightRow() {
    [...list.children].forEach((row, index) => row.setAttribute('aria-selected', String(index === selected)));
    const active = list.children[selected];
    if (active) {
      input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({block:'nearest'});
    } else input.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    if (context !== contextKey()) {sync();return;}
    const token = currentToken();
    if (!token) {sync();return;}
    const skill = rows[index];
    if (!skill) return;
    if (skill.duplicate) {status.textContent = t('skills.duplicate');return;}
    const end = input.selectionStart;
    const after = input.value[end] || '';
    const separator = after && /\s/.test(after) ? '' : ' ';
    input.value = input.value.slice(0, token.slash) + `/${skill.name}` + separator + input.value.slice(end);
    const caret = token.slash + skill.name.length + 1 + separator.length;
    input.setSelectionRange(caret, caret);
    closeDropdown();input.dispatchEvent(new Event('input', {bubbles:true}));input.focus();
  }
  function render() {
    const search = query();
    if (search === null || dismissed) {closeDropdown();return;}
    panel.hidden = false;input.setAttribute('aria-expanded', 'true');
    retry.hidden = !failed;list.replaceChildren();rows = [];
    if (pending) status.textContent = t('skills.loading');
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
        source.textContent = `${skill.scope === 'global' ? t('skills.global') : `${t('skills.root')} ${skill.root}`} · ${skill.path}${skill.duplicate ? ` · ${t('skills.duplicate_short')}` : ''}`;
        row.append(name, description, source);
        row.addEventListener('pointerdown', event => event.preventDefault());
        row.addEventListener('click', () => choose(index));list.append(row);
      });
    }
    if (search !== lastQuery) selected = 0;
    lastQuery = search;selected = Math.min(selected, Math.max(0, rows.length - 1));highlightRow();
  }
  function syncScroll() {
    if (highlight) {highlight.scrollTop = input.scrollTop;highlight.scrollLeft = input.scrollLeft;}
  }
  // The textarea text is transparent; this backdrop draws the same text and
  // colours installed skills. It always mirrors the full value so text is never hidden.
  function renderHighlight() {
    if (!highlight) return;
    const value = input.value;
    if (!value) {highlight.replaceChildren();syncScroll();return;}
    const names = catalog ? new Set(catalog.skills.map(skill => skill.name.toLowerCase())) : null;
    const fragment = document.createDocumentFragment();
    const regex = /(^|\s)\/([a-zA-Z0-9_-]+)/g;
    let last = 0, match;
    while ((match = regex.exec(value))) {
      if (match.index > last) fragment.append(document.createTextNode(value.slice(last, match.index)));
      if (names && names.has(match[2].toLowerCase())) {
        const token = document.createElement('span');
        token.className = 'skill-token';
        token.textContent = match[0];
        fragment.append(token);
      } else {
        fragment.append(document.createTextNode(match[0]));
      }
      last = regex.lastIndex;
    }
    if (last < value.length) fragment.append(document.createTextNode(value.slice(last)));
    highlight.replaceChildren(fragment);
    syncScroll();
  }
  async function fetchCatalog() {
    const request = ++epoch, key = context, id = projectId();
    pending = true;failed = false;
    if (query() !== null && !dismissed) render();
    try {
      const result = await invoke('project_skills', {project_id:id});
      if (request !== epoch || key !== contextKey() || key !== context) return;
      if (!result || !Array.isArray(result.skills)) throw new Error('invalid skill catalog');
      catalog = {truncated:!!result.truncated, skills:result.skills.filter(skill =>
        typeof skill.name === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(skill.name) &&
        Number.isSafeInteger(skill.root) && skill.root >= 0 && typeof skill.description === 'string' &&
        skill.enabled !== false && !skill.shadowed &&
        ['.agents', '.codex', '.aurachat', '.claude', '.cursor', '.github', '.copilot'].some(base => skill.path === `${base}/skills/${skill.name}/SKILL.md`))};
      renderHighlight();
    } catch (_) {
      if (request !== epoch || key !== contextKey() || key !== context) return;
      failed = true;
    }
    if (request !== epoch) return;
    pending = false;
    if (query() !== null && !dismissed) render();
  }
  function sync() {
    const key = contextKey();
    if (key !== context) {
      context = key;
      catalog = null;pending = false;failed = false;
      epoch++;dismissed = false;selected = 0;lastQuery = '';
      closeDropdown();renderHighlight();
    }
    if (!catalog && !pending && !failed) fetchCatalog();
    if (query() === null || dismissed) {if (!panel.hidden) closeDropdown();return;}
    render();
  }

  function invalidate() {closeDropdown();context = '';catalog = null;sync();}
  input.addEventListener('input', () => {dismissed = false;sync();renderHighlight();});
  input.addEventListener('focus', () => {dismissed = false;sync();});
  input.addEventListener('click', sync);
  input.addEventListener('scroll', syncScroll);
  input.addEventListener('blur', event => {if (!panel.contains(event.relatedTarget)) closeDropdown();});
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    // Recheck context before consuming Enter; an old catalog must never select in a new project.
    sync();
    if (panel.hidden || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault();event.stopImmediatePropagation();
    if (event.key === 'Escape') {dismissed = true;closeDropdown();}
    else if (event.key === 'Enter') choose(selected);
    else if (rows.length) {selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;highlightRow();}
  });
  retry.addEventListener('click', () => {input.focus();failed = false;sync();});
  document.addEventListener('pointerdown', event => {if (event.target !== input && !panel.contains(event.target)) {dismissed = true;closeDropdown();}});
  return {sync, invalidate, renderHighlight};
}

  let skillSettingsEpoch = 0;
  let skillDirectoryEpoch = 0;
  let skillSettingsCatalog = [];
  let skillInstallBusy = false;

  function skillSettingsKey() {
    return JSON.stringify([state.config.firebase_email, $('#skills-project').value]);
  }

  function skillSettingsError(error) {
    $('#skills-settings-error').textContent = localizeError(error);
    $('#skills-settings-error').hidden = false;
  }

  async function refreshSkillSettings(populate = false) {
    skillDirectoryEpoch++;
    const select = $('#skills-project');
    if (populate) {
      select.replaceChildren(new Option(t('skills.global_only'), ''));
      for (const project of state.data.projects) select.append(new Option(project.name, project.id));
      select.value = findConversation(state.activeConversationId)?.project?.id || state.pendingProjectId || '';
      $('#skills-query').value = '';$('#skills-directory').replaceChildren();
    }
    const request = ++skillSettingsEpoch, key = skillSettingsKey();
    $('#skills-settings-error').hidden = true;
    $('#skills-installed').replaceChildren();
    $('#skills-settings-status').textContent = t('skills.loading');
    $('#skills-refresh').disabled = true;
    skillSettingsCatalog = [];
    try {
      const result = await invoke('project_skills', {project_id:select.value || null, include_disabled:true});
      if (request !== skillSettingsEpoch || key !== skillSettingsKey()) return;
      if (!result || !Array.isArray(result.skills)) throw new Error(t('skills.failed'));
      skillSettingsCatalog = result.skills;
      $('#skills-settings-status').textContent = result.truncated ? t('skills.truncated') : '';
      renderInstalledSkills();
    } catch (e) {
      if (request === skillSettingsEpoch && key === skillSettingsKey()) {$('#skills-settings-status').textContent = '';skillSettingsError(e);}
    } finally {if (request === skillSettingsEpoch) $('#skills-refresh').disabled = false;}
  }

  function renderInstalledSkills() {
    const query = $('#skills-query').value.trim().toLocaleLowerCase();
    const list = $('#skills-installed');list.replaceChildren();
    const rows = skillSettingsCatalog.filter(skill => `${skill.name} ${skill.description} ${skill.scope}`.toLocaleLowerCase().includes(query));
    $('#skills-search-directory').disabled = skillInstallBusy || query.length < 2;
    if (!rows.length) list.append(settingsElement('p', 'skills-empty', t(query ? 'skills.no_match' : 'skills.empty')));
    for (const skill of rows) {
      const row = settingsElement('label', 'skill-setting-row');
      const info = settingsElement('span', 'skill-setting-info');
      info.append(settingsElement('strong', '', `/${skill.name}`), settingsElement('span', '', skill.description),
        settingsElement('small', '', `${t(skill.scope === 'global' ? 'skills.global' : 'skills.project')} · ${skill.path}${skill.shadowed ? ` · ${t('skills.shadowed')}` : ''}`));
      const toggle = document.createElement('input');toggle.type = 'checkbox';toggle.role = 'switch';
      toggle.className = 'skill-toggle';toggle.checked = skill.enabled !== false;toggle.disabled = skillInstallBusy;
      toggle.setAttribute('aria-label', `${t('skills.enable')} /${skill.name} · ${t(skill.scope === 'global' ? 'skills.global' : 'skills.project')}`);
      toggle.onchange = async () => {
        const enabled = toggle.checked, key = skillSettingsKey();
        toggle.disabled = true;$('#skills-settings-error').hidden = true;
        try {
          await invoke('set_skill_enabled', {project_id:$('#skills-project').value || null,id:skill.id,enabled});
          if (key !== skillSettingsKey()) return;
          skill.enabled = enabled;skillsChooser?.invalidate();
        } catch (e) {if (key === skillSettingsKey()) {toggle.checked = !enabled;skillSettingsError(e);}}
        finally {toggle.disabled = false;}
      };
      row.append(info,toggle);list.append(row);
    }
  }

  async function searchSkillDirectory(event) {
    event.preventDefault();
    if (skillInstallBusy) return;
    const query = $('#skills-query').value.trim();
    if (query.length < 2) return;
    const request = ++skillDirectoryEpoch, key = skillSettingsKey(), list = $('#skills-directory');
    $('#skills-settings-error').hidden = true;list.replaceChildren();
    $('#skills-settings-status').textContent = t('skills.searching');
    $('#skills-search-directory').disabled = true;
    try {
      const result = await invoke('search_skills', {query});
      if (request !== skillDirectoryEpoch || key !== skillSettingsKey() || query !== $('#skills-query').value.trim()) return;
      if (!result || !Array.isArray(result.skills)) throw new Error(t('skills.failed'));
      $('#skills-settings-status').textContent = result.skills.length ? t('skills.directory_results') : t('skills.directory_empty');
      for (const skill of result.skills) {
        const row = settingsElement('div', 'skill-setting-row');
        const info = settingsElement('span', 'skill-setting-info');
        info.append(settingsElement('strong', '', skill.name), settingsElement('small', '', skill.source));
        const install = settingsElement('button', 'btn', t('skills.install'));install.type = 'button';
        install.onclick = () => installDirectorySkill(skill);
        row.append(info,install);list.append(row);
      }
    } catch (e) {if (request === skillDirectoryEpoch && key === skillSettingsKey()) {$('#skills-settings-status').textContent = '';skillSettingsError(e);}}
    finally {if (request === skillDirectoryEpoch) $('#skills-search-directory').disabled = false;}
  }

  async function installDirectorySkill(skill) {
    if (skillInstallBusy) return;
    const question = t('skills.install_confirm').replace('{name}', skill.name).replace('{source}', skill.source);
    if (!confirm(question)) return;
    skillInstallBusy = true;
    const key = skillSettingsKey();
    $('#skills-settings-error').hidden = true;
    $('#skills-settings-status').textContent = t('skills.installing');
    $('#settings-skills').setAttribute('aria-busy','true');
    const controls = [...$('#settings-skills').querySelectorAll('button,input,select')];
    controls.forEach(control => control.disabled = true);
    try {
      await invoke('install_skill', {source:skill.source,name:skill.name});
      skillsChooser?.invalidate();
      if (key === skillSettingsKey()) {
        $('#skills-query').value = '';$('#skills-directory').replaceChildren();
        await refreshSkillSettings();
        $('#skills-settings-status').textContent = t('skills.installed').replace('{name}',skill.name);
      }
    } catch (e) {if (key === skillSettingsKey()) {$('#skills-settings-status').textContent = '';skillSettingsError(e);}}
    finally {
      skillInstallBusy = false;$('#settings-skills').removeAttribute('aria-busy');
      controls.forEach(control => control.disabled = false);
      $('#skills-search-directory').disabled = $('#skills-query').value.trim().length < 2;
      renderInstalledSkills();
    }
  }

  function setupSkillSettings() {
    $('#skills-project').onchange = () => {$('#skills-directory').replaceChildren();refreshSkillSettings();};
    $('#skills-refresh').onclick = () => refreshSkillSettings();
    $('#skills-directory-search').onsubmit = searchSkillDirectory;
    $('#skills-query').oninput = () => {
      skillDirectoryEpoch++;
      $('#skills-settings-status').textContent = '';$('#skills-directory').replaceChildren();renderInstalledSkills();
    };
  }
