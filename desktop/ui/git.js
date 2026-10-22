// UI-only Git actions: previews never mutate the repository; commit/push need confirmation.
const gitView = {key:null, root:null, manualRoot:false, repositories:null, truncated:false, epoch:0, operation:0, data:null, error:'', statusError:'', loading:false, working:false, staging:null, preview:null, message:'', combined:false, panel:null, editor:null, refreshTimer:null};

function gitProject() {
  return activeConversation()?.project || state.data.projects.find(p => p.id === state.pendingProjectId);
}

function gitContext() {
  const project = gitProject();
  const key = project ? `${state.config.firebase_email}:${project.id}:${(project.source_folders || []).join('|')}` : null;
  if (gitView.key !== key) {
    if ($('#git-push-confirm')?.open) $('#git-push-confirm').close('cancel');
    if ($('#git-discard-confirm')?.open) $('#git-discard-confirm').close('cancel');
    Object.assign(gitView, {key, root:project?.source_folders?.[0], manualRoot:false, repositories:null, truncated:false, epoch:gitView.epoch + 1, data:null, error:'', statusError:'', loading:false, working:false, staging:null, preview:null, message:'', panel:null, editor:null});
    if (project && gitView.root) queueMicrotask(() => refreshGit());
  }
  return project;
}

async function gitRequest(action, extra = {}) {
  const project = gitProject();
  if (!project || (!gitView.root && action !== 'discover')) throw new Error(t('git.no_folder'));
  const epoch = gitView.epoch, root = gitView.root;
  const result = await invoke('project_git', {project_id:project.id, root:root || '', action, conversation_id:state.activeConversationId, ...extra});
  if (epoch !== gitView.epoch || root !== gitView.root) throw new Error(t('git.context_changed'));
  return result;
}

async function refreshGit(background = false) {
  if (gitView.loading || gitView.working || gitView.staging || !gitProject()?.source_folders?.length) return;
  const epoch = gitView.epoch, operation = gitView.operation;
  let root = gitView.root;
  gitView.loading = true;
  if (!background) {gitView.error = '';gitView.panel = null;renderActivity();}
  let changed = !background;
  try {
    if (!background || gitView.repositories === null) {
      const discovery = await gitRequest('discover');
      if (epoch !== gitView.epoch) return;
      gitView.repositories = discovery.repositories;gitView.truncated = discovery.truncated;
      if (!gitView.repositories.includes(root)) {
        root = gitView.root = gitView.repositories[0] || null;
        gitView.manualRoot = false;
        gitView.data = null;gitView.preview = null;gitView.message = '';gitView.editor = null;
      }
    }
    if (!root) {gitView.data = null;gitView.statusError = '';return;}
    let data;
    if (gitView.repositories.length > 1 && !gitView.manualRoot && !gitView.preview && !gitView.message) {
      const statuses = await Promise.all(gitView.repositories.map(async repository => ({
        root:repository, data:await gitRequest('status', {root:repository}),
      })));
      if (epoch !== gitView.epoch || root !== gitView.root || operation !== gitView.operation) return;
      // Prefer line changes, then changed files (including binary files); keep the current root on ties.
      const score = item => [item.data.added + item.data.removed, item.data.files.length];
      const best = statuses.reduce((best, item) => {
        const a = score(item), b = score(best);
        return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) ? item : best;
      }, statuses.find(item => item.root === root) || statuses[0]);
      if (root !== best.root) {
        root = gitView.root = best.root;
        gitView.panel = null;gitView.editor = null;changed = true;
      }
      data = best.data;
    } else {
      data = await gitRequest('status');
    }
    if (epoch !== gitView.epoch || root !== gitView.root) return;
    if (operation !== gitView.operation) {changed = false;return;}
    changed ||= !!gitView.statusError || JSON.stringify(data) !== JSON.stringify(gitView.data);
    gitView.data = data;gitView.statusError = '';
    if (gitView.preview && gitView.preview.index_revision !== data.revision) gitView.preview.stale = true;
  } catch (error) {
    if (epoch === gitView.epoch && root === gitView.root && operation === gitView.operation) {gitView.data = null;gitView.statusError = localizeError(error);changed = true;}
  } finally {
    if (epoch === gitView.epoch && root === gitView.root) {
      gitView.loading = false;
      if (changed) {gitView.panel = null;renderActivity();}
    }
  }
}

