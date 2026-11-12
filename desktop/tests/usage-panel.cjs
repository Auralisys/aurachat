// Usage and estimated cost panel; native commands are simulated.
const { chromium } = require('playwright');
const { readFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'it-IT' });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const locales = JSON.parse(readFileSync(resolve(__dirname, '../ui/locales/it.json'), 'utf8'));
  const balanceCalls = () => page.evaluate(() => window.__calls.filter(call => call.cmd === 'provider_balance').length);
  const setBalance = patch => page.evaluate(patch => Object.assign(window.__balance, patch), patch);
  const hold = () => page.evaluate(() => { window.__balance.gate = new Promise(resolve => { window.__balance.release = resolve; }); });
  const release = () => page.evaluate(() => window.__balance.release());
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const row = (model, off_peak, requests, hit, miss, completion, reasoning, cost_usd) => ({ model, off_peak, requests, prompt_tokens: hit + miss, completion_tokens: completion,
    cache_hit_tokens: hit, cache_miss_tokens: miss, reasoning_tokens: reasoning, unpriced_tokens: cost_usd == null ? hit + miss + completion : 0, ...(cost_usd == null ? {} : { cost_usd }) });
  const models = [row('deepseek-flash', false, 2, 5000, 1000, 1400, 600, 0.00201), row('deepseek-v4-pro', true, 1, 3000, 1000, 1000, 300, 0.002706), row('acme-chat', false, 1, 0, 200, 100, 0, null)];
  const sum = key => models.reduce((total, item) => total + item[key], 0);
  const usage = { prompt_tokens: sum('prompt_tokens'), completion_tokens: sum('completion_tokens'), total_tokens: sum('prompt_tokens') + sum('completion_tokens'), requests: sum('requests'),
    cache_hit_tokens: sum('cache_hit_tokens'), cache_miss_tokens: sum('cache_miss_tokens'), reasoning_tokens: sum('reasoning_tokens'), unpriced_tokens: sum('unpriced_tokens'), cost_usd: 0.004716, models };
  await page.addInitScript(({ locales, usage }) => {
    window.__store = { projects: [], conversations: [
      { id: 'c', title: 'Costi', created_at: 1, updated_at: 2, context_tokens: 4000, usage, messages: [{ role: 'user', content: 'Ciao' }, { role: 'assistant', content: 'Ciao!' }] },
      { id: 'old', title: 'Vecchia', created_at: 1, updated_at: 1, context_tokens: 1530, messages: [{ role: 'user', content: 'Ciao' }, { role: 'assistant', content: 'Ciao!' }] }] };
    window.__calls = [];
    window.__balance = { reply: null, gate: null, release: null, linkFails: false };
    const config = { firebase_email: 'demo@example.com', firebase_project_id: 'demo', firebase_api_key: 'demo', firebase_auth_set: true, api_key_set: true, models: ['deepseek-flash'], active_model: 'deepseek-flash',
      providers: [{ id: 'legacy-0', name: 'DeepSeek', kind: 'deepseek', api_key_set: true, models: [{ id: 'deepseek-flash', model: 'deepseek-flash', base_url: 'https://api.deepseek.com', pricing: null }] }],
      known_pricing: [{ host: 'api.deepseek.com', model: 'deepseek-flash', pricing: { input_cache_hit: 0.006, input_cache_miss: 0.3, output: 1.2 }, off_peak_factor: 0.5 }] };
    window.__TAURI__ = { window: { getCurrentWindow: () => ({ minimize() {}, close() {}, async listen() { return () => {}; } }) }, core: { invoke: async (cmd, args) => {
      window.__calls.push({ cmd, args });
      if (cmd === 'speech_model_status') return { ready: false, busy: false, downloaded: 0, total: 1 };
      if (cmd === 'get_locale') return JSON.stringify(locales);
      if (['get_local_config', 'get_config'].includes(cmd)) return config;
      if (['get_data', 'refresh_data'].includes(cmd)) return structuredClone(window.__store);
      if (cmd === 'save_data') { window.__store = structuredClone(args.data); return structuredClone(args.data); }
      if (cmd === 'provider_balance') {
        await window.__balance.gate;
        if (window.__balance.reply.error) throw window.__balance.reply.error;
        return structuredClone(window.__balance.reply.data);
      }
      if (cmd === 'open_external_url' && window.__balance.linkFails) throw 'link_failed';
      if (cmd === 'chat') {
        const tree = structuredClone(window.__store), conv = tree.conversations.find(c => c.id === args.conversation_id);
        conv.messages.push({ role: 'user', content: args.content }, { role: 'assistant', content: 'Fatto.' });
        const reply = { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, requests: 1, cache_hit_tokens: 1000, cache_miss_tokens: 200, reasoning_tokens: 0, unpriced_tokens: 0, cost_usd: 0.000426,
          models: [{ model: 'deepseek-flash', off_peak: false, requests: 1, prompt_tokens: 1200, completion_tokens: 300, cache_hit_tokens: 1000, cache_miss_tokens: 200, reasoning_tokens: 0, unpriced_tokens: 0, cost_usd: 0.000426 }] };
        conv.usage = reply; window.__store = tree;
        return { data: structuredClone(tree), messages: structuredClone(conv.messages), usage: reply };
      }
    } } };
  }, { locales, usage });
  await page.goto(pathToFileURL(resolve(__dirname, '../ui/index.html')).href);
  await page.locator('#boot-splash').waitFor({ state: 'hidden' });

  // Thousands use explicit k/M with the locale decimal separator; tiny costs keep two significant digits.
  assert.deepEqual(await page.evaluate(() => [999, 1000, 1234, 12400, 150000, 999950, 1250000].map(formatTokens)), ['999', '1k', '1,2k', '12,4k', '150k', '1M', '1,3M']);
  const usd = await page.evaluate(() => [0, 0.000004, 0.000426, 0.004716, 0.0471, 1.5].map(formatUsd));
  ['0,00', '< 0,00001', '0,00043', '0,0047', '0,047', '1,50'].forEach((number, i) => assert.match(usd[i], new RegExp('^' + number + '\\s\\$$')));

  await page.evaluate(() => openConversation('c', false));
  const summary = page.locator('#context-info summary');
  assert.match(await summary.innerText(), /^12,7k · 0,0047\s\$$/);
  assert.match(await summary.getAttribute('aria-label'), /12\.700 token · costo stimato 0,0047\s\$/);
  await summary.click();
  const panel = page.locator('#context-details');
  assert.equal(await panel.locator('.usage-section').count(), 1);
  assert.equal(await panel.locator('.usage-section__title').innerText(), 'Questa chat');
  const rows = await panel.locator('.usage-row').evaluateAll(items => items.map(item => [item.querySelector('dt').textContent, item.querySelector('dd').textContent]));
  assert.deepEqual(rows.slice(0, 4), [['Ingresso da cache', '8k'], ['Ingresso nuovo', '2,2k'], ['Quota da cache', '78%'], ['Uscita', '2,5k']]);
  assert.deepEqual(rows.slice(4), [['di cui ragionamento', '900'], ['Richieste al modello', '4']]);
  assert.equal(await panel.locator('.usage-row dd').first().getAttribute('title'), '8000 token');
  assert.equal(await panel.locator('.usage-bar__part').count(), 3);
  assert.equal(await panel.locator('.usage-model').count(), 3);
  assert.match(await panel.locator('.usage-model').nth(1).innerText(), /deepseek-v4-pro\s*sconto 50%\s*5k\s*0,0027\s\$/);
  assert.match(await panel.locator('.usage-model').nth(2).innerText(), /acme-chat\s*300\s*Senza prezzo/);
  assert.equal(await panel.locator('.usage-footer .usage-note').innerText(), locales['usage.unpriced_note']);
  assert.equal(await panel.locator('.balance').count(), 0, 'providers without balance support show nothing');
  assert.equal(await balanceCalls(), 0);
  const shots = resolve(__dirname, '../../.artifact/usage'); mkdirSync(shots, { recursive: true });
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
  await page.screenshot({ path: resolve(shots, 'usage-panel.png') });
  const box = await panel.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 860, 'panel stays in the viewport');

  // Escape closes the popover and returns focus to its trigger; an outside click closes it too.
  await panel.locator('.usage-link').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#context-info').evaluate(el => el.open), false);
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#context-info summary')), true);
  await summary.click();
  await page.mouse.click(400, 400);
  assert.equal(await page.locator('#context-info').evaluate(el => el.open), false);

  // A new reply shows its own compact section below the chat total.
  await page.fill('#composer-input', 'Ancora');
  await page.click('#composer-send');
  await page.waitForFunction(() => document.querySelector('#context-summary').textContent.startsWith('1,5k'));
  await summary.click();
  assert.deepEqual(await panel.locator('.usage-section__title').allInnerTexts(), ['Questa chat', 'Ultima risposta']);
  assert.equal(await panel.locator('.usage-section').nth(1).locator('.usage-bar').count(), 0);
  assert.equal(await panel.locator('.usage-footer .usage-note').innerText(), locales['usage.estimate_note']);

  // "Edit prices" opens the inference settings.
  await panel.locator('.usage-link').click();
  assert.equal(await page.locator('#settings-inference').isVisible(), true);
  await page.click('#modal-close');

  // Conversations saved before cost tracking keep their token count and explain the missing cost.
  await page.evaluate(() => openConversation('old', false));
  assert.equal(await summary.innerText(), '1,5k token');
  await summary.click();
  assert.match(await panel.innerText(), /Contesto dell’ultima risposta\s*1,5k/);
  assert.match(await panel.innerText(), new RegExp(locales['usage.legacy_note']));
  assert.equal(await panel.locator('.usage-link').count(), 0);
  // The DeepSeek balance belongs to the API key: read when the popover opens, cached, and re-read after a reply.
  const topUpUrl = 'https://platform.deepseek.com/top_up';
  const cny = (total, topped_up, granted) => ({ currency: 'CNY', total, topped_up, granted });
  const readings = {
    first: { data: { is_available: true, top_up_url: topUpUrl, infos: [cny(110, 100, 10), { currency: 'USD', total: 3.5, topped_up: 3.5, granted: 0 }] } },
    second: { data: { is_available: true, top_up_url: topUpUrl, infos: [cny(109.5, 99.5, 10)] } },
    depleted: { data: { is_available: false, top_up_url: topUpUrl, infos: [cny(0, 0, 0)] } } };
  const balance = panel.locator('.balance--popover'), topUp = balance.locator('[data-balance-action=topup]'), refresh = balance.locator('.balance__refresh');
  const figures = () => balance.locator('.usage-row').evaluateAll(items => items.map(item => [item.querySelector('dt').textContent, item.querySelector('dd').textContent.replace(/\s/g, ' ')]));
  const balanceState = expected => page.waitForFunction(expected => document.querySelector('.balance--popover')?.dataset.state === expected, expected);
  await page.keyboard.press('Escape');
  await hold();
  await page.evaluate(reply => { state.config.providers[0].balance = true; window.__balance.reply = reply; return openConversation('c', false); }, readings.first);
  assert.equal(await balanceCalls(), 0, 'a closed popover does not read the balance');
  await summary.click();
  await page.waitForFunction(() => document.querySelector('.balance--popover .balance__body')?.getAttribute('aria-busy') === 'true');
  assert.equal(await balance.getAttribute('data-state'), 'loading');
  assert.equal(await balance.locator('h2').innerText(), 'Saldo DeepSeek');
  assert.equal(await balance.locator('.balance__status').innerText(), locales['usage.balance_loading']);
  await release();
  await balanceState('ready');
  assert.deepEqual(await page.evaluate(() => window.__calls.filter(call => call.cmd === 'provider_balance').map(call => call.args)), [{ provider_id: 'legacy-0' }]);
  assert.deepEqual(await figures(), [['Disponibile (CNY)', '110,00 ¥'], ['Ricaricato', '100,00 ¥'], ['Bonus', '10,00 ¥'], ['Disponibile (USD)', '3,50 $']]);
  assert.equal(await balance.locator('.usage-row--nested').count(), 2, 'the split appears only when both parts exist');
  assert.match(await balance.locator('.balance__note').innerText(), /^Aggiornato alle \d{2}:\d{2}$/);
  assert.equal(await topUp.innerText(), 'Ricarica su DeepSeek');
  assert.equal(await topUp.getAttribute('title'), 'platform.deepseek.com');
  await topUp.click();
  assert.deepEqual(await page.evaluate(() => window.__calls.filter(call => call.cmd === 'open_external_url').map(call => call.args)), [{ url: topUpUrl }]);

  // A fresh reading is reused when the popover is reopened.
  await page.keyboard.press('Escape');
  await summary.click();
  await settle();
  assert.equal(await balanceCalls(), 1);

  // A reply spends credit: the old reading stays visible while the next one loads.
  await page.keyboard.press('Escape');
  await page.evaluate(() => openConversation('old', false));
  await page.fill('#composer-input', 'Ancora');
  await page.click('#composer-send');
  await page.waitForFunction(() => /0,00043/.test(document.querySelector('#context-summary').textContent));
  await settle();
  assert.equal(await balanceCalls(), 1, 'a closed popover does not read the balance after a reply');
  await setBalance({ reply: readings.second });
  await hold();
  await summary.click();
  await page.waitForFunction(() => document.querySelector('.balance--popover .balance__refresh')?.classList.contains('is-loading'));
  assert.equal((await figures())[0][1], '110,00 ¥');
  await release();
  await page.waitForFunction(() => document.querySelector('.balance--popover .balance__primary dd')?.textContent.startsWith('109,50'));
  assert.deepEqual(await figures(), [['Disponibile', '109,50 ¥'], ['Ricaricato', '99,50 ¥'], ['Bonus', '10,00 ¥']]);
  assert.equal(await balanceCalls(), 2);

  // A failed refresh keeps the last reading and says so.
  await setBalance({ reply: { error: 'balance_unavailable' } });
  await refresh.click();
  await balance.locator('.balance__note--error').waitFor();
  assert.equal(await balance.locator('.balance__note--error').innerText(), locales['errors.balance_unavailable']);
  assert.match(await balance.locator('.balance__note').last().innerText(), /^Ultimo saldo letto alle \d{2}:\d{2}/);
  assert.equal(await balance.locator('.usage-row').count(), 3);
  assert.equal(await topUp.count(), 1);

  // An exhausted account is flagged and the top-up becomes the primary action.
  await setBalance({ reply: readings.depleted });
  await refresh.click();
  await balanceState('depleted');
  assert.equal(await balance.locator('.balance__flag').innerText(), 'Credito insufficiente');
  assert.equal(await balance.locator('.balance__note--error').count(), 0);
  assert.match(await topUp.getAttribute('class'), /balance__action--primary/);
  assert.deepEqual(await figures(), [['Disponibile', '0,00 ¥']]);

  // Without any reading the error names the recovery; "Riprova" retries and returns focus to the refresh button.
  await setBalance({ reply: { error: 'balance_unauthorized' } });
  await page.evaluate(() => resetBalances());
  await balanceState('error');
  assert.equal(await balance.locator('.balance__note--error').innerText(), locales['errors.balance_unauthorized']);
  assert.equal(await topUp.count(), 0);
  await setBalance({ reply: readings.first });
  await balance.getByRole('button', { name: 'Riprova' }).click();
  await balanceState('ready');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('balance__refresh')), true);

  // If the system browser cannot open, the address is shown to copy and focus stays on the button.
  await setBalance({ linkFails: true });
  await topUp.click();
  assert.equal(await balance.locator('.balance__url').innerText(), topUpUrl);
  assert.ok((await balance.locator('.balance__note--error').innerText()).includes(locales['chat.link_failed']));
  assert.equal(await page.evaluate(() => document.activeElement.dataset.balanceAction), 'topup');
  await setBalance({ linkFails: false });

  // The provider editor shows the same reading without asking again while it is fresh.
  const requests = await balanceCalls();
  await panel.locator('.usage-link').click();
  await page.click('.provider-row');
  const editorBalance = page.locator('#provider-editor .balance--settings');
  await editorBalance.waitFor();
  assert.equal(await editorBalance.locator('h4').innerText(), 'Saldo DeepSeek');
  assert.equal(await editorBalance.locator('.usage-row dt').first().innerText(), 'Disponibile (CNY)');
  assert.equal(await balanceCalls(), requests);
  await page.click('#modal-close');
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS: usage panel k/M tokens, USD estimates, cache split, per-model rows, unpriced note, last reply, legacy chats, Escape/outside close, price shortcut and DeepSeek balance (lazy read, cache, refresh after a reply, error/depleted/retry states, top-up link, provider editor).');
})().catch(error => { console.error(error); process.exit(1); });
