const {chromium}=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
  await page.addInitScript(({locales})=>{
    const chat=(id,title,updated_at)=>({id,title,created_at:1,updated_at,context_tokens:0,messages:[],messages_loaded:true,revision:'r0'});
    window.__data={projects:[],conversations:[chat('a','Ricerca A',3),chat('b','Chat B',2)]};window.__pending={};window.__calls=[];window.__events={};
    const config={firebase_auth_set:true,api_key_set:true,models:['demo'],active_model:'demo'};
    window.__TAURI__={window:{getCurrentWindow:()=>({async listen(name,fn){window.__events[name]=fn;return()=>{};}})},core:{invoke:async(cmd,args)=>{
      window.__calls.push({cmd,args});
      if(cmd==='get_locale')return JSON.stringify(locales);
      if(['get_config','get_local_config'].includes(cmd))return config;
      if(['get_data','refresh_data'].includes(cmd))return structuredClone(window.__data);
      if(cmd==='get_conversation')return structuredClone(window.__data.conversations.find(c=>c.id===args.conversation_id));
      if(cmd==='remote_chat_snapshot')return window.__remoteSnapshot || null;
      if(cmd==='remote_chat_inbox')return {approvals:[],questions:[]};
      if(cmd==='save_data'){window.__data=structuredClone(args.data);return structuredClone(window.__data);}
      if(cmd==='list_shells')return [];
      if(cmd==='chat'){
        const responseData=structuredClone(window.__data);
        return new Promise((resolve,reject)=>window.__pending[args.conversation_id]={args,reject,finish(text){
          const conv=responseData.conversations.find(c=>c.id===args.conversation_id);
          conv.messages.push({role:'user',content:args.content},{role:'assistant',content:text});conv.updated_at=Date.now();conv.revision='r'+conv.updated_at;conv.title=args.content;
          const stored=window.__data.conversations.find(c=>c.id===conv.id);Object.assign(stored,structuredClone(conv));
          resolve({data:responseData,messages:conv.messages,usage:{total_tokens:12}});
        }});
      }
    }}};
  },{locales});
  await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);await page.locator('#boot-splash').waitFor({state:'hidden'});
  const row=id=>page.locator(`#recent-chats [data-conversation-id="${id}"]`);
  await row('a').locator('.tree-conv__title').click();
  await page.fill('#composer-input','Prima ricerca');await page.click('#composer-send');await row('a').locator('.tree-conv__spinner').waitFor();
  assert.equal(await page.locator('#loader,.loader').count(),0);
  await row('b').locator('.tree-conv__title').click();
  assert.equal(await page.locator('#composer-send').isEnabled(),true);
  await page.fill('#composer-input','Bozza di B');
  await row('a').locator('.tree-conv__title').click();assert.match(await page.locator('#messages').innerText(),/Prima ricerca/);
  assert.equal(await page.locator('#composer-stop').isVisible(),true);
  assert.equal(await page.locator('#composer-send').isVisible(),false);
  await page.click('#menu-file');assert.equal(await page.getByRole('menuitem',{name:'Nuova chat',exact:true}).isEnabled(),true);await page.keyboard.press('Escape');
  await row('b').locator('.tree-conv__title').click();assert.equal(await page.locator('#composer-input').textContent(),'Bozza di B');
  await page.click('#btn-new-chat');assert.equal(await page.locator('#composer-input').textContent(),'');
  await page.fill('#composer-input','Ricerca C');await page.click('#composer-send');
  await page.waitForFunction(()=>Object.keys(window.__pending).length===2);
  const c=await page.evaluate(()=>Object.keys(window.__pending).find(id=>id!=='a'));
  assert.equal(await page.locator('.tree-conv__spinner').count(),2);
  await row('b').locator('.tree-conv__title').click();await page.locator('#composer-input').focus();
  await page.evaluate(id=>window.__pending[id].finish('Risposta C'),c);await row(c).locator('.tree-conv__unread').waitFor();
  await page.evaluate(()=>window.__pending.a.finish('Risposta A'));await row('a').locator('.tree-conv__unread').waitFor();
  assert.equal(await page.locator('.tree-conv__spinner').count(),0);
  assert.equal(await page.locator('#composer-input').textContent(),'Bozza di B');assert.equal(await page.locator('#composer-input').evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.locator('#messages').getByText('Risposta A',{exact:true}).count(),0);
  assert.equal(await row(c).count(),1,'An older background response must not remove newer chats');
  const shots=resolve(__dirname,'../../.artifact/background-chats');mkdirSync(shots,{recursive:true});await page.screenshot({path:resolve(shots,'unread-completions.png')});
  await row('a').locator('.tree-conv__title').click();assert.equal(await row('a').locator('.tree-conv__unread').count(),0);assert.match(await page.locator('#messages').innerText(),/Risposta A/);
  assert.equal(await row(c).locator('.tree-conv__unread').count(),1);
  await row(c).locator('.tree-conv__title').click();assert.match(await page.locator('#messages').innerText(),/Risposta C/);assert.equal(await row(c).locator('.tree-conv__unread').count(),0);
  await row('a').locator('.tree-conv__title').click();await page.fill('#composer-input','Richiesta fallita');await page.click('#composer-send');
  await row('a').locator('.tree-conv__spinner').waitFor();await row('b').locator('.tree-conv__title').click();
  await page.evaluate(()=>{
    window.__events['chat-progress']({payload:{conversation_id:'a',kind:'__delta',text:'Risposta interrotta da conservare'}});
    window.__pending.a.reject(new Error('Background failure'));
  });await row('a').locator('.tree-conv__unread').waitFor();
  assert.equal(await page.locator('#messages .msg--error').count(),0);
  await row('a').locator('.tree-conv__title').click();await page.locator('.msg--error').waitFor();assert.match(await page.locator('.msg--error').innerText(),/Background failure/);
  await page.locator('#messages').getByText('Risposta interrotta da conservare',{exact:true}).waitFor();
  assert.equal(await page.locator('.msg--error').getByRole('button',{name:locales['chat.retry'],exact:true}).isVisible(),true);
  assert.equal(await row('a').locator('.tree-conv__unread').count(),0);
  await page.evaluate(async()=>{
    state.config.firebase_email='test@example.com';
    state.runs.get('a').remote=true;
    window.__remoteSnapshot={device_id:'test-pc',status:'failed',turn_id:'test-turn',started_at:Date.now()};
    await refreshRemoteTurn('a');
  });
  assert.equal(await page.locator('.msg--error').count(),1,'A terminal remote snapshot must not erase the request failure');
  await row('b').locator('.tree-conv__title').click();
  await row('a').locator('.tree-conv__title').click();
  assert.equal(await page.locator('.msg--error').count(),1,'Leaving a failed remote turn retains its error');
  await page.evaluate(()=>{
    state.config.firebase_email='';state.runs.get('a').remote=false;
    window.__remoteSnapshot=null;remoteTurnSync.targets.clear();
  });
  await page.evaluate(async()=>{await window.__events['companion-updated']({payload:{conversation_id:'b'}});});
  assert.equal(await page.locator('.msg--error').count(),1,'Refreshing another chat must not erase the failure');
  await page.evaluate(async()=>{
    const saved=window.__data.conversations.find(c=>c.id==='a');
    saved.messages=state.runs.get('a').messages.filter(m=>m.role!=='error');
    saved.revision='partial';saved.updated_at=Date.now();
    await openConversation('a');
  });
  assert.equal(await page.locator('.msg--error').count(),1,'A saved partial turn retains its error without duplicating text');
  assert.equal(await page.locator('#messages').getByText('Risposta interrotta da conservare',{exact:true}).count(),1);
  // A genuinely newer history supersedes the failed attempt and its retry action.
  await page.evaluate(async()=>{
    const saved=window.__data.conversations.find(c=>c.id==='a');
    saved.messages.push({role:'user',content:'Continuazione da un altro computer'},{role:'assistant',content:'Nuova risposta remota'});
    saved.revision='newer';saved.updated_at=Date.now()+1;
    await openConversation('a');
  });
  await page.locator('#messages').getByText('Nuova risposta remota',{exact:true}).waitFor();
  assert.equal(await page.locator('.msg--error').count(),0);
  assert.equal(await page.evaluate(()=>state.failedSend),null);
  // FIFO can start a turn off screen: its user message must be visible on return.
  await row('b').locator('.tree-conv__title').click();
  await page.evaluate(()=>{state.queues.set('a',[{content:'Domanda accodata in background',attachments:[]}]);flushQueue('a');});
  await row('a').locator('.tree-conv__spinner').waitFor();
  await row('a').locator('.tree-conv__title').click();
  await page.locator('#messages .msg--user').getByText('Domanda accodata in background',{exact:true}).waitFor();
  await page.evaluate(()=>window.__pending.a.finish('Risposta alla coda'));
  await page.locator('#messages').getByText('Risposta alla coda',{exact:true}).waitFor();
  await page.evaluate(async()=>{await window.__events['companion-started']({payload:{conversation_id:'b',content:'Richiesta Android'}});});
  await row('b').locator('.tree-conv__spinner').waitFor();
  await page.evaluate(async()=>{
    const conv=window.__data.conversations.find(c=>c.id==='b');
    Object.assign(conv,{messages_loaded:true,messages:[{role:'user',content:'Richiesta Android'},{role:'assistant',content:'Risposta remota verificata'}]});
    await window.__events['companion-updated']({payload:{conversation_id:'b'}});
  });
  await row('b').locator('.tree-conv__unread').waitFor();
  assert.equal(await row('b').locator('.tree-conv__spinner').count(),0);
  await row('b').locator('.tree-conv__title').click();
  assert.match(await page.locator('#messages').innerText(),/Risposta remota verificata/);
  assert.deepEqual(errors,[]);await browser.close();console.log('PASS: concurrent chats, background failures, drafts/focus, and remote Android activity/completion reconciliation.');
})().catch(e=>{console.error(e);process.exit(1);});