function gitButton(key, action, disabled = false) {
  const button = activityText('button', t(key), 'activity-open-link');button.type = 'button';button.onclick = action;button.disabled = disabled || gitView.working;return button;
}

function gitStats(data) {
  const stats = activityText('span', '', 'git-stats');
  stats.append(activityText('span', `+${data.added}`, 'git-added'), activityText('span', `−${data.removed}`, 'git-removed'));
  return stats;
}

function renderGitCard(card) {
  if (!gitContext()) return;
  const group = activityText('section', '', 'activity-group git-group');
  const heading = activityText('button', '', 'activity-group__title');heading.type = 'button';heading.dataset.activityFocus = 'group:git';
  heading.append(activityText('span', t('git.changes')));
  if (gitView.data) heading.append(gitStats(gitView.data));
  heading.classList.add('git-menu-trigger');configureMenuTrigger(heading, 'tree-menu');
  heading.onclick = () => openGitMenu(group, heading);group.append(heading);
  const data = gitView.data;
  if (data) heading.setAttribute('aria-description', `${data.branch || t('git.detached')} · ${data.files.length} ${t('git.files')}`);
  else group.append(activityText('p', gitView.loading ? t('git.loading') : t(gitView.repositories?.length === 0 ? 'git.no_repositories' : 'git.open'), 'activity-empty'));
  if (gitView.truncated) group.append(activityText('p', t('git.discovery_truncated'), 'activity-empty'));
  if (gitView.statusError || gitView.error) group.append(activityText('p', gitView.statusError || gitView.error, 'activity-shell-error'));
  card.append(group);
}

function openGitMenu(row, trigger) {
  const epoch = gitView.epoch, root = gitView.root;
  const current = action => () => {if (epoch === gitView.epoch && root === gitView.root) action();};
  const unavailable = gitView.working || !!gitView.staging || state.busy || !gitView.data?.files.length;
  showTreeMenu(row, trigger, t('git.changes'), [
    ['check', 'git.commit', current(() => gitPreview(false)), unavailable],
    ['send', 'git.commit_push', current(() => gitPreview(true)), unavailable || !gitView.data?.upstream],
    ['file', 'git.open_detail', current(() => openActivity('git'))],
  ]);
}

function gitFiles(side) {return (gitView.data?.files || []).filter(file => file[side]);}

async function gitStage(side, paths) {
  if (gitView.working || state.busy || !gitView.data) return;
  paths = paths.filter(path => !gitPending(path));
  if (!paths.length) return;
  const existing = gitView.staging;
  const queue = gitView.staging ||= {epoch:gitView.epoch, confirmed:structuredClone(gitView.data), jobs:[]};
  queue.jobs.push({side, paths});
  gitView.operation++;gitView.preview = null;gitView.error = '';
  renderQueuedStaging(queue);
  if (existing) return;
  try {
    while (queue.jobs.length && gitView.staging === queue) {
      const job = queue.jobs[0];
      const result = await gitRequest(job.side === 'staged' ? 'unstage' : 'stage', {paths:job.paths, revision:queue.confirmed.revision});
      queue.confirmed = stagedDisplay(queue.confirmed, job);
      queue.confirmed.revision = result.revision;
      queue.jobs.shift();renderQueuedStaging(queue);
    }
  } catch (error) {
    if (gitView.staging === queue) {
      gitView.data = queue.confirmed;gitView.error = localizeError(error);
    }
  } finally {
    if (gitView.staging === queue) {
      gitView.staging = null;gitView.panel = null;renderActivity();scheduleGitRefresh();
    }
  }
}

