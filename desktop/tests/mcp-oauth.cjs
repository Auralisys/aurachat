// Isolated UI fixture: no live AuraChat chats, accounts, cookies or credentials.
const {chromium} = require('playwright');
const {readFileSync, mkdirSync} = require('node:fs');
const {resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const strings = JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
    await page.addInitScript(({strings}) => {
      window.__events = {};window.__calls = [];window.__passwords = false;window.__connected = false;
      const config = {firebase_email:'fixture@example.com',firebase_auth_set:true,api_key_set:true,models:['fixture'],active_model:'fixture'};
      window.__emit = (name,payload) => __events[name]?.({payload});
      window.__TAURI__ = {window:{getCurrentWindow:()=>({minimize(){},close(){},async listen(name,fn){const old = __events[name];__events[name] = event=>{old?.(event);return fn(event);};return()=>{};}})},
        core:{invoke:async(cmd,args)=>{
          __calls.push({cmd,args:structuredClone(args)});
          if(cmd==='get_locale')return JSON.stringify(strings);
          if(['get_local_config','get_config'].includes(cmd))return config;
          if(['get_data','refresh_data'].includes(cmd))return {projects:[],conversations:[]};
          if(cmd==='mcp_integrations'){
            if(window.__delayMcp)await new Promise(resolve=>window.__releaseMcp=resolve);
            return {servers:[{name:'mobbin',oauth:true,disabled:!__connected,authenticated:__connected}]};
          }
          if(cmd==='browser_preferences'){
            if(args?.save_passwords!=null)window.__passwords=args.save_passwords;
            return {save_passwords:__passwords,passwords_supported:true};
          }
          if(cmd==='mcp_connect'){
            const waiting = new Promise((resolve,reject)=>{window.__finish=resolve;window.__cancel=reject;});
            __emit('mcp-oauth-open',{tab_id:'oauth-fixture',email:config.firebase_email,server:'mobbin',url:'https://auth.example/authorize?state=private-state'});
            try {await waiting;window.__connected=true;return {tools:['search_screens','search_flows','search_sections']};}
            finally {await __emit('mcp-oauth-close',{tab_id:'oauth-fixture'});}
          }
          if(cmd==='mcp_disconnect'){window.__connected=false;return;}
          if(cmd==='browser_close' && args.tab_id==='oauth-fixture')__cancel?.('mcp_oauth_cancelled');
          if(cmd==='browser_open'){
            if(window.__failBrowser)throw Error('mcp_oauth_browser_failed');
            return {url:args.url,capture:true};
          }
          if(['list_shells','list_approvals','list_questions','project_folder_access'].includes(cmd))return [];
        }}};
    },{strings});
    await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);
    await page.locator('#boot-splash').waitFor({state:'hidden'});
    const settings = async () => {await page.click('#btn-settings');await page.click('[data-settings-tab=mcp]');await page.locator('#mcp-list strong').waitFor();};
    await settings();
    assert.match(await page.locator('#mcp-list').innerText(),/Disconnesso/);
    await page.check('#browser-save-passwords');
    await page.waitForFunction(()=>__passwords);
    await page.waitForFunction(()=>!document.querySelector('#browser-save-passwords').disabled);
    const folder = resolve(__dirname,'../../.artifact/mcp');mkdirSync(folder,{recursive:true});
    for(const width of [1440,768,390]){
      await page.setViewportSize({width,height:900});
      await page.screenshot({path:resolve(folder,`settings-${width}.png`)});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth),false);
    }
    await page.setViewportSize({width:1440,height:900});
    await page.getByRole('button',{name:'Collega',exact:true}).click();
    await page.waitForFunction(()=>activePanelTab()?.id==='oauth-fixture'&&activePanelTab().page);
    assert.equal(await page.locator('#settings-overlay').isHidden(),true);
    assert.equal(await page.locator('#browser-capture').isDisabled(),true);
    assert.equal(await page.locator('#browser-address').getAttribute('readonly'),'');
    await page.evaluate(()=>__emit('browser-state',{tab_id:'oauth-fixture',url:'https://auth.example/login?secret=never-save',title:'Login',loading:false}));
    assert.equal(await page.evaluate(()=>browserHistory().length),0,'OAuth pages must never enter saved history');
    await page.screenshot({path:resolve(folder,'sign-in-tab.png')});
    await page.click('#browser-external');
    await page.waitForFunction(()=>__calls.some(call=>call.cmd==='open_external_url'));
    assert.deepEqual(await page.evaluate(()=>__calls.filter(call=>call.cmd==='open_external_url').map(call=>call.args.url)),
      ['https://auth.example/authorize?state=private-state'],'System browser restarts from the authorization URL, never the current sign-in page');
    assert.match(await page.locator('#browser-status').innerText(),/browser di sistema/);
    assert.equal(await page.evaluate(()=>browserPage.tabs.some(tab=>tab.id==='oauth-fixture')),true,'The pending sign-in survives the hand-off');
    await page.evaluate(()=>__finish());
    await page.waitForFunction(()=>!browserPage.tabs.some(tab=>tab.id==='oauth-fixture')&&!mcpBusy);
    await settings();
    assert.match(await page.locator('#mcp-feedback').innerText(),/search_screens, search_flows, search_sections/);
    assert.match(await page.locator('#mcp-list').innerText(),/Autorizzazione salvata/);
    await page.screenshot({path:resolve(folder,'connected.png')});
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'Disconnetti',exact:true}).click();
    await page.waitForFunction(()=>!mcpBusy&&!__connected);
    assert.match(await page.locator('#mcp-feedback').innerText(),/Token locali eliminati/);
    await page.getByRole('button',{name:'Collega',exact:true}).click();
    await page.waitForFunction(()=>activePanelTab()?.id==='oauth-fixture'&&activePanelTab().page);
    await page.locator('.panel-tab__close').click();
    await page.waitForFunction(()=>!mcpBusy);
    await settings();
    assert.match(await page.locator('#mcp-error').innerText(),/Accesso annullato/);
    await page.evaluate(()=>window.__failBrowser=true);
    await page.getByRole('button',{name:'Collega',exact:true}).click();
    await page.waitForFunction(()=>!mcpBusy);
    assert.equal(await page.evaluate(()=>browserPage.tabs.some(tab=>tab.oauth)),false,'Failed native tab creation cancels OAuth');
    assert.equal(await page.evaluate(()=>browserHistory().length),0);
    assert.equal(await page.evaluate(()=>__calls.filter(call=>call.cmd==='open_external_url').length),1,'Failed or cancelled sign-ins never open the system browser');
    const connectCount = await page.evaluate(()=>__calls.filter(call=>call.cmd==='mcp_connect').length);
    await page.evaluate(()=>{window.__delayMcp=true;connectMcp('mobbin');});
    await page.waitForFunction(()=>typeof __releaseMcp==='function');
    await page.evaluate(()=>{state.config.firebase_email='other-fixture@example.com';window.__delayMcp=false;__releaseMcp();});
    await page.waitForFunction(()=>!mcpBusy);
    assert.equal(await page.evaluate(()=>__calls.filter(call=>call.cmd==='mcp_connect').length),connectCount,'Account changes abort a queued connect');
    assert.deepEqual(errors,[]);
    console.log('MCP settings, native-tab routing, privacy, cancel, disconnect and password preference passed.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
