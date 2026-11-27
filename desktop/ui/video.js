// Local video sampling uses the same browser decoder as playback. No provider request is involved.
const VIDEO_LIMIT = {source:128 << 20, framesPerSheet:8, interval:0.5, timeout:15000};
const mediaErrors = new Map();
let videoViewer = null;

function isVideoAttachment(file) {
  return !!file?.video && typeof file.video.id === 'string' && /^[a-f0-9]{64}$/.test(file.video.id);
}

function isVideoSource(file) {
  return typeof file?.video_data === 'string';
}

function videoTimestamp(seconds) {
  const ms = Math.round(seconds * 1000), hours = Math.floor(ms / 3600000);
  return `${String(hours).padStart(2,'0')}:${String(Math.floor(ms / 60000) % 60).padStart(2,'0')}:${String(Math.floor(ms / 1000) % 60).padStart(2,'0')}.${String(ms % 1000).padStart(3,'0')}`;
}

function videoSamples(duration, sheets) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isInteger(sheets) || sheets < 1 || sheets > IMAGE_LIMIT.count) throw Error('video_unreadable');
  const maximum = sheets * VIDEO_LIMIT.framesPerSheet;
  const count = Math.min(maximum, Math.max(2, Math.ceil(duration / VIDEO_LIMIT.interval) + 1));
  const step = Math.max(VIDEO_LIMIT.interval, duration / (maximum - 1));
  const last = Math.max(0, duration - Math.min(0.01, duration / 2));
  return Array.from({length:count}, (_,index) => Math.min(index * step, last));
}

function videoEvent(video, name, start) {
  return new Promise((resolve,reject) => {
    const cleanup = () => {clearTimeout(timer);video.removeEventListener(name,ready);video.removeEventListener('error',failed);};
    const ready = () => {cleanup();resolve();};
    const failed = () => {cleanup();reject(Error('video_unreadable'));};
    const timer = setTimeout(() => {cleanup();reject(Error('video_timeout'));}, VIDEO_LIMIT.timeout);
    video.addEventListener(name,ready,{once:true});video.addEventListener('error',failed,{once:true});
    try {start();} catch (error) {cleanup();reject(error);}
  });
}

