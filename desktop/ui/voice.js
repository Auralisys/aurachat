const voice = { waveform: [], frame: null, epoch: 0, pending: false, recording: null, capture: null, mediaOperation: null, transcribing: false, downloading: false, loading: false, loaded: false, nativeOperation: null };

async function speechRequest(command, args) {
  const operation = {};
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
  const finishing = !!(voice.nativeOperation || voice.mediaOperation) && !voice.pending && !voice.transcribing && !voice.recording;
  const active = !!voice.recording || voice.pending || voice.transcribing || finishing;
  const loading = voice.loading;
  mic.hidden = active;
  $('.composer__toolbar .model-select').hidden = active;
  $('#composer-attach').hidden = active;
  mic.disabled = active || loading || state.preparing || state.loadingConversation;
  mic.classList.toggle('is-loading', loading);
  mic.setAttribute('aria-pressed', String(!!voice.recording));
  const label = t(voice.recording ? 'voice.stop' : loading ? 'voice.loading_model' : 'chat.dictate');
  mic.setAttribute('aria-label', label);
  mic.title = label;
  mic.replaceChildren(icon(voice.recording ? 'stop' : 'mic'));
  $('#voice-recording').hidden = !active;
  $('#voice-recording-status').textContent = finishing ? t('voice.finishing') : message;
  $('#voice-recording-status').classList.toggle('sr-only', !voice.pending && !voice.transcribing && !finishing);
  $('#voice-waveform').hidden = voice.pending || voice.transcribing || finishing;
  $('#voice-recording-cancel').disabled = finishing;
  $('#voice-stop').hidden = !voice.recording;
  updateComposerControls();
  if (active && !voice.frame) drawVoiceWave();
  if (!active) { cancelAnimationFrame(voice.frame); voice.frame = null; }
}

function releaseRecording(recording) {
  clearTimeout(recording.timer);
  recording.stream?.getTracks().forEach(track => track.stop());
  recording.node?.disconnect(); recording.source?.disconnect();
  if (recording.context && recording.context.state !== 'closed') recording.context.close().catch(() => {});
  if (voice.capture === recording) voice.capture = null;
  if (recording.release) return recording.release;
  const operation = recording.release = (async () => {
    if (await recording.mediaPause) {
      try { await invoke('resume_dictation_media', {id:recording.mediaId}); }
      catch (error) { console.error('Dictation media resume failed', error);composerStatus(t('voice.media_error')); }
    }
  })();
  voice.mediaOperation = operation;
  operation.finally(() => {
    if (voice.mediaOperation === operation) {voice.mediaOperation = null;voiceUi();}
  });
  return operation;
}

function cancelVoice() {
  voice.epoch++;
  const released = voice.recording || voice.capture ? releaseRecording(voice.recording || voice.capture) : voice.mediaOperation;
  voice.recording = null; voice.pending = false; voice.transcribing = false;
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

function drawVoiceWave() {
  const canvas = $('#voice-waveform'), rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio)); canvas.height = 32 * ratio;
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
  const count = Math.max(1, Math.floor(rect.width / 5));
  const values = voice.waveform.slice(-count);
  ctx.fillStyle = getComputedStyle(canvas).color;
  for (let i = 0; i < count; i++) {
    const value = values[i - (count - values.length)] || 0;
    const height = Math.max(2, Math.min(26, value * 26));
    ctx.beginPath(); ctx.roundRect(i * 5, (32 - height)/2, 2, height, 1); ctx.fill();
  }
  voice.frame = requestAnimationFrame(drawVoiceWave);
}

