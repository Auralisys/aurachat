// The side panel owns browser tabs and the existing conversation tools.
// Native pages stay alive when hidden, but never paint over a dialog or menu.
const browserPage = {open:false, expanded:false, tabs:[], active:null, frame:0, owner:null};
const BROWSER_WIDTH = {min:360, keep:420, key:'aurachat.browserWidth'};
const BROWSER_FLOATING = '.overlay:not([hidden]), .tree-menu:not([hidden]), .project-preview:not([hidden]), .model-menu:not([hidden]), .app-menu__panel:not([hidden]), .account-menu:not([hidden]), .boot-splash:not([hidden]), .context-info[open] > div, .activity-dock.is-visible';
let browserQueue = Promise.resolve();

function browserIsOpen() { return browserPage.open; }
function activePanelTab() { return browserPage.tabs.find(tab => tab.id === browserPage.active); }
function panelHasTab(tab) { return browserPage.tabs.includes(tab); }
function panelShows(section) { return browserPage.open && activePanelTab()?.section === section; }

function browserIcon(name) {
  return lucide.icons[name] ? lucide.createElement(lucide.icons[name], {class:'ui-icon', 'aria-hidden':'true'}) : icon('more');
}

function queueBrowser(work) {
  const run = browserQueue.then(work);
  browserQueue = run.catch(() => {}); // The caller handles the error; the queue must remain usable.
  return run;
}

function setBrowserStatus(text = '', tab = activePanelTab()) {
  if (tab) tab.status = text;
  if (tab !== activePanelTab()) return;
  const status = $('#browser-status');status.textContent = text;status.hidden = !text;
}

function browserError(error, tab) {
  console.error('Browser operation failed:', error);
  setBrowserStatus(localizeError(error), tab);
}

function browserCovered(panel) {
  if ($('#view-chat').hidden || $('.main').inert || document.querySelector('dialog[open]')) return true;
  const area = panel.getBoundingClientRect();
  return [...document.querySelectorAll(BROWSER_FLOATING)].some(element => {
    const box = element.getBoundingClientRect();
    return box.width && box.height && box.left < area.right && box.right > area.left && box.top < area.bottom && box.bottom > area.top;
  });
}

function browserBounds() {
  const box = $('#browser-view').getBoundingClientRect();
  return {x:Math.max(0, Math.round(box.left)), y:Math.max(0, Math.round(box.top)),
    width:Math.max(1, Math.round(box.width)), height:Math.max(1, Math.round(box.height))};
}

// Serialize native operations and read the active tab at execution time, not when queued.
function syncBrowser() {
  if (browserPage.frame) return;
  browserPage.frame = requestAnimationFrame(() => {
    browserPage.frame = 0;
    queueBrowser(async () => {
      const active = activePanelTab(), view = $('#browser-view');
      const bounds = browserBounds();
      const visible = browserPage.open && !view.hidden && view.clientWidth > 1 && view.clientHeight > 1 && !browserCovered($('#browser-panel'));
      // Hide first, so switching tabs cannot briefly expose two native pages.
      const pages = browserPage.tabs.filter(tab => tab.page).sort((a, b) => Number(a === active) - Number(b === active));
      for (const tab of pages) {
        const shown = visible && tab === active;
        const key = shown ? JSON.stringify(bounds) : 'hidden';
        if (tab.shown === key) continue;
        try {
          await invoke('browser_bounds', {tab_id:tab.id, bounds, visible:shown});
          tab.shown = key;
        } catch (error) {tab.shown = null;browserError(error, tab);}
      }
    }).catch(error => browserError(error, activePanelTab()));
  });
}

function panelTabTitle(tab) {
  if (tab.section === 'git') return `${t('git.changes')}${gitProject() ? ` · ${gitProject().name}` : ''}`;
  if (tab.section) return t(`activity.${tab.section}`);
  if (tab.title) return tab.title;
  if (tab.url) {
    try {return new URL(tab.url).hostname;} catch (_) {return tab.url;}
  }
  return t('panel.new_tab');
}

