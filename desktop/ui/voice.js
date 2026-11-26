// `field` is a dictation aimed at a text field outside the composer (e.g. an image comment): at most one
// at a time, sharing the microphone, the model and the FIFO of `jobs` with the composer. Its jobs carry
// `field` (the target) instead of a conversation, so composer code must ignore them.
const voice = { waveform: [], frame: null, epoch: 0, pending: false, recording: null, capture: null, mediaOperation: null, transcribing: false, jobs: [], worker: null, previewWorker: null, downloading: false, loading: false, loaded: false, ttsDownloading: false, nativeOperation: null, conversationId: null, field: null };

const speechInference = () => ['transcribe_audio', 'preview_audio'].includes(voice.nativeOperation?.command);
const joinDictation = (before, after) => [before, after].filter(Boolean).join(' ');

// Longest reveal: the last staggered word plus its wipe and its ink (styles.css).
const REVEAL_MS = 1400;

// `elapsed` resumes words whose reveal already started (a rebuilt textarea mirror).
function dictationReveal(text, elapsed = 0) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return document.createTextNode(text);
  const fragment = document.createDocumentFragment();
  let index = 0;
  for (const word of text.match(/\S+|\s+/gu) || []) {
    if (!word.trim()) {fragment.append(word);continue;}
    const span = document.createElement('span');span.className = 'voice-reveal-word';span.textContent = word;
    span.style.setProperty('--voice-delay', `${Math.min(index++ * 60, 360) - elapsed}ms`);
    fragment.append(span);
  }
  return fragment;
}

