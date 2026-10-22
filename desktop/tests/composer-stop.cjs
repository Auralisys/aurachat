// Composer durante un turno: nome immediato della chat, stop, invio in coda e dettatura.
const {chromium}=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
  await page.addInitScript(({locales})=>{
    window.__data={projects:[],conversations:[]};window.__calls=[];window.__runs={};window.__events={};
    const config={firebase_auth_set:true,api_key_set:true,models:['demo'],active_model:'demo'};
    const conversation=id=>window.__data.conversations.find(c=>c.id===id);
    window.__TAURI__={window:{getCurrentWindow:()=>({async listen(name,callback){window.__events[name]=callback;return()=>{};},minimize(){},close(){}})},core:{invoke:async(cmd,args)=>{
      window.__calls.push({cmd,args});
      if(cmd==='get_locale')return JSON.stringify(locales);
      if(['get_config','get_local_config'].includes(cmd))return config;
      if(cmd==='speech_model_status')return {ready:true,busy:false,loading:false,loaded:true,downloaded:1,total:1};
      if(cmd==='get_data')return structuredClone(window.__data);
      if(cmd==='save_data'){window.__data=structuredClone(args.data);return structuredClone(window.__data);}
      if(cmd==='chat'){
        const id=args.conversation_id;
        conversation(id).messages.push({role:'user',content:args.content});
        return new Promise(resolveRun=>{window.__runs[id]={args,finish(reply,cancelled){
          const target=conversation(id);
          if(reply)target.messages.push({role:'assistant',content:reply});
          target.updated_at=Date.now();
          resolveRun({cancelled:!!cancelled,data:structuredClone(window.__data),messages:structuredClone(target.messages),usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}});
        }};});
      }
      // Lo stop reale chiude lo stream con la parte di risposta gia mostrata.
      if(cmd==='stop_chat'){window.__runs[args.conversation_id]?.finish('Risposta parziale',true);return;}
    }}};
  },{locales});
  await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);await page.locator('#boot-splash').waitFor({state:'hidden'});
  const chatCalls=()=>page.evaluate(()=>window.__calls.filter(c=>c.cmd==='chat').length);

  await page.click('#btn-new-chat');
  await page.fill('#composer-input','Prima domanda');await page.click('#composer-send');
  await page.waitForFunction(()=>Object.keys(window.__runs).length===1);
  const id=await page.evaluate(()=>Object.keys(window.__runs)[0]);
  // Il nome della chat arriva con il primo messaggio, prima della risposta.
  assert.equal(await page.locator('#conversation-title').textContent(),'Prima domanda');
  assert.equal(await page.locator(`#recent-chats [data-conversation-id="${id}"] .tree-conv__title`).textContent(),'Prima domanda');
  // Turno in corso, composer vuoto: solo Stop. La dettatura resta disponibile.
  assert.equal(await page.locator('#composer-stop').isVisible(),true);
  assert.equal(await page.locator('#composer-send').isVisible(),false);
  assert.equal(await page.locator('#composer-mic').isEnabled(),true);

  // Con un messaggio scritto si vedono Stop e Invia: l'invio va in coda.
  await page.fill('#composer-input','Seconda domanda');
  assert.equal(await page.locator('#composer-send').isVisible(),true);
  assert.equal(await page.locator('#composer-stop').isVisible(),true);
  await page.click('#composer-send');
  assert.equal(await page.locator('#composer-input').inputValue(),'');
  assert.equal(await page.locator('#composer-status').textContent(),locales['chat.queued']);
  assert.equal(await chatCalls(),1);
  assert.equal(await page.locator('#composer-send').isVisible(),false);
  assert.equal(await page.locator('#composer-stop').isVisible(),true);
  const queued=page.locator('.msg--queued');
  await queued.getByText('Seconda domanda',{exact:true}).waitFor();
  assert.equal(await queued.getByText('In coda',{exact:true}).isVisible(),true);
  const queueAction=async name=>{
    await queued.getByRole('button',{name:'Azioni messaggio in coda',exact:true}).click();
    await page.locator('#tree-menu').getByRole('menuitem',{name,exact:true}).click();
  };
  await queued.getByRole('button',{name:'Azioni messaggio in coda',exact:true}).click();
  for(const name of ['Invia subito','Modifica','Cancella']) assert.equal(await page.locator('#tree-menu').getByRole('menuitem',{name,exact:true}).isVisible(),true);
  const menuPosition=await page.locator('#tree-menu').boundingBox();
  await page.evaluate(async()=>{
    for(let i=0;i<15;i++){
      window.__events['chat-progress']({payload:{conversation_id:state.activeConversationId,kind:'__delta',text:`\n\nStreaming ${i}: ${'testo '.repeat(30)}`}});
      await new Promise(resolve=>setTimeout(resolve,45));
    }
    document.querySelector('#messages').dispatchEvent(new Event('scroll'));
  });
  assert.equal(await page.locator('#tree-menu').isVisible(),true,'Streaming must not dismiss the queued-message menu');
  assert.deepEqual(await page.locator('#tree-menu').boundingBox(),menuPosition,'Streaming must not move the action menu');
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('.msg--stream').textContent.includes('Streaming 14'));
  assert.equal(await queued.locator('.msg__text').evaluate(el=>getComputedStyle(el).borderTopStyle),'dashed');
  const shots=resolve(__dirname,'../../.artifact/sidebar-composer');mkdirSync(shots,{recursive:true});
  await page.evaluate(()=>{activity.visible=false;renderActivity();});
  await page.screenshot({path:resolve(shots,'queued-desktop.png')});
  await page.setViewportSize({width:720,height:680});
  await page.screenshot({path:resolve(shots,'queued-compact.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await queueAction('Modifica');
  assert.equal(await queued.count(),0);
  assert.equal(await page.locator('#composer-input').inputValue(),'Seconda domanda');
  await page.click('#composer-send');
  await queueAction('Cancella');
  assert.equal(await queued.count(),0);
  assert.equal(await chatCalls(),1);
  await page.fill('#composer-input','Seconda domanda');await page.click('#composer-send');

  // Stop: il turno si chiude con la risposta parziale e parte il messaggio accodato.
  await page.click('#composer-stop');
  await page.waitForFunction(()=>window.__calls.some(c=>c.cmd==='stop_chat'));
  await page.waitForFunction(()=>window.__calls.filter(c=>c.cmd==='chat').length===2);
  assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='chat')[1].args.content),'Seconda domanda');
  await page.locator('#messages').getByText('Risposta parziale',{exact:true}).waitFor();
  await page.screenshot({path:resolve(shots,'stop-e-coda.png')});

  await page.evaluate(()=>window.__runs[Object.keys(window.__runs)[0]].finish('Risposta finale'));
  await page.locator('#messages').getByText('Risposta finale',{exact:true}).waitFor();
  await page.waitForFunction(()=>!state.busy);
  assert.equal(await page.locator('#composer-stop').isVisible(),false);

  // Stop con composer vuoto: resta la parte gia mostrata e lo stato lo dice.
  await page.fill('#composer-input','Terza domanda');await page.click('#composer-send');
  await page.waitForFunction(()=>window.__calls.filter(c=>c.cmd==='chat').length===3);
  await page.click('#composer-stop');
  await page.waitForFunction(()=>!state.busy);
  assert.match(await page.locator('#composer-status').textContent(),new RegExp(locales['chat.stopped'].replace('.','\\.')));
  assert.equal(await chatCalls(),3);
  assert.equal(await page.locator('#composer-stop').isVisible(),false);
  assert.equal(await page.locator('#composer-send').isVisible(),true);
  // Immediate send steers the running turn rather than launching a parallel request.
  await page.fill('#composer-input','Quarta domanda');await page.click('#composer-send');
  await page.waitForFunction(()=>window.__calls.filter(c=>c.cmd==='chat').length===4);
  await page.fill('#composer-input','Indicazione immediata');await page.click('#composer-send');
  await queueAction('Invia subito');
  await page.waitForFunction(()=>window.__calls.some(c=>c.cmd==='steer_chat'));
  assert.equal(await chatCalls(),4);
  assert.equal(await queued.count(),0);
  assert.equal(await page.evaluate(()=>window.__calls.find(c=>c.cmd==='steer_chat').args.content),'Indicazione immediata');
  await page.evaluate(()=>window.__events['chat-progress']({payload:{conversation_id:state.activeConversationId,kind:'__steering',text:JSON.stringify({role:'user',content:'Indicazione immediata',attachments:[]})}}));
  await page.locator('#messages .msg--user:not(.msg--queued)').getByText('Indicazione immediata',{exact:true}).waitFor();
  assert.notEqual(await page.locator('#composer-status').textContent(),locales['chat.queued']);
  await page.evaluate(()=>window.__runs[Object.keys(window.__runs)[0]].finish('Fine'));
  await page.waitForFunction(()=>!state.busy);
  assert.deepEqual(errors,[]);await browser.close();
  console.log('PASS: immediate queued balloon with label and actions menu, dashed border, edit/delete/send-now, desktop/compact layout, chat title, stop, FIFO queue and dictation while thinking.');
})().catch(e=>{console.error(e);process.exit(1);});
