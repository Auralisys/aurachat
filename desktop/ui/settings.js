// Settings share the app's account, localization and native persistence.
let settingsTab = 'general';
let providerDirty = false;
let providerSaving = false;
const PROVIDER_PRESETS = {
  deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  openai: { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', models: [''] },
  openrouter: { name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', models: [''] },
  custom: { name: '', endpoint: '', models: [''] },
};

function settingsElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function providerIcon(kind) {
  const el = settingsElement('span', 'provider-icon');
  if (kind === 'deepseek') {
    const img = document.createElement('img');
    img.src = 'assets/providers/deepseek.svg'; img.alt = ''; el.append(img);
  } else { el.append(icon('cpu')); }
  return el;
}

function renderSettingsAccount() {
  const email = state.config.firebase_email || t('ui.account');
  const name = email.split('@')[0];
  $('#settings-profile-name').textContent = name;
  $('#settings-profile-email').textContent = email;
  $('#settings-account-name').textContent = name;
  $('#settings-account-email').textContent = email;
  document.querySelectorAll('.settings-avatar').forEach(el => el.textContent = name.slice(0, 2).toUpperCase());
  $('#settings-signout').disabled = [...state.runs.values()].some(run => run.pending);
}

function selectSettingsTab(tab) {
  settingsTab = tab;
  for (const name of ['general', 'account', 'inference', 'voice', 'skills']) $('#settings-' + name).hidden = tab !== name;
  if (tab === 'account') renderSettingsAccount();
  if (tab === 'voice') refreshSpeechModel();
  if (tab === 'inference') renderProviders();
  if (tab === 'skills') refreshSkillSettings(true);
  $('#settings-title').textContent = t('ui.' + tab);
  $('#settings-language').textContent = lang === 'it' ? 'Italiano' : 'English';
  document.querySelectorAll('.settings-nav [data-settings-tab]').forEach(button => {
    button.classList.toggle('is-active', button.dataset.settingsTab === tab);
    button.setAttribute('aria-current', button.dataset.settingsTab === tab ? 'page' : 'false');
  });
}

function filterSettings() {
  const query = $('#settings-search').value.trim().toLocaleLowerCase();
  const matches = [];
  document.querySelectorAll('.settings-nav [data-settings-tab]').forEach(button => {
    const tab = button.dataset.settingsTab;
    const keywords = t('settings.keywords_' + tab) + ' ' + button.textContent;
    const visible = keywords.toLocaleLowerCase().includes(query);
    button.hidden = !visible;
    if (visible) matches.push(tab);
  });
  $('#settings-no-results').hidden = matches.length > 0;
  if (query && matches.length && !matches.includes(settingsTab)) selectSettingsTab(matches[0]);
}

function renderProviders() {
  const list = $('#provider-list'); list.replaceChildren();
  const providers = state.config.providers || [];
  if (!providers.length) {
    const empty = settingsElement('div', 'providers-empty');
    empty.append(icon('cpu'), settingsElement('strong', '', t('settings.empty_title')), settingsElement('p', '', t('settings.empty_note')));
    list.append(empty);
  }
  for (const provider of providers) {
    const row = settingsElement('button', 'provider-row');
    row.type = 'button';
    const info = settingsElement('span', 'provider-row-info');
    info.append(settingsElement('strong', '', provider.name), settingsElement('span', '', `${provider.models.length} ${t('settings.models')} · ${provider.api_key_set ? t('settings.key_saved') : t('settings.key_missing')}`));
    const status = settingsElement('span', 'provider-row-status', t('settings.configure'));
    row.append(providerIcon(provider.kind), info, status, icon('chevron'));
    row.onclick = () => editProvider(provider);
    list.append(row);
  }
}

function providerField(label, name, value = '', type = 'text') {
  const field = settingsElement('label', 'field');
  const input = settingsElement('input', 'field__input');
  input.name = name; input.value = value; input.type = type;
  input.autocomplete = 'off'; input.spellcheck = false;
  field.append(settingsElement('span', 'field__label', label), input);
  return field;
}

function addProviderModel(model = '', endpoint = '') {
  const row = settingsElement('div', 'provider-model-row');
  row.append(providerField(t('settings.model_id'), 'model', model), providerField(t('settings.endpoint'), 'endpoint', endpoint, 'url'));
  row.querySelectorAll('input').forEach(input => { input.required = true; });
  row.querySelector('[name=model]').placeholder = t('settings.model_placeholder');
  row.querySelector('[name=endpoint]').placeholder = 'https://api.example.com/v1';
  const remove = settingsElement('button', 'icon-button');
  remove.type = 'button'; remove.append(icon('trash'));
  remove.title = remove.ariaLabel = t('settings.remove_model');
  remove.onclick = () => { row.remove(); providerDirty = true; updateModelCount(); };
  row.append(remove); $('#provider-models').append(row); updateModelCount();
}

function updateModelCount() {
  const rows = [...document.querySelectorAll('.provider-model-row')];
  $('#provider-model-count').textContent = String(rows.length);
  rows.forEach(row => row.querySelector('button').disabled = rows.length === 1);
}

function editProvider(provider) {
  if (!discardProviderEditor()) return;
  $('#provider-feedback').hidden = true;
  const editor = $('#provider-editor'); editor.replaceChildren();
  $('#providers-overview').hidden = true; editor.hidden = false;
  const back = settingsElement('button', 'settings-back', t('settings.back_providers'));
  back.prepend(icon('back')); back.onclick = discardProviderEditor;
  editor.append(back, settingsElement('h3', '', provider ? t('settings.edit_provider') : t('settings.add_provider')));
  const form = settingsElement('form', 'provider-form');
  const label = settingsElement('label', 'field');
  label.append(settingsElement('span', 'field__label', t('settings.provider_type')));
  const select = document.createElement('select'); select.className = 'field__input'; select.name = 'kind';
  for (const [kind, preset] of Object.entries(PROVIDER_PRESETS)) {
    const option = document.createElement('option'); option.value = kind; option.textContent = preset.name || t('settings.custom_provider'); select.append(option);
  }
  select.value = provider?.kind || 'deepseek'; select.disabled = !!provider;
  label.append(select); form.append(label, providerField(t('settings.provider_name'), 'name', provider?.name || 'DeepSeek'));
  const key = providerField(t('form.api_key'), 'api_key', '', 'password');
  key.querySelector('input').required = !provider?.api_key_set;
  key.querySelector('input').placeholder = provider?.api_key_set ? t('settings.key_keep') : t('settings.key_placeholder');
  key.querySelector('input').autocomplete = 'new-password';
  key.append(settingsElement('span', 'field__note', t('settings.key_note'))); form.append(key);
  const heading = settingsElement('div', 'provider-model-heading');
  heading.append(settingsElement('h4', '', t('settings.models_title')));
  const count = settingsElement('span', 'model-count'); count.id = 'provider-model-count'; heading.append(count);
  form.append(heading, settingsElement('p', 'settings-hint', t('settings.models_note')));
  const models = document.createElement('div'); models.id = 'provider-models'; form.append(models);
  const add = settingsElement('button', 'btn settings-add-model', t('settings.add_model')); add.type = 'button'; add.prepend(icon('plus'));
  add.onclick = () => { addProviderModel('', models.querySelector('[name=endpoint]')?.value || PROVIDER_PRESETS[select.value].endpoint); providerDirty = true; models.lastElementChild.querySelector('input').focus(); };
  form.append(add);
  const error = settingsElement('p', 'form__error'); error.id = 'provider-editor-error'; error.setAttribute('role', 'alert'); error.hidden = true; form.append(error);
  const actions = settingsElement('div', 'provider-actions');
  const save = settingsElement('button', 'btn btn--primary', t('settings.save_provider')); save.type = 'submit';
  const cancel = settingsElement('button', 'btn', t('project.cancel')); cancel.type = 'button'; cancel.onclick = discardProviderEditor;
  if (provider) {
    const remove = settingsElement('button', 'btn settings-danger', t('settings.remove_provider')); remove.type = 'button';
    remove.onclick = async () => {
      if (!confirm(t('settings.remove_confirm').replace('{name}', provider.name))) return;
      await persistProvider('remove_provider', { id: provider.id }, form);
    };
    actions.append(remove);
  }
  actions.append(cancel, save); form.append(actions); editor.append(form);
  const populate = () => {
    const preset = PROVIDER_PRESETS[select.value];
    form.elements.name.value = preset.name;
    models.replaceChildren();
    for (const model of preset.models) addProviderModel(model, preset.endpoint);
  };
  if (provider) for (const model of provider.models) addProviderModel(model.model, model.base_url);
  else populate();
  form.elements.name.required = true; form.elements.name.maxLength = 100;
  form.oninput = () => { providerDirty = true; error.hidden = true; };
  select.onchange = () => { populate(); providerDirty = true; };
  form.onsubmit = async event => {
    event.preventDefault();
    const input = { id: provider?.id || crypto.randomUUID(), name: form.elements.name.value.trim(), kind: select.value,
      api_key: form.elements.api_key.value.trim() || null,
      models: [...models.children].map(row => ({ model: row.querySelector('[name=model]').value.trim(), base_url: row.querySelector('[name=endpoint]').value.trim() })) };
    await persistProvider('save_provider', { input }, form);
  };
  providerDirty = false; select.disabled ? form.elements.name.focus() : select.focus();
}

async function persistProvider(command, payload, form) {
  if (providerSaving) return;
  const error = $('#provider-editor-error'); error.hidden = true;
  providerSaving = true;
  const controls = [...form.querySelectorAll('button,input,select')].filter(el => !el.disabled);
  controls.forEach(el => el.disabled = true);
  form.setAttribute('aria-busy', 'true');
  try {
    state.config = await invoke(command, payload);
    providerDirty = false; providerSaving = false; discardProviderEditor();
    populateModelSelect(); renderProviders(); $('#add-provider').focus();
  } catch (e) { error.textContent = localizeError(e); error.hidden = false; }
  finally { providerSaving = false; controls.forEach(el => el.disabled = false); form.removeAttribute('aria-busy'); }
}

function discardProviderEditor() {
  if (providerSaving) return false;
  if (providerDirty && !confirm(t('settings.discard'))) return false;
  providerDirty = false;
  $('#provider-editor').replaceChildren(); $('#provider-editor').hidden = true;
  $('#providers-overview').hidden = false;
  return true;
}

function setupSettings() {
  setupSkillSettings();
  $('#settings-search').oninput = filterSettings;
  $('#add-provider').onclick = () => editProvider();
  $('#settings-signout').onclick = async () => {
    const button = $('#settings-signout'); button.disabled = true;
    clearTimeout(windowSaveTimer); windowExpanded = false;
    try {
      await cancelVoice(true);
      await windowSaveQueue;
      await invoke('logout');
      location.reload();
    } catch (e) {
      windowExpanded = true;
      $('#settings-account-error').textContent = localizeError(e); $('#settings-account-error').hidden = false; button.disabled = false;
    }
  };
}