function renderPanelTabs() {
  const list = $('#panel-tabs');
  for (const node of [...list.children]) if (!browserPage.tabs.some(tab => tab.id === node.dataset.tabId)) node.remove();
  for (const tab of browserPage.tabs) {
    let node = [...list.children].find(node => node.dataset.tabId === tab.id);
    if (!node) {
      node = document.createElement('div');node.className = 'panel-tab';node.dataset.tabId = tab.id;
      const select = document.createElement('button');select.type = 'button';select.className = 'panel-tab__select';
      select.id = `panel-tab-${tab.id}`;select.setAttribute('role', 'tab');select.setAttribute('aria-controls', 'panel-content');
      select.onclick = () => selectPanelTab(tab);
      select.onkeydown = event => {
        const index = browserPage.tabs.indexOf(tab), count = browserPage.tabs.length;
        const next = {ArrowLeft:(index - 1 + count) % count, ArrowRight:(index + 1) % count, Home:0, End:count - 1}[event.key];
        if (next !== undefined) {event.preventDefault();selectPanelTab(browserPage.tabs[next], {focus:true});}
        if (event.key === 'Delete') {event.preventDefault();closePanelTab(tab);}
      };
      const glyph = document.createElement('span');glyph.className = 'panel-tab__icon';glyph.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');label.className = 'panel-tab__label';
      select.append(glyph, label);
      const close = activityButton(t('panel.close_tab'), 'close', () => closePanelTab(tab));
      close.classList.add('panel-tab__close');
      node.append(select, close);list.append(node);
      node.onauxclick = event => {if (event.button === 1) {event.preventDefault();closePanelTab(tab);}};
    }
    const selected = tab.id === browserPage.active, title = panelTabTitle(tab);
    node.classList.toggle('is-active', selected);
    const select = node.querySelector('[role=tab]');
    select.setAttribute('aria-selected', String(selected));select.tabIndex = selected ? 0 : -1;select.title = title;
    node.querySelector('.panel-tab__label').textContent = title;
    const glyphName = tab.section === 'git' ? 'git' : {outputs:'file',sources:'sources',agents:'agents',shells:'terminal'}[tab.section] || 'globe';
    const glyph = node.querySelector('.panel-tab__icon');
    if (glyph.dataset.icon !== glyphName) {glyph.dataset.icon = glyphName;glyph.replaceChildren(icon(glyphName));}
    glyph.classList.toggle('is-loading', !!tab.loading);
    const close = node.querySelector('.panel-tab__close');
    close.setAttribute('aria-label', `${t('panel.close_tab')}: ${title}`);
    close.disabled = !!(tab.busy || tab.closing);
  }
  if (browserPage.active) $('#panel-content').setAttribute('aria-labelledby', `panel-tab-${browserPage.active}`);
}

function renderBrowser() {
  const panel = $('#browser-panel'), toggle = $('#panel-toggle'), tab = activePanelTab();
  const open = browserPage.open && !$('#view-chat').hidden;
  panel.hidden = !open;panel.inert = $('.main').inert;
  document.querySelector('.workspace').classList.toggle('has-browser', open);
  document.querySelector('.workspace').classList.toggle('panel-expanded', open && browserPage.expanded);
  toggle.setAttribute('aria-expanded', String(open));toggle.classList.toggle('is-active', open);
  const expand = $('#panel-expand'), expandLabel = t(browserPage.expanded ? 'panel.restore' : 'panel.expand');
  expand.title = expandLabel;expand.setAttribute('aria-label', expandLabel);
  expand.setAttribute('aria-pressed', String(browserPage.expanded));
  expand.replaceChildren(icon(browserPage.expanded ? 'restore' : 'expand'));
  renderPanelTabs();
  const browser = tab && !tab.section;
  $('#browser-bar').hidden = !browser;$('#browser-view').hidden = !browser;
  $('#activity-panel').hidden = !tab?.section;
  const reload = $('#browser-reload');
  reload.replaceChildren(browserIcon(tab?.loading ? 'X' : 'RotateCw'));
  const reloadLabel = t(tab?.loading ? 'browser.stop' : 'browser.reload');
  reload.title = reloadLabel;reload.setAttribute('aria-label', reloadLabel);
  ['#browser-back', '#browser-forward', '#browser-reload', '#browser-external'].forEach(id => {$(id).disabled = !browser || !tab.page;});
  const capture = $('#browser-capture');
  capture.hidden = !!(tab?.page && !tab.capture);
  capture.disabled = !browser || !tab.page || tab.busy;
  panel.setAttribute('aria-busy', String(!!(browser && tab.loading)));
  $('#browser-progress').hidden = !browser || !tab.loading;
  $('#browser-empty').hidden = !browser || tab.page || tab.opening;
  const address = $('#browser-address');
  const value = tab?.address ?? tab?.url ?? '';
  if (address.value !== value) address.value = value;
  address.title = tab?.title || tab?.url || '';
  const status = $('#browser-status');status.textContent = tab?.status || '';status.hidden = !browser || !tab.status;
  const git = $('#panel-open-git');
  git.disabled = !gitProject()?.source_folders?.length;
  $('#panel-git-note').hidden = !git.disabled;
  syncBrowser();
}