function stagedDisplay(data, job) {
  const next = structuredClone(data);
  for (const file of next.files) {
    if (!job.paths.includes(file.path)) continue;
    // Pending line totals are provisional until the native status reconciliation.
    const stats = {added:file.added, removed:file.removed, binary:file.binary};
    file.staged = job.side === 'staged' ? null : stats;
    file.unstaged = job.side === 'staged' ? stats : null;
  }
  return next;
}

function gitPending(path) {
  return gitView.staging?.jobs.some(job => job.paths.includes(path)) || false;
}

function renderQueuedStaging(queue) {
  if (gitView.staging !== queue) return;
  gitView.data = queue.jobs.reduce(stagedDisplay, queue.confirmed);
  gitView.panel = null;renderActivity();
}

async function gitDiscard(paths) {
  if (gitView.working || gitView.staging || state.busy || !paths.length) return;
  const epoch = gitView.epoch;
  await gitWork(async () => {
    const preview = await gitRequest('discard_preview', {paths, revision:gitView.data.revision});
    const dialog = $('#git-discard-confirm');
    $('#git-discard-files').replaceChildren(...preview.files.map(file =>
      activityText('li', `${file.path}${file.untracked ? ` · ${t('git.discard_delete_new')}` : ''}`)));
    const accepted = await new Promise(resolve => {
      dialog.returnValue = 'cancel';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'discard'), {once:true});
      dialog.showModal();
    });
    if (!accepted || epoch !== gitView.epoch) return;
    await gitRequest('discard', {paths, revision:preview.revision});
    composerStatus(t('git.discarded'));
  });
  if (epoch === gitView.epoch) scheduleGitRefresh();
}

function renderGitFiles(panel, side) {
  const files = gitFiles(side);
  const section = activityText('section', '', 'git-file-group');section.dataset.gitSide = side;
  const header = activityText('div', '', 'git-file-heading');
  header.append(activityText('h3', `${t(`git.${side}`)} · ${files.length}`));
  const actionKey = side === 'staged' ? 'git.unstage_all' : 'git.stage_all';
  const buttons = activityText('div', '', 'git-file-actions');
  if (side === 'unstaged') {
    const discard = gitButton('git.discard_all', () => gitDiscard(files.map(file => file.path)), !files.length || !!gitView.staging || state.busy);
    discard.classList.add('git-discard-action');buttons.append(discard);
  }
  buttons.append(gitButton(actionKey, () => gitStage(side, files.map(file => file.path)), !files.some(file => !gitPending(file.path)) || state.busy));
  header.append(buttons);
  section.append(header);
  if (!files.length) section.append(activityText('p', t(`git.empty_${side}`), 'activity-empty'));
  for (const file of files) {
    const row = activityText('div', '', 'git-file');
    const stats = file[side];
    const path = activityText('span', file.path, 'git-file-path');path.title = file.path;
    const action = activityButton(`${t(side === 'staged' ? 'git.unstage' : 'git.stage')} · ${file.path}`, side === 'staged' ? 'minimize' : 'plus', () => gitStage(side, [file.path]));
    const pending = gitPending(file.path);
    action.disabled = gitView.working || pending || state.busy;
    row.classList.toggle('is-stage-pending', pending);
    if (pending) {
      row.setAttribute('aria-busy', 'true');
    }
    action.dataset.activityFocus = `${side}:${file.path}`;
    row.append(path);
    if (pending) row.append(activityText('span', t('git.staging_pending'), 'git-file-pending'));
    row.append(stats.binary ? activityText('span', t('git.binary'), 'git-file-stats') : gitStats(stats));
    if (side === 'unstaged') {
      const discard = activityButton(`${t('git.discard')} · ${file.path}`, 'trash', () => gitDiscard([file.path]));
      discard.classList.add('git-discard-action');
      discard.disabled = gitView.working || !!gitView.staging || state.busy;
      discard.dataset.activityFocus = `discard:${file.path}`;
      row.append(discard);
    }
    row.append(action);
    section.append(row);
  }
  panel.append(section);
}

