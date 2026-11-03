// Image attachments: client-side normalization, previews and the image viewer.
// Images travel as raw base64 attachments ({name, mime_type, data, content:''});
// the backend re-checks type, size and dimensions before any provider request.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// Vision models downscale to about 1.3 MP, so larger uploads only cost bandwidth and storage.
const IMAGE_LIMIT = {count:8, total:6 << 20, side:2048, pixels:1.7e6, bytes:512 << 10, source:20 << 20};
const imageCache = new Map();
let imageCacheSize = 0;
// Images still being prepared, per conversation (null is the new-chat composer).
const imageJobs = new Map();
let imageViewer = null;

function isImageAttachment(file) {
  return typeof file?.data === 'string' && IMAGE_TYPES.includes(file.mime_type);
}

function imageTag(bytes, offset, text) {
  return [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
}

// Same signatures as the backend: the declared type must match the content.
function sniffImage(bytes) {
  if (bytes[0] === 0x89 && imageTag(bytes, 1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (imageTag(bytes, 0, 'GIF87a') || imageTag(bytes, 0, 'GIF89a')) return 'image/gif';
  if (imageTag(bytes, 0, 'RIFF') && imageTag(bytes, 8, 'WEBP')) return 'image/webp';
  return null;
}

// Pixel size from the file header, without decoding the image.
function imageHeaderSize(bytes) {
  const has = (offset, length) => offset >= 0 && offset + length <= bytes.length;
  const be16 = i => has(i, 2) ? (bytes[i] << 8) | bytes[i + 1] : 0;
  const le16 = i => has(i, 2) ? bytes[i] | (bytes[i + 1] << 8) : 0;
  const le24 = i => has(i, 3) ? bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) : -1;
  const be32 = i => has(i, 4) ? bytes[i] * 0x1000000 + ((bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) : 0;
  const size = (width, height) => width > 0 && height > 0 ? {width, height} : null;
  switch (sniffImage(bytes)) {
    case 'image/png': return imageTag(bytes, 12, 'IHDR') ? size(be32(16), be32(20)) : null;
    case 'image/gif': return size(le16(6), le16(8));
    case 'image/webp': {
      if (imageTag(bytes, 12, 'VP8 ')) return size(le16(26) & 0x3fff, le16(28) & 0x3fff);
      if (imageTag(bytes, 12, 'VP8L') && has(21, 4)) {
        const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
        return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (imageTag(bytes, 12, 'VP8X')) return size(le24(24) + 1, le24(27) + 1);
      return null;
    }
    case 'image/jpeg': {
      let i = 2;
      for (;;) {
        if (!has(i, 2) || bytes[i] !== 0xff) return null;
        while (bytes[i + 1] === 0xff) i++;
        const marker = bytes[i + 1];
        if (marker === undefined) return null;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {i += 2;continue;}
        if (marker === 0xda || !has(i + 2, 2)) return null;
        const length = be16(i + 2);
        if (length < 2) return null;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return size(be16(i + 7), be16(i + 5));
        i += 2 + length;
      }
    }
    default: return null;
  }
}

function base64Bytes(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function blobBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {const url = String(reader.result);resolve(url.slice(url.indexOf(',') + 1));};
    reader.onerror = () => reject(new Error('image_unreadable'));
    reader.readAsDataURL(blob);
  });
}

// ===== Preview cache =====
// Keyed by the base64 payload: attachments are cloned often, the data is stable.
function rememberImage(data, blob, width, height) {
  const previous = imageCache.get(data);
  if (previous) {imageCache.delete(data);imageCache.set(data, previous);return previous;}
  const entry = {url:URL.createObjectURL(blob), width, height, size:data.length};
  imageCache.set(data, entry);imageCacheSize += entry.size;
  trimImageCache(entry);
  return entry;
}

function trimImageCache(keep) {
  const full = () => imageCache.size > 64 || imageCacheSize > 64 << 20;
  if (!full()) return;
  const visible = new Set([...document.images].map(img => img.getAttribute('src')));
  for (const [key, entry] of imageCache) {
    if (!full()) break;
    if (entry === keep || visible.has(entry.url)) continue;
    URL.revokeObjectURL(entry.url);imageCache.delete(key);imageCacheSize -= entry.size;
  }
}

function imageEntry(file) {
  if (!isImageAttachment(file)) return null;
  const cached = imageCache.get(file.data);
  if (cached) return rememberImage(file.data);
  try {
    const bytes = base64Bytes(file.data);
    const size = imageHeaderSize(bytes) || {width:0, height:0};
    return rememberImage(file.data, new Blob([bytes], {type:file.mime_type}), size.width, size.height);
  } catch (_) {return null;}
}

function imageURL(file) { return imageEntry(file)?.url || null; }

function isImageURL(value) {
  return typeof value === 'string' && value.startsWith('blob:') && [...imageCache.values()].some(entry => entry.url === value);
}

// ===== Normalization =====
function imageName(name, type) {
  const extension = {'image/png':'.png', 'image/jpeg':'.jpg', 'image/gif':'.gif', 'image/webp':'.webp'}[type];
  const clean = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const [, stem = '', suffix = ''] = clean.match(/^(.*?)(\.[^.]*)?$/) || [];
  const base = Array.from(stem.trim()).slice(0, 60).join('') || 'image';
  return base + (type === 'image/jpeg' && /^\.jpe?g$/i.test(suffix) ? suffix : extension);
}

async function encodeImage(img, width, height, sourceType) {
  let scale = Math.min(1, IMAGE_LIMIT.side / Math.max(width, height), Math.sqrt(IMAGE_LIMIT.pixels / (width * height)));
  let type = sourceType === 'image/jpeg' ? 'image/jpeg' : 'image/png', quality = 0.85;
  for (let attempt = 0; attempt < 8; attempt++) {
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');canvas.width = w;canvas.height = h;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('image_unreadable');
    context.imageSmoothingEnabled = true;context.imageSmoothingQuality = 'high';
    // JPEG has no alpha: flatten transparency on white, as image viewers do.
    if (type === 'image/jpeg') {context.fillStyle = '#fff';context.fillRect(0, 0, w, h);}
    context.drawImage(img, 0, 0, w, h);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, type, quality));
    canvas.width = canvas.height = 0;
    const actual = blob && sniffImage(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
    if (!actual) throw new Error('image_unreadable');
    if (blob.size <= IMAGE_LIMIT.bytes) return {blob, type:actual, width:w, height:h};
    if (type === 'image/png') type = 'image/jpeg';
    else if (quality > 0.6) quality = 0.6;
    else scale *= 0.75;
  }
  throw new Error('image_too_large');
}

// Decodes the image once, then sends small originals untouched and re-encodes the rest.
// JPEGs are always re-encoded: this applies EXIF rotation and drops location metadata.
async function normalizeImage(blob, name) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('image_unreadable');
  if (blob.size > IMAGE_LIMIT.source) throw new Error('image_too_large');
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const type = sniffImage(head);
  if (!type) throw new Error('image_unreadable');
  const source = URL.createObjectURL(blob);
  try {
    const img = new Image();img.src = source;
    try {await img.decode();} catch (_) {throw new Error('image_unreadable');}
    const width = img.naturalWidth, height = img.naturalHeight;
    if (!width || !height) throw new Error('image_unreadable');
    const header = imageHeaderSize(head);
    const fits = Math.max(width, height) <= IMAGE_LIMIT.side && width * height <= IMAGE_LIMIT.pixels;
    let output = {blob:new Blob([blob], {type}), type, width, height};
    if (type === 'image/jpeg' || !fits || blob.size > IMAGE_LIMIT.bytes || header?.width !== width || header?.height !== height) {
      output = await encodeImage(img, width, height, type);
    }
    const data = await blobBase64(output.blob);
    rememberImage(data, output.blob, output.width, output.height);
    return {name:imageName(name, output.type), mime_type:output.type, data, content:''};
  } finally {URL.revokeObjectURL(source);}
}