// Textareas cannot style a substring. Mirror the value while leaving the real field,
// caret, selection and input handling in place; only `reveals` ({start,length,at}) animate.
function revealDictationField(field, reveals) {
  field._voiceRevealCleanup?.();
  const now = performance.now();
  reveals = reveals.filter(reveal => reveal.length && now - reveal.at < REVEAL_MS).sort((a, b) => a.start - b.start);
  if (!reveals.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const style = getComputedStyle(field), box = field.getBoundingClientRect(), parent = field.parentElement.getBoundingClientRect();
  const mirror = document.createElement('div');mirror.className = 'voice-field-reveal';mirror.setAttribute('aria-hidden', 'true');
  for (const name of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','textAlign','textIndent','textTransform','paddingTop','paddingRight','paddingBottom','paddingLeft','wordBreak','overflowWrap','tabSize','direction']) mirror.style[name] = style[name];
  Object.assign(mirror.style, {
    left:`${box.left - parent.left - field.parentElement.clientLeft + field.parentElement.scrollLeft + field.clientLeft}px`,
    top:`${box.top - parent.top - field.parentElement.clientTop + field.parentElement.scrollTop + field.clientTop}px`,
    width:`${field.clientWidth}px`, height:`${field.clientHeight}px`, color:style.color
  });
  let at = 0;
  for (const reveal of reveals) {
    mirror.append(document.createTextNode(field.value.slice(at, reveal.start)), dictationReveal(field.value.slice(reveal.start, reveal.start + reveal.length), now - reveal.at));
    at = reveal.start + reveal.length;
  }
  mirror.append(document.createTextNode(field.value.slice(at)));
  field.parentElement.append(mirror);mirror.scrollTop = field.scrollTop;mirror.scrollLeft = field.scrollLeft;
  field.style.setProperty('--voice-caret', style.caretColor);
  field.classList.add('voice-field-revealing');
  field._voiceReveals = reveals;
  const cleanup = () => {
    clearTimeout(timer);observer.disconnect();mirror.remove();field.classList.remove('voice-field-revealing');field.style.removeProperty('--voice-caret');
    field.removeEventListener('input', cleanup);field.removeEventListener('scroll', cleanup);field._voiceRevealCleanup = null;field._voiceReveals = [];
  };
  // Ignore the observer's initial notification.
  let observed = false;
  const timer = setTimeout(cleanup, REVEAL_MS - (now - Math.max(...reveals.map(reveal => reveal.at)))), observer = new ResizeObserver(() => {if (observed) cleanup();observed = true;});
  observer.observe(field);
  field._voiceRevealCleanup = cleanup;
  field.addEventListener('input', cleanup);field.addEventListener('scroll', cleanup);
}

function voiceSelection(offset, start, end, length) {
  return offset < start ? offset : offset <= end ? start + length : offset + length - (end - start);
}

// Shared textarea adapter. Re-resolve the element: cards and annotation rows can be re-rendered.
function fieldDictationTarget(target, field, read, write, limit, limitMessage) {
  return Object.assign(target, {
    read: () => field()?.value ?? read(),
    at: () => field()?.selectionEnd ?? read().length,
    limit, limitMessage,
    replace(start, end, text, live) {
      const element = field();
      if (element) {
        // Words still revealing outside the replaced range keep animating; the rest appear as they are.
        const delta = text.length - (end - start);
        const reveals = (element._voiceReveals || []).filter(reveal => reveal.start + reveal.length <= start || reveal.start >= end)
          .map(reveal => reveal.start >= end ? {...reveal, start:reveal.start + delta} : reveal);
        if (live) reveals.push({start, length:text.length, at:performance.now()});
        element._voiceRevealCleanup?.();
        const a = element.selectionStart, b = element.selectionEnd, direction = element.selectionDirection, scroll = element.scrollTop;
        element.setRangeText(text, start, end, 'preserve');
        element.setSelectionRange(voiceSelection(a, start, end, text.length), voiceSelection(b, start, end, text.length), direction);
        element.dispatchEvent(new Event('input', {bubbles:true}));
        element.scrollTop = scroll;
        revealDictationField(element, reveals);
      } else {
        const value = read();
        write(value.slice(0, start) + text + value.slice(end));
      }
    }
  });
}

function editDictationComposer(change, mapOffset = offset => offset) {
  const selection = window.getSelection(), current = selection?.rangeCount ? selection.getRangeAt(0) : null;
  let offsets, backward;
  if (current && composerEl().contains(current.commonAncestorContainer)) {
    const prefix = current.cloneRange();prefix.selectNodeContents(composerEl());prefix.setEnd(current.startContainer, current.startOffset);
    const start = composerText(prefix.cloneContents()).length;
    offsets = [start, start + composerText(current.cloneContents()).length];
    backward = selection.anchorNode === current.endContainer && selection.anchorOffset === current.endOffset;
  }
  change();
  if (offsets) {
    const r = composerRange(...offsets.map(mapOffset));
    if (backward) selection.setBaseAndExtent(r.endContainer, r.endOffset, r.startContainer, r.startOffset);
    else selection.setBaseAndExtent(r.startContainer, r.startOffset, r.endContainer, r.endOffset);
  }
}

// Unwraps reveal spans once their animation is over, keeping the caret where it was.
function settleDictationWords(words) {
  const live = words.filter(word => word.isConnected);
  if (live.length) editDictationComposer(() => live.forEach(word => word.replaceWith(...word.childNodes)));
}

function composerDictationTarget(id, owner) {
  return {
    valid: () => owner === state.config.firebase_email && !!findConversation(id),
    status: composerStatus,
    read: () => id === state.activeConversationId ? composerText() : state.drafts.get(id)?.text || '',
    replace(start, end, text, live) {
      if (id === state.activeConversationId) {
        // A final pass shows its words as they are: words still revealing simply end now.
        if (!live) settleDictationWords([...composerEl().querySelectorAll('.voice-reveal-word')]);
        let words = [];
        editDictationComposer(() => {
          if (start === 0 && end === 0) dropComposerPlaceholder(composerEl(), false);
          const range = composerRange(start, end);
          const leaf = range.startContainer, word = leaf.parentElement;
          if (range.collapsed && word?.classList.contains('voice-reveal-word') && range.startOffset === leaf.length) {
            range.setStartAfter(word);range.collapse(true);
          }
          range.deleteContents();
          if (!text) return;
          const node = live ? dictationReveal(text) : document.createTextNode(text);
          if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) words = [...node.querySelectorAll('.voice-reveal-word')];
          range.insertNode(node);
        }, offset => voiceSelection(offset, start, end, text.length));
        if (words.length) Promise.all(words.flatMap(word => word.getAnimations().map(animation => animation.finished.catch(() => {})))).then(() => settleDictationWords(words));
        autoGrow();saveChatDraft();
      } else {
        const draft = state.drafts.get(id) || {text:'', attachments:[], editing:null};
        // Preserve collapsed pastes/file mentions outside the dictated range.
        if (draft.parts) {
          const slice = (from, to) => {
            let at = 0;
            return draft.parts.flatMap(part => {
              const first = Math.max(0, from - at), last = Math.min(part.text.length, to - at);at += part.text.length;
              return last > first ? [{...part, text:part.text.slice(first, last)}] : [];
            });
          };
          draft.parts = [...slice(0, start), {text}, ...slice(end, draft.text.length)];
        }
        draft.text = draft.text.slice(0, start) + text + draft.text.slice(end);
        state.drafts.set(id, draft);
      }
    }
  };
}

// Own only the inserted range, not the user's draft. An edit inside it gives that
// text back to the user; recognition then continues with the as-yet-unshown audio.
function dictationInsertion(target) {
  let previous = target.read(), start = target.at?.() ?? previous.length, inserted = '';
  const edit = {
    sync() {
      const value = target.read();
      if (value === previous) return true;
      if (!inserted) { previous = value;start = target.at?.() ?? value.length;return true; }
      const shift = value.length - previous.length;
      if (start + shift >= 0 && value.slice(start + shift) === previous.slice(start)) {
        start += shift;previous = value;return true;
      }
      const edge = start + inserted.length;
      if (value.slice(0, edge) === previous.slice(0, edge)) {
        const extension = /[\p{L}\p{N}]$/u.test(inserted) && value.slice(edge).match(/^[\p{L}\p{M}\p{N}]+/u);
        if (extension && !previous.slice(edge).startsWith(extension[0])) {
          start = edge + extension[0].length;inserted = '';previous = value;return false;
        }
        previous = value;return true;
      }
      let first = 0, suffix = 0;
      while (first < Math.min(previous.length, value.length) && previous[first] === value[first]) first++;
      while (suffix < Math.min(previous.length, value.length) - first && previous[previous.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++;
      const end = previous.length - suffix, delta = value.length - previous.length;
      let owned = true;
      if (end <= start) start += delta;
      else if (first < start + inserted.length) {
        start = Math.min(value.length, Math.max(first, start + inserted.length + delta));
        inserted = '';owned = false;
      }
      previous = value;
      return owned;
    },
    update(text, live = false) {
      if (!target.valid()) return;
      const value = target.read(), end = start + inserted.length;
      const before = value.slice(0, start), after = value.slice(end);
      const full = text ? `${before && !/\s$/.test(before) ? ' ' : ''}${text}${after && !/^\s/.test(after) ? ' ' : ''}` : '';
      const replacement = full.slice(0, Math.max(0, (target.limit ?? Infinity) - value.length + inserted.length));
      if (replacement !== inserted) {
        let prefix = 0, suffix = 0;
        while (prefix < Math.min(inserted.length, replacement.length) && inserted[prefix] === replacement[prefix]) prefix++;
        while (suffix < Math.min(inserted.length, replacement.length) - prefix && inserted[inserted.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]) suffix++;
        target.replace(start + prefix, end - suffix, replacement.slice(prefix, replacement.length - suffix), live);
      }
      inserted = replacement;previous = target.read();
      if (replacement.length < full.length) target.status(t(target.limitMessage));
    },
    cancel() { if (target.valid() && edit.sync()) edit.update(''); }
  };
  return edit;
}

const dictationWords = text => text.match(/\S+/gu) || [];
const dictationKey = word => word.toLowerCase().replace(/^\p{P}+|\p{P}+$/gu, '') || word;

function agreedWords(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// Locate the end of an already published prefix after Whisper revises earlier words.
// The common append-only case needs no alignment. On a correction, prefer the nearest
// word boundary with the fewest insertions, deletions and substitutions.
function dictationBoundary(published, current) {
  const first = agreedWords(published, current);
  if (first === Math.min(published.length, current.length)) return first;
  const rest = published.slice(first), anchor = current.indexOf(rest[0], first);
  if (anchor !== -1 && rest.every((word, i) => word === current[anchor+i])) return anchor + rest.length;
  const n = rest.length, m = Math.min(current.length - first, n * 2);
  // In a tie retain exact matches: "meet John" -> "meet with John" must consume John.
  const step = n + 1;
  let costs = Array.from({length:m + 1}, (_, j) => j * step);
  for (let i = 1; i <= n; i++) {
    const next = [i * step];
    for (let j = 1; j <= m; j++) next[j] = Math.min(costs[j] + step, next[j-1] + step,
      costs[j-1] + (published[first+i-1] === current[first+j-1] ? -1 : step));
    costs = next;
  }
  let best = Math.min(n, m);
  for (let j = 0; j <= m; j++) if (costs[j] < costs[best] || (costs[j] === costs[best] && Math.abs(n-j) < Math.abs(n-best))) best = j;
  return first + best;
}

function syncLiveInsertion(recording) {
  if (recording.insertion.sync()) return;
  // The user took over the words already shown; the confirmed ones still waiting continue after the edit.
  const unshown = dictationWords(recording.previewText).slice(recording.shown);
  recording.protectedWords = recording.published.slice(0, Math.max(0, recording.published.length - unshown.length));
  recording.previewText = unshown.join(' ');
  recording.shown = 0;
}

// Confirmed words arrive in bursts, one per preview: show them one at a time, faster when they pile up.
function dripDictation(recording) {
  recording.drip = null;
  if (recording.stopped || !recording.target.valid()) return;
  syncLiveInsertion(recording);
  const words = dictationWords(recording.previewText);
  recording.shown = Math.min(words.length, recording.shown + 1);
  recording.insertion.update(words.slice(0, recording.shown).join(' '), true);
  const left = words.length - recording.shown;
  if (left > 0) recording.drip = setTimeout(() => dripDictation(recording), Math.min(220, Math.max(50, 900 / left)));
}

// Stop shows every confirmed word at once; the final pass then corrects the text in place.
function flushDictation(recording) {
  clearTimeout(recording.drip);recording.drip = null;
  syncLiveInsertion(recording);
  recording.shown = dictationWords(recording.previewText).length;
  recording.insertion.update(recording.previewText, true);
}

function publishDictationPreview(recording, text) {
  const words = dictationWords(text), keys = words.map(dictationKey);
  const confirmed = agreedWords(recording.previousWords, keys);
  recording.previousWords = keys;
  const start = dictationBoundary(recording.published, keys);
  if (confirmed > start) {
    recording.previewText = joinDictation(recording.previewText, words.slice(start, confirmed).join(' '));
    recording.published = keys.slice(0, confirmed);
    if (!recording.drip) dripDictation(recording);
  }
  return confirmed < keys.length;
}

function recordingSamples(recording, start = 0, end = recording.count) {
  let offset = 0;
  const chunks = [];
  for (const chunk of recording.chunks) {
    if (offset >= end) break;
    const first = Math.max(0, start - offset), last = Math.min(chunk.length, end - offset);
    if (last > first) chunks.push(chunk.subarray(first, last));
    offset += chunk.length;
  }
  return speechSamples(chunks, recording.context.sampleRate);
}

function previewRecording(recording) {
  if (recording.stopped || voice.capture !== recording || !recording.target.valid() || recording.owner !== state.config.firebase_email
    || recording.count < recording.nextPreview || (recording.lastSpeech <= recording.previewSpeech && !recording.confirmPause)
    || voice.previewWorker || voice.worker || voice.jobs.length || voice.nativeOperation) return;
  syncLiveInsertion(recording);
  const rate = recording.context.sampleRate, from = recording.from;
  const end = Math.min(recording.count, from + rate * 30);
  if (end - from < rate * 1.5) return;
  const samples = recordingSamples(recording, from, end);
  const spoken = recording.lastSpeech;
  const current = () => !recording.stopped && voice.capture === recording && recording.target.valid()
    && recording.owner === state.config.firebase_email;
  const newSpeech = spoken > recording.previewSpeech;
  recording.confirmPause = false;
  voice.previewWorker = (async () => {
    try {
      const result = await speechRequest('preview_audio', {samples, language:recording.language});
      if (!current()) return;
      syncLiveInsertion(recording);
      const pending = publishDictationPreview(recording, joinDictation(recording.committed, result.text.trim()));
      // A short phrase followed by silence still gets one chance to settle.
      recording.confirmPause = newSpeech && pending;
      recording.previewSpeech = Math.min(spoken, end);
      recording.committed = joinDictation(recording.committed, result.committed);
      recording.from += Math.round(result.advance * rate / 16000);
      if (recording.previewFailed) recording.target.status('');
      recording.previewFailed = false;
    } catch (error) {
      if (!current()) return;
      if (String(error).includes('speech_silence')) {
        recording.previewSpeech = Math.min(spoken, end);
        if (end - from >= rate * 12) {
          // The next audio window no longer contains the words visible before this silence.
          if (recording.published.length > dictationWords(recording.committed).length) recording.committed = recording.published.join(' ');
          recording.previousWords = dictationWords(recording.committed).map(dictationKey);
          recording.from = end;
        }
      } else if (!String(error).includes('speech_busy')) {
        console.error('Live dictation failed', error);
        if (!recording.previewFailed) recording.target.status(voiceError(error));
        recording.previewFailed = true;
      }
    } finally {
      recording.nextPreview = recording.count + rate * 0.75;
      voice.previewWorker = null;
      drainTranscriptions();
    }
  })();
}

function voiceBusy(id) {
  return ((voice.pending || voice.recording) && voice.conversationId === id)
    || voice.jobs.some(job => !job.field && !job.cancelled && job.conversationId === id);
}

async function speechRequest(command, args) {
  const operation = {command};
  voice.nativeOperation = operation;
  try { return await invoke(command, args); }
  finally {
    if (voice.nativeOperation === operation) voice.nativeOperation = null;
    if (!voice.pending && !voice.transcribing && !voice.recording) voiceUi();
  }
}

function voiceError(error) {
  const code = String(error);
  for (const key of ['speech_busy','speech_model_missing','speech_silence','speech_invalid_audio','speech_checksum']) {
    if (code.includes(key)) return t('voice.' + key);
  }
  for (const key of ['tts_busy','tts_model_missing','tts_checksum','tts_voice_missing','tts_invalid_text','tts_audio_invalid','tts_text_too_long']) {
    if (code.includes(key)) {
      if (key === 'tts_checksum') return t('voice.tts_checksum');
      if (key === 'tts_text_too_long') return t('voice.tts_text_too_long');
      return t('voice.tts_error');
    }
  }
  if (code.includes('NotAllowed') || code.includes('PermissionDenied')) return t('voice.permission');
  return t('voice.error');
}

function renderSpeechModel(status) {
  if (!status) return;
  const percent = Math.floor(100 * status.downloaded / status.total);
  $('#voice-model-progress').value = status.downloaded;
  $('#voice-model-progress').max = status.total;
  $('#voice-model-progress').hidden = status.ready || !status.downloaded;
  const label = !status.ready ? '' : status.loading ? 'voice.loading_model' : status.busy ? 'voice.speech_busy' : status.loaded ? 'voice.loaded' : 'voice.ready';
  $('#voice-model-status').textContent = label ? t(label) : status.downloaded ? `${t('voice.downloaded')} ${percent}% · ${(status.downloaded/1e9).toFixed(2)} / ${(status.total/1e9).toFixed(2)} GB` : t('voice.not_installed');
  $('#voice-download').hidden = status.ready || voice.downloading;
  $('#voice-download').disabled = status.busy || status.loading || voice.transcribing;
  $('#voice-download').textContent = t(status.downloaded ? 'voice.resume' : 'voice.download');
  $('#voice-download-cancel').hidden = !voice.downloading;
  $('#voice-remove').hidden = !status.downloaded;
  $('#voice-remove').disabled = status.busy || status.loading || voice.downloading || voice.transcribing || !!voice.recording;
}

async function refreshSpeechModel() {
  try { renderSpeechModel(await invoke('speech_model_status')); }
  catch (_) { $('#voice-model-status').textContent = t('voice.error'); }
}

function selectedTtsVoice() {
  const selected = $('#tts-voice')?.value;
  return selected === 'im_nicola' ? selected : 'if_sara';
}

function renderTtsModel(status) {
  if (!status) return;
  const percent = Math.floor(100 * status.downloaded / status.total);
  $('#tts-model-progress').value = status.downloaded;
  $('#tts-model-progress').max = status.total;
  $('#tts-model-progress').hidden = status.ready || !status.downloaded;
  const label = !status.ready ? '' : status.loading ? 'voice.tts_loading' : status.busy ? 'voice.tts_busy' : status.loaded ? 'voice.tts_loaded' : 'voice.tts_ready';
  $('#tts-model-status').textContent = label ? t(label) : status.downloaded ? `${t('voice.tts_downloaded')} ${percent}% · ${(status.downloaded/1048576).toFixed(0)} / ${(status.total/1048576).toFixed(0)} MiB` : t('voice.tts_not_installed');
  $('#tts-download').hidden = status.ready || voice.ttsDownloading;
  $('#tts-download').disabled = status.busy || status.loading;
  $('#tts-download').textContent = t(status.downloaded ? 'voice.tts_resume' : 'voice.tts_download');
  $('#tts-download-cancel').hidden = !voice.ttsDownloading;
  $('#tts-remove').hidden = !status.downloaded;
  $('#tts-remove').disabled = status.busy || status.loading || voice.ttsDownloading;
}

async function refreshTtsModel() {
  try { renderTtsModel(await invoke('tts_model_status')); }
  catch (_) { $('#tts-model-status').textContent = t('voice.tts_error'); }
}

// The weights stay in memory: loading them at startup keeps the first microphone
// immediate and replaces an unexplained "model busy" with a visible loading state.
async function warmSpeechModel() {
  if (voice.loading) return;
  let status;
  try { status = await invoke('speech_model_status'); } catch (_) { return; }
  if (!status?.ready) { voice.loaded = false; return; }
  if (status.loaded) { voice.loaded = true; return; }
  if (status.busy) return;
  voice.loading = true; voice.loaded = false;
  if ($('#composer-mic')) voiceUi();
  try {
    await invoke('prepare_speech_model');
    voice.loaded = true;
  } catch (error) {
    if (!/speech_(busy|cancelled)/.test(String(error))) composerStatus(voiceError(error));
  } finally {
    voice.loading = false;
    if ($('#composer-mic')) voiceUi();
    if ($('#voice-model-status')) refreshSpeechModel();
  }
}

function voiceUi(message = '') {
  const mic = $('#composer-mic');
  const job = voice.jobs.find(job => !job.field && !job.cancelled && job.conversationId === state.activeConversationId);
  const transcribing = !!job && !voice.recording && !voice.pending;
  const finishing = !!((voice.mediaOperation && !voice.mediaOperation.forField) || (voice.nativeOperation && !speechInference())) && !voice.pending && !voice.field && !transcribing && !voice.recording;
  const active = !!voice.recording || voice.pending || transcribing || finishing;
  const loading = voice.loading;
  mic.hidden = active;
  $('.composer__toolbar .model-select').hidden = active;
  $('#composer-attach').hidden = active;
  mic.disabled = active || loading || !!voice.field || state.preparing || state.loadingConversation || queuedTurns.preparing.has(state.activeConversationId);
  mic.classList.toggle('is-loading', loading);
  mic.setAttribute('aria-pressed', String(!!voice.recording));
  const label = t(voice.recording ? 'voice.stop' : loading ? 'voice.loading_model' : 'chat.dictate');
  mic.setAttribute('aria-label', label);
  mic.title = label;
  mic.replaceChildren(icon(voice.recording ? 'stop' : 'mic'));
  const busy = voice.pending || transcribing || finishing;
  // Like Codex: while the first job transcribes, the frozen waveform stays and Stop (or Send) spins.
  const queued = transcribing && job !== voice.jobs[0], spinning = transcribing && !queued;
  const textual = voice.pending || finishing || queued;
  // Intermediate refreshes (e.g. media resume) must not wipe the visible progress label.
  voice.status = busy ? message || voice.status || '' : '';
  voice.shownWave = voice.recording ? null : job?.wave || [];
  $('#voice-recording').hidden = !active;
  $('#voice-recording').classList.toggle('is-busy', textual);
  $('#voice-recording').classList.toggle('is-transcribing', spinning);
  const backgroundChat = voice.conversationId && voice.conversationId !== state.activeConversationId ? findConversation(voice.conversationId)?.conversation.title : null;
  const statusText = finishing ? t('voice.finishing') : transcribing ? t(queued ? 'voice.queued' : 'voice.transcribing') : busy ? voice.status : message;
  $('#voice-recording-status').textContent = backgroundChat ? `${statusText} · ${backgroundChat}` : statusText;
  $('#voice-recording-status').classList.toggle('sr-only', !textual);
  $('#voice-waveform').hidden = !voice.recording && !spinning;
  $('#voice-recording-cancel').disabled = finishing;
  const stop = $('#voice-stop'), stopSpins = spinning && !job.sendAfter;
  stop.hidden = !voice.recording && !stopSpins;
  stop.disabled = !voice.recording;
  stop.classList.toggle('is-spinning', stopSpins);
  updateComposerControls();
  if (active && !voice.frame) drawVoiceWave();
  if (!active) { cancelAnimationFrame(voice.frame); voice.frame = null; }
  syncAnnotatorVoice();syncQuestionVoice();
}

function releaseRecording(recording) {
  recording.stopped = true;
  clearTimeout(recording.timer);clearTimeout(recording.drip);
  recording.stream?.getTracks().forEach(track => track.stop());
  recording.node?.disconnect(); recording.source?.disconnect();
  if (recording.context && recording.context.state !== 'closed') recording.context.close().catch(() => {});
  if (voice.capture === recording) voice.capture = null;
  if (recording.release) return recording.release;
  const operation = recording.release = (async () => {
    if (await recording.mediaPause) {
      try { await invoke('resume_dictation_media', {id:recording.mediaId}); }
      catch (error) { console.error('Dictation media resume failed', error);(recording.report || composerStatus)(t('voice.media_error')); }
    }
  })();
  voice.mediaOperation = operation;
  operation.forField = !!recording.field;
  operation.finally(() => {
    if (voice.mediaOperation === operation) {voice.mediaOperation = null;voiceUi();}
  });
  return operation;
}

function cancelVoice(all = false) {
  if (all) cancelFieldVoice();
  // A composer cancel must leave a live field dictation (which owns `capture`) alone.
  if (all || !voice.field || voice.recording || voice.pending) voice.epoch++;
  if (all || (!voice.recording && !voice.pending)) {
    for (const job of voice.jobs) {
      if (all || (!job.field && job.conversationId === state.activeConversationId)) {
        job.cancelled = true;
        job.recording.insertion.cancel();
      }
    }
  }
  const own = voice.recording || (voice.capture?.field ? null : voice.capture);
  own?.insertion.cancel();
  const released = own ? releaseRecording(own) : voice.mediaOperation;
  voice.recording = null; voice.pending = false; voice.conversationId = null;
  if ($('#voice-recording')) voiceUi();
  return released;
}

// Capture at the device rate if it cannot supply 16 kHz; downsample before local IPC.
function speechSamples(chunks, rate) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Float32Array(size); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  const output = new Float32Array(Math.min(16000 * 120, Math.floor(size * 16000 / rate)));
  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * rate / 16000), end = Math.min(size, Math.max(start + 1, Math.floor((i + 1) * rate / 16000)));
    let sum = 0; for (let j = start; j < end; j++) sum += joined[j];
    output[i] = Math.max(-1, Math.min(1, sum / (end - start)));
  }
  return Array.from(output);
}

function paintWave(canvas, values = voice.waveform) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio)); canvas.height = 32 * ratio;
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
  const count = Math.max(1, Math.floor(rect.width / 5));
  values = values.slice(-count);
  ctx.fillStyle = getComputedStyle(canvas).color;
  for (let i = 0; i < count; i++) {
    const value = values[i - (count - values.length)] || 0;
    const height = Math.max(2, Math.min(26, value * 26));
    ctx.beginPath(); ctx.roundRect(i * 5, (32 - height)/2, 2, height, 1); ctx.fill();
  }
}

