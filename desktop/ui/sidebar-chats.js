// The two sidebar lists have independent disclosures. Keep them through a refresh,
// without writing display preferences into the conversation or the project.
const foldedChats = {projects:new Set(), recents:new Set()};
let foldedOwner;

function chatStatus(id) {
  const run = state.runs.get(id);
  let kind = 'idle', description = t('sidebar.chat_idle_hint');
  if (run?.pending) {
    const question = pendingQuestions(id).length > 0;
    const approval = [...(permissionRequests.get(id)?.values() || [])].some(request => request.status === 'pending');
    kind = question || approval ? 'waiting' : 'running';
    description = t(question ? 'questions.waiting' : approval ? 'permissions.waiting' : 'chat.thinking');
  } else if (state.loadingConversation && id === state.activeConversationId) {
    kind = 'loading';description = t('sidebar.chat_loading');
  } else if (run?.queueOutcome === 'failed') {
    kind = 'failed';description = t('sidebar.chat_failed');
  } else if (run?.queueOutcome === 'cancelled') {
    kind = 'stopped';description = t('chat.stopped');
  } else if (state.unread.has(id)) {
    kind = 'done';description = t('chat.unread');
  }
  const label = t(`sidebar.chat_${kind}`);
  return {kind,label,description};
}

function isViewingConversation(id) {
  return !!id && id === state.activeConversationId && !state.loadingConversation && !state.conversationLoadFailed
    && !state.runs.get(id)?.awaitingHistory
    && !document.hidden && document.hasFocus() && !$('#view-chat').hidden && !$('.app').inert;
}

function markConversationRead(id = state.activeConversationId) {
  return isViewingConversation(id) && state.unread.delete(id);
}

function markConversationFinished(id) {
  if (!findConversation(id)) return;
  if (isViewingConversation(id)) state.unread.delete(id);
  else state.unread.add(id);
}

function acknowledgeVisibleChat() {
  if (markConversationRead()) renderSidebar();
}

function setupChatReadStatus() {
  window.addEventListener('focus', acknowledgeVisibleChat);
  document.addEventListener('visibilitychange', acknowledgeVisibleChat);
}

function appendChatTree(container, chats, section, projectOf, limit = chats.length) {
  const byId = new Map(chats.map(chat => [chat.id, chat])), nodes = new Map();
  const seeds = chats.slice(0,limit), children = new Map();
  // An old standalone child has no other sidebar entry. Keep the whole family
  // reachable if any member falls within the recent window.
  if (limit < chats.length) for (const child of chats) {
    const parent = byId.get(child.linked_from);
    if (!parent || projectOf(child) !== projectOf(parent)) continue;
    if (!children.has(parent.id)) children.set(parent.id,[]);
    children.get(parent.id).push(child);
  }
  for (const seed of seeds) {
    // Include ancestors outside the recent window. A dangling/cyclic link becomes
    // a root instead of losing the conversation or recursing indefinitely.
    const path = [], seen = new Set();
    let chat = seed;
    while (chat && !nodes.has(chat.id) && !seen.has(chat.id)) {
      path.push(chat);seen.add(chat.id);
      const parent = byId.get(chat.linked_from);
      chat = parent && projectOf(parent) === projectOf(chat) ? parent : null;
    }
    let parent = chat && nodes.get(chat.id);
    for (const item of path.reverse()) {
      const branch = document.createElement('div');branch.className = 'chat-node';
      const depth = parent ? parent.depth + 1 : 0;
      branch.style.setProperty('--chat-indent', `${Math.min(4, depth) * 18}px`);
      const row = conversationEl(item, section, projectOf(item));
      branch.append(row);
      if (parent) {
        parent.group ||= chatChildren(parent, section);
        parent.group.append(branch);
      } else container.append(branch);
      parent = {item,branch,row,depth};
      nodes.set(item.id, parent);
      for (const child of children.get(item.id) || []) seeds.push(child);
    }
  }
}

