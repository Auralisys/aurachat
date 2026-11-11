// Native webviews and Git are mocked. Never launches or interacts with the installed app.
const {chromium} = require('playwright');
const {readFileSync, mkdirSync} = require('node:fs');
const {resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');

(async () => {
  const native=readFileSync(resolve(__dirname,'../src-tauri/src/browser.rs'),'utf8');
  for(const name of ['open','bounds','action','close','capture']) {
    assert.match(native,new RegExp(`#\\[tauri::command\\(rename_all = "snake_case"\\)\\]\\s*pub async fn browser_${name}\\(`),'Native command argument casing must match the JS tab_id contract');
  }
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
    await page.addInitScript(({locales})=>{
      window.__events={};window.__calls=[];window.__pages={};
      const config={firebase_email:'demo@example.com',firebase_auth_set:true,api_key_set:true,models:['demo'],active_model:'demo'};
      const data={conversations:[],projects:['one','two'].map(id=>({
        id,name:`Progetto ${id}`,source_folders:[`C:\\fixture\\${id}`],
        conversations:[{id,title:`Chat ${id}`,created_at:1,updated_at:1,messages:[{role:'user',content:'Controlla il progetto.'}]}]
      }))};
      window.__emit=(name,payload)=>window.__events[name]?.({payload});
      window.__TAURI__={window:{getCurrentWindow:()=>({minimize(){},close(){},async listen(name,fn){const old=window.__events[name];window.__events[name]=event=>{old?.(event);fn(event);};return()=>{};}})},
        core:{invoke:async(cmd,args)=>{
          window.__calls.push({cmd,args:structuredClone(args)});
          if(cmd==='get_locale')return JSON.stringify(locales);
          if(['get_config','get_local_config'].includes(cmd))return config;
          if(['get_data','refresh_data'].includes(cmd))return structuredClone(data);
          if(cmd==='save_data')return args.data;
          if(cmd==='project_permission_mode')return 'auto';
          if(['list_shells','list_approvals','list_questions','project_folder_access'].includes(cmd))return [];
          if(cmd==='speech_model_status')return {ready:false,busy:false};
          if(cmd==='project_git'){
            if(args.action==='discover')return {repositories:[`C:\\fixture\\${args.project_id}`],truncated:false};
            if(args.action==='status')return {branch:'main',revision:'r1',added:3,removed:1,files:[
              {path:'app.js',status:'M ',added:3,removed:1,staged:{added:3,removed:1,binary:false},unstaged:null}
            ]};
            if(args.action==='preview')return {revision:'r1',index_revision:'r1',diff:'+example'};
            throw Error(`Unexpected Git operation: ${args.action}`);
          }
          if(cmd==='browser_open'){
            if(args.url.includes('fail.example'))throw Error('Navigation refused');
            if(args.url.includes('slow.example'))await new Promise(resolve=>window.__releaseOpen=resolve);
            const url=new URL(args.url.includes('://')?args.url:`https://${args.url}`).href;
            __pages[args.tab_id]={url,visible:false,history:[url]};
            __emit('browser-state',{tab_id:args.tab_id,url:url.includes('redirect.example')?'https://final.example/':url,title:new URL(url).hostname,loading:false});
            return {url,capture:false};
          }
          if(cmd==='browser_bounds'){
            if(__pages[args.tab_id])__pages[args.tab_id].visible=args.visible;
          }
          if(cmd==='browser_action')__pages[args.tab_id].history.push(args.action);
          if(cmd==='browser_close'){
            if(window.__failClose){window.__failClose=false;throw Error('Close refused');}
            delete __pages[args.tab_id];
          }
        }}};
    },{locales});
    await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);
    await page.locator('#boot-splash').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Chat one',exact:true}).first().click();
    const tabs=page.locator('#panel-tabs [role=tab]');
    const activeId=()=>page.evaluate(()=>activePanelTab()?.id);
    const calls=cmd=>page.evaluate(cmd=>__calls.filter(call=>call.cmd===cmd),cmd);
    const settle=()=>page.evaluate(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);await browserQueue;});
    const address=page.locator('#browser-address');
    const navigate=async url=>{await address.fill(url);await address.press('Enter');await settle();};
    const select=async id=>{await page.locator(`#panel-tab-${id}`).click();await settle();};
    const shots=resolve(__dirname,'../../.artifact/panel');mkdirSync(shots,{recursive:true});

    assert.equal(await page.locator('.chat-header [data-icon=globe]').count(),0);
    assert.equal(await page.locator('#panel-toggle svg').evaluate(svg=>svg.outerHTML===icon('panelRight').outerHTML),true);
    assert.equal(await page.locator('#activity-toggle svg').evaluate(svg=>svg.outerHTML===icon('summary').outerHTML),true);
    assert.equal(await page.locator('.chat-tools__separator').isVisible(),true);
    const controls=await page.locator('.chat-tools').evaluate(el=>[...el.children].map(node=>node.id||node.className));
    assert.deepEqual(controls,['conversation-options','activity-toggle','chat-tools__separator','panel-toggle']);
    const width=(await page.locator('#messages').boundingBox()).width;
    await page.click('#activity-toggle');
    assert.equal((await page.locator('#messages').boundingBox()).width,width+280);
    await page.click('#activity-toggle');
    await page.screenshot({path:resolve(shots,'summary-1440.png')});
    await page.click('#panel-toggle');
    assert.equal(await tabs.count(),1);
    assert.equal(await page.locator('#activity-dock').isVisible(),true);
    assert.equal(await page.locator('#browser-empty').isVisible(),true);
    assert.equal(await page.locator('#browser-empty [data-panel-tool]').count(),5,'The new tab lists every panel tool');
    await page.waitForFunction(()=>/3/.test(document.querySelector('[data-panel-info="git"]').textContent));
    assert.equal(await page.locator('[data-panel-info="agents"]').innerText(),'Ancora niente');
    assert.equal(await page.locator('#panel-recent-empty').isVisible(),true);
    await page.screenshot({path:resolve(shots,'new-tab-1440.png')});
    await navigate('one.example');
    const first=await activeId();
    await page.click('#panel-add-tab');
    const second=await activeId();
    assert.equal(await page.locator('#panel-recent-list li').count(),1,'Visited pages appear under Recent');
    assert.match(await page.locator('#panel-recent-list').innerText(),/one\.example/);
    assert.equal(await page.locator('#panel-recent-empty').isHidden(),true);
    await page.screenshot({path:resolve(shots,'new-tab-recent-1440.png')});
    await address.fill('two.example');
    await select(first);await select(second);
    assert.equal(await address.inputValue(),'two.example','Unsubmitted address is kept per tab');
    await address.press('Enter');await settle();
    assert.notEqual(first,second);
    assert.deepEqual(await page.evaluate(()=>Object.values(__pages).map(page=>page.visible)),[false,true]);
    await page.evaluate(id=>__emit('browser-state',{tab_id:id,url:'https://one.example/next',title:'First page updated',loading:false}),first);
    assert.equal(await address.inputValue(),'https://two.example/','Inactive page events cannot alter the active address');
    await select(first);await page.click('#browser-back');await settle();
    assert.equal((await calls('browser_action')).at(-1).args.tab_id,first);
    await page.click('#browser-close');await settle();
    assert.equal((await calls('browser_close')).length,0);
    assert.equal(await page.evaluate(()=>Object.values(__pages).every(page=>!page.visible)),true);
    await page.click('#panel-toggle');await settle();
    assert.equal(await activeId(),first);
    assert.equal((await calls('browser_open')).length,2,'Reopening does not navigate or recreate pages');
    await page.click('#activity-toggle');
    assert.equal(await page.locator('#browser-panel').isVisible(),true);
    await page.click('#activity-toggle');
    await page.evaluate(id=>__emit('browser-new-tab',{tab_id:id,url:'https://popup.example/'}),first);
    await page.waitForFunction(()=>browserPage.tabs.length===3&&activePanelTab().page);
    assert.equal(await address.inputValue(),'https://popup.example/');
    await page.evaluate(()=>__emit('browser-state',{tab_id:'closed-tab',url:'https://ignored.example/',loading:false}));
    assert.equal(await tabs.count(),3);

    await page.click('#panel-add-tab');
    await page.click('#panel-open-git');
    await page.waitForFunction(()=>gitView.data?.revision==='r1');
    const git=await activeId();
    assert.equal(await page.locator('#browser-bar').isHidden(),true);
    await settle();
    assert.equal(await page.evaluate(()=>Object.values(__pages).every(page=>!page.visible)),true);
    await page.locator('[data-activity-focus="group:git"]').click();
    assert.equal(await tabs.count(),4,'Git reuses its existing tab');
    await page.locator('#activity-panel').getByRole('button',{name:'Commit…',exact:true}).click();
    await page.locator('#git-message').fill('Bozza da conservare');
    await select(first);await select(git);
    assert.equal(await page.locator('#git-message').inputValue(),'Bozza da conservare');
    await page.click('#panel-expand');
    assert.equal(await page.locator('.main').isHidden(),true);
    await page.click('#panel-expand');
    assert.equal(await page.locator('.main').isVisible(),true);
    await page.locator('#browser-resize').focus();await page.keyboard.press('Home');
    assert.ok((await page.locator('.main').boundingBox()).width>=419,'Resizing keeps the chat readable beside the sidebar');
    await page.getByRole('button',{name:'Chat two',exact:true}).first().click();
    await page.waitForFunction(()=>gitView.root==='C:\\fixture\\two'&&!gitView.loading);
    assert.equal(await tabs.filter({hasText:'Modifiche · Progetto two'}).count(),1);
    assert.equal(await page.locator('#git-message').count(),0,'Commit drafts do not cross projects');
    assert.equal(await page.evaluate(()=>Object.keys(__pages).length),3,'Browser tabs survive conversation switches');
    await page.setViewportSize({width:1001,height:900});
    const summary=await page.locator('#activity-dock').boundingBox(), chat=await page.locator('.main').boundingBox();
    assert.ok(summary.x>=chat.x&&summary.x+summary.width<=chat.x+chat.width,'The summary also fits a narrow split-view column');
    const messages=await page.locator('#messages').boundingBox();
    assert.ok(summary.y+summary.height<=messages.y+1,'Split view stacks the summary without covering the conversation');
    for(const viewportWidth of [1440,768,390]){
      await page.setViewportSize({width:viewportWidth,height:900});
      await settle();
      const selected=await page.locator('.panel-tab.is-active').boundingBox(), strip=await page.locator('#panel-tabs').boundingBox();
      assert.ok(selected.x>=strip.x-1&&selected.x+selected.width<=strip.x+strip.width+1,`Selected tab must fit at ${viewportWidth}px: ${JSON.stringify({selected,strip})}`);
      await page.screenshot({path:resolve(shots,`git-${viewportWidth}.png`)});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
    await page.click('#browser-close');
    assert.equal(await page.locator('.main').isVisible(),true);
    await page.setViewportSize({width:1440,height:900});
    await page.click('#panel-toggle');

    await page.click('#panel-add-tab');await navigate('redirect.example');
    assert.equal(await address.inputValue(),'https://final.example/','An open acknowledgement cannot overwrite a redirect');
    await page.evaluate(()=>window.__failClose=true);
    await page.locator('.panel-tab.is-active .panel-tab__close').click();await settle();
    assert.match(await page.locator('#browser-status').innerText(),/Close refused/);
    assert.equal(await page.locator('.panel-tab.is-active .panel-tab__close').isEnabled(),true,'Failed closes stay recoverable');
    await page.locator('.panel-tab.is-active .panel-tab__close').click();await settle();
    await page.click('#panel-add-tab');
    const slow=await activeId();
    await address.fill('slow.example');await address.press('Enter');
    await page.waitForFunction(()=>window.__releaseOpen);
    await page.locator('.panel-tab.is-active .panel-tab__close').click();
    await page.evaluate(()=>window.__releaseOpen());await settle();
    assert.equal(await page.evaluate(id=>!!__pages[id],slow),false,'Closing while opening cannot orphan a native page');
    await page.click('#panel-add-tab');await navigate('fail.example');
    assert.match(await page.locator('#browser-status').innerText(),/Navigation refused/);
    await navigate('recovered.example');
    assert.equal(await page.locator('#browser-status').isHidden(),true);
    for(let i=0;i<5;i++)await page.click('#panel-add-tab');
    assert.equal(await page.locator('#panel-tabs').evaluate(el=>el.scrollWidth>el.clientWidth),true);
    await page.locator('.panel-tab.is-active [role=tab]').focus();await page.keyboard.press('Home');
    assert.equal(await activeId(),first);
    await page.keyboard.press('End');
    const before=await tabs.count();
    await page.keyboard.press('Delete');await settle();
    assert.equal(await tabs.count(),before-1);
    assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('role')),'tab');
    await page.keyboard.press('Control+Shift+KeyA');await settle();
    assert.equal(await page.evaluate(()=>activePanelTab().section),'agents','Ctrl+Shift+A opens Subagents');
    assert.match(await page.locator('#activity-panel-content').innerText(),/Nessun subagente al lavoro/);
    await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'O',code:'',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})));await settle();
    assert.equal(await page.evaluate(()=>activePanelTab().section),'outputs','shortcuts work when input has no physical key code');
    await page.evaluate(()=>{state.config.firebase_auth_set=false;renderActivity();});await settle();
    assert.equal(await tabs.count(),0);
    assert.equal(await page.evaluate(()=>Object.keys(__pages).length),0);
    assert.equal(await page.locator('#browser-panel').isHidden(),true);
    await page.evaluate(()=>{state.config.firebase_auth_set=true;renderActivity();});
    await page.click('#panel-toggle');
    await page.locator('.panel-tab.is-active .panel-tab__close').click();await settle();
    assert.equal(await tabs.count(),0);
    assert.equal(await page.locator('#panel-toggle').getAttribute('aria-expanded'),'false');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'panel-toggle','Closing the last tab returns focus to the panel control');
    assert.deepEqual(errors,[]);
    console.log('PASS summary/header controls, multi-tab lifecycle, native isolation, drafts, Git context, resize, keyboard, races and logout.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