async function prepareVideo(source, maximumSheets, progress = () => {}) {
  if (!/^[a-f0-9]{64}$/.test(source.video_id || '')) throw Error('video_unavailable');
  if (typeof source.video_data === 'string' && source.video_data.length > Math.ceil(VIDEO_LIMIT.source / 3) * 4) throw Error('video_too_large');
  const blob = new Blob([base64Bytes(source.video_data)], {type:source.video_mime});
  if (!blob.size) throw Error('video_unreadable');
  if (blob.size > VIDEO_LIMIT.source) throw Error('video_too_large');
  const video = document.createElement('video'), url = URL.createObjectURL(blob);
  video.muted = true;video.playsInline = true;video.preload = 'auto';
  const canvas = document.createElement('canvas');
  try {
    await videoEvent(video,'loadeddata',() => {video.src = url;});
    // Browser-recorded WebM files can omit duration until the decoder seeks to the end.
    if (video.duration === Infinity) await videoEvent(video,'seeked',() => {video.currentTime = 1e10;});
    const duration = video.duration, width = video.videoWidth, height = video.videoHeight;
    if (!width || !height || width > 32768 || height > 32768) throw Error('video_unreadable');
    const times = videoSamples(duration, maximumSheets);
    const stem = Array.from(imageName(source.name,'image/jpeg').replace(/\.jpe?g$/i,'')).slice(0,50).join('');
    const attachments = [], frames = [];
    let poster = '';
    const columns = 2, tileWidth = 512, tileHeight = 288, labelHeight = 24;
    for (let first = 0; first < times.length; first += VIDEO_LIMIT.framesPerSheet) {
      const batch = times.slice(first,first + VIDEO_LIMIT.framesPerSheet), sheet = Math.floor(first / VIDEO_LIMIT.framesPerSheet) + 1;
      canvas.width = tileWidth * columns;canvas.height = Math.ceil(batch.length / columns) * (tileHeight + labelHeight);
      const context = canvas.getContext('2d');
      if (!context) throw Error('video_unreadable');
      context.fillStyle = '#171717';context.fillRect(0,0,canvas.width,canvas.height);
      const name = `${stem}-frames-${String(sheet).padStart(2,'0')}.jpg`;
      for (const [cell,time] of batch.entries()) {
        if (Math.abs(video.currentTime - time) > 0.0001 || video.readyState < 2) {
          await videoEvent(video,'seeked',() => {video.currentTime = time;});
        }
        if (first + cell === 0) {
          const scale = Math.min(1,512 / Math.max(width,height));
          const preview = await encodeImage(video,Math.round(width * scale),Math.round(height * scale),'image/jpeg');
          poster = await blobBase64(preview.blob);
          rememberImage(poster,preview.blob,preview.width,preview.height);
        }
        const x = cell % columns * tileWidth, y = Math.floor(cell / columns) * (tileHeight + labelHeight);
        const scale = Math.min(tileWidth / width, tileHeight / height);
        context.drawImage(video,x + (tileWidth - width * scale) / 2,y + labelHeight + (tileHeight - height * scale) / 2,width * scale,height * scale);
        const timestamp = videoTimestamp(time), index = first + cell;
        context.fillStyle = '#ffffff';context.font = '16px monospace';context.textBaseline = 'middle';
        context.fillText(`f${String(index).padStart(3,'0')}  ${timestamp}`,x + 8,y + labelHeight / 2);
        frames.push({index,time_seconds:time,timestamp,sheet:name,row:Math.floor(cell / columns) + 1,column:cell % columns + 1});
        progress(index + 1,times.length);
      }
      const output = await encodeImage(canvas,canvas.width,canvas.height,'image/jpeg');
      const data = await blobBase64(output.blob);
      rememberImage(data,output.blob,output.width,output.height);
      attachments.push({name,mime_type:output.type,data,content:''});
    }
    const catalog = {
      source:source.name, duration_seconds:duration, width, height, frame_count:frames.length,
      sampling:'Timestamped visual samples, not every encoded frame. Read sheets left to right, top to bottom.',
      nominal_step_seconds:Math.max(VIDEO_LIMIT.interval,duration / (maximumSheets * VIDEO_LIMIT.framesPerSheet - 1)),
      limitations:'Audio is not included. Do not infer speech, exact frame rate or events between samples. Cut times are approximate; use the source video to verify precise edits.',
      preparation:'Frames and catalog generated locally without AI. Only these sheets and this catalog are attached, not the video bytes.',
      frames,
    };
    const catalogName = `${stem}-video-frames.json`;
    return [{name:catalogName,content:JSON.stringify(catalog,null,2)},...attachments,
      {name:source.name,content:'',video:{id:source.video_id,mime_type:blob.type,poster,duration,width,height}}];
  } finally {
    video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);canvas.width = canvas.height = 0;
  }
}

