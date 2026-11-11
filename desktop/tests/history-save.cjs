const {chromium}=require('playwright');
const {readFileSync}=require('node:fs');const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
  await page.addInitScript(({locales})=>{
    const chat=(id,title,updated_at)=>({id,title,created_at:1,updated_at,context_tokens:0,messages:[],messages_loaded:true,revision:'r0'});
    window.__data={projects:[],conversations:[chat('a','Chat A',3),chat('b','Chat B',2)]};window.__pending={};window.__saveErrors=[];window.__events={};
    const config={firebase_auth_set:true,api_key_set:true,models:['demo'],active_model:'demo'};
    let revision=0;
    const all=data=>[...(data?.conversations||[]),...(data?.projects||[]).flatMap(p=>p.conversations||[])];
    const find=(data,id)=>all(data).find(c=>c.id===id);
    window.__title=(id,title,title_state)=>{
      Object.assign(find(window.__data,id),{title,title_state});
      window.__events['conversation-title-updated']({payload:{conversation_id:id,title,title_state,email:config.firebase_email}});
    };
    const json=messages=>JSON.stringify(messages||[]);
    const withoutFeedback=messages=>JSON.stringify((messages||[]).map(({feedback,...message})=>message));
    // Mirrors ChatData::rebase + save_tree: a sidebar save may change feedback, never the history.
    const saveData=({data,base})=>{
      const next=structuredClone(data);
      for(const desired of all(next)){
        const before=find(base,desired.id),current=find(window.__data,desired.id);
        if(before && before.messages_loaded!==false && desired.messages_loaded!==false && json(before.messages)!==json(desired.messages)){
          if(before.revision!==current?.revision) throw 'conversation_conflict';
          if(withoutFeedback(current?.messages)!==withoutFeedback(desired.messages)) throw 'use_save_conversation';
        } else if(current){desired.messages=structuredClone(current.messages);desired.revision=current.revision;}
        else if(desired.messages?.length) throw 'use_save_conversation';
      }
      window.__data=next;return structuredClone(next);
    };
    window.__TAURI__={window:{getCurrentWindow:()=>({async listen(name,fn){window.__events[name]=fn;return()=>{};}})},core:{invoke:async(cmd,args)=>{
      if(cmd==='get_locale')return JSON.stringify(locales);
      if(['get_config','get_local_config'].includes(cmd))return config;
      if(['get_data','refresh_data'].includes(cmd))return structuredClone(window.__data);
      if(cmd==='get_conversation')return {...structuredClone(find(window.__data,args.conversation_id)),messages_loaded:true};
      if(cmd==='save_data'){try{
        const saved=saveData(args);
        if(window.__holdSave){window.__holdSave=false;return new Promise(resolve=>window.__releaseSave=()=>resolve(saved));}
        return saved;
      }catch(error){window.__saveErrors.push(error);throw error;}}
      if(cmd==='list_shells')return [];
      if(cmd==='chat'){
        // Like chat_inner, the backend stores the user turn only when the answer is saved.
        return new Promise((resolve,reject)=>window.__pending[args.conversation_id]={args,reject,finish(text){
          const stored=find(window.__data,args.conversation_id);
          stored.messages=[...stored.messages,{role:'user',content:args.content},{role:'assistant',content:text}];
          stored.updated_at=Date.now();stored.revision='r'+(++revision);
          delete window.__pending[args.conversation_id];
          const result={data:structuredClone(window.__data),messages:structuredClone(stored.messages),usage:{total_tokens:12}};
          if(window.__holdReply){window.__holdReply=false;window.__releaseReply=()=>resolve(result);}
          else resolve(result);
        }});
      }
    }}};
  },{locales});
  await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);await page.locator('#boot-splash').waitFor({state:'hidden'});
  const row=id=>page.locator(`#recent-chats [data-conversation-id="${id}"]`);
  const send=async text=>{await page.fill('#composer-input',text);await page.click('#composer-send');};
  const pending=id=>page.waitForFunction(id=>!!window.__pending[id],id);
  const finish=(id,text)=>page.evaluate(([id,text])=>window.__pending[id].finish(text),[id,text]);
  const saveErrors=()=>page.evaluate(()=>window.__saveErrors);

  // A finished turn, then the next turn of the same open chat is still running.
  await row('a').locator('.tree-conv__title').click();
  await send('Prima domanda');await pending('a');
  await page.evaluate(()=>{
    window.__title('a','Prima domanda','generating');
    window.__holdSave=true;window.__saving=persist();
    window.__holdReply=true;window.__pending.a.finish('Prima risposta');
  });
  await page.waitForFunction(()=>!!window.__releaseSave && !!window.__releaseReply);
  await page.evaluate(()=>window.__title('a','Analisi del progetto','generated'));
  assert.equal(await row('a').locator('.tree-conv__title').innerText(),'Analisi del progetto');
  assert.equal(await page.locator('#conversation-title').innerText(),'Analisi del progetto');
  assert.equal(await row('a').locator('.tree-conv__spinner').count(),1,'The title appears while the first response is still pending');
  await page.evaluate(async()=>{window.__releaseSave();await window.__saving;});
  assert.equal(await row('a').locator('.tree-conv__title').innerText(),'Analisi del progetto','A late sidebar save must not restore the generating title');
  await page.evaluate(()=>window.__releaseReply());
  await page.locator('#messages').getByText('Prima risposta').waitFor();
  assert.equal(await row('a').locator('.tree-conv__title').innerText(),'Analisi del progetto','A late turn response must not restore the generating title');
  assert.equal(await page.evaluate(()=>state.runs.get('a').saved.title_state),'generated');
  await send('Seconda domanda');await pending('a');

  // Meanwhile a brand-new chat is created: its save must not carry A's unsaved turn.
  await page.click('#btn-new-chat');await send('Nuova chat in parallelo');
  await page.waitForFunction(()=>Object.keys(window.__pending).length===2 || window.__saveErrors.length>0);
  assert.deepEqual(await saveErrors(),[],'Creating a chat must not save the running turn of another chat');
  assert.equal(await page.locator('.msg--error').count(),0);
  const created=await page.evaluate(()=>Object.keys(window.__pending).find(id=>id!=='a'));
  await finish(created,'Risposta nuova');await page.locator('#messages').getByText('Risposta nuova').waitFor();
  await finish('a','Seconda risposta');await row('a').locator('.tree-conv__unread').waitFor();
  await row('a').locator('.tree-conv__title').click();await page.locator('#messages').getByText('Seconda risposta').waitFor();
  assert.equal(await page.locator('#messages .msg--user').count(),2);

  // A turn finished on another device, then a local turn runs while the sidebar saves a rename.
  await row('b').locator('.tree-conv__title').click();
  await page.evaluate(async()=>{
    const conv=window.__data.conversations.find(c=>c.id==='b');
    Object.assign(conv,{revision:'remote',messages:[{role:'user',content:'Dal telefono'},{role:'assistant',content:'Risposta remota'}]});
    await window.__events['companion-updated']({payload:{conversation_id:'b'}});
  });
  await page.locator('#messages').getByText('Risposta remota').waitFor();
  await send('Locale dopo remoto');await pending('b');
  await row('a').click({button:'right'});await page.getByRole('menuitem',{name:'Rinomina'}).click();
  await page.locator('.tree-input').fill('Chat A rinominata');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.__data.conversations.find(c=>c.id==='a')?.title==='Chat A rinominata' || window.__saveErrors.length>0);
  assert.deepEqual(await saveErrors(),[],'A sidebar save must not carry the running turn of the open chat');
  assert.equal(await page.locator('.msg--error').count(),0);
  await row('a').getByText('Chat A rinominata').waitFor();
  await page.evaluate(()=>window.__title('a','Titolo AI tardivo','generated'));
  assert.equal(await row('a').locator('.tree-conv__title').innerText(),'Chat A rinominata','A manual title wins over a late AI result');
  await finish('b','Risposta locale');await page.locator('#messages').getByText('Risposta locale').waitFor();
  assert.equal(await page.locator('#messages .msg--user').count(),2);

  assert.deepEqual(errors,[]);await browser.close();console.log('PASS: concurrent titles survive late saves and turn responses; manual titles and unsaved history are preserved.');
})().catch(e=>{console.error(e);process.exit(1);});
