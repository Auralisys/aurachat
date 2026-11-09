// Internal browser: a native child webview (browser.rs) placed over #browser-view.
// Native views always paint above the DOM, so the page is hidden whenever a
// dialog, overlay or floating menu overlaps the panel. Captures go through the
// image annotator and land in the composer like any other image.
const browserPage = {open:false, page:false, capture:false, url:'', title:'', loading:false, busy:false, shown:null, frame:0, dock:false};
const BROWSER_WIDTH = {min:360, keep:420, key:'aurachat.browserWidth'};
const BROWSER_FLOATING = '.overlay:not([hidden]), .tree-menu:not([hidden]), .project-preview:not([hidden]), .model-menu:not([hidden]), .boot-splash:not([hidden]), .context-info[open] > div';

function browserIsOpen() { return browserPage.open; }

function browserIcon(name) {
  return lucide.icons[name] ? lucide.createElement(lucide.icons[name], {class:'ui-icon', 'aria-hidden':'true'}) : icon('more');
}

function setBrowserStatus(text = '') {
  const status = $('#browser-status');status.textContent = text;status.hidden = !text;
}

function browserCovered(panel) {
  if ($('#view-chat').hidden || document.querySelector('dialog[open]')) return true;
  const area = panel.getBoundingClientRect();
  return [...document.querySelectorAll(BROWSER_FLOATING)].some(element => {
    const box = element.getBoundingClientRect();
    return box.width && box.height && box.left < area.right && box.right > area.left && box.top < area.bottom && box.bottom > area.top;
  });
}

// Coalesces layout changes into one native call per frame, and only when something changed.
function syncBrowser() {
  if (browserPage.frame) return;
  browserPage.frame = requestAnimationFrame(() => {
    browserPage.frame = 0;
    if (!browserPage.page) return;
    const view = $('#browser-view'), box = view.getBoundingClientRect();
    const visible = browserPage.open && box.width > 1 && box.height > 1 && !browserCovered($('#browser-panel'));
    const bounds = {x:Math.round(box.left), y:Math.round(box.top), width:Math.round(box.width), height:Math.round(box.height)};
    const key = visible ? JSON.stringify(bounds) : 'hidden';
    if (key === browserPage.shown) return;
    browserPage.shown = key;
    invoke('browser_bounds', {bounds, visible}).catch(() => {browserPage.shown = null;});
  });
}

function renderBrowser() {
  const panel = $('#browser-panel'), toggle = $('#browser-toggle');
  panel.hidden = !browserPage.open;
  document.querySelector('.workspace').classList.toggle('has-browser', browserPage.open);
  toggle.setAttribute('aria-expanded', String(browserPage.open));
  toggle.classList.toggle('is-active', browserPage.open);
  const reload = $('#browser-reload');
  reload.replaceChildren(browserIcon(browserPage.loading ? 'X' : 'RotateCw'));
  const reloadLabel = t(browserPage.loading ? 'browser.stop' : 'browser.reload');
  reload.title = reloadLabel;reload.setAttribute('aria-label', reloadLabel);
  ['#browser-back', '#browser-forward', '#browser-reload', '#browser-external'].forEach(id => {$(id).disabled = !browserPage.page;});
  const capture = $('#browser-capture');
  capture.hidden = browserPage.page && !browserPage.capture;
  capture.disabled = !browserPage.page || browserPage.busy;
  $('#browser-panel').setAttribute('aria-busy', String(browserPage.loading));
  $('#browser-progress').hidden = !browserPage.loading;
  $('#browser-empty').hidden = browserPage.page;
  const address = $('#browser-address');
  if (document.activeElement !== address) address.value = browserPage.url;
  address.title = browserPage.title || browserPage.url;
  // The activity dock only needs a new layout when the right side changes owner.
  if (browserPage.dock !== browserPage.open) {browserPage.dock = browserPage.open;renderActivity();}
  syncBrowser();
}

function showBrowserPanel() {
  if (browserPage.open) return;
  browserPage.open = true;browserPage.shown = null;
  renderBrowser();
  const saved = Number(localStorage.getItem(BROWSER_WIDTH.key));
  if (saved) setBrowserWidth(saved, false);
}

// Native open calls run one at a time: the first one creates the page webview.
let browserQueue = Promise.resolve();
function openBrowser(url, options) {
  const run = browserQueue.then(() => navigateBrowser(url, options));
  browserQueue = run.catch(() => {});
  return run;
}

async function navigateBrowser(url, {focus = false} = {}) {
  showBrowserPanel();
  if (!url) {
    if (focus) {const address = $('#browser-address');address.focus();address.select();}
    return;
  }
  setBrowserStatus();
  await new Promise(requestAnimationFrame);
  const box = $('#browser-view').getBoundingClientRect();
  try {
    const opened = await invoke('browser_open', {url, bounds:{x:Math.round(box.left), y:Math.round(box.top), width:Math.round(box.width), height:Math.round(box.height)}});
    browserPage.page = true;browserPage.capture = !!opened.capture;browserPage.url = opened.url;browserPage.shown = null;
    if (!browserPage.open) {await invoke('browser_close').catch(() => {});browserPage.page = false;}
  } catch (error) {setBrowserStatus(localizeError(error));}
  renderBrowser();
}

