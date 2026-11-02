// Guida in attesa: resta sopra il composer, si modifica o si annulla finche il modello non la legge.
const {chromium}=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
  await page.addInitScript(({locales})=>{
    window.__data={projects:[],conversations:[]};window.__calls=[];window.__runs={};window.__events={};window.__guideSeq=0;window.__guides={};window.__read=new Set();
    const config={firebase_auth_set:true,api_key_set:true,models:['demo'],active_model:'demo'};
    const conversation=id=>window.__data.conversations.find(c=>c.id===id);
    window.__TAURI__={window:{getCurrentWindow:()=>({async listen(name,callback){window.__events[name]=callback;return()=>{};},minimize(){},close(){}})},core:{invoke:async(cmd,args)=>{
      window.__calls.push({cmd,args});
      if(cmd==='get_locale')return JSON.stringify(locales);
      if(['get_config','get_local_config'].includes(cmd))return config;
      if(cmd==='speech_model_status')return {ready:true,busy:false,loading:false,loaded:true,downloaded:1,total:1};
      if(['get_data','refresh_data'].includes(cmd))return structuredClone(window.__data);
      if(cmd==='list_shells')return [];if(cmd==='get_conversation')return {...structuredClone(conversation(args.conversation_id)),messages_loaded:true};if(cmd==='save_data'){window.__data=structuredClone(args.data);return structuredClone(window.__data);}
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
      // Il nativo annuncia la guida accettata prima di rispondere, come fa sotto il lock.
      if(cmd==='steer_chat'){
        const id='g'+(++window.__guideSeq);window.__guides[id]=args.content;
        window.__events['chat-progress']({payload:{conversation_id:args.conversation_id,kind:'__guidance_queued',text:JSON.stringify({id,role:'user',content:args.content,attachments:args.attachments||[]})}});
        return {id};
      }
      if(cmd==='withdraw_guidance'){
        if(window.__read.has(args.guidance_id))throw 'guidance_consumed';
        window.__events['chat-progress']({payload:{conversation_id:args.conversation_id,kind:'__guidance_withdrawn',text:JSON.stringify({id:args.guidance_id})}});
        return {role:'user',content:window.__guides[args.guidance_id],attachments:[]};
      }
    }}};
  },{locales});
  await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);await page.locator('#boot-splash').waitFor({state:'hidden'});
  const progress=(kind,text)=>page.evaluate(([kind,text])=>window.__events['chat-progress']({payload:{conversation_id:state.activeConversationId,kind,text}}),[kind,text]);
  const calls=cmd=>page.evaluate(cmd=>window.__calls.filter(c=>c.cmd===cmd).map(c=>c.args),cmd);
  const pending=page.locator('.msg--guide-pending');
  const lastRow=()=>page.evaluate(()=>[...document.querySelectorAll('#messages .msg')].at(-1)?.className||'');
  const openMenu=async()=>{await pending.getByRole('button',{name:'Azioni messaggio in coda',exact:true}).click();return page.locator('#tree-menu');};
  const steer=async text=>{
    await page.fill('#composer-input',text);await page.click('#composer-send');
    const queued=page.locator('.msg--queued:not(.msg--guide-pending)');await queued.waitFor();
    await queued.getByRole('button',{name:'Azioni messaggio in coda',exact:true}).click();
    await page.locator('#tree-menu').getByRole('menuitem',{name:'Invia subito',exact:true}).click();
    await pending.filter({hasText:text}).waitFor();
  };

  await page.click('#btn-new-chat');
  await page.fill('#composer-input','Prima domanda');await page.click('#composer-send');
  await page.waitForFunction(()=>Object.keys(window.__runs).length===1);
  await progress('__reasoning','Sto pensando');

  // La guida accettata resta in fondo, etichettata e azionabile mentre il modello ragiona.
  await steer('Guida X');
  await progress('__reasoning',' ancora');
  assert.equal(await pending.count(),1);
  assert.match(await pending.textContent(),/Guida · in attesa/);
  assert.match(await lastRow(),/msg--guide-pending/);
  let menu=await openMenu();
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(),['Modifica','Annulla invio']);

  // Annulla invio: ritirata nel nativo, sparisce e non entra in cronologia.
  await menu.getByRole('menuitem',{name:'Annulla invio',exact:true}).click();
  await pending.waitFor({state:'detached'});
  assert.deepEqual(await calls('withdraw_guidance'),[{conversation_id:await page.evaluate(()=>state.activeConversationId),guidance_id:'g1'}]);
  assert.equal(await page.locator('#messages').getByText('Guida X').count(),0);

  // Modifica: torna nel composer e il nuovo invio va dritto al turno come guida.
  await steer('Guida Y');
  menu=await openMenu();await menu.getByRole('menuitem',{name:'Modifica',exact:true}).click();
  await pending.waitFor({state:'detached'});
  assert.equal((await page.locator('#composer-input').textContent()).trim(),'Guida Y');
  assert.match(await page.locator('#composer-status').textContent(),/Modifica la guida/);
  await page.fill('#composer-input','Guida Y corretta');await page.click('#composer-send');
  await pending.filter({hasText:'Guida Y corretta'}).waitFor();
  assert.deepEqual((await calls('steer_chat')).map(a=>a.content),['Guida X','Guida Y','Guida Y corretta']);
  assert.equal(await page.locator('.msg--queued:not(.msg--guide-pending)').count(),0);

  // Letta dal modello: lascia il fondo ed entra in cronologia, non piu modificabile.
  await progress('__steering',JSON.stringify({role:'user',content:'Guida Y corretta',attachments:[],guidance_id:'g3'}));
  await pending.waitFor({state:'detached'});
  const read=page.locator('#messages .msg').filter({hasText:'Guida Y corretta'});
  assert.equal(await read.count(),1);
  assert.equal(await read.locator('.msg__queue-meta').count(),0);

  // Una guida mandata dal telefono compare uguale; se il modello la legge prima del ritiro lo dice.
  await progress('__guidance_queued',JSON.stringify({id:'m1',role:'user',content:'Dal telefono',attachments:[]}));
  await pending.filter({hasText:'Dal telefono'}).waitFor();
  await page.evaluate(()=>window.__read.add('m1'));
  menu=await openMenu();await menu.getByRole('menuitem',{name:'Annulla invio',exact:true}).click();
  await page.waitForFunction(()=>/già letto la guida/.test(document.querySelector('#composer-status').textContent));
  await progress('__steering',JSON.stringify({role:'user',content:'Dal telefono',attachments:[],guidance_id:'m1'}));
  await pending.waitFor({state:'detached'});
  assert.equal(await page.locator('#messages .msg').filter({hasText:'Dal telefono'}).count(),1);

  // Turno remoto: la lista pubblicata dal computer che esegue governa le guide in attesa.
  const remote=await page.evaluate(()=>{
    const run={pendingGuidance:[{message:{role:'user',content:'Locale',attachments:[]},accepted:false,consumed:false}]};
    syncRemoteGuidance(run,[{id:'r1',content:'Locale'},{id:'r2',content:'Altro'}]);
    const first=run.pendingGuidance.map(p=>[p.id,p.message.content,!!p.external]);
    syncRemoteGuidance(run,[{id:'r2',content:'Altro'}]);
    dropPendingGuidance(run,'r2');
    syncRemoteGuidance(run,[{id:'r2',content:'Altro'}]);
    return {first,after:run.pendingGuidance.map(p=>p.id)};
  });
  assert.deepEqual(remote,{first:[['r1','Locale',false],['r2','Altro',true]],after:[]});

  const id=await page.evaluate(()=>state.activeConversationId);
  await page.evaluate(id=>window.__runs[id].finish('Fatto'),id);
  await page.locator('#messages').getByText('Fatto').waitFor();
  assert.equal(await pending.count(),0);
  assert.deepEqual(errors,[]);
  console.log('pending guidance ok');
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});