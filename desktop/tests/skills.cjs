const {chromium} = require('playwright');
const {readFileSync, mkdirSync} = require('node:fs');
const {resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1409, height:1000},locale:'it-IT'});
    const errors = [];page.on('pageerror', error => errors.push(error.message));
    const locales = Object.fromEntries(['it', 'en'].map(lang => [lang, JSON.parse(readFileSync(resolve(__dirname, `../ui/locales/${lang}.json`), 'utf8'))]));
    await page.addInitScript(({locales}) => {
      const config = {firebase_email:'demo@example.com',firebase_project_id:'demo',firebase_api_key:'demo',firebase_auth_set:true,api_key_set:true,models:['deepseek-flash'],active_model:'deepseek-flash'};
      window.__store = {projects:[{id:'p',name:'Project P',conversations:[{id:'c',title:'Project chat',messages:[]}]},{id:'q',name:'Project Q',conversations:[]}], conversations:[]};
      window.__skillRequests = [];window.__calls = [];window.__listeners = {};
      window.__TAURI__ = {window:{getCurrentWindow:() => ({minimize(){},close(){},async listen(name, callback){window.__listeners[name] = callback;return () => {};}})},core:{invoke:async (cmd, args) => {
        window.__calls.push({cmd,args});
        if (cmd === 'get_locale') return JSON.stringify(locales[args.lang] || locales.it);
        if (['get_local_config','get_config'].includes(cmd)) return config;
        if (cmd === 'get_data') return structuredClone(window.__store);
        if (cmd === 'save_data') return structuredClone(args.data);
        if (cmd === 'speech_model_status') return {ready:false,busy:false,downloaded:0,total:1};
        if (cmd === 'project_permission_mode') return 'ask';
        if (cmd === 'project_skills') return new Promise((resolve,reject) => window.__skillRequests.push({project:args.project_id,resolve,reject}));
      }}};
    }, {locales});
    await page.goto(pathToFileURL(resolve(__dirname, '../ui/index.html')).href);
    await page.locator('#boot-splash').waitFor({state:'hidden'});
    const input = page.locator('#composer-input'), chooser = page.locator('#skill-chooser');
    const options = page.locator('#skill-options [role=option]'), status = page.locator('#skill-status');
    const skill = (name, description = '', root = 0, base = '.agents') => ({name,description,root,path:`${base}/skills/${name}/SKILL.md`});
    const selectProject = id => page.evaluate(id => {state.activeConversationId=null;state.pendingProjectId=id;populateProjectMenu();}, id);
    const count = () => page.evaluate(() => __skillRequests.length);
    const fulfill = (index, skills, truncated = false) => page.evaluate(({index,skills,truncated}) => __skillRequests[index].resolve({skills,truncated}), {index,skills,truncated});
    const open = async () => {await input.focus();await input.fill('/');};

    // No project means no native catalog request, including on free chats.
    await selectProject(null);await open();assert.equal(await status.textContent(), locales.it['skills.no_project']);assert.equal(await count(), 0);
    await input.press('Escape');assert.equal(await chooser.isHidden(), true);
    await selectProject('p');await open();await page.waitForFunction(() => __skillRequests.length === 1);
    assert.equal(await page.evaluate(() => __skillRequests[0].project), 'p');
    assert.equal(await status.textContent(), locales.it['skills.loading']);
    await input.press('Enter');assert.equal(await input.inputValue(), '/');
    await fulfill(0, [skill('review','Review code'),skill('write','Write safely')]);
    await options.last().waitFor();assert.equal(await options.count(), 2);
    assert.equal(await input.getAttribute('aria-expanded'), 'true');
    await input.press('ArrowDown');assert.equal(await input.getAttribute('aria-activedescendant'), 'skill-option-1');
    await input.press('ArrowUp');assert.equal(await input.getAttribute('aria-activedescendant'), 'skill-option-0');
    await input.press('ArrowUp');await input.press('Enter');
    assert.equal(await input.inputValue(), '/write ');assert.equal(await chooser.isHidden(), true);
    assert.equal(await page.evaluate(() => __calls.filter(c => c.cmd === 'chat').length), 0);
    await input.fill('/review task');assert.equal(await chooser.isHidden(), true);

    // Fresh opening refreshes grants/catalog; descriptions stay inert text.
    await open();await fulfill(1, [skill('review','<img src=x onerror=alert(1)> Review code')]);
    await options.first().waitFor();assert.equal(await chooser.locator('img').count(), 0);
    assert.match(await options.first().textContent(), /<img src=x/);
    await input.fill('/code');await options.first().click();assert.equal(await input.inputValue(), '/review ');
    await open();await fulfill(2, [skill('review','Code review')]);await options.first().waitFor();
    await input.fill('/missing');assert.equal(await status.textContent(), locales.it['skills.no_match']);
    await input.press('Enter');assert.equal(await input.inputValue(), '/missing');
    await input.press('Escape');await page.evaluate(() => updateComposerControls());assert.equal(await chooser.isHidden(), true);

    // Duplicates stay ambiguous even when filtering by just one description.
    await open();await fulfill(3, [skill('review','Only-first'),skill('review','Second',1,'.codex')], true);
    await options.last().waitFor();await input.fill('/Only-first');assert.equal(await options.count(), 1);
    assert.equal(await options.first().getAttribute('aria-disabled'), 'true');
    assert.match(await status.textContent(), /catalogo è incompleto/);
    await input.press('Enter');assert.equal(await input.inputValue(), '/Only-first');
    await options.first().click({force:true});assert.equal(await input.inputValue(), '/Only-first');

    // A newer request wins even in the same project; a stale project response also loses.
    await input.press('Escape');await open();const old = (await count()) - 1;
    await input.press('Escape');await input.focus();await input.fill('/r');const fresh = (await count()) - 1;
    await fulfill(fresh, [skill('recent')]);await options.first().waitFor();await fulfill(old, [skill('retired')]);
    assert.match(await options.first().textContent(), /recent/);
    await input.press('Escape');await open();const pRequest = (await count()) - 1;
    await selectProject('q');const qRequest = (await count()) - 1;
    assert.equal(await page.evaluate(i => __skillRequests[i].project, qRequest), 'q');
    await fulfill(qRequest, [skill('qskill')]);await options.first().waitFor();await fulfill(pRequest, [skill('pskill')]);
    assert.match(await options.first().textContent(), /qskill/);

    // Errors can be retried without sending, and active chats determine project scope.
    await input.press('Escape');await open();const failing = (await count()) - 1;
    await page.evaluate(index => __skillRequests[index].reject(new Error('denied')), failing);
    await page.locator('#skill-retry').waitFor({state:'visible'});assert.equal(await status.textContent(), locales.it['skills.failed']);
    await page.locator('#skill-retry').click();const retryRequest = (await count()) - 1;
    await fulfill(retryRequest, [skill('retried')]);await options.first().waitFor();
    assert.match(await options.first().textContent(), /retried/);
    await page.evaluate(() => {state.activeConversationId='c';state.pendingProjectId='q';updateComposerControls();});
    assert.equal(await page.evaluate(() => __skillRequests.at(-1).project), 'p');
    await fulfill((await count()) - 1, [skill('review')]);await options.first().waitFor();

    const shots = resolve(__dirname, '../../.artifact/rea-chatgpt');mkdirSync(shots, {recursive:true});
    await page.screenshot({path:resolve(shots, 'skills-desktop.png')});
    await page.setViewportSize({width:600,height:800});
    await page.screenshot({path:resolve(shots, 'skills-compact.png')});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.evaluate(english => {lang='en';strings=english;applyTranslations();skillsChooser.invalidate();}, locales.en);
    await fulfill((await count()) - 1, []);
    await page.waitForFunction(() => document.querySelector('#skill-status').textContent === 'No matching project skills.');
    assert.equal(await page.locator('#skill-title').textContent(), locales.en['skills.title']);
    // Verify translation keys without depending on OS/browser language detection.
    for (const locale of Object.values(locales)) {
      for (const key of ['skills.title','skills.no_match','skills.duplicate','progress.load_project_skill','progress.list_project_skills']) assert.ok(locale[key]);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: scoped catalog, keyboard/pointer selection, safe text, loading/empty/duplicate/error/retry states, stale request/project rejection, active-chat scope and compact layout.');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exit(1);});
