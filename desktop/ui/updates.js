// The gateway stays paused until this startup-only gate has completed.
async function runUpdateGate() {
  const dialog = document.querySelector('#update-dialog');
  const title = dialog.querySelector('h2');
  const message = dialog.querySelector('[data-update-message]');
  const detail = dialog.querySelector('[data-update-detail]');
  const progress = dialog.querySelector('progress');
  const retry = dialog.querySelector('[data-update-retry]');
  const offline = dialog.querySelector('[data-update-offline]');
  let required = false;
  let running = false;
  let completed;
  const done = new Promise(resolve => { completed = resolve; });
  dialog.addEventListener('cancel', event => event.preventDefault());

  function stage(heading, body) {
    title.textContent = t(heading);
    message.textContent = t(body);
    detail.textContent = '';
    retry.hidden = true;
    offline.hidden = true;
    progress.hidden = false;
    progress.removeAttribute('value');
  }

  async function enterApp() {
    try {
      await invoke('finish_update_check');
      dialog.close();
      completed();
    } catch (error) {
      detail.textContent = errText(error);
      retry.hidden = false;
      offline.hidden = required;
    }
  }

  async function attempt() {
    if (running) return;
    running = true;
    try {
      if (!required) {
        stage('updates.check_title', 'updates.check_body');
        const update = await invoke('check_app_update');
        if (!update) {
          await enterApp();
          return;
        }
        required = true;
        dialog.dataset.version = update.version;
      }
      stage('updates.required_title', 'updates.downloading');
      const channel = new window.__TAURI__.core.Channel();
      channel.onmessage = event => {
        if (event.phase === 'installing') {
          stage('updates.installing_title', 'updates.installing_body');
          progress.value = 1;
        } else if (event.phase === 'downloading') {
          if (event.total > 0) progress.value = Math.min(event.downloaded / event.total, 1);
          else progress.removeAttribute('value');
          detail.textContent = `${dialog.dataset.version} · ${(event.downloaded / 1048576).toFixed(1)} MB`;
        }
      };
      await invoke('install_app_update', { progress: channel });
      stage('updates.installing_title', 'updates.restarting');
    } catch (error) {
      title.textContent = t(required ? 'updates.failed_title' : 'updates.check_failed');
      message.textContent = t(required ? 'updates.failed_body' : 'updates.offline_body');
      detail.textContent = errText(error);
      progress.hidden = true;
      retry.hidden = false;
      offline.hidden = required;
      retry.focus();
    } finally {
      running = false;
    }
  }
  retry.textContent = t('updates.retry');
  offline.textContent = t('updates.continue');
  retry.onclick = attempt;
  offline.onclick = enterApp;
  dialog.showModal();
  await attempt();
  await done;
}