function rememberPanelTab(tab) {
  if (!tab) return;
  if (tab.section) {
    Object.assign(tab, {selected:activity.selected, filter:activity.filter, scroll:$('#activity-panel-content').scrollTop});
  } else tab.address = $('#browser-address').value;
}

function selectPanelTab(tab, {focus = false} = {}) {
  if (!panelHasTab(tab)) return;
  const previous = activePanelTab(), wasOpen = browserPage.open;
  rememberPanelTab(previous);
  browserPage.active = tab.id;browserPage.open = true;
  activity.section = tab.section || null;activity.selected = tab.selected || null;activity.filter = tab.filter || 'all';
  renderActivity();
  if (!wasOpen) setBrowserWidth(Number(localStorage.getItem(BROWSER_WIDTH.key)) || document.querySelector('.workspace').clientWidth * 0.46, false);
  if (previous !== tab) {
    $('#activity-panel-content').scrollTop = tab.scroll || 0;
    $('#browser-address').value = tab.address ?? tab.url;
  }
  if (focus) $(`#panel-tab-${tab.id}`).focus({preventScroll:true});
  $(`#panel-tab-${tab.id}`).parentElement.scrollIntoView({block:'nearest', inline:'nearest'});
}

function newPanelTab(section = null) {
  const tab = {id:crypto.randomUUID(), section, page:false, capture:false, url:'', address:'', title:'', loading:false, busy:false, opening:false, closing:false, stateVersion:0, shown:null, status:'', selected:null, filter:'all', scroll:0};
  browserPage.tabs.push(tab);
  selectPanelTab(tab);
  if (!section) {$('#browser-address').focus();$('#browser-address').select();}
  return tab;
}

function openPanelSection(section, selected = null) {
  let tab = browserPage.tabs.find(tab => tab.section === section);
  if (!tab) {
    const blank = activePanelTab();
    if (blank && !blank.section && !blank.page && !blank.opening && !blank.address.trim()) {
      tab = blank;tab.section = section;
    } else tab = newPanelTab(section);
  }
  selectPanelTab(tab);
  if (tab.selected !== selected) tab.scroll = 0;
  tab.selected = selected;activity.selected = selected;
  if (section !== 'outputs') tab.filter = activity.filter = 'all';
  renderActivity();$('#activity-panel-content').scrollTop = tab.scroll;
  $('#activity-panel-title').focus();
}

async function closePanelTab(tab = activePanelTab()) {
  if (!panelHasTab(tab) || tab.busy || tab.closing) return;
  tab.closing = true;renderPanelTabs();
  if (!tab.section) {
    try {await queueBrowser(() => invoke('browser_close', {tab_id:tab.id}));}
    catch (error) {
      tab.closing = false;tab.shown = null;
      browserError(error, tab);composerStatus(localizeError(error));renderBrowser();return;
    }
  }
  const index = browserPage.tabs.indexOf(tab), wasActive = tab.id === browserPage.active;
  if (index < 0) return;
  browserPage.tabs.splice(index, 1);
  if (wasActive) {
    const next = browserPage.tabs[Math.min(index, browserPage.tabs.length - 1)];
    browserPage.active = null;
    if (next) selectPanelTab(next, {focus:true});
    else closeBrowser();
  }
  renderActivity();
}

function showBrowserPanel() {
  if (!browserPage.tabs.length) newPanelTab();
  else selectPanelTab(activePanelTab() || browserPage.tabs[0]);
  const saved = Number(localStorage.getItem(BROWSER_WIDTH.key));
  if (saved) setBrowserWidth(saved, false);
}

function closeBrowser() {
  rememberPanelTab(activePanelTab());
  browserPage.open = false;browserPage.expanded = false;
  renderActivity();$('#panel-toggle').focus();
}