function drawVoiceWave() {
  paintWave($('#voice-waveform'), voice.shownWave || voice.waveform);
  voice.frame = requestAnimationFrame(drawVoiceWave);
}

// Shared by the composer and field dictation: checks the model, loads it, opens the microphone and
// starts capturing. `extra` is merged into the recording; `ui` holds the target-specific reactions
// (progress, report, missing, live). Resolves quietly when refused or superseded; throws on failure,
// with the microphone already released.
async function captureVoice(epoch, extra, ui) {
  const owner = state.config.firebase_email;
  const status = await invoke('speech_model_status');
  if (epoch !== voice.epoch) return;
  if (status?.busy && !voice.transcribing && !voice.previewWorker) { ui.report(t('voice.speech_busy')); return; }
  if (!status?.ready) { ui.missing(status); return; }
  ui.progress(t('voice.loading_model'));
  if (!voice.transcribing && !voice.previewWorker) await speechRequest('prepare_speech_model');
  voice.loaded = true;
  if (epoch !== voice.epoch) return;
  ui.progress(t('voice.preparing'));
  voice.waveform = [];
  const target = extra.field || composerDictationTarget(extra.conversationId, owner);
  const recording = { chunks: [], count: 0, waveEnergy: 0, waveSamples: 0, epoch, owner, language:lang, report:ui.report,
    target, insertion:dictationInsertion(target), from:0, committed:'', previewText:'', shown:0, drip:null, previousWords:[], published:[], protectedWords:[],
    nextPreview:0, previewSpeech:0, lastSpeech:0, ...extra };
  voice.capture = recording;
  try {
    recording.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    if (epoch !== voice.epoch) { releaseRecording(recording); return; }
    recording.context = new AudioContext({ sampleRate: 16000 });
    recording.nextPreview = recording.context.sampleRate * 1.5;
    await recording.context.audioWorklet.addModule('audio-recorder.js');
    if (epoch !== voice.epoch) { releaseRecording(recording); return; }
    recording.source = recording.context.createMediaStreamSource(recording.stream);
    recording.node = new AudioWorkletNode(recording.context, 'aura-recorder');
    recording.node.port.onmessage = event => {
      if (event.data.flushed) { recording.flushed?.(); return; }
      const chunk = event.data.samples;
      if (!chunk || recording.count >= recording.context.sampleRate * 120) return;
      recording.chunks.push(chunk); recording.count += chunk.length;
      // One bar per 100 ms of audio, independent of device rate and callback size.
      const waveWindow = Math.round(recording.context.sampleRate * 0.1);
      for (const sample of chunk) {
        recording.waveEnergy += sample * sample;
        if (++recording.waveSamples >= waveWindow) {
          const rms = Math.sqrt(recording.waveEnergy / recording.waveSamples);
          if (rms >= 0.001) recording.lastSpeech = recording.count;
          voice.waveform.push(Math.min(1, rms * 12));
          recording.waveEnergy = 0; recording.waveSamples = 0;
        }
      }
      voice.waveform = voice.waveform.slice(-200);
      previewRecording(recording);
    };
    recording.mediaId = crypto.randomUUID();
    recording.mediaPause = invoke('pause_dictation_media', {id:recording.mediaId}).then(() => true, error => {
      console.error('Dictation media pause failed', error);recording.report(t('voice.media_error'));return false;
    });
    await recording.mediaPause;
    if (epoch !== voice.epoch) { await releaseRecording(recording);return; }
    recording.source.connect(recording.node); recording.node.connect(recording.context.destination);
    await recording.context.resume();
    if (epoch !== voice.epoch) { releaseRecording(recording); return; }
    ui.report('');
    ui.live(recording);
  } catch (error) {
    releaseRecording(recording);
    throw error;
  }
}

