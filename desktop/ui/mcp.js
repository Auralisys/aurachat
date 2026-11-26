// Account-local integrations. Native commands never return credentials.
let mcpBusy = false;
let mcpSettingsVersion = 0;

function mcpFeedback(message = '', error = false) {
  $('#mcp-feedback').textContent = error ? '' : message;
  $('#mcp-error').textContent = error ? message : '';
  $('#mcp-error').hidden = !error;
}

async function refreshMcpSettings() {
  const version = ++mcpSettingsVersion;
  const email = state.config.firebase_email;
  $('#mcp-refresh').disabled = true;
  try {
    const [data, preferences] = await Promise.all([invoke('mcp_integrations'), invoke('browser_preferences')]);
    if (version !== mcpSettingsVersion || email !== state.config.firebase_email) return;
    if (!Array.isArray(data?.servers)) throw new Error(t('errors.mcp_catalog_failed'));
    $('#mcp-list').replaceChildren(...data.servers.map(server => {
      const row = settingsElement('div', 'settings-signout');
      const info = settingsElement('div');
      const title = settingsElement('strong', '', server.name);
      const status = server.disabled ? 'mcp.disconnected' : server.authenticated ? 'mcp.authorized' : server.oauth ? 'mcp.needs_sign_in' : 'mcp.manual';
      info.append(title, settingsElement('p', '', t(status)));
      row.append(info);
      if (server.oauth) {
        const connect = settingsElement('button', 'btn', t(server.authenticated && !server.disabled ? 'mcp.verify' : 'mcp.connect'));
        connect.type = 'button';connect.disabled = mcpBusy;
        connect.onclick = () => connectMcp(server.name);
        row.append(connect);
        if (server.authenticated || !server.disabled) {
          const disconnect = settingsElement('button', 'btn', t('mcp.disconnect'));
          disconnect.type = 'button';disconnect.disabled = mcpBusy;
          disconnect.onclick = () => disconnectMcp(server.name);
          row.append(disconnect);
        }
      }
      return row;
    }));
    const passwords = $('#browser-save-passwords');
    passwords.checked = !!preferences?.save_passwords;
    passwords.disabled = !preferences?.passwords_supported || mcpBusy;
    $('#browser-passwords-note').textContent = t(preferences?.passwords_supported ? 'mcp.passwords_note' : 'errors.browser_passwords_unsupported');
  } catch (error) {
    if (version === mcpSettingsVersion && email === state.config.firebase_email) mcpFeedback(localizeError(error), true);
  }
  finally {if (version === mcpSettingsVersion) $('#mcp-refresh').disabled = mcpBusy;}
}

async function connectMcp(name) {
  if (mcpBusy) return;
  mcpBusy = true;
  const email = state.config.firebase_email;
  mcpFeedback(t('mcp.connecting'));
  try {
    await refreshMcpSettings();
    if (email !== state.config.firebase_email) return;
    const result = await invoke('mcp_connect', {name});
    if (email !== state.config.firebase_email) return;
    if (!Array.isArray(result?.tools)) throw new Error(t('errors.mcp_catalog_failed'));
    mcpFeedback(t('mcp.connected').replace('{name}', name).replace('{tools}', result.tools.join(', ')));
    composerStatus(t('mcp.ready').replace('{name}', name));
  } catch (error) {
    if (email === state.config.firebase_email) {
      mcpFeedback(localizeError(error), true);
      composerStatus(localizeError(error));
    }
  } finally {
    mcpBusy = false;
    if (email === state.config.firebase_email) await refreshMcpSettings();
  }
}

async function disconnectMcp(name) {
  if (mcpBusy || !confirm(t('mcp.disconnect_confirm').replace('{name}', name))) return;
  mcpBusy = true;
  const email = state.config.firebase_email;
  try {
    await refreshMcpSettings();
    if (email !== state.config.firebase_email) return;
    await invoke('mcp_disconnect', {name});
    if (email === state.config.firebase_email) mcpFeedback(t('mcp.disconnected_note'));
  } catch (error) {
    if (email === state.config.firebase_email) mcpFeedback(localizeError(error), true);
  }
  finally {mcpBusy = false;await refreshMcpSettings();}
}

function setupMcpSettings() {
  $('#mcp-refresh').onclick = refreshMcpSettings;
  $('#browser-save-passwords').onchange = async event => {
    const input = event.target;
    input.disabled = true;
    try {await invoke('browser_preferences', {save_passwords:input.checked});}
    catch (error) {mcpFeedback(localizeError(error), true);}
    finally {await refreshMcpSettings();}
  };
}