function uniqueImageName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name, suffix = dot > 0 ? name.slice(dot) : '';
  let index = 2;
  while (taken.has(`${stem}-${index}${suffix}`)) index++;
  return `${stem}-${index}${suffix}`;
}

// One image at a time: decoding large photos is memory hungry. Picker results
// arrive as raw base64 attachments and are decoded only when their turn comes.
let imageWork = Promise.resolve();
function prepareImage(source) {
  const work = imageWork.then(() => normalizeImage(source instanceof Blob ? source : new Blob([base64Bytes(source.data)], {type:source.mime_type}), source.name));
  imageWork = work.catch(() => {});
  return work;
}

// ===== Thumbnails =====
function imageThumb(files, index, className = 'image-thumb') {
  const file = files[index], entry = imageEntry(file);
  const button = document.createElement('button');button.type = 'button';button.className = className;
  button.setAttribute('aria-label', `${t('chat.open_image')}: ${file.name}`);button.title = file.name;
  const img = document.createElement('img');img.alt = '';img.draggable = false;img.decoding = 'async';
  if (entry) img.src = entry.url;
  button.append(img);
  button.onclick = () => openImageViewer(files, index, button);
  return button;
}

// Deterministic sizes keep the conversation scrolled to the bottom while images load.
function messageImagesEl(files) {
  const group = document.createElement('div');group.className = 'message-images';
  group.classList.toggle('message-images--single', files.length === 1);
  files.forEach((file, index) => {
    const thumb = imageThumb(files, index);
    const entry = imageEntry(file);
    if (files.length === 1 && entry?.width && entry?.height) {
      const ratio = Math.min(3, Math.max(1 / 3, entry.width / entry.height));
      const width = Math.min(ratio >= 1 ? 260 : 260 * ratio, Math.max(64, entry.width));
      thumb.style.width = `${Math.round(width)}px`;thumb.style.aspectRatio = String(ratio);
    }
    group.append(thumb);
  });
  return group;
}