async function openBrowser(url, {focus = false, newTab = false} = {}) {
  let tab = activePanelTab();
  if (newTab || !tab || tab.section) tab = newPanelTab();
  else selectPanelTab(tab);
  if (!url) {
    if (focus) {$('#browser-address').focus();$('#browser-address').select();}
    return;
  }
  tab.address = url;tab.opening = true;tab.loading = true;setBrowserStatus('', tab);renderBrowser();
  await queueBrowser(async () => {
    if (!panelHasTab(tab)) return;
    try {
      const version = tab.stateVersion;
      const opened = await invoke('browser_open', {tab_id:tab.id, url, bounds:browserBounds()});
      tab.page = true;tab.capture = !!opened.capture;tab.shown = null;
      if (tab.stateVersion === version) tab.url = opened.url;
      if (tab.address === url) tab.address = tab.url;
    } catch (error) {tab.loading = false;browserError(error, tab);}
    finally {tab.opening = false;}
  });
  if (panelHasTab(tab)) renderBrowser();
}

async function browserAction(action) {
  const tab = activePanelTab();
  if (!tab?.page) return;
  try {await queueBrowser(() => invoke('browser_action', {tab_id:tab.id, action}));}
  catch (error) {browserError(error, tab);}
}

async function openExternalBrowserPage() {
  const tab = activePanelTab();
  if (!tab?.url) return;
  try {await invoke('open_external_url', {url:tab.url});}
  catch (error) {browserError(error, tab);}
}

function browserCaptureName(page) {
  let host = '';
  try {host = new URL(page.url).hostname.replace(/^www\./, '');} catch (_) {}
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return `${(host || 'page').replace(/[^\w.-]+/g, '-').slice(0, 60)}-${stamp}.png`;
}

async function captureBrowser() {
  const tab = activePanelTab();
  if (!tab?.page || tab.busy) return;
  const conversationId = state.activeConversationId, projectId = state.pendingProjectId;
  tab.busy = true;renderBrowser();setBrowserStatus(t('browser.capturing'), tab);
  try {
    const shot = await queueBrowser(() => invoke('browser_capture', {tab_id:tab.id}));
    if (!panelHasTab(tab) || conversationId !== state.activeConversationId || projectId !== state.pendingProjectId) throw new Error(t('browser.capture_context_changed'));
    const file = await prepareImage({data:shot.data, mime_type:shot.mime_type, name:browserCaptureName(shot)});
    setBrowserStatus('', tab);
    const annotation = await openAnnotator(file, {opener:$('#browser-capture'), meta:{source:'browser', url:shot.url, title:shot.title, captured_at:Date.now()}});
    if (annotation === undefined) return;
    if (!panelHasTab(tab) || conversationId !== state.activeConversationId || projectId !== state.pendingProjectId) throw new Error(t('browser.capture_context_changed'));
    if (annotation) file.annotation = annotation;
    await addImageAttachments([{prepared:true, file}]);
    setBrowserStatus(t('browser.attached'), tab);
  } catch (error) {browserError(error, tab);}
  finally {tab.busy = false;renderBrowser();}
}

// Links get their own tab; modifier-click keeps the system browser.
async function openLink(url, event) {
  if (event?.ctrlKey || event?.metaKey || event?.shiftKey) {
    try {await invoke('open_external_url', {url});} catch (_) {composerStatus(t('chat.link_failed'));}
    return;
  }
  await openBrowser(url, {newTab:true});
}

function setBrowserWidth(width, save = true) {
  const workspace = document.querySelector('.workspace').clientWidth;
  const sidebar = $('.sidebar').getBoundingClientRect().width;
  const max = Math.max(BROWSER_WIDTH.min, workspace - sidebar - BROWSER_WIDTH.keep);
  const next = Math.round(Math.min(max, Math.max(BROWSER_WIDTH.min, width)));
  $('#browser-panel').style.setProperty('--browser-width', `${next}px`);
  const handle = $('#browser-resize');
  handle.setAttribute('aria-valuenow', String(next));handle.setAttribute('aria-valuemin', String(BROWSER_WIDTH.min));handle.setAttribute('aria-valuemax', String(Math.round(max)));
  if (save) try {localStorage.setItem(BROWSER_WIDTH.key, String(next));} catch (error) {console.warn('Panel width could not be saved:', error);}
  requestAnimationFrame(() => {
    if (browserPage.open) $(`#panel-tab-${browserPage.active}`)?.parentElement.scrollIntoView({block:'nearest', inline:'nearest'});
  });
  syncBrowser();
}

