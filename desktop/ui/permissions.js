// Native requests are never trusted from model text; IDs come from the scoped backend queue.
const permissionRequests = new Map();
let permissionRenderFrame = null;

function permissionRecord(conversationId) {
  if (!permissionRequests.has(conversationId)) permissionRequests.set(conversationId, new Map());
  return permissionRequests.get(conversationId);
}

function approvalLabel(item) {
  return t(item.status === 'reviewing' ? 'permissions.reviewing' : item.status === 'pending' ? 'permissions.waiting' : `permissions.${item.status}`);
}

function approvalDetails(item) {
  const details = document.createElement('details');details.className = 'approval-details';
  const summary = document.createElement('summary');summary.textContent = t(item.action?.kind === 'write' ? 'permissions.show_change' : 'permissions.show_command');details.append(summary);
  const action = item.action || {};
  if (action.kind === 'write') {
    for (const [key, label] of [['previous_content','permissions.before'],['content','permissions.after']]) {
      if (action[key] == null) continue;
      const title = document.createElement('p');title.textContent = t(label);
      const code = document.createElement('pre');code.textContent = action[key];details.append(title, code);
    }
    if (action.truncated) {const note = document.createElement('p');note.textContent = t('permissions.preview_truncated');details.append(note);}
  } else {
    const code = document.createElement('pre');code.textContent = JSON.stringify({program:action.program, arguments:action.arguments}, null, 2);details.append(code);
    const note = document.createElement('p');note.textContent = t('permissions.command_scope');details.append(note);
  }
  return details;
}

function renderPermissionRequests() {
  let tray = $('#permission-requests');
  if (!tray) {tray = document.createElement('section');tray.id = 'permission-requests';tray.setAttribute('aria-label', t('permissions.requests'));$('.composer').prepend(tray);}
  const requests = [...(permissionRequests.get(state.activeConversationId)?.values() || [])].filter(r => ['pending','reviewing'].includes(r.status));
  const hadFocus = tray.contains(document.activeElement);
  tray.hidden = !requests.length;
  const existing = new Map([...tray.children].map(el => [el.dataset.requestId, el]));
  for (const item of requests) {
    let card = existing.get(item.id);existing.delete(item.id);
    if (card && card.dataset.status === item.status) continue;
    const replacement = document.createElement('article');replacement.className = 'approval-card';replacement.dataset.requestId = item.id;replacement.dataset.status = item.status;
    const title = document.createElement('div');title.className = 'approval-card__title';
    const label = document.createElement('strong');label.textContent = approvalLabel(item);if (item.status === 'reviewing') label.className = 'is-working-text';
    title.append(icon('shield'), label);
    const path = document.createElement('p');path.className = 'approval-card__path';path.textContent = item.action?.path || '';path.title = path.textContent;
    replacement.append(title, path);
    if (item.reason) {const reason = document.createElement('p');reason.className = 'approval-card__reason';reason.textContent = item.reason === 'review_unavailable' ? t('permissions.review_unavailable') : item.reason;replacement.append(reason);}
    replacement.append(approvalDetails(item));
    if (item.status === 'pending') {
      const actions = document.createElement('div');actions.className = 'approval-card__actions';
      for (const [allow, key] of [[false,'permissions.deny'],[true,'permissions.allow_once']]) {
        const button = document.createElement('button');button.type = 'button';button.textContent = t(key);button.className = allow ? 'approval-allow' : 'approval-deny';
        button.onclick = async () => {
          actions.querySelectorAll('button').forEach(b => b.disabled = true);
          try {await invoke('resolve_approval',{conversation_id:item.conversation_id,id:item.id,allow});}
          catch(e) {composerStatus(localizeError(e));actions.querySelectorAll('button').forEach(b => b.disabled = false);}
        };actions.append(button);
      }
      replacement.append(actions);
    }
    if (card) card.replaceWith(replacement);else tray.append(replacement);
  }
  for (const element of existing.values()) element.remove();
  if (!requests.length && hadFocus) $('#composer-input').focus({preventScroll:true});
}

function retainApproval(item) {
  const record = permissionRecord(item.conversation_id), previous = record.get(item.id);
  if (previous && ((item.revision != null && previous.revision != null && item.revision < previous.revision) || (['approved','denied','cancelled'].includes(previous.status) && ['pending','reviewing'].includes(item.status)))) return false;
  record.set(item.id,item);return true;
}

async function refreshPermissionRequests(conversationId) {
  try {
    const items = await invoke('list_approvals',{conversation_id:conversationId});
    if (!Array.isArray(items)) return;
    for (const item of items) retainApproval(item);
    if (state.activeConversationId === conversationId) renderPermissionRequests();
  } catch (_) { /* A restoring account will receive native events once available. */ }
}

async function setupPermissions() {
  await appWindow.listen('approval-activity', ({payload:item}) => {
    if (!item?.conversation_id || typeof item.id !== 'string' || !['pending','reviewing','approved','denied','cancelled'].includes(item.status)) return;
    if (!retainApproval(item)) return;
    const run = state.runs.get(item.conversation_id);
    if (run?.pending) {
      const stream = run.stream ||= {content:'',shown:0,activity:[],frame:null};
      const previous = stream.activity.find(a => a.kind === 'approval' && a.id === item.id);
      if (previous) Object.assign(previous,item);else stream.activity.push({...item,kind:'approval',offset:stream.content.length});
    }
    if (item.agent_id) {
      const agent = activityRecord(item.conversation_id).agents.get(item.agent_id);
      if (agent && ['running','waiting'].includes(agent.status)) agent.status = ['pending','reviewing'].includes(item.status) ? 'waiting' : 'running';
    }
    if (permissionRenderFrame) return;
    permissionRenderFrame = requestAnimationFrame(() => {
      permissionRenderFrame = null;renderPermissionRequests();renderThinkingStatus();renderActivity();updateLiveTurn();
      // Both sidebar occurrences reflect requests on background conversations.
      renderSidebar();
    });
  });
}

function confirmFullAccess(project) {
  const dialog = $('#permission-confirm');
  $('#permission-confirm-project').textContent = project.name;
  return new Promise(resolve => {
    dialog.onclose = () => resolve(dialog.returnValue === 'allow');
    dialog.returnValue = 'deny';dialog.showModal();
  });
}