async function startVoice() {
  if (voice.pending || voice.transcribing || voice.loading || voice.nativeOperation || voice.mediaOperation || state.preparing || state.loadingConversation) return;
  if (voice.recording) return stopVoice();
  const epoch = ++voice.epoch;
  voice.pending = true; voiceUi(t('voice.preparing'));
  let recording;
  try {
    const status = await invoke('speech_model_status');
    if (epoch !== voice.epoch) return;
    if (status?.busy) { composerStatus(t('voice.speech_busy')); return; }
    if (!status?.ready) {
      openSettings(); selectSettingsTab('voice'); renderSpeechModel(status); return;
    }
    voiceUi(t('voice.loading_model'));
    await speechRequest('prepare_speech_model');
    voice.loaded = true;
    if (epoch !== voice.epoch) return;
    voiceUi(t('voice.preparing'));
    voice.waveform = [];
    recording = { chunks: [], count: 0, waveEnergy: 0, waveSamples: 0, epoch };
    voice.capture = recording;
    recording.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    if (epoch !== voice.epoch) { releaseRecording(recording); return; }
    recording.context = new AudioContext({ sampleRate: 16000 });
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
          voice.waveform.push(Math.min(1, rms * 12));
          recording.waveEnergy = 0; recording.waveSamples = 0;
        }
      }
      voice.waveform = voice.waveform.slice(-200);
    };
    recording.mediaId = crypto.randomUUID();
    recording.mediaPause = invoke('pause_dictation_media', {id:recording.mediaId}).then(() => true, error => {
      console.error('Dictation media pause failed', error);composerStatus(t('voice.media_error'));return false;
    });
    await recording.mediaPause;
    if (epoch !== voice.epoch) { await releaseRecording(recording);return; }
    recording.source.connect(recording.node); recording.node.connect(recording.context.destination);
    await recording.context.resume();
    if (epoch !== voice.epoch) { releaseRecording(recording); return; }
    voice.recording = recording;
    recording.timer = setTimeout(() => stopVoice(false), 120000);
    voice.pending = false; voiceUi(t('voice.recording'));
  } catch (error) {
    if (recording) releaseRecording(recording);
    if (epoch === voice.epoch) composerStatus(voiceError(error));
  } finally {
    if (epoch === voice.epoch) { voice.pending = false; if (!voice.recording) voiceUi(); }
  }
}

async function stopVoice(sendAfter = false) {
  const recording = voice.recording;
  if (!recording || voice.transcribing) return;
  voice.transcribing = true; voice.recording = null; voiceUi(t('voice.transcribing'));
  const epoch = recording.epoch;
  try {
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 300);
      recording.flushed = () => { clearTimeout(timeout); resolve(); };
      recording.node.port.postMessage('flush');
    });
    await releaseRecording(recording);
    if (epoch !== voice.epoch) return;
    const samples = speechSamples(recording.chunks, recording.context.sampleRate);
    recording.chunks = [];
    const text = await speechRequest('transcribe_audio', { samples, language: lang });
    if (epoch !== voice.epoch) return;
    if (!text?.trim()) { composerStatus(t('voice.speech_silence')); return; }
    const input = $('#composer-input'); input.value += (input.value && !/\s$/.test(input.value) ? ' ' : '') + text.trim();
    autoGrow(input); input.focus(); composerStatus();
    if (sendAfter) { voice.transcribing = false; voiceUi(); await send(); }
  } catch (error) {
    await releaseRecording(recording);
    if (epoch === voice.epoch) composerStatus(voiceError(error));
  } finally {
    if (epoch === voice.epoch) { voice.transcribing = false; voiceUi();flushQueue(state.activeConversationId); }
  }
}

function setupLocalVoice() {
  voiceUi();
  $('.voice-source').onclick = async event => {
    event.preventDefault();
    try { await invoke('open_external_url', { url: event.currentTarget.href }); }
    catch (_) { $('#voice-error').textContent = t('chat.link_failed'); }
  };
  $('#composer-mic').onclick = startVoice;
  $('#voice-stop').onclick = () => stopVoice(false);
  $('#voice-recording-cancel').onclick = cancelVoice;
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
  appWindow.listen('speech-model-progress', event => renderSpeechModel(event.payload)).catch(() => {});
  appWindow.listen('dictation-cancel', cancelVoice).catch(error => console.error('Dictation close listener failed', error));
  window.addEventListener('pagehide', cancelVoice);
  // Installed model: warm it up right away so the microphone is never a guessing game.
  warmSpeechModel().catch(() => {});
}
