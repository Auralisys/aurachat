// Real browser UI with native approval/agent events mocked; no account or provider calls.
const {chromium}=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
  await page.addInitScript(({locales})=>{
    window.__events={};window.__calls=[];window.__pending={};
    const data={projects:[{id:'p',name:'AuraChat',source_folders:['C:/work/AuraChat'],conversations:[{id:'c',title:'Gestione operativa',created_at:2,updated_at:2,messages:[{role:'user',content:'Aggiorna il progetto con un agente.'}]}]}],conversations:[{id:'other',title:'Altra conversazione',created_at:1,updated_at:1,messages:[]}]};
    const config={firebase_email:'demo@example.com',firebase_project_id:'demo',firebase_api_key:'demo',firebase_auth_set:true,api_key_set:true,models:['deepseek-flash'],active_model:'deepseek-flash'};
    window.__TAURI__={window:{getCurrentWindow:()=>({minimize(){},close(){},async listen(name,fn){const previous=window.__events[name];window.__events[name]=event=>{previous?.(event);fn(event);};return()=>{};}})},core:{invoke:async(cmd,args)=>{
      window.__calls.push({cmd,args});
      if(cmd==='get_locale')return JSON.stringify(locales);
      if(['get_local_config','get_config'].includes(cmd))return config;
      if(cmd==='get_data')return structuredClone(data);
      if(cmd==='project_permission_mode')return 'auto';
      if(cmd==='list_shells')return [];
      if(cmd==='list_approvals')return Object.values(window.__pending).filter(r=>r.conversation_id===args.conversation_id);
      if(cmd==='resolve_approval'){
        const item=window.__pending[args.id];if(!item||item.conversation_id!==args.conversation_id)throw 'approval_not_found';
        item.status=args.allow?'approved':'denied';window.__events['approval-activity']({payload:{...item}});return;
      }
      if(cmd==='stop_subagent'){window.__events['agent-activity']({payload:{conversation_id:args.conversation_id,id:args.id,status:'cancelled',summary:'Interrotto dall’utente',finished_at:Date.now()}});return;}
      if(cmd==='speech_model_status')return {ready:false,busy:false};
      if(cmd==='chat')return await new Promise(resolve=>window.__finish=()=>{
        const conversation=data.projects[0].conversations[0];conversation.messages.push({role:'assistant',content:'Aggiornamento completato.',activity:structuredClone(state.runs.get('c').stream.activity)});
        resolve({data:structuredClone(data),messages:structuredClone(conversation.messages),usage:{total_tokens:32}});
      });
    }}};
    window.__emitApproval=item=>{window.__pending[item.id]={...item};window.__events['approval-activity']({payload:item});};
  },{locales});
  await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);await page.locator('#boot-splash').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Gestione operativa',exact:true}).first().click();
  await page.evaluate(()=>{window.__send=requestChat({conversation_id:'c',content:'Aggiorna il progetto con un agente.'});});
  await page.evaluate(()=>{
    __events['chat-progress']({payload:{conversation_id:'c',kind:'__reasoning',text:'Controllo la modifica e i permessi.'}});
    __emitApproval({id:'write-1',conversation_id:'c',turn_id:'t',status:'pending',reviewer:'user',action:{kind:'write',path:'C:/work/AuraChat/note.md',previous_content:'Titolo originale',content:'<img src=x onerror="window.__unsafe=true">'},created_at:Date.now()});
  });
  await page.locator('.approval-card').waitFor();await page.locator('.approval-details > summary').click();
  assert.equal(await page.locator('.approval-details img').count(),0);assert.match(await page.locator('.approval-details pre').last().innerText(),/onerror/);
  assert.equal(await page.locator('[data-conversation-id="c"] .is-waiting').count(),2);
  const dot=await page.locator('[data-conversation-id="c"] .is-waiting').first().evaluate(el=>{const r=el.getBoundingClientRect(),row=el.parentElement.getBoundingClientRect(),s=getComputedStyle(el);return {w:r.width,center:Math.abs(r.top+r.height/2-row.top-row.height/2),inside:r.right<=row.right,bg:s.backgroundColor,svg:el.querySelectorAll('svg').length};});
  assert.deepEqual({w:dot.w,inside:dot.inside,bg:dot.bg,svg:dot.svg},{w:8,inside:true,bg:'rgb(245, 184, 61)',svg:0});assert(dot.center<1,`waiting dot centered: ${dot.center}`);
  await page.evaluate(()=>openConversation('other',false,'recents'));assert.equal(await page.locator('#permission-requests').isHidden(),true);
  await page.evaluate(()=>openConversation('c',false,'projects'));await page.locator('.approval-card').waitFor();
  await page.getByRole('button',{name:'Rifiuta',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.approval-card').length===0);
  assert.deepEqual(await page.evaluate(()=>__calls.filter(c=>c.cmd==='resolve_approval').map(c=>c.args.allow)),[false]);
  await page.evaluate(()=>__emitApproval({id:'command-2',conversation_id:'c',turn_id:'t',status:'reviewing',reviewer:'automatic',action:{kind:'command',path:'C:/work/AuraChat',program:'git',arguments:['status','--short']},created_at:Date.now()}));
  await page.locator('.approval-card .is-working-text').waitFor();
  await page.evaluate(()=>__emitApproval({...__pending['command-2'],status:'pending',reason:'review_unavailable'}));
  await page.getByRole('button',{name:'Consenti una volta',exact:true}).waitFor();assert.match(await page.locator('.approval-card__reason').innerText(),/non è disponibile/);
  await page.getByRole('button',{name:'Consenti una volta',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.approval-card').length===0);
  await page.evaluate(()=>__emitApproval({id:'mcp-1',conversation_id:'c',turn_id:'t',status:'pending',reviewer:'user',action:{kind:'mcp',server:'global:fixture',tool:'lookup_record',arguments:{id:'123'}},created_at:Date.now()}));
  await page.getByText('global:fixture · lookup_record',{exact:true}).waitFor();
  await page.getByText('Mostra chiamata MCP',{exact:true}).click();
  assert.match(await page.locator('.approval-details pre').innerText(),/lookup_record/);
  assert.match(await page.locator('.approval-details p').innerText(),/servizi esterni/);
  assert.equal(await page.evaluate(()=>activityShells(activityRecord('c')).some(shell=>shell.id==='approval:mcp-1')),false);
  await page.getByRole('button',{name:'Rifiuta',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.approval-card').length===0);
  await page.evaluate(()=>__emitApproval({id:'mcp-config',conversation_id:'c',turn_id:'t',status:'pending',reviewer:'user',action:{kind:'mcp_config',server:'global:fixture',operation:'configure',configuration:{transport:'stdio',command:'node',environment_keys:['TOKEN']}},created_at:Date.now()}));
  await page.getByText('Mostra chiamata MCP',{exact:true}).click();
  assert.match(await page.locator('.approval-details pre').innerText(),/configure/);
  await page.getByRole('button',{name:'Rifiuta',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.approval-card').length===0);
  await page.evaluate(()=>__emitApproval({id:'http-1',conversation_id:'c',turn_id:'t',status:'pending',reviewer:'user',action:{kind:'http',url:'https://example.invalid/docs',method:'GET'},created_at:Date.now()}));
  await page.getByText('Mostra richiesta HTTP',{exact:true}).click();
  assert.match(await page.locator('.approval-details pre').innerText(),/https:\/\/example.invalid\/docs/);
  assert.equal(await page.evaluate(()=>activityShells(activityRecord('c')).some(shell=>shell.id==='approval:http-1')),false);
  await page.getByRole('button',{name:'Rifiuta',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.approval-card').length===0);
  // Working files stay hidden; only an explicit final publication is an Output.
  await page.evaluate(()=>__events['chat-progress']({payload:{conversation_id:'c',kind:'__activity',text:JSON.stringify({kind:'tool',id:'write-live',action:'write_project_file',arguments:{root:0,path:'report.md'},status:'running'})}}));
  await page.locator('[data-activity-focus="group:outputs"]').click();
  assert.equal(await page.locator('#activity-panel-content .activity-row').count(),0);
  await page.evaluate(()=>__events['chat-progress']({payload:{conversation_id:'c',kind:'__activity',text:JSON.stringify({kind:'tool',id:'publish-live',action:'publish_project_output',status:'completed',output:JSON.stringify({path:'C:\\work\\AuraChat\\report.md',written_bytes:200,final_output:true})})}}));
  await page.locator('#activity-panel-content .activity-row').first().waitFor();
  assert.equal(await page.locator('#activity-panel-content .activity-row__title').innerText(),'report.md');
  assert.equal(await page.locator('#activity-panel-content .activity-row.is-pending').count(),0);
  await page.click('#activity-close');
  await page.evaluate(()=>__events['agent-activity']({payload:{conversation_id:'c',id:'a',title:'Aggiorna note',status:'running',summary:'Modifica del file in corso',task:'Aggiorna note.md',model:'deepseek-flash',content:'Prima parte.',reasoning_content:'Verifico il contenuto originale.',activity:[{kind:'tool',id:'tool-a',action:'edit_project_file',path:'note.md',status:'completed',output:'written',arguments:{path:'note.md'}}]}}));
  await page.locator('[data-activity-focus="all:agents"]').click();await page.getByRole('button',{name:/Aggiorna note/}).click();
  await page.locator('.agent-detail-history > details > summary').click();
  await page.evaluate(()=>{window.__historyNode=document.querySelector('.agent-detail-history > details');});
  await page.evaluate(()=>__events['agent-activity']({payload:{conversation_id:'c',id:'a',status:'running',content:'Prima parte. Seconda parte.',reasoning_content:'Verifico il contenuto originale. Ora applico la modifica.'}}));
  await page.waitForFunction(()=>document.querySelector('.agent-stream-content')?.textContent.includes('Seconda parte.'));
  assert.equal(await page.evaluate(()=>__historyNode===document.querySelector('.agent-detail-history > details')&&__historyNode.open),true);
  const shots=resolve(__dirname,'../../.artifact/operations');mkdirSync(shots,{recursive:true});await page.screenshot({path:resolve(shots,'agent-running-desktop.png')});
  await page.getByRole('button',{name:'Interrompi agente',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.agent-detail-status')?.textContent===t('activity.cancelled'));
  assert.equal(await page.getByRole('button',{name:'Interrompi agente',exact:true}).count(),0);
  // Late running events cannot resurrect a cancelled agent.
  await page.evaluate(()=>__events['agent-activity']({payload:{conversation_id:'c',id:'a',status:'running',summary:'Late'}}));
  assert.equal(await page.locator('.agent-detail-status').innerText(),locales['activity.cancelled']);
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.msg--stream .turn-history[data-live-history] > summary > svg').first().evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.click('#activity-close');await page.click('#sidebar-collapse');await page.setViewportSize({width:700,height:820});
  await page.evaluate(()=>__emitApproval({id:'write-3',conversation_id:'c',turn_id:'t',status:'pending',reviewer:'user',action:{kind:'write',path:'C:/work/AuraChat/note.md',content:'Nuovo contenuto'},created_at:Date.now()}));
  await page.locator('.approval-card').waitFor();await page.screenshot({path:resolve(shots,'approval-compact.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.getByRole('button',{name:'Rifiuta',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.approval-card').length===0);
  await page.evaluate(()=>window.__finish());await page.waitForFunction(()=>!state.busy);
  assert.equal(await page.evaluate(()=>!!window.__unsafe),false);assert.deepEqual(errors,[]);
  console.log('PASS scoped approval cards, safe previews, background navigation, deny/allow, reviewer fallback, child reasoning/tool history continuity, cancellation, reduced motion and compact layout.');await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