function renderGitPanel(content) {
  if (gitView.panel && content.firstChild === gitView.panel && gitView.panelBusy === state.busy) return;
  gitView.panelBusy = state.busy;
  const panel = activityText('div', '', 'git-panel');gitView.panel = panel;content.replaceChildren(panel);
  const project = gitProject();
  if (!project) {panel.append(activityText('p', t('git.no_folder'), 'activity-empty'));return;}
  if (gitView.repositories?.length > 1) {
    const select = document.createElement('select');select.setAttribute('aria-label', t('git.repository'));
    for (const root of gitView.repositories) {const option = document.createElement('option');option.value = root;option.textContent = root;option.selected = root === gitView.root;select.append(option);}
    select.disabled = gitView.working || gitView.loading || !!gitView.staging;
    select.onchange = () => {gitView.root = select.value;gitView.manualRoot = true;gitView.epoch++;gitView.data = null;gitView.preview = null;gitView.message = '';gitView.editor = null;refreshGit();};panel.append(select);
  }
  const header = activityText('div', '', 'git-actions');
  header.append(gitButton('git.refresh', () => refreshGit(), gitView.loading));
  panel.append(header);
  const error = activityText('p', gitView.statusError || gitView.error, 'activity-shell-error');error.setAttribute('role', 'alert');panel.append(error);
  if (gitView.loading && !gitView.data) {panel.append(activityText('p', t('git.loading'), 'activity-empty'));return;}
  if (gitView.truncated) panel.append(activityText('p', t('git.discovery_truncated'), 'activity-empty'));
  if (gitView.repositories?.length === 0) panel.append(activityText('p', t('git.no_repositories'), 'activity-empty'));
  const data = gitView.data;if (!data) return;
  panel.append(activityText('h3', `${data.branch || t('git.detached')} · ${t('git.changes')}`), gitStats(data));
  panel.append(activityText('p', data.upstream ? `${data.upstream} · ↑${data.ahead} ↓${data.behind}` : t('git.no_upstream'), 'activity-empty'));
  if (!data.files.length) panel.append(activityText('p', t('git.clean'), 'activity-empty'));
  renderGitFiles(panel, 'staged');renderGitFiles(panel, 'unstaged');
  const actions = activityText('div', '', 'git-actions');
  const unavailable = !gitFiles('staged').length || !data.branch || state.busy || gitView.loading || !!gitView.staging;
  actions.append(gitButton('git.commit', () => gitPreview(false), unavailable), gitButton('git.push', () => gitPush(), !data.upstream || !data.ahead || state.busy || !!gitView.staging));
  const more = activityButton(t('git.more'), 'more', () => showTreeMenu(actions, more, 'Git', [['send','git.commit_push',() => gitPreview(true)]]));
  more.classList.add('git-menu-trigger');
  more.disabled = unavailable || gitView.working;configureMenuTrigger(more, 'tree-menu');actions.append(more);panel.append(actions);
  if (gitView.working) panel.append(activityText('p', t('git.working'), 'activity-empty'));
  if (!gitView.preview) return;
  const preview = activityText('section', '', 'git-preview');
  preview.append(activityText('h3', t('git.review')));
  if (gitView.preview.stale) preview.append(activityText('p', t('git.stale'), 'activity-shell-error'));
  const diff = activityText('pre', gitView.preview.diff, 'activity-terminal');diff.tabIndex = 0;diff.setAttribute('aria-label', t('git.diff'));preview.append(diff);
  const label = activityText('label', t('git.message'));label.htmlFor = 'git-message';
  const message = gitView.editor ||= document.createElement('textarea');message.id = 'git-message';message.rows = 4;
  message.dataset.activityFocus = 'git-message';
  if (message.value !== gitView.message) message.value = gitView.message;
  message.disabled = gitView.working;
  message.oninput = () => {gitView.message = message.value;confirm.disabled = !message.value.trim() || gitView.working || gitView.preview?.stale || state.busy;};
  const buttons = activityText('div', '', 'git-actions');
  buttons.append(gitButton('git.generate', () => gitGenerate(), !gitFiles('staged').length));
  const confirm = gitButton(gitView.combined ? 'git.confirm_commit_push' : 'git.confirm_commit', () => gitCommit(), !gitView.message.trim() || gitView.preview.stale || state.busy);
  confirm.classList.add('git-primary');buttons.append(confirm);
  preview.append(label, message, activityText('p', t('git.model_note'), 'activity-empty'), buttons);panel.append(preview);
}

