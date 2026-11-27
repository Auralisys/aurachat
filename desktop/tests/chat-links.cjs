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
    window.__data={projects:[{id:'p',name:'Archivio',source_folders:[],conversations:[
      chat('files','Riordino dei documenti',8),
      chat('notes','Verifica dei documenti ricevuti e dei campi mancanti nel riepilogo finale',9,{linked_from:'files',created_at:1795172400000,model:'demo'}),
      chat('review','Revisione finale',7,{linked_from:'notes'}),
    ]}],conversations:[
      chat('parent','Chat madre',5,{messages:[{role:'user',content:'Prepara tutto'},{role:'assistant',content:'Fatto, ho aperto una chat.',activity:[created,missing]}]}),
      chat('child','Seguito',4,{linked_from:'parent',messages:[{role:'user',content:'Handoff completo'},{role:'assistant',content:'Riparto da qui.'}]}),
      chat('orphan','Orfana',3,{linked_from:'deleted'}),
      chat('free','Libera',2),
    ]};
    window.__calls=[];window.__events={};
    const conversation=(data,id)=>[...data.conversations,...data.projects.flatMap(p=>p.conversations)].find(c=>c.id===id);
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

  // The same family can be explored independently in Projects and Recents.
  const label=locales['chat.linked_from'].replace('{title}','Chat madre');
  assert.equal(await row('child').locator('xpath=../..').getAttribute('id'),'chat-children-recents-parent');
  assert.equal(await row('orphan').locator('xpath=ancestor::div[@class="chat-children"]').count(),0);
  const projectRow=id=>page.locator(`#sidebar-tree [data-conversation-id="${id}"]`);
  const branch=projectRow('files').locator('.chat-toggle');
  await branch.focus();await page.keyboard.press('Space');
  assert.equal(await projectRow('review').isVisible(),false);assert.equal(await row('review').isVisible(),true);
  await page.evaluate(()=>renderSidebar());
  assert.equal(await branch.getAttribute('aria-expanded'),'false');await branch.click();
  await page.evaluate(()=>document.activeElement.blur());
  const name=projectRow('notes').locator('.tree-conv__title');
  await name.hover();const peek=page.locator('#project-preview');await peek.waitFor({state:'visible'});
  assert.match(await peek.innerText(),/Creata:.*Verifica.*Archivio.*demo/s);
  assert.equal(await peek.locator('.chat-preview__status').textContent(),locales['sidebar.chat_idle']);
  assert.equal(await projectRow('notes').locator('.chat-toggle > .chat-indicator[role="status"]').count(),1);
  assert.equal(await projectRow('notes').locator('.chat-project-hint').isVisible(),true);
  const motion=await name.locator('span').evaluate(el=>({animation:getComputedStyle(el).animationName,travel:parseFloat(el.style.getPropertyValue('--title-travel')),diff:el.scrollWidth-el.parentNode.clientWidth}));
  assert.equal(motion.animation,'chat-title-pan');assert.ok(motion.diff>0 && Math.abs(motion.travel+motion.diff)<=1);
  assert.equal(await projectRow('review').locator('xpath=../..').getAttribute('id'),'chat-children-projects-notes');
  await page.screenshot({path:resolve(shots,'chat-tree-preview.png'),clip:{x:50,y:45,width:555,height:375}});
  await page.keyboard.press('Escape');await peek.waitFor({state:'hidden'});
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await name.locator('span').evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  const recentIds=await page.evaluate(()=>{
    const nav=document.createElement('nav');
    const chats=[{id:'fresh',linked_from:'old'},...Array.from({length:15},(_,i)=>({id:`separate-${i}`})),
      {id:'old'}, {id:'sibling',linked_from:'old'}];
    appendChatTree(nav,chats,'recents',()=>null,12);
    return [...nav.querySelectorAll('.tree-conv')].map(row=>row.dataset.conversationId);
  });
  assert.deepEqual(recentIds.slice(0,3),['old','fresh','sibling']);
  assert.equal(new Set(recentIds).size,recentIds.length);
  await page.screenshot({path:resolve(shots,'sidebar.png')});

  // A created chat gets a compact card; a deleted one stays only in the history.
  await row('parent').locator('.tree-conv__title').click();
  const card=page.locator('#messages .turn-chat');
  assert.equal(await card.count(),1);
  assert.equal(await card.locator('.turn-agent__title').textContent(),'Seguito');
  assert.equal(await card.locator('.turn-agent__status').textContent(),'Riparto da qui.');
  assert.equal(await card.getAttribute('data-status'),'completed');
  assert.match(await card.getAttribute('aria-label'),new RegExp(locales['chat.open_created']));
  const [box,chevron]=await Promise.all([card.boundingBox(),card.locator('> .ui-icon').last().boundingBox()]);
  assert.ok(box.x+box.width-(chevron.x+chevron.width)<=16,'The chevron sits at the right edge of the card');
  await page.locator('#messages .turn-history > summary').click();
  const steps=page.locator('#messages .turn-history .turn-step');
  assert.equal(await steps.count(),1);
  assert.match(await steps.first().locator('.turn-step__label').textContent(),/Nuova chat · Persa/);
  assert.equal(await page.locator('#conversation-link').count(),0);
  await page.screenshot({path:resolve(shots,'created-card.png')});

  // While the created chat works, its bubble becomes a loader.
  await page.evaluate(async()=>{await window.__events['companion-started']({payload:{conversation_id:'child',content:'Continua'}});});
  assert.equal(await card.getAttribute('data-status'),'running');
  assert.equal(await card.locator('.turn-agent__status').textContent(),locales['chat.thinking']);
  assert.equal(await card.locator('.turn-agent__lead').evaluate(el=>getComputedStyle(el,'::after').animationName),'turn-agent-spin');
  await card.screenshot({path:resolve(shots,'created-card-running.png')});
  await page.evaluate(async()=>{await window.__events['companion-updated']({payload:{conversation_id:'child',status:'completed',cancelled:false}});});
  assert.equal(await card.getAttribute('data-status'),'completed');
  assert.equal(await card.locator('.turn-agent__status').textContent(),'Riparto da qui.');

  await row('parent').locator('.chat-toggle').click();
  assert.equal(await row('child').isVisible(),false);
  await card.click();
  assert.equal(await page.evaluate(()=>state.activeConversationId),'child');
  assert.equal(await row('child').isVisible(),true);

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