function setupBrowserResize() {
  const handle = $('#browser-resize'), panel = $('#browser-panel');
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();handle.setPointerCapture(event.pointerId);
    const right = panel.getBoundingClientRect().right;
    panel.classList.add('is-resizing');
    const move = moved => setBrowserWidth(right - moved.clientX, false);
    const end = () => {
      handle.removeEventListener('pointermove', move);panel.classList.remove('is-resizing');
      setBrowserWidth(panel.getBoundingClientRect().width);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', released => {if (handle.hasPointerCapture(released.pointerId)) handle.releasePointerCapture(released.pointerId);}, {once:true});
    handle.addEventListener('lostpointercapture', end, {once:true});
  });
  handle.addEventListener('keydown', event => {
    const step = event.shiftKey ? 80 : 24, width = panel.getBoundingClientRect().width;
    const next = {ArrowLeft:width + step, ArrowRight:width - step, Home:Number.MAX_SAFE_INTEGER, End:0}[event.key];
    if (next === undefined) return;
    event.preventDefault();setBrowserWidth(next);
  });
}

function resetPanelAccount() {
  const owner = state.config.firebase_auth_set ? (state.config.firebase_email || '') : null;
  if (owner === browserPage.owner) return;
  browserPage.owner = owner;
  const tabs = browserPage.tabs;
  browserPage.tabs = [];browserPage.active = null;browserPage.open = false;browserPage.expanded = false;
  activity.section = null;activity.selected = null;
  for (const tab of tabs.filter(tab => !tab.section)) {
    queueBrowser(() => invoke('browser_close', {tab_id:tab.id})).catch(error => {
      console.error('Browser session could not close:', error);showError(localizeError(error));
    });
  }
}

async function setupBrowser() {
  $('#panel-toggle').onclick = () => browserPage.open ? closeBrowser() : showBrowserPanel();
  $('#browser-close').onclick = closeBrowser;
  $('#panel-add-tab').onclick = () => newPanelTab();
  $('#panel-expand').onclick = () => {browserPage.expanded = !browserPage.expanded;renderBrowser();};
  $('#panel-open-git').onclick = () => openActivity('git');
  $('#panel-open-browser').onclick = () => {$('#browser-address').focus();$('#browser-address').select();};
  $('#browser-back').onclick = () => browserAction('back');
  $('#browser-forward').onclick = () => browserAction('forward');
  $('#browser-reload').onclick = () => browserAction(activePanelTab()?.loading ? 'stop' : 'reload');
  $('#browser-capture').onclick = captureBrowser;
  $('#browser-external').onclick = openExternalBrowserPage;
  $('#browser-address').oninput = event => {const tab = activePanelTab();if (tab && !tab.section) tab.address = event.target.value;};
  $('#browser-bar').addEventListener('submit', event => {
    event.preventDefault();
    const value = $('#browser-address').value.trim();
    if (value) {$('#browser-address').blur();openBrowser(value);}
  });
  $('#browser-address').addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();event.stopPropagation();
    const tab = activePanelTab();event.target.value = tab?.url || '';if (tab) tab.address = event.target.value;event.target.select();
  });
  $('#browser-panel').addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) {event.preventDefault();event.stopPropagation();closeBrowser();}
  });
  setupBrowserResize();
  new ResizeObserver(syncBrowser).observe($('#browser-view'));
  window.addEventListener('resize', () => {
    const saved = Number(localStorage.getItem(BROWSER_WIDTH.key));
    if (browserPage.open) setBrowserWidth(saved || $('#browser-panel').getBoundingClientRect().width, false);
  });
  new MutationObserver(syncBrowser).observe(document.body, {subtree:true, attributes:true, attributeFilter:['open', 'hidden', 'inert']});
  await appWindow.listen('browser-state', ({payload}) => {
    const tab = browserPage.tabs.find(tab => tab.id === payload?.tab_id && !tab.section);
    if (!tab) return;
    tab.stateVersion++;
    if (typeof payload.url === 'string') {
      if (tab.address === tab.url) tab.address = payload.url;
      tab.url = payload.url;
    }
    tab.title = typeof payload.title === 'string' ? payload.title : '';
    tab.loading = !!payload.loading;
    if (tab.loading) setBrowserStatus('', tab);
    renderBrowser();
  });
  await appWindow.listen('browser-blocked', ({payload}) => {
    const tab = browserPage.tabs.find(tab => tab.id === payload?.tab_id);
    if (tab) {tab.loading = false;setBrowserStatus(t('errors.browser_blocked_url'), tab);renderBrowser();}
  });
  await appWindow.listen('browser-new-tab', ({payload}) => {
    if (browserPage.open && browserPage.active === payload?.tab_id && typeof payload.url === 'string') openBrowser(payload.url, {newTab:true});
  });
  renderBrowser();
}
