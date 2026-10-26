const {chromium} = require('playwright');
const {readFileSync, mkdirSync} = require('node:fs');
const {resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({channel: process.platform === 'darwin' ? 'chrome' : 'msedge', headless: true});
  try {
    for (const language of ['it', 'en']) {
      const strings = JSON.parse(readFileSync(resolve(__dirname, `../ui/locales/${language}.json`), 'utf8'));
      const page = await browser.newPage({viewport: {width: 480, height: 320}, locale: language});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({strings}) => {
        window.__mode = 'none';
        window.__calls = [];
        window.__listeners = {};
        window.__TAURI__ = {
          window: {getCurrentWindow: () => ({async listen(name, callback) {window.__listeners[name] = callback; return () => {};}})},
          core: {
            Channel: class {constructor() {window.__progress = this;}},
            async invoke(cmd) {
              window.__calls.push(cmd);
              if (cmd === 'get_locale') return JSON.stringify(strings);
              if (cmd === 'check_app_update') {
                await new Promise(resolve => {window.__checked = resolve;});
                if (window.__mode === 'offline') throw new Error('GitHub unavailable');
                return window.__mode === 'none' ? null : {version: '0.2.0'};
              }
              if (cmd === 'install_app_update') {
                window.__progress.onmessage({phase: 'downloading', downloaded: 1048576, total: 2097152});
                await new Promise((resolve, reject) => {window.__installed = resolve; window.__failed = reject;});
              }
              if (cmd === 'get_local_config' || cmd === 'get_config') return {firebase_auth_set: false, firebase_email: '', models: []};
            },
          },
        };
      }, {strings});
      const url = pathToFileURL(resolve(__dirname, '../ui/index.html')).href;
      const start = async mode => {
        await page.goto(url);
        await page.waitForFunction(() => window.__checked);
        await page.evaluate(mode => {window.__mode = mode; window.__checked();}, mode);
      };
      // No update: no account or gateway work starts before the check completes.
      await page.goto(url);
      await page.waitForFunction(() => window.__checked);
      assert.equal(await page.evaluate(() => window.__calls.includes('get_config')), false);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#update-dialog').isVisible(), true);
      await page.evaluate(() => window.__checked());
      await page.locator('#login-form').waitFor({state: 'visible'});
      assert.equal(await page.locator('#update-dialog').isVisible(), false);
      assert.equal(await page.evaluate(() => window.__calls.indexOf('finish_update_check') < window.__calls.indexOf('get_config')), true);

      // Required update: automatic download, focus trap, no dismiss or offline bypass.
      await start('required');
      await page.waitForFunction(() => window.__installed);
      assert.equal(await page.locator('#update-title').textContent(), strings['updates.required_title']);
      assert.equal(await page.locator('#update-dialog progress').getAttribute('value'), '0.5');
      assert.equal(await page.locator('[data-update-offline]').isVisible(), false);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('#update-dialog').isVisible(), true);
      assert.equal(await page.evaluate(() => window.__calls.includes('get_config')), false);
      const shots = resolve(__dirname, '../../.artifact/updates');
      mkdirSync(shots, {recursive: true});
      await page.screenshot({path: resolve(shots, `${language}-downloading-480.png`)});
      await page.setViewportSize({width: 1080, height: 880});
      await page.screenshot({path: resolve(shots, `${language}-downloading-1080.png`)});
      await page.evaluate(() => window.__failed(new Error('Invalid update signature')));
      await page.locator('[data-update-retry]').waitFor({state: 'visible'});
      assert.equal(await page.locator('[data-update-offline]').isVisible(), false);
      assert.match(await page.locator('[data-update-detail]').textContent(), /Invalid update signature/);
      await page.locator('[data-update-retry]').click();
      await page.waitForFunction(() => window.__calls.filter(cmd => cmd === 'install_app_update').length === 2);
      assert.equal(await page.evaluate(() => window.__calls.filter(cmd => cmd === 'check_app_update').length), 1);
      await page.evaluate(() => window.__progress.onmessage({phase: 'installing'}));
      assert.equal(await page.locator('#update-title').textContent(), strings['updates.installing_title']);
      await page.evaluate(() => window.__installed());
      await page.waitForFunction(text => document.querySelector('[data-update-message]').textContent === text, strings['updates.restarting']);
      assert.equal(await page.evaluate(() => window.__calls.includes('finish_update_check')), false);

      // An unreachable service is an explicit recoverable check error, never "up to date".
      await start('offline');
      await page.locator('[data-update-offline]').waitFor({state: 'visible'});
      assert.equal(await page.locator('#update-title').textContent(), strings['updates.check_failed']);
      await page.locator('[data-update-retry]').click();
      await page.waitForFunction(() => window.__calls.filter(cmd => cmd === 'check_app_update').length === 2);
      await page.evaluate(() => window.__checked());
      await page.locator('[data-update-offline]').waitFor({state: 'visible'});
      await page.locator('[data-update-offline]').click();
      await page.locator('#login-form').waitFor({state: 'visible'});
      assert.equal(await page.locator('#update-dialog').isVisible(), false);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS: IT/EN startup gate, automatic mandatory install, progress, Escape/focus blocking, failed signature retry, restart and explicit offline recovery.');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
