const {chromium}=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
  await page.addInitScript(({locales})=>{
    const created={kind:'tool',id:'t1',action:'create_chat',arguments:{title:'Seguito',message:'Handoff completo'},status:'completed',output:JSON.stringify({chat_id:'child',title:'Seguito',linked:true,status:'started'})};
    const missing={kind:'tool',id:'t2',action:'create_chat',arguments:{title:'Persa',message:'x'},status:'completed',output:JSON.stringify({chat_id:'gone',title:'Persa',linked:false,status:'started'})};
    const chat=(id,title,updated_at,extra={})=>({id,title,created_at:1,updated_at,context_tokens:0,messages:[],messages_loaded:true,revision:'r0',...extra});
    window.__data={projects:[],conversations:[
      chat('parent','Chat madre',5,{messages:[{role:'user',content:'Prepara tutto'},{role:'assistant',content:'Fatto, ho aperto una chat.',activity:[created,missing]}]}),
      chat('child','Seguito',4,{linked_from:'parent',messages:[{role:'user',content:'Handoff completo'},{role:'assistant',content:'Riparto da qui.'}]}),
      chat('orphan','Orfana',3,{linked_from:'deleted'}),
      chat('free','Libera',2),
    ]};
    window.__calls=[];window.__events={};
    const conversation=(data,id)=>data.conversations.find(c=>c.id===id);
    const config={firebase_email:'demo@example.com',firebase_auth_set:true,api_key_set:true,models:['demo'],active_model:'demo'};
    window.__TAURI__={window:{getCurrentWindow:()=>({async listen(name,fn){window.__events[name]=fn;return()=>{};}})},core:{invoke:async(cmd,args)=>{
      window.__calls.push({cmd,args});
      if(cmd==='get_locale')return JSON.stringify(locales);
      if(['get_config','get_local_config'].includes(cmd))return config;
      if(['get_data','refresh_data'].includes(cmd))return structuredClone(window.__data);
      if(cmd==='get_conversation')return structuredClone(conversation(window.__data,args.conversation_id));
      if(cmd==='save_data'){window.__data=structuredClone(args.data);return structuredClone(window.__data);}
      if(cmd==='project_folder_access')return [];
      if(cmd==='remote_chat_snapshot')return null;
      if(cmd==='remote_chat_inbox')return {approvals:[],questions:[]};
      if(cmd==='list_shells')return [];
      if(cmd==='chat'){
        const data=structuredClone(window.__data),conv=conversation(data,args.conversation_id);
        conv.messages.push({role:'user',content:args.content},{role:'assistant',content:'Ok'});
        window.__data=structuredClone(data);
        return {data,messages:conv.messages,usage:{total_tokens:1}};
      }
    }}};
  },{locales});
  await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);await page.locator('#boot-splash').waitFor({state:'hidden'});
  const row=id=>page.locator(`#recent-chats [data-conversation-id="${id}"]`);
  const shots=resolve(__dirname,'../../.artifact/chat-links');mkdirSync(shots,{recursive:true});

  // Sidebar: only chats whose parent still exists are marked.
  const label=locales['chat.linked_from'].replace('{title}','Chat madre');
  assert.equal(await row('child').locator('.linked-chat').count(),1);
  assert.equal(await row('child').locator('.linked-chat').getAttribute('title'),label);
  assert.equal(await row('orphan').locator('.linked-chat').count(),0);
  assert.equal(await row('free').locator('.linked-chat').count(),0);
  await page.screenshot({path:resolve(shots,'sidebar.png')});

  // The step that created a chat links to it; a deleted chat leaves no button.
  await row('parent').locator('.tree-conv__title').click();
  await page.locator('#messages .turn-history > summary').click();
  const steps=page.locator('#messages .turn-history .turn-step');
  assert.equal(await steps.count(),2);
  assert.match(await steps.first().locator('.turn-step__label').textContent(),/Nuova chat · Seguito/);
  assert.equal(await steps.first().locator('.turn-step__open').count(),1);
  assert.equal(await steps.nth(1).locator('.turn-step__open').count(),0);
  assert.equal(await page.locator('#conversation-link').count(),0);
  await page.screenshot({path:resolve(shots,'created-step.png')});
  assert.equal(await steps.first().evaluate(el=>el.open),false);
  await steps.first().locator('.turn-step__open').click();
  assert.equal(await page.evaluate(()=>state.activeConversationId),'child');

  // The linked chat points back at its parent.
  const chip=page.locator('#conversation-link');
  assert.equal(await chip.textContent(),label);
  await page.screenshot({path:resolve(shots,'linked-header.png')});
  await chip.click();
  assert.equal(await page.evaluate(()=>state.activeConversationId),'parent');
  assert.equal(await page.locator('#conversation-link').count(),0);

  // Handoff menu entries send a preset prompt that asks the model for create_chat.
  await page.click('#conversation-options');
  const independent=page.getByRole('menuitem',{name:locales['chat.handoff_new'],exact:true});
  const linked=page.getByRole('menuitem',{name:locales['chat.handoff_linked'],exact:true});
  assert.equal(await independent.isEnabled(),true);
  await page.screenshot({path:resolve(shots,'handoff-menu.png')});
  await independent.click();
  await page.waitForFunction(()=>window.__calls.some(call=>call.cmd==='chat'));
  await page.waitForFunction(()=>!state.busy);
  let request=await page.evaluate(()=>window.__calls.filter(call=>call.cmd==='chat').at(-1).args);
  assert.equal(request.conversation_id,'parent');
  assert.equal(request.content,locales['chat.handoff_prompt']);
  assert.match(request.content,/create_chat/);assert.doesNotMatch(request.content,/linked=true/);
  await page.click('#conversation-options');
  await linked.click();
  await page.waitForFunction(()=>window.__calls.filter(call=>call.cmd==='chat').length===2);
  await page.waitForFunction(()=>!state.busy);
  request=await page.evaluate(()=>window.__calls.filter(call=>call.cmd==='chat').at(-1).args);
  assert.equal(request.content,locales['chat.handoff_prompt_linked']);
  assert.match(request.content,/linked=true/);

  // An empty chat has nothing to hand off.
  await row('orphan').locator('.tree-conv__title').click();
  await page.click('#conversation-options');
  assert.equal(await page.getByRole('menuitem',{name:locales['chat.handoff_new'],exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('menuitem',{name:locales['chat.handoff_linked'],exact:true}).isDisabled(),true);
  assert.equal(await page.locator('#conversation-link').count(),0,'A missing parent shows no link');

  assert.deepEqual(errors,[]);
  await browser.close();
  console.log('chat-links OK');
})().catch(error=>{console.error(error);process.exit(1);});
