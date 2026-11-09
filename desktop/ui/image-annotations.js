// Numbered comments on images. The image is never modified: each comment keeps
// a point as a fraction (0..1) of the image size, and the backend tells the model
// where each comment is. Contract: llm.rs `ImageAnnotation` (version 1).
const ANNOTATION_LIMIT = {comments:20, text:1000};
let annotator = null;

function randomId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}-${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function ensureAttachmentId(file) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(file.id || '')) file.id = randomId('img');
  return file.id;
}

function annotationComments(file) {
  return Array.isArray(file?.annotation?.comments) ? file.annotation.comments : [];
}

function clampUnit(value) { return Math.min(1, Math.max(0, Number(value) || 0)); }

function roundUnit(value) { return Math.round(clampUnit(value) * 10000) / 10000; }

// Browser captures keep only the page origin and path: credentials, query and fragment may hold secrets.
function cleanPageURL(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';url.password = '';url.search = '';url.hash = '';
    return url.href.length <= 2048 ? url.href : null;
  } catch (_) {return null;}
}

// Comments without text are dropped; an annotation without comments is removed.
function buildAnnotation(comments, size, meta = {}) {
  const kept = comments.map(comment => ({id:comment.id, x:roundUnit(comment.x), y:roundUnit(comment.y), text:String(comment.text || '').trim().slice(0, ANNOTATION_LIMIT.text)}))
    .filter(comment => comment.text).slice(0, ANNOTATION_LIMIT.comments);
  if (!kept.length || !size?.width || !size?.height) return null;
  const annotation = {version:1, source:meta.source === 'browser' ? 'browser' : 'image', width:size.width, height:size.height, comments:kept};
  if (annotation.source === 'browser') {
    const url = cleanPageURL(meta.url || '');
    if (url) annotation.url = url;
    const title = String(meta.title || '').trim().slice(0, 300);
    if (title) annotation.title = title;
    if (Number.isFinite(meta.captured_at)) annotation.captured_at = meta.captured_at;
  }
  return annotation;
}

function annotationIcon(name) {
  return lucide.icons[name] ? lucide.createElement(lucide.icons[name], {class:'ui-icon', 'aria-hidden':'true'}) : icon('more');
}

function annotationMarker(number, className = 'annotation-marker') {
  const marker = document.createElement(className.includes('--static') ? 'span' : 'button');
  marker.className = className;marker.textContent = String(number);
  if (marker.tagName === 'BUTTON') marker.type = 'button';
  return marker;
}

// Read-only markers over an image, used by the viewer.
function annotationOverlay(file) {
  const layer = document.createElement('div');layer.className = 'annotation-layer';layer.setAttribute('aria-hidden', 'true');
  annotationComments(file).forEach((comment, index) => {
    const marker = annotationMarker(index + 1, 'annotation-marker annotation-marker--static');
    marker.style.left = `${clampUnit(comment.x) * 100}%`;marker.style.top = `${clampUnit(comment.y) * 100}%`;
    layer.append(marker);
  });
  return layer;
}

function annotationList(file) {
  const list = document.createElement('ol');list.className = 'annotation-notes';
  list.setAttribute('aria-label', t('annotations.comments'));
  annotationComments(file).forEach((comment, index) => {
    const item = document.createElement('li');
    item.append(annotationMarker(index + 1, 'annotation-marker annotation-marker--static'));
    const text = document.createElement('span');text.textContent = comment.text;item.append(text);
    list.append(item);
  });
  return list;
}

function annotationBadge(count) {
  const badge = document.createElement('span');badge.className = 'annotation-badge';
  badge.append(annotationIcon('MessageSquareText'), document.createTextNode(String(count)));
  badge.setAttribute('aria-hidden', 'true');
  return badge;
}

// ===== Editor =====
function createAnnotator() {
  const dialog = document.createElement('dialog');dialog.className = 'annotator';dialog.setAttribute('aria-labelledby', 'annotator-title');
  dialog.innerHTML = `
    <header class="annotator__head">
      <div class="annotator__heading"><h2 id="annotator-title"></h2><p class="annotator__source"></p></div>
      <button type="button" class="icon-button annotator__close"></button>
    </header>
    <div class="annotator__body">
      <div class="annotator__stage"><div class="annotator__canvas"><img class="annotator__image" alt="" draggable="false"><div class="annotator__markers"></div></div></div>
      <aside class="annotator__panel">
        <p class="annotator__hint"></p>
        <ol class="annotator__list"></ol>
      </aside>
    </div>
    <footer class="annotator__foot">
      <p class="annotator__status" role="status"></p>
      <button type="button" class="btn annotator__cancel"></button>
      <button type="button" class="btn btn--primary annotator__save"></button>
    </footer>`;
  dialog.querySelector('.annotator__close').append(icon('close'));
  const canvas = dialog.querySelector('.annotator__canvas');
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', event => {
    if (event.target !== canvas || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();addAnnotatorComment(0.5, 0.5);
  });
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('.annotation-marker')) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    addAnnotatorComment((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  });
  dialog.querySelector('.annotator__close').onclick = () => closeAnnotator(undefined);
  dialog.querySelector('.annotator__cancel').onclick = () => closeAnnotator(undefined);
  dialog.querySelector('.annotator__save').onclick = () => closeAnnotator(buildAnnotation(dialog._comments, dialog._size, dialog._meta));
  dialog.addEventListener('cancel', event => {event.preventDefault();closeAnnotator(undefined);});
  dialog.addEventListener('close', () => {
    dialog.querySelector('.annotator__image').removeAttribute('src');
    const resolve = dialog._resolve;dialog._resolve = null;resolve?.(dialog._result);
    if (dialog._opener?.isConnected) dialog._opener.focus();
  });
  document.body.append(dialog);
  return dialog;
}