async function gitWork(work) {
  if (gitView.working || gitView.staging) return;
  const epoch = gitView.epoch, root = gitView.root;
  gitView.operation++;
  gitView.working = true;gitView.error = '';gitView.panel = null;renderActivity();
  try {await work();}
  catch (error) {if (epoch === gitView.epoch && root === gitView.root) gitView.error = localizeError(error);}
  finally {if (epoch === gitView.epoch && root === gitView.root) {gitView.working = false;gitView.panel = null;renderActivity();}}
}

async function gitPreview(combined) {
  openActivity('git');
  if (!gitFiles('staged').length) {
    gitView.error = t('git.stage_first');gitView.panel = null;renderActivity();return;
  }
  await gitWork(async () => {
    gitView.preview = await gitRequest('preview');gitView.combined = combined;
  });
}

async function gitGenerate() {
  await gitWork(async () => {
    const result = await gitRequest('generate');
    gitView.preview = result;gitView.message = result.message;
  });
}

async function gitCommit() {
  const combined = gitView.combined;
  const epoch = gitView.epoch;
  let committed = false;
  await gitWork(async () => {
    await gitRequest('commit', {revision:gitView.preview.revision, message:gitView.message});
    committed = true;gitView.preview = null;gitView.message = '';gitView.editor = null;
    composerStatus(t('git.committed'));
  });
  if (committed && epoch === gitView.epoch) {
    await refreshGit();
    if (combined && epoch === gitView.epoch) await gitPush();
  }
}

async function gitPush() {
  const epoch = gitView.epoch;
  await gitWork(async () => {
    const target = await gitRequest('push_preview');
    const dialog = $('#git-push-confirm');$('#git-push-target').textContent = `${target.remote} → ${target.target}\n${target.head}`;
    const accepted = await new Promise(resolve => {dialog.addEventListener('close', () => resolve(dialog.returnValue === 'push'), {once:true});dialog.showModal();});
    if (!accepted || epoch !== gitView.epoch) return;
    await gitRequest('push', {revision:target.revision});composerStatus(t('git.pushed'));
    gitView.data = await gitRequest('status');
  });
}

function scheduleGitRefresh() {
  if (!gitView.key || gitView.refreshTimer) return;
  gitView.refreshTimer = setTimeout(() => {
    gitView.refreshTimer = null;
    if (gitView.loading) scheduleGitRefresh();else refreshGit(true);
  }, 150);
}

async function setupGitEvents() {
  await appWindow.listen('chat-progress', ({payload}) => {
    if (payload?.kind !== '__activity') return;
    try {
      const item = JSON.parse(payload.text);
      if (['write_project_file','edit_project_file','execute_project_command'].includes(item.action) && item.status === 'completed') scheduleGitRefresh();
    } catch (_) { /* Only complete tool events invalidate Git status. */ }
  });
  await appWindow.listen('agent-activity', ({payload}) => {
    if (payload?.activity?.some(item => ['write_project_file','edit_project_file','execute_project_command'].includes(item.action) && item.status === 'completed')) scheduleGitRefresh();
  });
  await appWindow.listen('shell-activity', ({payload}) => {
    if (['completed','failed','cancelled'].includes(payload?.status)) scheduleGitRefresh();
  });
}

window.addEventListener('focus', scheduleGitRefresh);
setInterval(() => {
  if (gitView.key && activity.visible && !document.hidden) refreshGit(true);
}, 2000);
