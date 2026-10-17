// Native commands are simulated; no credentials or external services are used.
const { chromium } = require('playwright');
const { readFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 880 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const strings = JSON.parse(readFileSync(resolve(__dirname, '../ui/locales/it.json'), 'utf8'));
  const config = { firebase_email: 'lorenzo@example.com', firebase_project_id: 'demo', firebase_api_key: 'public-demo', firebase_auth_set: true, api_key_set: true,
    models: ['deepseek-flash', 'deepseek-v4-pro'], active_model: 'deepseek-flash', providers: [{ id: 'legacy-0', name: 'DeepSeek', kind: 'deepseek', api_key_set: true,
      models: ['deepseek-flash', 'deepseek-v4-pro'].map(model => ({ id: model, model, base_url: 'https://api.deepseek.com' })) }] };
  const saved = []; let fail = false, loggedOut = false;
  await page.exposeFunction('mockInvoke', async (cmd, args) => {
    if (cmd === 'get_locale') return JSON.stringify(strings);
    if (cmd === 'get_local_config' || cmd === 'get_config') return config;
    if (cmd === 'get_data') return { projects: [], conversations: [] };
    if (cmd === 'save_provider') {
      saved.push(args.input);
      if (fail) throw new Error('Simulated offline');
      const input = args.input;
      const old = config.providers.find(p => p.id === input.id);
      const provider = { id: input.id, name: input.name, kind: input.kind, api_key_set: true,
        models: input.models.map(m => ({ ...m, id: old?.models.find(o => o.model === m.model)?.id || `${input.id}::${m.model}` })) };
      config.providers = config.providers.filter(p => p.id !== input.id).concat(provider);
      config.models = config.providers.flatMap(p => p.models.map(m => m.id));
      return config;
    }
    if (cmd === 'remove_provider') {
      config.providers = config.providers.filter(p => p.id !== args.id);
      config.models = config.providers.flatMap(p => p.models.map(m => m.id));
      if (!config.models.includes(config.active_model)) config.active_model = config.models[0] || '';
      return config;
    }
    if (cmd === 'set_model') { config.active_model = args.model; return config; }
    if (cmd === 'logout') { loggedOut = true; config.firebase_auth_set = false; config.firebase_email = ''; return; }
  });
  await page.addInitScript(() => {
    window.__TAURI__ = { core: { invoke: (cmd, args) => window.mockInvoke(cmd, args) }, window: { getCurrentWindow: () => ({ close() {}, minimize() {}, async listen() { return () => {}; } }) } };
  });
  await page.goto(pathToFileURL(resolve(__dirname, '../ui/index.html')).href);
  await page.locator('#view-chat').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#model-name').textContent(), 'deepseek-flash');
  assert.equal(await page.locator('#model-name img.model-provider-logo').count(), 1);
  assert.match(await page.locator('#model-name img').evaluate(el => getComputedStyle(el).filter), /brightness\(0\).*invert\(1\)/);
  await page.click('#model-select');
  const deepseekOption = page.getByRole('menuitemradio', { name: 'DeepSeek · deepseek-flash', exact: true });
  assert.equal(await deepseekOption.locator('img').count(), 1);
  assert.equal(await deepseekOption.locator('span').first().textContent(), 'deepseek-flash');
  await page.keyboard.press('Escape');
  await page.click('#btn-settings');
  await page.click('.settings-nav [data-settings-tab=account]');
  assert.equal(await page.locator('#settings-account-email').textContent(), 'lorenzo@example.com');
  assert.equal(await page.locator('#settings-overlay [name^=firebase]').count(), 0);
  const output = resolve(__dirname, '../../.artifact/settings'); mkdirSync(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'account-desktop.png') });
  await page.fill('#settings-search', 'api key');
  assert.equal(await page.locator('#settings-inference').isVisible(), true);
  assert.equal(await page.locator('.settings-nav button:visible').count(), 1);
  await page.fill('#settings-search', 'zzzzzz');
  assert.equal(await page.locator('#settings-no-results').isVisible(), true);
  await page.fill('#settings-search', '');
  await page.screenshot({ path: resolve(output, 'providers-desktop.png') });
  await page.click('.provider-row');
  assert.equal(await page.locator('.provider-model-row').count(), 2);
  assert.equal(await page.locator('[name=api_key]').last().inputValue(), '');
  await page.click('.provider-form button[type=submit]');
  await page.locator('#providers-overview').waitFor({ state: 'visible' });
  assert.equal(saved.at(-1).api_key, null);
  await page.click('#add-provider');
  await page.selectOption('.provider-form [name=kind]', 'openrouter');
  assert.equal(await page.locator('.provider-model-row [name=endpoint]').inputValue(), 'https://openrouter.ai/api/v1');
  await page.selectOption('.provider-form [name=kind]', 'openai');
  assert.equal(await page.locator('.provider-model-row [name=endpoint]').inputValue(), 'https://api.openai.com/v1');
  await page.selectOption('.provider-form [name=kind]', 'custom');
  await page.fill('.provider-form [name=name]', 'Acme AI');
  await page.fill('.provider-form [name=api_key]', 'test-secret-not-real');
  await page.locator('.provider-model-row [name=model]').fill('acme-chat');
  await page.locator('.provider-model-row [name=endpoint]').fill('https://api.example.com/v1');
  await page.click('.settings-add-model');
  assert.equal(await page.locator('.provider-model-row').count(), 2);
  assert.equal(await page.locator('.provider-model-row').last().locator('[name=endpoint]').inputValue(), 'https://api.example.com/v1');
  await page.locator('.provider-model-row').last().locator('[name=model]').fill('acme-reasoner');
  await page.screenshot({ path: resolve(output, 'editor-desktop.png') });
  await page.setViewportSize({ width: 520, height: 780 });
  await page.screenshot({ path: resolve(output, 'editor-compact.png') });
  assert.equal(await page.evaluate(() => document.querySelector('.settings-content').scrollWidth <= document.querySelector('.settings-content').clientWidth), true);
  fail = true;
  await page.click('.provider-form button[type=submit]');
  await page.locator('#provider-editor-error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.provider-form [name=name]').inputValue(), 'Acme AI');
  fail = false;
  await page.click('.provider-form button[type=submit]');
  await page.locator('#providers-overview').waitFor({ state: 'visible' });
  assert.equal(saved.at(-1).models.length, 2);
  assert.equal(await page.locator('.provider-row').count(), 2);
  assert.equal(await page.locator('#provider-editor input[type=password]').count(), 0);
  await page.click('#modal-close');
  await page.click('#model-select');
  await page.getByRole('menuitemradio', { name: 'Acme AI · acme-chat', exact: true }).click();
  assert.equal(await page.locator('#model-name').textContent(), 'Acme AI · acme-chat');
  await page.keyboard.press('Control+,');
  await page.click('.settings-nav [data-settings-tab=inference]');
  await page.locator('.provider-row').filter({ hasText: 'Acme AI' }).click();
  await page.fill('.provider-form [name=name]', 'Unsaved');
  page.once('dialog', dialog => dialog.dismiss());
  await page.click('#modal-close');
  assert.equal(await page.locator('#settings-overlay').isVisible(), true);
  page.once('dialog', dialog => dialog.accept());
  await page.click('.settings-back');
  await page.locator('.provider-row').filter({ hasText: 'Acme AI' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.click('.settings-danger');
  await page.locator('#providers-overview').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.provider-row').count(), 1);
  assert.equal(config.active_model, 'deepseek-flash');
  await page.click('.provider-row');
  page.once('dialog', dialog => dialog.accept());
  await page.click('.settings-danger');
  await page.locator('.providers-empty').waitFor({ state: 'visible' });
  await page.click('#modal-close');
  await page.click('#model-select');
  await page.getByRole('menuitem', { name: 'Gestisci provider…', exact: true }).click();
  assert.equal(await page.locator('#settings-inference').isVisible(), true);
  assert.equal(await page.locator('#add-provider').isVisible(), true);
  await page.setViewportSize({ width: 1080, height: 880 });
  await page.click('.settings-nav [data-settings-tab=account]');
  await page.click('#settings-signout');
  await page.locator('#login-form').waitFor({ state: 'visible' });
  assert.equal(loggedOut, true);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS: account, settings search, preset/custom providers, multi-model save, retained key, save failure recovery, composer selection, unsaved changes, removal fallback, responsive layout and sign out.');
})().catch(error => { console.error(error); process.exit(1); });