// Stops feeding `recording` and turns what was captured into the samples of `job`.
async function finishRecording(recording, job) {
  recording.stopped = true;
  try {
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 300);
      recording.flushed = () => { clearTimeout(timeout); resolve(); };
      recording.node.port.postMessage('flush');
    });
    await releaseRecording(recording);
    job.samples = recordingSamples(recording);
    recording.chunks = [];
  } catch (error) {
    await releaseRecording(recording);
    job.error = error;
  } finally {
    job.ready = true;
  }
}

async function startVoice() {
  if (voice.pending || voice.field || voice.loading || (voice.nativeOperation && !speechInference()) || voice.mediaOperation || state.preparing || state.loadingConversation || queuedTurns.preparing.has(state.activeConversationId)) return;
  if (voice.recording) return stopVoice();
  if (voice.jobs.length >= 8) {composerStatus(t('voice.queue_full'));return;}
  const epoch = ++voice.epoch;
  voice.conversationId = state.activeConversationId;
  voice.pending = true; voiceUi(t('voice.preparing'));
  try {
    if (!voice.conversationId) {
      const draft = {text:composerText(), attachments:structuredClone(state.attachments), editing:state.editingMessageIndex};
      await ensureConversation();
      if (epoch !== voice.epoch || !state.activeConversationId) return;
      voice.conversationId = state.activeConversationId;
      state.drafts.set(voice.conversationId,draft);restoreChatDraft(voice.conversationId);
    }
    await captureVoice(epoch, {conversationId:voice.conversationId}, {
      progress: voiceUi,
      report: composerStatus,
      missing: status => { openSettings(); selectSettingsTab('voice'); renderSpeechModel(status); },
      live: recording => {
        voice.recording = recording;
        recording.timer = setTimeout(() => stopVoice(false), 120000);
        voice.pending = false; voiceUi(t('voice.recording'));
      }
    });
  } catch (error) {
    voice.conversationId = null;
    if (epoch === voice.epoch) composerStatus(voiceError(error));
  } finally {
    if (epoch === voice.epoch) { voice.pending = false; if (!voice.recording) voiceUi(); }
  }
}

