const {chromium}=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
  await page.addInitScript(({locales})=>{
    const chat=(id,title,updated_at)=>({id,title,created_at:1795172400000,updated_at,context_tokens:0,messages:[],messages_loaded:true,revision:'r0'});
    window.__data={projects:[],conversations:[chat('a','Ricerca A',3),chat('b','Chat B',2)]};window.__pending={};window.__calls=[];window.__events={};
    const conversation=(data,id)=>[...data.conversations,...data.projects.flatMap(project=>project.conversations)].find(c=>c.id===id);
    const config={firebase_auth_set:true,api_key_set:true,models:['demo'],active_model:'demo'};
    window.__TAURI__={window:{getCurrentWindow:()=>({async listen(name,fn){window.__events[name]=fn;return()=>{};}})},core:{invoke:async(cmd,args)=>{
      window.__calls.push({cmd,args});
      if(cmd==='get_locale')return JSON.stringify(locales);
      if(['get_config','get_local_config'].includes(cmd))return config;
      if(['get_data','refresh_data'].includes(cmd))return structuredClone(window.__data);
      if(cmd==='get_conversation'){
        if(window.__failLoad===args.conversation_id)throw new Error('History temporarily unavailable');
        return {...structuredClone(conversation(window.__data,args.conversation_id)),messages_loaded:true};
      }
      if(cmd==='project_folder_access'){
        if(window.__holdAccess){window.__holdAccess=false;return new Promise((resolve,reject)=>window.__access={resolve,reject});}
        return window.__grantedFolders || [];
      }
      if(cmd==='choose_project_folder')return null;
      if(cmd==='remote_chat_snapshot'){
        if(window.__holdSnapshot===args.conversation_id){
          window.__holdSnapshot=null;
          return new Promise((resolve,reject)=>window.__snapshot={resolve,reject});
        }
        return window.__remoteSnapshots?.[args.conversation_id] || window.__remoteSnapshot || null;
      }
      if(cmd==='remote_chat_inbox')return {approvals:[],questions:[]};
      if(cmd==='save_data'){window.__data=structuredClone(args.data);return structuredClone(window.__data);}
      if(cmd==='list_shells')return [];
      if(cmd==='chat'){
        const responseData=structuredClone(window.__data);
        return new Promise((resolve,reject)=>window.__pending[args.conversation_id]={args,reject,finish(text,cancelled=false){
          const conv=conversation(responseData,args.conversation_id);
          conv.messages.push({role:'user',content:args.content},{role:'assistant',content:text});conv.updated_at=Date.now();conv.revision='r'+conv.updated_at;conv.title=args.content;
          const stored=conversation(window.__data,conv.id);Object.assign(stored,structuredClone(conv));
          resolve({data:responseData,messages:conv.messages,usage:{total_tokens:12},cancelled});
        }});
      }
    }}};
  },{locales});
  await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);await page.locator('#boot-splash').waitFor({state:'hidden'});
  const row=id=>page.locator(`#recent-chats [data-conversation-id="${id}"]`);
  const shots=resolve(__dirname,'../../.artifact/background-chats');mkdirSync(shots,{recursive:true});
  const peek=page.locator('#project-preview'),badge=peek.locator('.chat-preview__status');
  const preview=async id=>{
    await page.mouse.move(8,8);
    if (!await page.locator('#sidebar').isVisible()) await page.click('#sidebar-collapse');
    await row(id).locator('.tree-conv__title').hover();await peek.waitFor({state:'visible'});
  };
  const captureStatus=async name=>{
    const bounds=await peek.boundingBox();
    await page.screenshot({path:resolve(shots,name),clip:{x:52,y:Math.max(44,bounds.y-48),width:560,height:bounds.height+64}});
    const contrast=await badge.evaluate(el=>{
      const context=document.createElement('canvas').getContext('2d',{willReadFrequently:true}),style=getComputedStyle(el);
      context.fillStyle=getComputedStyle(el.closest('#project-preview')).backgroundColor;context.fillRect(0,0,1,1);
      context.fillStyle=style.backgroundColor;context.fillRect(0,0,1,1);
      const background=context.getImageData(0,0,1,1).data;
      context.fillStyle=style.color;context.fillRect(0,0,1,1);
      const foreground=context.getImageData(0,0,1,1).data;
      const luminance=color=>[...color].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const a=luminance(foreground),b=luminance(background);
      return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    });
    assert.ok(contrast>=4.5,`Status text contrast must reach 4.5:1, got ${contrast}`);
    for (const width of [768,390]) {
      await page.setViewportSize({width,height:844});await preview('a');
      const panel=await peek.boundingBox();
      assert.ok(panel.x>=0 && panel.x+panel.width<=width,'The preview must stay inside the window');
      assert.equal(await badge.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:resolve(shots,name.replace('.png',`-${width}.png`))});
    }
    await page.setViewportSize({width:1400,height:900});await preview('a');
  };
  await row('a').locator('.tree-conv__title').click();
  await page.fill('#composer-input','Prima ricerca');
  await page.evaluate(()=>{window.__holdSnapshot='a';window.__sendStarted=performance.now();document.querySelector('#composer-send').click();});
  await page.waitForFunction(()=>!!window.__snapshot);
  const preparing=await page.evaluate(()=>({
    visible:document.querySelector('#messages').textContent.includes('Prima ricerca'),
    elapsed:performance.now()-window.__sendStarted,
    globalLock:state.preparing,
    requests:window.__calls.filter(call=>call.cmd==='chat').length
  }));
  console.log('Send while remote discovery is pending:',preparing);
  assert.equal(preparing.visible,true,'The user bubble must render before remote discovery completes');
  assert.equal(preparing.globalLock,false,'Preparation must not lock navigation or other chats');
  assert.equal(preparing.requests,0,'The model must wait for routing checks');
  await row('b').locator('.tree-conv__title').click();
  await page.fill('#composer-input','Bozza durante la preparazione di A');
  await row('a').locator('.tree-conv__title').click();
  await page.locator('#messages .msg--queued').getByText('Prima ricerca',{exact:true}).waitFor();
  assert.equal(await page.locator('.msg__state').textContent(),locales['queue.preparing']);
  await page.screenshot({path:resolve(shots,'preparing-desktop.png')});
  await page.setViewportSize({width:720,height:680});
  await page.screenshot({path:resolve(shots,'preparing-compact.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:1400,height:900});
  await page.evaluate(()=>window.__snapshot.resolve(null));
  await row('a').locator('.tree-conv__spinner').waitFor();
  assert.equal(await row('a').getAttribute('data-chat-status'),'running');
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
  await page.evaluate(()=>window.__events['approval-activity']({payload:{id:'status-approval',conversation_id:'a',status:'pending',revision:1,action:{kind:'command',program:'git',arguments:['status']}}}));
  await row('a').locator('.is-waiting').waitFor();await preview('a');
  assert.equal(await badge.textContent(),locales['sidebar.chat_waiting']);
  assert.equal(await badge.getAttribute('title'),locales['permissions.waiting']);
  await page.evaluate(()=>window.__events['approval-activity']({payload:{id:'status-approval',conversation_id:'a',status:'approved',revision:2}}));
  await row('a').locator('.is-waiting').waitFor({state:'detached'});
  await page.locator('#composer-input').focus();
  await page.evaluate(id=>window.__pending[id].finish('Risposta C'),c);await row(c).locator('.tree-conv__unread').waitFor();
  await page.evaluate(()=>window.__pending.a.finish('Risposta A'));await row('a').locator('.tree-conv__unread').waitFor();
  assert.equal(await page.locator('.tree-conv__spinner').count(),0);
  assert.equal(await page.locator('#composer-input').textContent(),'Bozza di B');assert.equal(await page.locator('#composer-input').evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.locator('#messages').getByText('Risposta A',{exact:true}).count(),0);
  assert.equal(await row(c).count(),1,'An older background response must not remove newer chats');
  await page.screenshot({path:resolve(shots,'unread-completions.png')});
  assert.equal(await row('a').getAttribute('data-chat-status'),'done');
  await preview('a');
  assert.equal(await badge.textContent(),locales['sidebar.chat_done']);
  assert.equal(await row('a').locator('.chat-mark > .tree-conv__unread').count(),1,'The unread indicator occupies the leading status slot');
  assert.equal(await page.evaluate(()=>state.unread.has('a')),true,'A preview is not a read receipt');
  await captureStatus('status-done.png');
  await row('a').locator('.tree-conv__title').click();assert.equal(await row('a').locator('.tree-conv__unread').count(),0);assert.match(await page.locator('#messages').innerText(),/Risposta A/);
  assert.equal(await row('a').getAttribute('data-chat-status'),'idle');
  await preview('a');assert.equal(await badge.textContent(),locales['sidebar.chat_idle']);
  await captureStatus('status-idle.png');
  assert.equal(await row(c).locator('.tree-conv__unread').count(),1);
  // Opening a chat is not enough if its history failed to load.
  await page.evaluate(id=>{findConversation(id).conversation.messages_loaded=false;state.preloaded.delete(id);window.__failLoad=id;},c);
  await row(c).locator('.tree-conv__title').click();await page.waitForFunction(()=>state.conversationLoadFailed);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  assert.equal(await row(c).getAttribute('data-chat-status'),'done');
  await page.evaluate(()=>window.__failLoad=null);
  await row(c).locator('.tree-conv__title').click();await page.waitForFunction(()=>!state.loadingConversation && !state.conversationLoadFailed);
  assert.match(await page.locator('#messages').innerText(),/Risposta C/);assert.equal(await row(c).locator('.tree-conv__unread').count(),0);
  // A selected chat stays unread while the app is unfocused or covered by settings.
  await page.fill('#composer-input','Risposta con finestra in background');await page.click('#composer-send');
  await page.waitForFunction(id=>window.__pending[id]?.args.content==='Risposta con finestra in background',c);
  await page.evaluate(id=>{
    Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false});
    window.__pending[id].finish('Completata fuori dalla finestra');
  },c);
  await row(c).locator('.tree-conv__unread').waitFor();assert.equal(await row(c).getAttribute('data-chat-status'),'done');
  await page.evaluate(()=>{delete document.hasFocus;window.dispatchEvent(new Event('focus'));});
  assert.equal(await row(c).getAttribute('data-chat-status'),'idle');
  await page.fill('#composer-input','Risposta mentre apro le impostazioni');await page.click('#composer-send');
  await page.waitForFunction(id=>window.__pending[id]?.args.content==='Risposta mentre apro le impostazioni',c);
  await page.click('#btn-settings');
  await page.evaluate(id=>window.__pending[id].finish('Completata nelle impostazioni'),c);
  await row(c).locator('.tree-conv__unread').waitFor();assert.equal(await row(c).getAttribute('data-chat-status'),'done');
  await page.click('#modal-close');assert.equal(await row(c).getAttribute('data-chat-status'),'idle');
  await page.fill('#composer-input','Turno da interrompere');await page.click('#composer-send');
  await page.waitForFunction(id=>window.__pending[id]?.args.content==='Turno da interrompere',c);
  await row('b').locator('.tree-conv__title').click();
  await page.evaluate(id=>window.__pending[id].finish('Risposta parziale',true),c);
  await row(c).locator('.tree-conv__unread').waitFor();await preview(c);
  assert.equal(await badge.textContent(),locales['sidebar.chat_stopped']);
  await row('a').locator('.tree-conv__title').click();
  // Sending must keep the rendered history: rebuilding long chats froze the UI before the bubble painted.
  await page.evaluate(()=>document.querySelectorAll('#messages > .msg').forEach(node=>{node.__kept=true;}));
  await page.fill('#composer-input','Richiesta fallita');await page.click('#composer-send');
  await row('a').locator('.tree-conv__spinner').waitFor();
  assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('#messages > .msg')].map(node=>!!node.__kept)),[true,true,false,false]);
  await row('b').locator('.tree-conv__title').click();
  await page.evaluate(()=>{
    window.__events['chat-progress']({payload:{conversation_id:'a',kind:'__delta',text:'Risposta interrotta da conservare'}});
    window.__pending.a.reject(new Error('Background failure'));
  });await row('a').locator('.tree-conv__unread').waitFor();
  assert.equal(await row('a').getAttribute('data-chat-status'),'failed');
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
  await page.evaluate(()=>window.__events['companion-updated']({payload:{conversation_id:'b'}}));
  assert.equal(await row('b').getAttribute('data-chat-status'),'running','Metadata updates must not finish a live turn');
  await page.evaluate(async()=>{
    const conv=window.__data.conversations.find(c=>c.id==='b');
    Object.assign(conv,{messages_loaded:true,messages:[{role:'user',content:'Richiesta Android'},{role:'assistant',content:'Risposta remota verificata'}]});
    await window.__events['companion-updated']({payload:{conversation_id:'b',status:'completed',cancelled:false}});
  });
  await row('b').locator('.tree-conv__unread').waitFor();
  assert.equal(await row('b').getAttribute('data-chat-status'),'done');
  assert.equal(await row('b').locator('.tree-conv__spinner').count(),0);
  await row('b').locator('.tree-conv__title').click();
  assert.match(await page.locator('#messages').innerText(),/Risposta remota verificata/);
  assert.equal(await row('b').getAttribute('data-chat-status'),'idle');
  await row('a').locator('.tree-conv__title').click();
  await page.evaluate(()=>window.__events['companion-updated']({payload:{conversation_id:'b'}}));
  assert.equal(await row('b').getAttribute('data-chat-status'),'idle','A metadata update must not resurrect Done');
  await row('b').locator('.tree-conv__title').click();

  // A preparation failure retains the exact draft and attachments, and never
  // dispatches into the chat opened while the routing request was pending.
  await page.evaluate(()=>{
    window.__snapshot=null;window.__holdSnapshot='b';
    state.attachments=[{name:'note.txt',mime_type:'text/plain',content:'Allegato originale'}];renderDraft();
  });
  await page.fill('#composer-input','Invio da riprendere');await page.click('#composer-send');
  await page.waitForFunction(()=>!!window.__snapshot);
  await page.fill('#composer-input','Messaggio successivo');await page.click('#composer-send');
  assert.equal(await page.locator('.msg--queued').count(),2);
  assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='chat' && c.args.content==='Invio da riprendere').length),0);
  await row('a').locator('.tree-conv__title').click();
  await page.evaluate(()=>window.__snapshot.reject(new Error('Routing temporarily unavailable')));
  await page.waitForFunction(()=>queuedTurns.paused.has('b'));
  assert.equal(await page.locator('#messages').getByText('Routing temporarily unavailable',{exact:true}).count(),0);
  await row('b').locator('.tree-conv__title').click();
  await page.locator('.queue-note').filter({hasText:'Routing temporarily unavailable'}).waitFor();
  await page.getByRole('button',{name:locales['queue.resume'],exact:true}).click();
  await page.waitForFunction(()=>window.__pending.b?.args.content==='Invio da riprendere');
  assert.deepEqual(await page.evaluate(()=>window.__pending.b.args.attachments),[{name:'note.txt',mime_type:'text/plain',content:'Allegato originale'}]);
  assert.equal(await page.locator('#messages').getByText('Invio da riprendere',{exact:true}).count(),1);
  await page.evaluate(()=>window.__pending.b.finish('Primo invio recuperato'));
  await page.waitForFunction(()=>window.__pending.b?.args.content==='Messaggio successivo');
  await page.evaluate(()=>window.__pending.b.finish('Secondo invio recuperato'));
  await page.waitForFunction(()=>!state.busy && !state.queues.get('b')?.length);

  // Folder access is checked for the original project after the bubble paints.
  // A failed check or dismissed consent dialog must never start the model.
  await page.evaluate(async()=>{
    window.__data.projects.push({id:'p',name:'Progetto locale',source_folders:['C:\\project'],conversations:[
      {id:'project-chat',title:'Chat progetto',messages:[],messages_loaded:true,created_at:1,updated_at:Date.now(),context_tokens:0}
    ]});
    applyChatData(structuredClone(window.__data));renderSidebar();await openConversation('project-chat',false);
    window.__holdAccess=true;
  });
  await page.fill('#composer-input','Messaggio al progetto');await page.click('#composer-send');
  await page.waitForFunction(()=>!!window.__access);
  assert.equal(await page.locator('#messages').getByText('Messaggio al progetto',{exact:true}).count(),1);
  await row('a').locator('.tree-conv__title').click();
  await page.evaluate(()=>window.__access.reject(new Error('Folder access temporarily unavailable')));
  await page.waitForFunction(()=>queuedTurns.paused.has('project-chat'));
  await row('project-chat').locator('.tree-conv__title').click();
  await page.locator('.queue-note').filter({hasText:'Folder access temporarily unavailable'}).waitFor();
  await page.getByRole('button',{name:locales['queue.resume'],exact:true}).click();
  await page.waitForFunction(()=>window.__calls.some(c=>c.cmd==='choose_project_folder') && queuedTurns.paused.has('project-chat'));
  assert.equal(await page.evaluate(()=>window.__calls.find(c=>c.cmd==='choose_project_folder').args.project_id),'p');
  assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='chat' && c.args.conversation_id==='project-chat').length),0);
  await page.locator('.msg--queued').getByRole('button',{name:locales['queue.actions'],exact:true}).click();
  await page.locator('#tree-menu').getByRole('menuitem',{name:locales['queue.edit'],exact:true}).click();
  assert.equal(await page.locator('#composer-input').textContent(),'Messaggio al progetto');
  await page.evaluate(()=>window.__grantedFolders=['C:\\project']);
  await page.click('#composer-send');
  await page.waitForFunction(()=>!!window.__pending['project-chat']);
  await page.evaluate(()=>window.__pending['project-chat'].finish('Progetto completato'));
  await page.locator('#messages').getByText('Progetto completato',{exact:true}).waitFor();
  assert.equal(await page.locator('#sidebar-tree [data-conversation-id="project-chat"]').getAttribute('data-chat-status'),'idle');

  // Remote desktop snapshots follow the same completion/read lifecycle.
  await page.evaluate(async id=>{
    state.config.firebase_email='test@example.com';
    const started=Date.now()+1000;
    window.__remoteSnapshots={[id]:{device_id:'test-pc',status:'running',turn_id:'remote-status',started_at:started,updated_at:started,user_content:'Domanda remota'}};
    await refreshRemoteTurn(id);
  },c);
  assert.equal(await row(c).getAttribute('data-chat-status'),'running');
  await page.evaluate(async id=>{
    const snapshot=window.__remoteSnapshots[id],conv=window.__data.conversations.find(chat=>chat.id===id);
    conv.messages.push({role:'user',content:'Domanda remota'},{role:'assistant',content:'Risposta dal secondo desktop'});
    conv.updated_at=snapshot.started_at+1;conv.revision='remote-completed';
    snapshot.status='completed';snapshot.updated_at=conv.updated_at;
    await refreshRemoteTurn(id);
  },c);
  assert.equal(await row(c).getAttribute('data-chat-status'),'done');
  await row(c).locator('.tree-conv__title').click();await page.waitForFunction(()=>!state.loadingConversation);
  assert.equal(await row(c).getAttribute('data-chat-status'),'idle');
  // A local turn can defer the companion refresh; a fresh preload must not
  // acknowledge its result before the completed history has actually loaded.
  await page.evaluate(()=>{
    window.__parallelRequest=requestChat({conversation_id:'a',content:'Turno locale parallelo',attachments:[]});
  });
  await row('a').locator('.tree-conv__spinner').waitFor();
  await page.evaluate(async()=>{
    await window.__events['companion-started']({payload:{conversation_id:'b',content:'Risultato da caricare'}});
    const chat=window.__data.conversations.find(chat=>chat.id==='b');
    chat.messages.push({role:'user',content:'Risultato da caricare'},{role:'assistant',content:'Risultato effettivamente letto'});
    chat.revision='deferred-result';chat.updated_at=Date.now();
    state.preloaded.set('b',Date.now());
    await window.__events['companion-updated']({payload:{conversation_id:'b',status:'completed',cancelled:false}});
  });
  assert.equal(await row('b').getAttribute('data-chat-status'),'done');
  await row('b').locator('.tree-conv__title').click();await page.waitForFunction(()=>!state.loadingConversation);
  await page.locator('#messages').getByText('Risultato effettivamente letto',{exact:true}).waitFor();
  assert.equal(await row('b').getAttribute('data-chat-status'),'idle');
  await page.evaluate(async()=>{window.__pending.a.finish('Turno parallelo concluso');await window.__parallelRequest;});
  await page.evaluate(async()=>{
    await window.__events['companion-started']({payload:{conversation_id:'b',content:'Turno fallito sul gateway'}});
    await window.__events['companion-updated']({payload:{conversation_id:'b',status:'failed',cancelled:false}});
  });
  assert.equal(await row('b').getAttribute('data-chat-status'),'failed','A failed companion turn is not Done');
  assert.deepEqual(errors,[]);await browser.close();console.log('PASS: concurrent chats, background failures, drafts/focus, and remote Android activity/completion reconciliation.');
})().catch(e=>{console.error(e);process.exit(1);});