function closeAnnotator(result) {
  if (!annotator?.open) return;
  annotator._result = result;annotator.close();
}

function addAnnotatorComment(x, y) {
  const dialog = annotator;
  if (dialog._comments.length >= ANNOTATION_LIMIT.comments) {setAnnotatorStatus(t('annotations.limit'));return;}
  const comment = {id:randomId('c'), x:clampUnit(x), y:clampUnit(y), text:''};
  dialog._comments.push(comment);
  renderAnnotator();
  dialog.querySelector(`[data-comment="${comment.id}"] textarea`)?.focus();
}

function setAnnotatorStatus(text = '') { annotator.querySelector('.annotator__status').textContent = text; }

function removeAnnotatorComment(id) {
  const dialog = annotator, index = dialog._comments.findIndex(comment => comment.id === id);
  if (index < 0) return;
  dialog._comments.splice(index, 1);renderAnnotator();
  const next = dialog._comments[Math.min(index, dialog._comments.length - 1)];
  (next ? dialog.querySelector(`.annotator__markers [data-id="${next.id}"]`) : dialog.querySelector('.annotator__save'))?.focus();
}

function highlightAnnotatorComment(id, on) {
  annotator.querySelectorAll(`[data-id="${id}"], [data-comment="${id}"]`).forEach(element => element.classList.toggle('is-active', on));
}

function dragMarker(marker, comment, event) {
  if (event.button !== 0) return;
  event.preventDefault();event.stopPropagation();
  const canvas = annotator.querySelector('.annotator__canvas'), start = {x:event.clientX, y:event.clientY};
  let moved = false;
  marker.setPointerCapture(event.pointerId);
  const move = moveEvent => {
    if (!moved && Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 3) return;
    moved = true;
    const rect = canvas.getBoundingClientRect();
    comment.x = clampUnit((moveEvent.clientX - rect.left) / rect.width);comment.y = clampUnit((moveEvent.clientY - rect.top) / rect.height);
    marker.style.left = `${comment.x * 100}%`;marker.style.top = `${comment.y * 100}%`;
  };
  const end = () => {
    marker.removeEventListener('pointermove', move);marker.removeEventListener('pointerup', end);marker.removeEventListener('pointercancel', end);
    if (!moved) annotator.querySelector(`[data-comment="${comment.id}"] textarea`)?.focus();
  };
  marker.addEventListener('pointermove', move);marker.addEventListener('pointerup', end);marker.addEventListener('pointercancel', end);
}

function markerKeys(marker, comment, event) {
  const steps = {ArrowLeft:[-1, 0], ArrowRight:[1, 0], ArrowUp:[0, -1], ArrowDown:[0, 1]}[event.key];
  if (steps) {
    event.preventDefault();
    const step = event.shiftKey ? 0.05 : 0.01;
    comment.x = clampUnit(comment.x + steps[0] * step);comment.y = clampUnit(comment.y + steps[1] * step);
    marker.style.left = `${comment.x * 100}%`;marker.style.top = `${comment.y * 100}%`;
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();removeAnnotatorComment(comment.id);
  } else if (event.key === 'Enter') {
    event.preventDefault();annotator.querySelector(`[data-comment="${comment.id}"] textarea`)?.focus();
  }
}

