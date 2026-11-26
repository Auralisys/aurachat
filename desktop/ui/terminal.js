// Only the new-tab button starts a shell. The terminal DOM and PTY belong to the tab, not the current chat.
const TERMINAL_CONFIRM_KEY = 'aurachat.terminal.confirm_close';

function terminalConfirmEnabled() {
  try {return localStorage.getItem(TERMINAL_CONFIRM_KEY) !== 'off';} catch {return true;}
}

function setTerminalConfirm(enabled) {
  try {localStorage.setItem(TERMINAL_CONFIRM_KEY, enabled ? 'on' : 'off');}
  catch (error) {console.warn('Terminal preference could not be saved:', error);}
  $('#terminal-confirm-close').checked = enabled;
}

// An ended or failed shell has nothing left to stop, so it closes without asking.
function confirmTerminalClose(session) {
  if (session.ended || !terminalConfirmEnabled()) return Promise.resolve(true);
  const dialog = $('#terminal-close-confirm'), skip = $('#terminal-close-skip');
  const [before, after = ''] = t('terminal.close_note').split('{name}');
  $('#terminal-close-note').replaceChildren(before, activityText('strong', t('terminal.title')), after);
  skip.checked = false;
  return new Promise(resolve => {
    dialog.returnValue = 'cancel';
    dialog.addEventListener('close', () => {
      const accepted = dialog.returnValue === 'close';
      if (accepted && skip.checked) setTerminalConfirm(false);
      resolve(accepted);
    }, {once:true});
    dialog.showModal();
  });
}

function terminalProject() {
  return state.config.firebase_auth_set && !remoteTarget(state.activeConversationId) && gitProject();
}

function renderTerminalPanel(tab) {
  const current = tab?.terminal, panel = $('#panel-terminals');
  panel.hidden = !current;
  for (const view of panel.children) view.hidden = view !== current?.view;
  const available = !!terminalProject()?.source_folders?.length;
  $('#panel-open-terminal').disabled = !available;
  const info = $('#panel-terminal-info'), text = t(available ? 'terminal.launch' : 'terminal.no_folder');
  if (info.textContent !== text) info.textContent = text;
}

function disposeTerminal(session) {
  if (session.disposed) return;
  session.disposed = true;
  session.observer.disconnect();session.term.dispose();session.view.remove();
}

async function closeTerminal(session) {
  await session.ready;
  if (session.id != null) await invoke('terminal_close', {id:session.id});
  disposeTerminal(session);
}

function terminalStatus(session, text) {
  session.status.textContent = text;session.status.hidden = !text;
}

async function readTerminal(session) {
  const {term, id} = session;
  try {
    while (!session.disposed) {
      const data = await invoke('terminal_read', {id});
      if (session.disposed) return;
      if (data === null) break;
      if (data) {
        await new Promise(done => term.write(Uint8Array.from(atob(data), c => c.charCodeAt(0)), done));
        if (!session.disposed && !session.interactive && term.buffer.active.getLine(0)?.translateToString(true)) session.enableInput();
      }
    }
    if (!session.disposed) terminalStatus(session, t('terminal.ended'));
  } catch (error) {
    if (!session.disposed) terminalStatus(session, localizeError(error));
  } finally {
    if (!session.disposed) {
      session.ended = true;term.options.disableStdin = true;
      try {await invoke('terminal_close', {id});session.id = null;}
      catch (error) {if (!session.disposed) terminalStatus(session, localizeError(error));}
    }
  }
}

function openTerminalTab() {
  const tab = activePanelTab(), project = terminalProject();
  if (!project?.source_folders?.length || !tab || tab.terminal || tab.section || tab.file || tab.page || tab.opening || tab.closing) return;
  const view = activityText('section', '', 'manual-terminal');
  const context = activityText('header', '', 'manual-terminal__context');
  const name = activityText('strong', t('terminal.title'));
  const folder = activityText('span', project.name, 'manual-terminal__folder');
  context.append(name, folder);
  const surface = activityText('div', '', 'manual-terminal__surface');surface.inert = true;
  const status = activityText('p', '', 'manual-terminal__status');status.setAttribute('role','status');
  view.append(context, surface, status);$('#panel-terminals').append(view);
  const theme = getComputedStyle(view);
  const term = new Terminal({fontFamily:'Consolas, Menlo, monospace', fontSize:14, scrollback:3000,
    screenReaderMode:true, disableStdin:true, linkHandler:{activate() {}},
    theme:{background:theme.backgroundColor, foreground:theme.color, cursor:theme.color}});
  const fit = new FitAddon.FitAddon();term.loadAddon(fit);
  const session = tab.terminal = {term, view, status, id:null, disposed:false};
  const tabButton = $(`#panel-tab-${tab.id}`);
  session.enableInput = () => {
    if (!surface.inert || tab.closing) return;
    session.interactive = true;surface.inert = false;terminalStatus(session, '');
    if (activePanelTab() === tab && document.activeElement === tabButton) term.focus();
  };
  let writes = Promise.resolve();
  const fitVisible = () => {if (!session.disposed && surface.clientWidth && surface.clientHeight) fit.fit();};
  session.observer = new ResizeObserver(fitVisible);
  renderBrowser();term.open(surface);fitVisible();session.observer.observe(surface);
  term.textarea.setAttribute('aria-description', t('terminal.keyboard'));
  surface.addEventListener('keydown', event => event.stopPropagation());
  term.attachCustomKeyEventHandler(event => {
    if (event.key === 'Escape' && event.shiftKey) {
      if (event.type === 'keydown') {$(`#panel-tab-${tab.id}`).focus();event.preventDefault();}
      return false;
    }
    return true;
  });
  term.onResize(({cols, rows}) => {
    if (session.id != null && !session.ended && !tab.closing) invoke('terminal_resize', {id:session.id, cols, rows}).catch(error => {
      if (!session.disposed && !session.ended && !tab.closing) terminalStatus(session, localizeError(error));
    });
  });
  term.onData(data => {
    const id = session.id;
    if (id == null || session.ended) return;
    writes = writes.then(async () => {
      // Bound pastes without splitting UTF-16 surrogate pairs.
      for (const [chunk] of data.matchAll(/[\s\S]{1,4096}/gu)) {
        if (session.disposed || session.ended || tab.closing || session.id !== id) return;
        await invoke('terminal_write', {id, data:chunk});
      }
    }).catch(error => {if (!session.disposed && !session.ended && !tab.closing) terminalStatus(session, localizeError(error));});
  });
  terminalStatus(session, t('terminal.starting'));tabButton.focus();
  session.ready = invoke('terminal_open', {project_id:project.id, email:state.config.firebase_email, cols:term.cols, rows:term.rows})
    .then(async opened => {
      session.id = opened.id;
      if (session.disposed) {await invoke('terminal_close', {id:opened.id});return;}
      if (tab.closing) return;
      name.textContent = opened.shell;folder.title = opened.root;
      term.options.disableStdin = false;
      // Let xterm answer ConPTY's startup cursor query before accepting keystrokes.
      if (opened.shell !== 'PowerShell') session.enableInput();
      // The panel may have been resized while the shell was starting.
      const {cols, rows} = term;
      await invoke('terminal_resize', {id:opened.id, cols, rows});
      if (!session.disposed && !tab.closing) readTerminal(session);
    }).catch(async error => {
      if (session.disposed) return;
      terminalStatus(session, localizeError(error));term.options.disableStdin = true;session.ended = true;
      if (session.id != null) {
        try {await invoke('terminal_close', {id:session.id});session.id = null;}
        catch (closeError) {terminalStatus(session, localizeError(closeError));}
      }
    });
}