function chatChildren({item, branch, row}, section) {
  const group = document.createElement('div');group.className = 'chat-children';
  group.id = `chat-children-${section}-${item.id}`;group.setAttribute('role','group');
  const title = item.title || t('sidebar.new_chat');
  const label = t('sidebar.linked_chats').replace('{title}',title);
  group.setAttribute('aria-label',label);
  const toggle = document.createElement('button');toggle.type = 'button';toggle.className = 'chat-mark chat-toggle';
  toggle.setAttribute('aria-controls',group.id);toggle.setAttribute('aria-label',label);
  toggle.append(row.querySelector('.chat-indicator'),icon('chevron'));
  const setOpen = open => {group.hidden = !open;toggle.setAttribute('aria-expanded',String(open));};
  setOpen(!foldedChats[section].has(item.id));
  toggle.onclick = () => {
    const open = group.hidden;
    if (open) foldedChats[section].delete(item.id);else foldedChats[section].add(item.id);
    setOpen(open);
  };
  row.querySelector('.chat-mark').replaceWith(toggle);branch.append(group);
  return group;
}

function chatPreview(panel, conv, project) {
  const top = document.createElement('p');top.className = 'chat-preview__meta';
  const current = chatStatus(conv.id);
  const status = document.createElement('span');status.className = 'chat-preview__status';
  status.dataset.status = current.kind;status.textContent = current.label;status.title = current.description;
  top.append(status);
  const date = new Date(conv.created_at);
  if (conv.created_at > 0 && Number.isFinite(date.getTime())) {
    const time = document.createElement('time');
    time.dateTime = date.toISOString();
    time.textContent = t('sidebar.chat_created').replace('{date}',new Intl.DateTimeFormat(lang,{dateStyle:'short',timeStyle:'short'}).format(date));
    top.append(time);
  }
  const title = document.createElement('strong');title.textContent = conv.title || t('sidebar.new_chat');
  const detail = (glyph, content) => {const line = document.createElement('p');line.className = 'chat-preview__detail';line.append(icon(glyph),content);return line;};
  panel.replaceChildren(top,title,detail('project',project?.name || t('chat.no_project')));
  if (conv.model) {
    const provider = state.config.providers?.find(p => p.models.some(m => m.id === conv.model));
    panel.append(detail('cpu',provider ? `${provider.name} · ${provider.models.find(m => m.id === conv.model).model}` : conv.model));
  }
  const usage = detail('usage',document.createElement('span'));
  usage.classList.add('chat-preview__usage');
  usage.setAttribute('role','group');
  setChatPreviewUsage(usage,conv.id);
  panel.append(usage);
}

function setChatPreviewUsage(row, id) {
  const {text,label,pending,idle} = conversationUsage(id);
  row.lastElementChild.textContent = text;
  row.title = label;
  row.setAttribute('aria-label',label);
  row.toggleAttribute('data-live',pending);
  row.toggleAttribute('data-idle',idle);
}

function refreshChatPreviewUsage(id) {
  if (previewRow?.closest('.tree-conv')?.dataset.conversationId !== id) return;
  const row = $('#project-preview .chat-preview__usage');
  if (row) setChatPreviewUsage(row,id);
}

function setupChatPeek(row, title, conv, project) {
  const text = title.firstElementChild;
  const start = () => {
    scheduleTreePreview(row,title,panel => chatPreview(panel,conv,project));
    const travel = text.scrollWidth - title.clientWidth;
    if (travel > 1) {
      text.style.setProperty('--title-travel',`${-travel}px`);
      text.style.setProperty('--title-duration',`${travel / 23}s`);
      title.classList.add('is-overflowing');
    }
  };
  const end = () => {title.classList.remove('is-overflowing');deferHideProjectPreview();};
  row.addEventListener('pointerenter',e => {if (e.pointerType !== 'touch') start();});
  row.addEventListener('pointerleave',end);
  title.addEventListener('focus',start);title.addEventListener('blur',end);
}
