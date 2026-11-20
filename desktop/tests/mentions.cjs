// `@` file mentions and files linked by path. Isolated: the native commands are stubbed.
const {chromium} = require('playwright');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1409, height:1000}, locale:'it-IT'});
    const errors = [];page.on('pageerror', error => errors.push(error.message));
    const locales = Object.fromEntries(['it', 'en'].map(lang => [lang, JSON.parse(readFileSync(resolve(__dirname, `../ui/locales/${lang}.json`), 'utf8'))]));
    await page.addInitScript(({locales}) => {
      const config = {firebase_email:'demo@example.com',firebase_project_id:'demo',firebase_api_key:'demo',firebase_auth_set:true,api_key_set:true,models:['deepseek-flash'],active_model:'deepseek-flash'};
      window.__store = {projects:[{id:'p',name:'Project P',conversations:[{id:'c',title:'Project chat',messages:[]}]}], conversations:[]};
      window.__searches = [];window.__calls = [];window.__listeners = {};
      window.__TAURI__ = {window:{getCurrentWindow:() => ({minimize(){},close(){},async listen(name, callback){window.__listeners[name] = callback;return () => {};}})},core:{invoke:async (cmd, args) => {
        window.__calls.push({cmd,args:structuredClone(args)});
        if (cmd === 'get_locale') return JSON.stringify(locales[args.lang] || locales.it);
        if (['get_local_config','get_config'].includes(cmd)) return config;
        if (['get_data','refresh_data'].includes(cmd)) return structuredClone(window.__store);
        if (cmd === 'save_data') return structuredClone(args.data);
        if (cmd === 'speech_model_status') return {ready:false,busy:false,downloaded:0,total:1};
        if (cmd === 'project_permission_mode') return 'ask';
        if (cmd === 'project_skills') return {skills:[],truncated:false};
        if (cmd === 'search_project_paths') return new Promise((resolve,reject) => window.__searches.push({project:args.project_id,query:args.query,resolve,reject}));
        if (cmd === 'preview_project_path') {
          if (args.path.endsWith('outside.txt')) throw 'outside_project';
          return {kind:'text',size:13,content:'Hello mention',truncated:false};
        }
        if (cmd === 'chat') return new Promise(() => {});
      }}};
    }, {locales});
    await page.goto(pathToFileURL(resolve(__dirname, '../ui/index.html')).href);
    await page.locator('#boot-splash').waitFor({state:'hidden'});
    const input = page.locator('#composer-input'), chooser = page.locator('#mention-chooser');
    const options = page.locator('#mention-options [role=option]'), status = page.locator('#mention-status');
    const file = (relative, root = 'C:\\work\\proj') => ({path:`${root}\\${relative.replaceAll('/', '\\')}`, name:relative.split('/').at(-1), relative});
    const selectProject = id => page.evaluate(id => {state.activeConversationId=null;state.pendingProjectId=id;populateProjectMenu();}, id);
    const count = () => page.evaluate(() => __searches.length);
    const fulfill = (index, files, extra = {}) => page.evaluate(({index,files,extra}) => __searches[index].resolve({files,truncated:false,...extra}), {index,files,extra});
    const text = () => page.evaluate(() => composerText());
    const chips = page.locator('#composer-input .mention-token');

    // Without a project there is nothing to search: the panel only explains how to get suggestions.
    await selectProject(null);await input.focus();await input.fill('@');
    await chooser.waitFor({state:'visible'});assert.equal(await status.textContent(), locales.it['mentions.no_project']);
    await input.fill('@a');assert.equal(await chooser.isHidden(), true);
    assert.equal(await count(), 0);

    // Addresses and mid-word at-signs are not mentions.
    await input.fill('');
    await selectProject('p');await input.focus();await input.fill('scrivi a me@example.com');
    assert.equal(await chooser.isHidden(), true);assert.equal(await count(), 0);

    // `@` opens the list for the active project; the backend sees the typed query with `/` separators.
    await input.fill('guarda @');await page.waitForFunction(() => __searches.length === 1);
    assert.deepEqual(await page.evaluate(() => [__searches[0].project, __searches[0].query]), ['p', '']);
    assert.equal(await status.textContent(), locales.it['mentions.loading']);
    await input.press('Enter');assert.equal(await text(), 'guarda @', 'Enter waits for the suggestions instead of sending or choosing');
    assert.equal(await page.evaluate(() => __calls.filter(call => call.cmd === 'chat').length), 0);
    await fulfill(0, [file('README.md'), file('src/readme-notes.md')]);
    await options.last().waitFor();assert.equal(await options.count(), 2);
    assert.match(await options.first().textContent(), /README\.md/);
    await input.press('ArrowDown');assert.equal(await input.getAttribute('aria-activedescendant'), 'mention-option-1');
    await input.press('ArrowUp');

    // Typing narrows the query (backslashes become slashes); a stale answer never replaces the newer one.
    await input.pressSequentially('src\\rea');await page.waitForFunction(() => __searches.length >= 2);
    const newest = (await count()) - 1;
    assert.equal(await page.evaluate(i => __searches[i].query, newest), 'src/rea');
    await fulfill(newest, [file('src/readme-notes.md')]);
    await page.waitForFunction(() => document.querySelectorAll('#mention-options [role=option]').length === 1);
    await fulfill(0, [file('stale.md')]);
    assert.match(await options.first().textContent(), /readme-notes/);

    // Choosing inserts an atomic chip carrying the absolute path, followed by a space.
    await input.press('Enter');
    await chips.first().waitFor();assert.equal(await chooser.isHidden(), true);
    assert.equal(await text(), 'guarda C:\\work\\proj\\src\\readme-notes.md ');
    assert.equal(await chips.first().textContent(), 'readme-notes.md');
    assert.equal(await chips.first().getAttribute('title'), 'C:\\work\\proj\\src\\readme-notes.md');
    assert.deepEqual(await page.evaluate(() => composerParts().filter(part => part.pasted)), [{text:'C:\\work\\proj\\src\\readme-notes.md', pasted:true, kind:'file'}]);
    await input.pressSequentially('e dimmi');assert.equal(await text(), 'guarda C:\\work\\proj\\src\\readme-notes.md e dimmi');

    // Escape closes a fresh list.
    const before = await count();
    await input.pressSequentially(' @');await page.waitForFunction(n => __searches.length > n, before);
    await input.press('Escape');assert.equal(await chooser.isHidden(), true);

    // Clicking the chip opens the side panel with a preview.
    await chips.first().click();
    await page.locator('#activity-panel-content .activity-source-content').waitFor();
    assert.equal(await page.locator('#activity-panel-content .activity-source-content').textContent(), 'Hello mention');
    assert.match(await page.locator('#activity-panel-content').textContent(), /C:\\work\\proj\\src\\readme-notes\.md/);
    assert.deepEqual(await page.evaluate(() => __calls.filter(call => call.cmd === 'preview_project_path').at(-1).args), {project_id:'p', path:'C:\\work\\proj\\src\\readme-notes.md'});

    // Mention ranges travel with the message and drive the chips shown in the conversation.
    await page.evaluate(() => setComposerParts([{text:'leggi '}, {text:'C:\\work\\proj\\a.js', pasted:true, kind:'file'}, {text:' ora'}]));
    assert.deepEqual(await page.evaluate(() => composerMessage(composerParts())), {content:'leggi C:\\work\\proj\\a.js ora', pastes:[{start:6, end:23, kind:'file'}]});

    // Linked attachments keep only a path: the chip says so, opens the panel, and no file content is stored.
    await page.evaluate(() => {
      state.attachments = [{name:'report.pdf', path:'D:\\outside\\report.pdf', content:''}, {name:'outside.txt', path:'D:\\outside\\outside.txt', content:''}];
      renderDraft();
    });
    const linked = page.locator('#composer-attachments .attachment-chip--linked');
    assert.equal(await linked.count(), 2);
    assert.equal(await page.locator('#linked-note').isVisible(), true);
    assert.equal(await page.locator('#attachment-note').isVisible(), false);
    await linked.nth(1).locator('button').first().click();
    await page.locator('#activity-panel-content .activity-empty--note').waitFor();
    assert.equal(await page.locator('#activity-panel-content .activity-empty--note').textContent(), locales.it['mentions.outside']);
    await page.evaluate(() => {state.attachments = [{name:'notes.md', content:'ciao'}];renderDraft();});
    assert.equal(await page.locator('#linked-note').isHidden(), true);
    assert.equal(await page.locator('#attachment-note').isVisible(), true);
    assert.equal(await page.locator('#composer-attachments .attachment-chip--linked').count(), 0);

    assert.deepEqual(errors, []);
    console.log('mentions OK');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error);process.exit(1);});
