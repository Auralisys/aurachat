// Run via the ignored Rust browser_terminal_fixture test (see README).
// stdio is a private transport to its real PTY; everything else is synthetic.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const root = process.env.AURA_TERMINAL_FIXTURE;
assert.ok(root, 'Run via browser_terminal_fixture');
const pending = new Map(), calls = [], writes = [];
const pipe = require('node:readline').createInterface({input:process.stdin});
pipe.on('line', line => {
  const {seq, result} = JSON.parse(line), {ok, fail} = pending.get(seq);
  pending.delete(seq);result.error ? fail(Error(result.error)) : ok(result.value);
});
let sequence = 0;
function native(cmd, args = {}) {
  calls.push(cmd);
  if (cmd === 'terminal_write') writes.push(args.data);
  return new Promise((ok, fail) => {
    const seq = ++sequence;pending.set(seq, {ok, fail});process.stdout.write(JSON.stringify({seq,cmd,args})+'\n');
  });
}

(async () => {
  const browser = await chromium.launch({channel:process.platform === 'win32' ? 'msedge' : undefined,headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1600,height:940},reducedMotion:'reduce'});
    const errors = [];page.on('pageerror', e => errors.push(e.message));
    await page.route(/^https?:/, route => route.abort());
    await page.exposeFunction('fixtureIPC', native);
    await page.addInitScript(({lang, root}) => {
      const config = {firebase_email:'fixture@example.test',firebase_auth_set:true,api_key_set:true,models:['demo'],active_model:'demo'};
      const data = {projects:[{id:'fixture',name:'Terminal demo',source_folders:[root],conversations:[
        {id:'chat',title:'Local environment',created_at:1,updated_at:1,messages:[{role:'user',content:'Check the local environment.'}]}
      ]}],conversations:[]};
      window.__TAURI__ = {window:{getCurrentWindow:()=>({async listen(){return ()=>{};}})},core:{invoke:async(cmd,args)=>{
        if (cmd.startsWith('terminal_')) {
          const result = await fixtureIPC(cmd,args);
          if (cmd === 'terminal_open' && window.holdOpen) await new Promise(resolve=>window.releaseOpen=resolve);
          return result;
        }
        if (cmd === 'get_locale') return lang;
        if (['get_config','get_local_config'].includes(cmd)) return config;
        if (['get_data','refresh_data'].includes(cmd)) return structuredClone(data);
        if (cmd === 'project_git' && args.action === 'discover') return {repositories:[],truncated:false};
        if (cmd === 'project_folder_access') return [root];
        if (cmd === 'project_permission_mode') return 'ask';
        if (['list_shells','list_questions','list_approvals'].includes(cmd)) return [];
      }}};
    }, {lang:readFileSync(resolve(__dirname,'../ui/locales/en.json'),'utf8'),root});
    await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);
    await page.locator('#boot-splash').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Local environment',exact:true}).first().click();
    await page.click('#panel-toggle');
    const launch = page.locator('#panel-open-terminal');
    assert.ok(await launch.isEnabled());
    await page.evaluate(()=>{const p=gitProject();window.restoreFolders=p.source_folders;p.source_folders=[];renderBrowser();});
    assert.ok(await launch.isDisabled());
    await page.evaluate(()=>{gitProject().source_folders=window.restoreFolders;renderBrowser();});
    await launch.evaluate(button => button.click());
    assert.equal(calls.includes('terminal_open'),false,'Opening the panel or synthetic click must not spawn a PTY');
    await launch.click();
    const selected = page.getByRole('tab',{name:'Terminal',exact:true});
    await selected.waitFor();
    const surface = page.locator('.manual-terminal .xterm-helper-textarea');
    const waitForText = text => page.waitForFunction(text=>{
      const buffer = activePanelTab()?.terminal?.term.buffer.active;
      return buffer && Array.from({length:buffer.length},(_,i)=>buffer.getLine(i).translateToString(true)).join('').includes(text);
    }, text, {timeout:15000}).catch(async error => {
      console.error('Fixture screen:', await page.locator('.xterm-rows').allTextContents(), errors);
      throw error;
    });
    const send = async line => {await surface.focus();await page.keyboard.type(line);await page.keyboard.press('Enter');};
    const win = process.platform === 'win32';
    await page.waitForFunction(()=>activePanelTab()?.terminal?.id != null);
    if (win) await waitForText('PS '+root+'>');
    await send(win ? 'Get-Content .\\message.txt' : 'cat ./message.txt');
    await waitForText('Local PTY verified.');
    await send(win ? '$proof = 19 + 23' : 'proof=42');
    await page.click('#panel-add-tab');
    await page.locator('[data-panel-tool=shells]').click();
    assert.ok(await page.locator('#activity-panel').isVisible());
    await selected.click();
    await page.click('#browser-close');await page.click('#panel-toggle');
    await send(win ? 'Write-Output "Session value: $proof"' : 'echo "Session value: $proof"');
    await waitForText('Session value: 42');
    assert.equal(calls.filter(n=>n==='terminal_open').length,1);
    const previousCols = await page.evaluate(()=>activePanelTab().terminal.term.cols);
    await page.click('#panel-expand');
    await page.waitForFunction(cols=>activePanelTab().terminal.term.cols > cols, previousCols);
    await page.click('#panel-expand');
    await page.locator('#browser-resize').focus();await page.keyboard.press('End');
    await page.waitForFunction(cols=>activePanelTab().terminal.term.cols < cols, previousCols);
    await page.locator('#browser-resize').focus();await page.keyboard.press('Home');
    await page.waitForFunction(cols=>activePanelTab().terminal.term.cols > cols, previousCols);
    await surface.focus();await page.keyboard.press('Shift+Escape');
    assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('role')),'tab');
    await surface.focus();
    await send(win ? 'Clear-Host' : 'clear');
    await send(win ? 'Get-Content .\\message.txt; $proof * 2' : 'cat ./message.txt; echo $((proof * 2))');
    await waitForText('Local PTY verified.84');
    if (win) await page.waitForFunction(root=>{
      const {buffer} = activePanelTab().terminal.term, b = buffer.active;
      return b.getLine(b.baseY + b.cursorY)?.translateToString(true).trimEnd() === 'PS '+root+'>';
    },root);
    assert.ok(await page.locator('.manual-terminal .xterm-screen').evaluate(el=>{
      const screen=el.getBoundingClientRect(), panel=document.querySelector('#browser-panel').getBoundingClientRect();
      return screen.left >= panel.left && screen.right <= panel.right+1 && screen.width > panel.width*0.85;
    }), 'The resized terminal screen must fit its visible panel');
    const shot = resolve(__dirname,'../../.artifact/terminal.png');
    await page.screenshot({path:shot});
    console.error('Screenshot: '+shot);
    const closeDialog = page.getByRole('dialog',{name:'Close terminal?'});
    await page.locator('.panel-tab.is-active .panel-tab__close').click();
    await closeDialog.waitFor();
    assert.equal(await closeDialog.locator('strong').innerText(),'Terminal');
    assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Cancel','Cancel is the safe default');
    await page.screenshot({path:resolve(__dirname,'../../.artifact/terminal-close.png')});
    await closeDialog.getByRole('button',{name:'Cancel'}).click();
    assert.ok(await selected.isVisible());
    assert.equal(await native('fixture_count'),1,'Cancel keeps the shell running');
    await page.locator('.panel-tab.is-active .panel-tab__close').click();
    await closeDialog.getByRole('button',{name:'Close terminal'}).click();
    await selected.waitFor({state:'detached'});
    assert.equal(await native('fixture_count'),0,'Closing the tab releases the native PTY');
    await page.click('#panel-add-tab');
    await page.evaluate(()=>window.holdOpen=true);await launch.click();
    await page.waitForFunction(()=>!!window.releaseOpen);
    await page.locator('.panel-tab.is-active .panel-tab__close').click();
    await closeDialog.getByRole('checkbox',{name:"Don't ask again when closing terminals"}).check();
    await closeDialog.getByRole('button',{name:'Close terminal'}).click();
    await page.evaluate(()=>{window.holdOpen=false;window.releaseOpen();});
    await selected.waitFor({state:'detached'});
    assert.equal(await native('fixture_count'),0,'Close while opening cannot orphan the shell');
    assert.equal(await page.evaluate(()=>[localStorage.getItem('aurachat.terminal.confirm_close'),document.querySelector('#terminal-confirm-close').checked].join()),'off,false');
    await page.click('#panel-add-tab');await launch.click();
    await page.waitForFunction(()=>activePanelTab()?.terminal?.id != null);
    await page.locator('.panel-tab.is-active .panel-tab__close').click();
    await selected.waitFor({state:'detached'});
    assert.equal(await native('fixture_count'),0,'With confirmation off the tab closes at once');
    await page.evaluate(()=>{const box=document.querySelector('#terminal-confirm-close');box.checked=true;box.dispatchEvent(new Event('change'));});
    await page.click('#panel-add-tab');await launch.click();
    await page.waitForFunction(()=>!document.querySelector('.manual-terminal__surface')?.inert);
    if (win) await waitForText('PS '+root+'>');
    await send('exit');await page.getByText('Session ended.',{exact:true}).waitFor({timeout:8000}).catch(async error => {
      console.error('Fixture exit:', await page.locator('.xterm-rows').allTextContents(),
        await page.locator('.manual-terminal__status').allTextContents(),calls.slice(-16),writes.slice(-16),errors);
      throw error;
    });
    await page.waitForFunction(()=>activePanelTab().terminal.id === null);
    await page.locator('.panel-tab.is-active .panel-tab__close').click();
    await selected.waitFor({state:'detached'});
    assert.equal(await closeDialog.isVisible(),false,'An ended shell closes without asking');
    await page.click('#panel-add-tab');await launch.click();
    await page.waitForFunction(()=>activePanelTab()?.terminal?.id != null);
    await page.locator('.panel-tab.is-active .panel-tab__close').click();
    await closeDialog.waitFor();
    await native('fixture_logout');
    await page.evaluate(()=>{state.config.firebase_auth_set=false;renderActivity();});
    assert.equal(await closeDialog.isVisible(),false,'Logout dismisses a pending close prompt');
    assert.equal(await page.locator('.manual-terminal').count(),0);
    assert.equal(await native('fixture_count'),0);
    assert.deepEqual(errors,[]);
    console.error('PASS explicit launch, native prompt and output, retained shell variable, resize, keyboard, exit, close confirmation and logout.');
  } finally {await browser.close();}
})().catch(err=>{console.error(err);process.exitCode=1;}).finally(()=>{pipe.close();process.stdin.destroy();});