async function stopVoice(sendAfter = false) {
  const recording = voice.recording;
  if (!recording) return;
  const conversationId = recording.conversationId;
  flushDictation(recording);
  // Send keeps the draft and the live words visible; the composer is only locked until the final pass.
  const job = {conversationId, recording, owner:recording.owner, language:recording.language, cancelled:false, samples:null, sendAfter, wave:voice.waveform.slice()};
  voice.jobs.push(job);voice.transcribing = true;
  voice.recording = null;voiceUi(t('voice.transcribing'));
  try { await finishRecording(recording, job); }
  finally {
    if (voice.conversationId === conversationId && !voice.recording && !voice.pending) voice.conversationId = null;
    drainTranscriptions();
  }
}

// What stops a field dictation from starting: 'composer' (the composer owns the microphone),
// 'busy' (another field or a cancelled operation is finishing) or 'loading' (model warm-up).
function fieldVoiceBlocker() {
  if (voice.pending || voice.recording) return 'composer';
  if (voice.field || voice.mediaOperation || (voice.nativeOperation && !speechInference())) return 'busy';
  return voice.loading ? 'loading' : null;
}

// 'preparing' | 'recording' | 'queued' | 'transcribing' for the first field target matching `matches`.
function fieldVoicePhase(matches) {
  if (voice.field && matches(voice.field.target)) return voice.field.recording ? 'recording' : 'preparing';
  const job = voice.jobs.find(job => job.field && !job.cancelled && matches(job.field));
  return job ? (job === voice.jobs[0] ? 'transcribing' : 'queued') : null;
}