async function addVideoAttachments(sources, origin = state.activeConversationId) {
  const draft = () => attachmentDraft(origin);
  mediaErrors.delete(origin);
  let error = null;
  for (const [index,source] of sources.entries()) {
    if (draft().filter(isVideoAttachment).length >= 4 || draft().filter(file => !isImageAttachment(file) && !isLinkedAttachment(file) && !isVideoAttachment(file)).length >= 4) {
      error = 'invalid_attachments';break;
    }
    const room = IMAGE_LIMIT.count - draft().filter(isImageAttachment).length - (imageJobs.get(origin) || 0);
    const reserved = Math.floor(room / (sources.length - index));
    if (reserved < 1) {error = 'invalid_attachments';break;}
    imageJobs.set(origin,(imageJobs.get(origin) || 0) + reserved);
    if (origin === state.activeConversationId) {renderDraft();composerStatus(t('chat.preparing_video'));}
    try {
      const prepared = await prepareVideo(source,reserved,(done,total) => {
        if (origin === state.activeConversationId) composerStatus(`${t('chat.preparing_video')} ${done}/${total}`);
      });
      const files = draft(), next = [...files,...prepared];
      const texts = next.filter(file => !isImageAttachment(file) && !isLinkedAttachment(file) && !isVideoAttachment(file));
      if (texts.length > 4 || texts.reduce((sum,file) => sum + new TextEncoder().encode(file.content).length,0) > 262144
        || next.filter(isVideoAttachment).length > 4 || next.filter(isLinkedAttachment).length > 16 || next.filter(isImageAttachment).length > IMAGE_LIMIT.count) throw Error('invalid_attachments');
      if (attachmentImageBytes(next) > IMAGE_LIMIT.total) throw Error('image_too_large');
      const taken = new Set(files.map(file => file.name));
      // Sheet names are referenced by the catalog: rename the whole batch consistently on repeated attachments.
      for (const file of prepared) {
        const name = uniqueImageName(file.name,taken);
        if (name !== file.name) {
          const catalog = JSON.parse(prepared[0].content);
          for (const frame of catalog.frames) if (frame.sheet === file.name) frame.sheet = name;
          if (isVideoAttachment(file)) catalog.source = name;
          prepared[0].content = JSON.stringify(catalog,null,2);
        }
        file.name = name;taken.add(name);ensureAttachmentId(file);
      }
      prepared.find(isVideoAttachment).video.generated_ids = prepared.filter(file => !isVideoAttachment(file)).map(file => file.id);
      files.push(...next.slice(files.length));
    } catch (e) {error ||= errText(e);}
    finally {
      const left = (imageJobs.get(origin) || 0) - reserved;
      if (left > 0) imageJobs.set(origin,left);else imageJobs.delete(origin);
      if (origin === state.activeConversationId) renderDraft();
    }
  }
  if (error) mediaErrors.set(origin,localizeError(error));
  if (origin === state.activeConversationId) composerStatus(error ? localizeError(error) : t('chat.video_prepared'));
}

function videoPoster(file) {
  return imageURL({mime_type:'image/jpeg',data:file.video.poster});
}

function videoThumb(file, className) {
  const button = document.createElement('button');button.type = 'button';button.className = `${className} video-thumb`;
  button.setAttribute('aria-label',`${t('chat.open_video')}: ${file.name}`);button.title = file.name;
  const image = document.createElement('img');image.alt = '';image.draggable = false;image.src = videoPoster(file);
  const play = document.createElement('span');play.className = 'video-thumb__play';play.append(viewerIcon('Play'));
  const duration = document.createElement('span');duration.className = 'video-thumb__duration';duration.textContent = videoTimestamp(file.video.duration).replace(/^00:/,'').slice(0,-4);
  button.append(image,play,duration);button.onclick = () => openVideoViewer(file,button);
  return button;
}

function releaseVideoPlayer(video) {
  video.pause();video.removeAttribute('src');video.load();
  if (video._objectURL) URL.revokeObjectURL(video._objectURL);
  video._objectURL = null;
}

function disposeVideoContent(container) {
  for (const video of container.querySelectorAll('video')) releaseVideoPlayer(video);
}

async function mountVideoPlayer(container, file, current, time = 0) {
  const video = document.createElement('video');video.controls = true;video.playsInline = true;video.preload = 'metadata';
  video.className = 'video-player';video.poster = videoPoster(file);video.setAttribute('aria-label',file.name);
  const status = activityText('p',t('chat.loading_video'),'video-player__status');status.setAttribute('role','status');
  container.append(video,status);
  video.addEventListener('error',() => {if (current()) {status.hidden = false;status.textContent = t('errors.video_unreadable');}});
  try {
    const data = await invoke('read_chat_video',{id:file.video.id});
    if (!current()) return;
    if (typeof data !== 'string' || data.length > Math.ceil(VIDEO_LIMIT.source / 3) * 4) throw Error('video_unavailable');
    const url = URL.createObjectURL(new Blob([base64Bytes(data)],{type:file.video.mime_type}));
    video._objectURL = url;
    await videoEvent(video,'loadeddata',() => {video.src = url;});
    if (!current()) {releaseVideoPlayer(video);return;}
    if (video.duration === Infinity) await videoEvent(video,'seeked',() => {video.currentTime = 1e10;});
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw Error('video_unreadable');
    const position = Math.min(time,Math.max(0,video.duration - 0.01));
    if (Math.abs(video.currentTime - position) > 0.0001) await videoEvent(video,'seeked',() => {video.currentTime = position;});
    if (!current()) {releaseVideoPlayer(video);return;}
    status.hidden = true;
  } catch (error) {
    releaseVideoPlayer(video);
    if (current()) {status.hidden = false;status.textContent = localizeError(error);}
  }
}