function renderAnnotator() {
  const dialog = annotator, comments = dialog._comments;
  const markers = dialog.querySelector('.annotator__markers'), list = dialog.querySelector('.annotator__list');
  markers.replaceChildren();list.replaceChildren();
  comments.forEach((comment, index) => {
    const number = index + 1;
    const marker = annotationMarker(number);marker.dataset.id = comment.id;
    marker.style.left = `${comment.x * 100}%`;marker.style.top = `${comment.y * 100}%`;
    marker.setAttribute('aria-label', `${t('annotations.comment')} ${number}. ${t('annotations.marker_help')}`);
    marker.onpointerdown = event => dragMarker(marker, comment, event);
    marker.onkeydown = event => markerKeys(marker, comment, event);
    for (const [type, on] of [['pointerenter', true], ['pointerleave', false], ['focus', true], ['blur', false]]) marker.addEventListener(type, () => highlightAnnotatorComment(comment.id, on));
    markers.append(marker);

    const item = document.createElement('li');item.className = 'annotator__item';item.dataset.comment = comment.id;
    const label = document.createElement('label');label.className = 'annotator__label';
    const id = `annotation-${comment.id}`;label.htmlFor = id;
    label.append(annotationMarker(number, 'annotation-marker annotation-marker--static'), document.createTextNode(`${t('annotations.comment')} ${number}`));
    const remove = document.createElement('button');remove.type = 'button';remove.className = 'icon-button annotator__remove';
    remove.setAttribute('aria-label', `${t('annotations.remove')} ${number}`);remove.title = t('annotations.remove');
    remove.append(annotationIcon('Trash2'));remove.onclick = () => removeAnnotatorComment(comment.id);
    const field = document.createElement('textarea');field.id = id;field.rows = 2;field.maxLength = ANNOTATION_LIMIT.text;
    field.placeholder = t('annotations.placeholder');field.value = comment.text;
    field.oninput = () => {comment.text = field.value;updateAnnotatorSave();};
    field.onkeydown = event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {event.preventDefault();dialog.querySelector('.annotator__save').click();}
    };
    for (const [type, on] of [['focus', true], ['blur', false]]) field.addEventListener(type, () => highlightAnnotatorComment(comment.id, on));
    const top = document.createElement('div');top.className = 'annotator__item-head';top.append(label, remove);
    item.append(top, field);list.append(item);
  });
  dialog.querySelector('.annotator__hint').textContent = comments.length ? t('annotations.hint_more') : t('annotations.hint');
  setAnnotatorStatus();updateAnnotatorSave();
}

function updateAnnotatorSave() {
  const dialog = annotator, filled = dialog._comments.filter(comment => comment.text.trim()).length;
  const empty = dialog._comments.length - filled;
  setAnnotatorStatus(empty ? t('annotations.empty_dropped') : '');
  const save = dialog.querySelector('.annotator__save');
  // A capture can be attached without comments; an image needs a change to save.
  save.disabled = dialog._meta.source !== 'browser' && !filled && !annotationComments(dialog._file).length;
}

// Resolves with the new annotation (null when every comment was removed), or undefined on cancel.
function openAnnotator(file, {opener = document.activeElement, meta = {}, title} = {}) {
  const entry = imageEntry(file);
  if (!entry?.url || !entry.width || !entry.height) return Promise.resolve(undefined);
  const dialog = annotator ||= createAnnotator();
  if (dialog.open) return Promise.resolve(undefined);
  dialog._file = file;dialog._opener = opener;dialog._size = {width:entry.width, height:entry.height};
  dialog._meta = {...meta, source:meta.source || file.annotation?.source || 'image'};
  if (dialog._meta.source === 'browser' && file.annotation) dialog._meta = {url:file.annotation.url, title:file.annotation.title, captured_at:file.annotation.captured_at, ...dialog._meta};
  dialog._comments = annotationComments(file).map(comment => ({...comment}));
  dialog._result = undefined;
  dialog.querySelector('#annotator-title').textContent = title || t(dialog._meta.source === 'browser' ? 'annotations.capture_title' : 'annotations.title');
  const source = dialog.querySelector('.annotator__source');
  source.textContent = dialog._meta.source === 'browser' ? (dialog._meta.title || cleanPageURL(dialog._meta.url || '') || file.name) : file.name;
  const close = dialog.querySelector('.annotator__close');close.setAttribute('aria-label', t('annotations.cancel'));close.title = t('annotations.cancel');
  dialog.querySelector('.annotator__cancel').textContent = t('annotations.cancel');
  dialog.querySelector('.annotator__save').textContent = t(dialog._meta.source === 'browser' ? 'annotations.attach_capture' : 'annotations.save');
  const img = dialog.querySelector('.annotator__image');img.src = entry.url;img.alt = file.name || '';
  const canvas = dialog.querySelector('.annotator__canvas');canvas.style.aspectRatio = `${entry.width} / ${entry.height}`;
  canvas.style.setProperty('--image-ratio', String(entry.width / entry.height));
  canvas.setAttribute('aria-label', t('annotations.canvas_help'));
  renderAnnotator();
  dialog.showModal();
  (dialog.querySelector('.annotator__markers .annotation-marker') || dialog.querySelector('.annotator__canvas'))?.focus?.();
  return new Promise(resolve => {dialog._resolve = resolve;});
}