// `target`: {valid(), status(message), read(), replace(start,end,text)}. The destination is pinned here: the result is
// inserted only while `valid()` still holds, never into whatever is current when it arrives.
async function startFieldVoice(target) {
  if (fieldVoiceBlocker()) return;
  if (voice.jobs.length >= 8) { target.status(t('voice.queue_full')); return; }
  const epoch = ++voice.epoch, field = voice.field = {target, epoch, recording:null, message:t('voice.preparing')};
  voiceUi();
  try {
    await captureVoice(epoch, {field:target}, {
      progress: message => { field.message = message; voiceUi(); },
      report: message => target.status(message),
      missing: status => { renderSpeechModel(status); target.status(t('voice.speech_model_missing')); },
      live: recording => {
        field.recording = recording;
        recording.timer = setTimeout(stopFieldVoice, 120000);
        voiceUi();
      }
    });
  } catch (error) {
    if (epoch === voice.epoch) target.status(voiceError(error));
  } finally {
    if (voice.field === field && !field.recording) voice.field = null;
    voiceUi();
  }
}

async function stopFieldVoice() {
  const recording = voice.field?.recording;
  if (!recording) return;
  flushDictation(recording);
  const job = {field:recording.field, recording, owner:recording.owner, language:recording.language, cancelled:false, samples:null};
  voice.jobs.push(job);voice.transcribing = true;
  voice.field = null;voiceUi();
  try { await finishRecording(recording, job); }
  finally { drainTranscriptions(); }
}