function imageTile(files, index, remove) {
  const tile = document.createElement('div');tile.className = 'image-tile';
  const close = document.createElement('button');close.type = 'button';close.className = 'image-tile__remove';
  close.setAttribute('aria-label', `${t('chat.remove_attachment')}: ${files[index].name}`);close.title = t('chat.remove_attachment');
  close.append(icon('close'));close.onclick = remove;
  tile.append(imageThumb(files, index, 'image-tile__open'), close);
  return tile;
}

function imageSkeleton() {
  const tile = document.createElement('div');tile.className = 'image-tile image-tile--pending';
  tile.setAttribute('role', 'img');tile.setAttribute('aria-label', t('chat.preparing_image'));
  tile.append(icon('image'));
  return tile;
}

// ===== Viewer =====
function viewerIcon(name) {
  return lucide.icons[name] ? lucide.createElement(lucide.icons[name], {class:'ui-icon', 'aria-hidden':'true'}) : icon('chevron');
}

function createImageViewer() {
  const viewer = document.createElement('dialog');viewer.className = 'image-viewer';
  viewer.setAttribute('aria-labelledby', 'image-viewer-name');
  const control = (className, glyph, step) => {
    const button = document.createElement('button');button.type = 'button';button.className = `icon-button ${className}`;
    button.append(glyph);
    button.onclick = () => step ? showViewerImage(viewer._index + step) : viewer.close();
    return button;
  };
  const figure = document.createElement('figure');figure.className = 'image-viewer__figure';
  const img = document.createElement('img');img.className = 'image-viewer__image';
  const caption = document.createElement('figcaption');caption.className = 'image-viewer__caption';
  const name = document.createElement('span');name.id = 'image-viewer-name';
  const count = document.createElement('span');count.className = 'image-viewer__count';
  caption.append(name, count);figure.append(img, caption);
  viewer.append(control('image-viewer__close', icon('close')), control('image-viewer__nav image-viewer__nav--prev', viewerIcon('ChevronLeft'), -1), figure,
    control('image-viewer__nav image-viewer__nav--next', viewerIcon('ChevronRight'), 1));
  viewer.addEventListener('click', event => {if (!event.target.closest('button, img')) viewer.close();});
  viewer.addEventListener('keydown', event => {
    if (event.defaultPrevented || viewer._images.length < 2 || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();showViewerImage(viewer._index + (event.key === 'ArrowLeft' ? -1 : 1));
  });
  viewer.addEventListener('close', () => {
    img.removeAttribute('src');
    if (viewer._opener?.isConnected) viewer._opener.focus();
    viewer._opener = null;
  });
  document.body.append(viewer);
  return viewer;
}

function showViewerImage(index) {
  const viewer = imageViewer, count = viewer._images.length;
  viewer._index = (index + count) % count;
  const file = viewer._images[viewer._index], img = viewer.querySelector('.image-viewer__image');
  const url = imageURL(file);
  if (url) img.src = url;else img.removeAttribute('src');
  img.alt = file.name || '';
  viewer.querySelector('#image-viewer-name').textContent = file.name || '';
  viewer.querySelector('.image-viewer__count').textContent = count > 1 ? `${viewer._index + 1} / ${count}` : '';
}

function openImageViewer(files, index = 0, opener = document.activeElement) {
  const images = files.filter(isImageAttachment);
  if (!images.length) return;
  const viewer = imageViewer ||= createImageViewer();
  viewer._images = images;viewer._opener = opener;
  for (const [selector, key] of [['.image-viewer__close', 'chat.close_image'], ['.image-viewer__nav--prev', 'chat.previous_image'], ['.image-viewer__nav--next', 'chat.next_image']]) {
    const button = viewer.querySelector(selector);button.setAttribute('aria-label', t(key));button.title = t(key);
    if (selector !== '.image-viewer__close') button.hidden = images.length < 2;
  }
  showViewerImage(Math.max(0, images.indexOf(files[index])));
  if (!viewer.open) viewer.showModal();
  viewer.querySelector('.image-viewer__close').focus();
}