async function closeBrowser() {
  if (!browserPage.open) return;
  Object.assign(browserPage, {open:false, page:false, capture:false, url:'', title:'', loading:false, shown:null});
  setBrowserStatus();
  renderBrowser();
  try {await invoke('browser_close');} catch (_) {}
}

async function openExternalBrowserPage() {
  if (!browserPage.url) return;
  try {await invoke('open_external_url', {url:browserPage.url});} catch (_) {setBrowserStatus(t('chat.link_failed'));}
}

function browserCaptureName(page) {
  let host = '';
  try {host = new URL(page.url).hostname.replace(/^www\./, '');} catch (_) {}
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return `${(host || 'page').replace(/[^\w.-]+/g, '-').slice(0, 60)}-${stamp}.png`;
}

// Capture -> annotate -> attach. Cancelling the annotator discards the capture.
async function captureBrowser() {
  if (!browserPage.page || browserPage.busy) return;
  const button = $('#browser-capture');
  browserPage.busy = true;renderBrowser();setBrowserStatus(t('browser.capturing'));
  try {
    const shot = await invoke('browser_capture');
    const file = await prepareImage({data:shot.data, mime_type:shot.mime_type, name:browserCaptureName(shot)});
    setBrowserStatus();
    const annotation = await openAnnotator(file, {opener:button, meta:{source:'browser', url:shot.url, title:shot.title, captured_at:Date.now()}});
    if (annotation === undefined) return;
    if (annotation) file.annotation = annotation;
    await addImageAttachments([{prepared:true, file}]);
    setBrowserStatus(t('browser.attached'));
  } catch (error) {setBrowserStatus(localizeError(error));}
  finally {browserPage.busy = false;renderBrowser();}
}

// Chat links open beside the conversation; Ctrl/Cmd-click keeps the system browser.
async function openLink(url, event) {
  if (event?.ctrlKey || event?.metaKey || event?.shiftKey) {
    try {await invoke('open_external_url', {url});} catch (_) {composerStatus(t('chat.link_failed'));}
    return;
  }
  await openBrowser(url);
}

function setBrowserWidth(width, save = true) {
  const workspace = document.querySelector('.workspace').getBoundingClientRect().width;
  const max = Math.max(BROWSER_WIDTH.min, workspace - BROWSER_WIDTH.keep);
  const next = Math.round(Math.min(max, Math.max(BROWSER_WIDTH.min, width)));
  const panel = $('#browser-panel');
  panel.style.setProperty('--browser-width', `${next}px`);
  const handle = $('#browser-resize');
  handle.setAttribute('aria-valuenow', String(next));handle.setAttribute('aria-valuemin', String(BROWSER_WIDTH.min));handle.setAttribute('aria-valuemax', String(Math.round(max)));
  if (save) try {localStorage.setItem(BROWSER_WIDTH.key, String(next));} catch (_) {}
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
    handle.addEventListener('lostpointercapture', end, {once:true});
  });
  handle.addEventListener('keydown', event => {
    const step = event.shiftKey ? 80 : 24, width = panel.getBoundingClientRect().width;
    const next = {ArrowLeft:width + step, ArrowRight:width - step, Home:Number.MAX_SAFE_INTEGER, End:0}[event.key];
    if (next === undefined) return;
    event.preventDefault();setBrowserWidth(next);
  });
}

async function setupBrowser() {
  const toggle = $('#browser-toggle');
  toggle.onclick = () => browserPage.open ? closeBrowser() : openBrowser('', {focus:true});
  $('#browser-close').onclick = () => {closeBrowser();toggle.focus();};
  $('#browser-back').onclick = () => invoke('browser_action', {action:'back'}).catch(() => {});
  $('#browser-forward').onclick = () => invoke('browser_action', {action:'forward'}).catch(() => {});
  $('#browser-reload').onclick = () => invoke('browser_action', {action:browserPage.loading ? 'stop' : 'reload'}).catch(() => {});
  $('#browser-capture').onclick = captureBrowser;
  $('#browser-external').onclick = openExternalBrowserPage;
  $('#browser-bar').addEventListener('submit', event => {
    event.preventDefault();
    const value = $('#browser-address').value.trim();
    if (value) {$('#browser-address').blur();openBrowser(value);}
  });
  $('#browser-address').addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();event.stopPropagation();event.target.value = browserPage.url;event.target.select();
  });
  $('#browser-panel').addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) {event.preventDefault();closeBrowser();toggle.focus();}
  });
  setupBrowserResize();
  new ResizeObserver(syncBrowser).observe($('#browser-view'));
  window.addEventListener('resize', () => {
    const saved = Number(localStorage.getItem(BROWSER_WIDTH.key));
    if (browserPage.open && saved) setBrowserWidth(saved, false);
  });
  // Anything that opens, closes or shows over the panel decides whether the page can stay visible.
  new MutationObserver(syncBrowser).observe(document.body, {subtree:true, attributes:true, attributeFilter:['open', 'hidden']});
  await appWindow.listen('browser-state', ({payload}) => {
    if (!browserPage.page || !payload) return;
    browserPage.url = typeof payload.url === 'string' ? payload.url : browserPage.url;
    browserPage.title = typeof payload.title === 'string' ? payload.title : '';
    browserPage.loading = !!payload.loading;
    if (browserPage.loading) setBrowserStatus();
    renderBrowser();
  });
  await appWindow.listen('browser-blocked', () => setBrowserStatus(t('errors.browser_blocked_url')));
  renderBrowser();
}