// Discards the recording and the queued or running audio of every field target accepted by `matches`.
function cancelFieldVoice(matches = () => true) {
  for (const job of voice.jobs) if (job.field && matches(job.field)) {job.cancelled = true;job.recording.insertion.cancel();}
  const field = voice.field;
  let released = voice.mediaOperation;
  if (field && matches(field.target)) {
    voice.epoch++;
    const recording = field.recording || (voice.capture?.field === field.target ? voice.capture : null);
    if (recording) {recording.insertion.cancel();released = releaseRecording(recording);}
    voice.field = null;
  }
  voiceUi();
  return released;
}

// The cancel / loader / status / waveform / stop strip shown under a field while it is dictated.
// The classes are the annotator's (annotations.css); callers drive it from their own sync function.
function fieldVoiceStrip(onCancel) {
  const strip = document.createElement('div');strip.className = 'annotator__voice';strip.hidden = true;
  const button = (name, label, action) => {
    const element = document.createElement('button');element.type = 'button';element.className = `icon-button annotator__voice-btn annotator__voice-${name}`;
    element.setAttribute('aria-label', t(label));element.title = t(label);element.append(icon(name === 'stop' ? 'stop' : 'close'));
    element.onclick = action;
    return element;
  };
  const loader = document.createElement('span');loader.className = 'annotator__voice-loader';loader.setAttribute('aria-hidden', 'true');
  loader.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  const status = document.createElement('span');status.className = 'annotator__voice-status';status.setAttribute('role', 'status');
  const wave = document.createElement('canvas');wave.className = 'annotator__voice-wave';wave.height = 32;wave.setAttribute('aria-hidden', 'true');
  strip.append(button('cancel', 'voice.cancel', onCancel), loader, status, wave, button('stop', 'voice.stop', () => stopFieldVoice()));
  return strip;
}

// Sends exactly what the composer of `id` shows, collapsed pastes and file mentions included.
function takeVoiceMessage(id) {
  if (id === state.activeConversationId) saveChatDraft();
  const draft = state.drafts.get(id);
  const message = {...composerMessage(draft?.parts || [{text:draft?.text || ''}]), attachments:draft?.attachments || [], edit_index:draft?.editing ?? null};
  if (!message.content && !message.attachments.length) return null;
  state.drafts.delete(id);
  if (id === state.activeConversationId) restoreChatDraft(id);
  return message;
}

// A field job never reaches the engine once cancelled, and its text is dropped unless the target is
// still valid when the transcript arrives.
async function finalTranscript(job) {
  const recording = job.recording;
  const text = await speechRequest('transcribe_audio', {samples:job.samples,language:job.language});
  if (job.cancelled || !recording.target.valid()) return null;
  if (!text?.trim()) throw 'speech_silence';
  syncLiveInsertion(recording);
  if (!recording.protectedWords.length) return text.trim();
  const words = dictationWords(text);
  return words.slice(dictationBoundary(recording.protectedWords, words.map(dictationKey))).join(' ');
}