function openVideoViewer(file, opener = document.activeElement, time = 0) {
  if (!videoViewer) {
    const dialog = document.createElement('dialog');dialog.className = 'image-viewer video-viewer';dialog.setAttribute('aria-labelledby','video-viewer-name');
    const close = activityButton(t('chat.close_image'),'close',() => dialog.close());close.classList.add('image-viewer__close');
    const side = activityButton(t('chat.video_side_panel'),'panelRight',() => {
      const file = dialog._file, time = dialog.querySelector('video')?.currentTime || 0;
      dialog.close();openVideoTab(file,time);
    });side.classList.add('video-viewer__side');
    const figure = activityText('figure','','image-viewer__figure');
    const stage = activityText('div','','video-viewer__stage');
    const caption = activityText('figcaption','','image-viewer__caption');caption.id = 'video-viewer-name';
    figure.append(stage,caption);dialog.append(close,side,figure);document.body.append(dialog);
    dialog.addEventListener('click',event => {if (event.target === dialog) dialog.close();});
    dialog.addEventListener('close',() => {
      dialog._request++;disposeVideoContent(stage);
      if (dialog._opener?.isConnected) dialog._opener.focus();
      dialog._opener = null;
    });
    videoViewer = dialog;
  }
  for (const video of document.querySelectorAll('.video-player')) video.pause();
  const viewer = videoViewer, stage = viewer.querySelector('.video-viewer__stage');
  disposeVideoContent(stage);stage.replaceChildren();
  viewer._file = file;viewer._opener = opener;viewer._request = (viewer._request || 0) + 1;
  for (const [selector,key] of [['.image-viewer__close','chat.close_image'],['.video-viewer__side','chat.video_side_panel']]) {
    const button = viewer.querySelector(selector);button.title = t(key);button.setAttribute('aria-label',t(key));
  }
  const request = viewer._request;
  viewer.querySelector('#video-viewer-name').textContent = file.name;
  if (!viewer.open) viewer.showModal();
  viewer.querySelector('.image-viewer__close').focus();
  mountVideoPlayer(stage,file,() => viewer.open && viewer._request === request,time);
}

function openVideoTab(attachment, time = 0) {
  let tab = browserPage.tabs.find(tab => tab.file?.video?.video.id === attachment.video.id);
  if (tab) {selectPanelTab(tab,{focus:true});const player = tab.file.view.querySelector('video');if (player?.readyState >= 1) player.currentTime = time;return;}
  const file = {video:attachment,path:attachment.name,url:`aurachat-video:${attachment.video.id}`,view:activityText('div','','file-preview video-preview'),icon:'Film'};
  $('#file-previews').append(file.view);
  tab = newPanelTab(null,crypto.randomUUID(),false,file);
  loadVideoTab(tab,time);
}

async function loadVideoTab(tab, time = 0) {
  const {file} = tab, request = file.request = (file.request || 0) + 1;
  const current = () => panelHasTab(tab) && file.request === request;
  disposeVideoContent(file.view);file.view.replaceChildren();
  const tools = activityText('div','','file-tools');
  const fullscreen = activityButton(t('chat.video_fullscreen'),'expand',() => openVideoViewer(file.video,fullscreen,file.view.querySelector('video')?.currentTime || 0));
  tools.append(activityText('span',file.video.name),fullscreen);file.view.append(tools);
  const content = activityText('div','','video-preview__content');file.view.append(content);
  tab.loading = true;renderBrowser();
  await mountVideoPlayer(content,file.video,current,time);
  if (current()) {tab.loading = false;renderBrowser();}
}