async function drainFieldJob(job) {
  const target = job.field, stale = () => job.cancelled || job.owner !== state.config.firebase_email || !target.valid();
  try {
    if (stale()) return;
    if (job.error) throw job.error;
    const text = await finalTranscript(job);
    if (stale()) return;
    if (text !== null) job.recording.insertion.update(text);
  } catch (error) {
    console.error('Dictation failed',error);
    if (!stale()) target.status(voiceError(error));
  } finally {
    job.samples = null;
    voice.jobs.shift();voice.transcribing = voice.jobs.length > 0;
    voiceUi();
  }
}

function drainTranscriptions() {
  if (voice.worker || voice.previewWorker) return;
  voice.worker = (async () => {
    while (voice.jobs[0]?.ready) {
      const job = voice.jobs[0], id = job.conversationId;
      if (job.field) { await drainFieldJob(job); continue; }
      const stale = () => job.cancelled || job.owner !== state.config.firebase_email || !findConversation(id);
      try {
        if (stale()) continue;
        if (job.error) throw job.error;
        const text = await finalTranscript(job);
        if (stale()) continue;
        if (text !== null) job.recording.insertion.update(text);
        if (job.sendAfter) {
          await discoverRemoteTarget(id);
          if (stale()) continue;
          const message = takeVoiceMessage(id);
          if (message) {
            const queue = state.queues.get(id) || [];
            queue.push(message);state.queues.set(id,queue);refreshQueue(id);
            if (id === state.activeConversationId) chatScroll.follow();
          }
        } else if (id === state.activeConversationId) composerStatus();
        else composerStatus(`${t('voice.added_to')} «${findConversation(id)?.conversation.title}»`);
      } catch (error) {
        console.error('Dictation failed',error);
        // The draft and the live words never left the composer: it only needs unlocking.
        if (job.owner === state.config.firebase_email) composerStatus(`${voiceError(error)} · ${findConversation(id)?.conversation.title || ''}`);
      } finally {
        job.samples = null;
        voice.jobs.shift();voice.transcribing = voice.jobs.length > 0;
        voiceUi();flushQueue(id);
        // Locking the composer dropped its focus (and the disabled Send button's): give it back.
        const focused = document.activeElement;
        if (job.sendAfter && id === state.activeConversationId && (focused === document.body || focused?.closest('.composer'))) {
          composerEl().focus();placeCaretAtEnd(composerEl());
        }
      }
    }
  })().finally(() => {voice.worker = null;if (voice.jobs[0]?.ready) drainTranscriptions();});
}

function setupLocalVoice() {
  voiceUi();
  const savedTtsVoice = localStorage.getItem('aurachat.tts.voice');
  $('#tts-voice').value = savedTtsVoice === 'im_nicola' ? 'im_nicola' : 'if_sara';
  $('#tts-voice').onchange = () => localStorage.setItem('aurachat.tts.voice', selectedTtsVoice());
  $('.voice-source').onclick = async event => {
    event.preventDefault();
    try { await invoke('open_external_url', { url: event.currentTarget.href }); }
    catch (_) { $('#voice-error').textContent = t('chat.link_failed'); }
  };
  $('#composer-mic').onclick = startVoice;
  $('#voice-stop').onclick = () => stopVoice(false);
  $('#voice-recording-cancel').onclick = () => cancelVoice();
  $('#voice-download').onclick = async () => {
    if (voice.downloading) return;
    voice.downloading = true; $('#voice-error').textContent = ''; await refreshSpeechModel();
    try { renderSpeechModel(await invoke('download_speech_model')); }
    catch (error) { if (!String(error).includes('speech_cancelled')) $('#voice-error').textContent = voiceError(error); }
    finally { voice.downloading = false; await refreshSpeechModel(); await warmSpeechModel(); }
  };
  $('#voice-download-cancel').onclick = async () => {
    $('#voice-download-cancel').disabled = true;
    try { await invoke('cancel_speech_download'); } finally { $('#voice-download-cancel').disabled = false; }
  };
  $('#voice-remove').onclick = async () => {
    $('#voice-error').textContent = '';
    try { voice.loaded = false; renderSpeechModel(await invoke('remove_speech_model')); } catch (error) { $('#voice-error').textContent = voiceError(error); }
  };
  $('#tts-download').onclick = async () => {
    if (voice.ttsDownloading) return;
    voice.ttsDownloading = true; $('#tts-error').textContent = ''; await refreshTtsModel();
    try { renderTtsModel(await invoke('download_tts_model')); }
    catch (error) { if (!String(error).includes('tts_cancelled')) $('#tts-error').textContent = voiceError(error); }
    finally { voice.ttsDownloading = false; await refreshTtsModel(); }
  };
  $('#tts-download-cancel').onclick = async () => {
    $('#tts-download-cancel').disabled = true;
    try { await invoke('cancel_tts_download'); }
    finally { $('#tts-download-cancel').disabled = false; }
  };
  $('#tts-remove').onclick = async () => {
    $('#tts-error').textContent = '';
    try { renderTtsModel(await invoke('remove_tts_model')); }
    catch (error) { $('#tts-error').textContent = voiceError(error); }
  };
  appWindow.listen('speech-model-progress', event => renderSpeechModel(event.payload)).catch(() => {});
  appWindow.listen('tts-model-progress', event => renderTtsModel(event.payload)).catch(() => {});
  appWindow.listen('dictation-cancel', () => cancelVoice(true)).catch(error => console.error('Dictation close listener failed', error));
  window.addEventListener('pagehide', () => cancelVoice(true));
  // Installed model: warm it up right away so the microphone is never a guessing game.
  warmSpeechModel().catch(() => {});
}
