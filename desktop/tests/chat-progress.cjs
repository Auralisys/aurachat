const { chromium }=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1409,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
 await page.addInitScript(({locales})=>{
  window.__store={projects:[],conversations:[{id:'c',title:'test ciao',created_at:1,updated_at:1,context_tokens:97,messages:[{role:'user',content:'test ciao'},{role:'assistant',content:'Ciao! Test ricevuto. Come posso aiutarti?'}]}]};
  window.__listeners={};window.__calls=[];window.__copied=[];window.__spoken=[];
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.__copied.push(text)}});
  window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
  Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{speaking:false,cancel(){this.speaking=false;},speak(utterance){window.__spoken.push(utterance.text);queueMicrotask(()=>utterance.onend?.());}}});

  const config={firebase_email:'demo@example.com',firebase_project_id:'demo',firebase_api_key:'demo',firebase_auth_set:true,api_key_set:true,models:['deepseek-flash'],active_model:'deepseek-flash'};
  window.__TAURI__={window:{getCurrentWindow:()=>({minimize(){},close(){},async listen(name,callback){window.__listeners[name]=callback;return()=>{};}})},core:{invoke:async(cmd,args)=>{
   window.__calls.push({cmd,args});
   if(cmd==='speech_model_status')return {ready:false,busy:false,downloaded:0,total:1994857346};
   if(cmd==='get_locale')return JSON.stringify(locales);
   if(['get_local_config','get_config'].includes(cmd))return config;
   if(cmd==='get_data')return structuredClone(window.__store);
   if(cmd==='save_data'){window.__store=structuredClone(args.data);return structuredClone(args.data);}
   if(cmd==='choose_chat_files')return window.__nextFiles||[{name:'notes.md',content:'Private text selected by the user.'}];
   if(cmd==='chat') {
    return await new Promise(resolve => {window.__finish=()=>{
      const conv=window.__store.conversations[0];
      conv.messages.push({role:'user',content:args.content},{role:'assistant',content:window.__answer,activity:window.__history});
      resolve({data:structuredClone(window.__store),messages:structuredClone(conv.messages),usage:{total_tokens:42}});
    };});
   }
  }}};
 },{locales});
 await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);await page.locator('#boot-splash').waitFor({state:'hidden'});

 await page.evaluate(()=>{window.__send= requestChat({conversation_id:'c',content:'Leggi il file'});});
 const liveHistory = page.locator('.msg--stream .turn-history');
 await liveHistory.waitFor({state:'visible'});
 assert.equal(await page.locator('#thinking-status,.thinking__activity').count(),0);
 assert.equal(await liveHistory.count(),1);
 assert.equal(await liveHistory.locator(':scope > summary > svg').first().evaluate(el=>getComputedStyle(el).animationName),'work-pulse');
 assert.match(await liveHistory.locator('.thinking__timer').textContent(),/\d+s/);
 await page.evaluate(()=>{
   window.__emit=(kind,text)=>window.__listeners['chat-progress']({payload:{conversation_id:'c',kind,text}});
   __emit('__reasoning','Controllo i file del progetto.');
   __emit('__activity',JSON.stringify({kind:'tool',id:'one',action:'read_project_file',path:'notes.md',arguments:{path:'notes.md'},status:'running'}));
 });
 await liveHistory.locator(':scope > summary').click();
 assert.match(await liveHistory.innerText(),/notes.md/);
 await liveHistory.locator('.turn-step').first().locator('summary').click();
 await page.evaluate(()=>{window.__liveHistory=document.querySelector('.msg--stream .turn-history');window.__liveBrain=__liveHistory.querySelector('summary > svg');});
 await page.evaluate(()=>{
   const item={kind:'tool',id:'one',action:'read_project_file',path:'notes.md',arguments:{path:'notes.md'},status:'completed',output:'Contenuto verificato',offset:0};
   __emit('__activity',JSON.stringify(item));
   window.__history=[{kind:'reasoning',text:'Controllo i file del progetto.',offset:0},item];
   window.__answer='Ho letto il file. '+ 'Ecco i dettagli della verifica, con una risposta progressiva. '.repeat(15);
   __emit('__delta',window.__answer);
 });
 await page.waitForFunction(()=>document.querySelector('.msg--stream .turn-text')?.textContent.length>0);
 const partial=await page.locator('.msg--stream .turn-text').innerText();
 assert.ok(partial.length<await page.evaluate(()=>window.__answer.length));
 assert.equal(await page.evaluate(()=>__liveHistory===document.querySelector('.msg--stream .turn-history') && __liveHistory.open && __liveHistory.querySelector('.turn-step').open && __liveBrain===__liveHistory.querySelector('summary > svg')),true);
 assert.equal(await liveHistory.locator(':scope > summary > span').first().textContent(),locales['progress.history']+' · 2');
 assert.equal(await page.locator('#thinking-status,.thinking__activity').count(),0);
 const shots=resolve(__dirname,'../../.artifact/chat-progress');mkdirSync(shots,{recursive:true});
 await page.screenshot({path:resolve(shots,'streaming-desktop.png')});
 await page.evaluate(()=>window.__finish());
 await page.waitForFunction(()=>!state.busy);
 assert.equal(await page.locator('.turn-history[data-live-history]').count(),0);
 const history=page.locator('#messages .turn-history').last();await history.locator(':scope > summary').click();
 await history.locator('.turn-step').last().locator('summary').click();
 assert.match(await history.innerText(),/Contenuto verificato/);
 assert.equal(await page.locator('#messages .msg--assistant').last().locator('.turn-text').innerText(),await page.evaluate(()=>window.__answer.trim()));
 // Reload the saved response through the same deserialized messages used on reopening.
 await page.evaluate(()=>{state.runs.delete('c');state.messages=structuredClone(window.__store.conversations[0].messages);renderMessages();});
 assert.equal(await page.locator('#messages .turn-history').count(),1);
 await page.setViewportSize({width:600,height:800});
 await page.screenshot({path:resolve(shots,'history-compact.png')});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.evaluate(()=>{window.__send=requestChat({conversation_id:'c',content:'Seconda verifica'});});
 assert.equal(await liveHistory.locator(':scope > summary > svg').first().evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.evaluate(()=>{__emit('__delta','Risposta immediata.');});
 await page.waitForFunction(()=>document.querySelector('.msg--stream .turn-text')?.textContent.trim()==='Risposta immediata.');
 await page.evaluate(()=>{window.__answer='Risposta immediata.';window.__history=[];window.__finish();});
 await page.waitForFunction(()=>!state.busy);
 // Shell snapshots update correlated rows without recreating expanded details or starting commands.
 await page.evaluate(()=>{
   state.messages=[{role:'assistant',content:'Command status.',activity:[
     {kind:'tool',id:'command-row',action:'execute_project_command',status:'running',output:JSON.stringify({id:'shell-test',status:'running'})},
     {kind:'tool',id:'inspect-row',action:'inspect_project_command',shell_id:'shell-test',status:'running',output:'{}'}
   ]}];renderMessages();
   window.__shellRow=document.querySelector('.turn-step');__shellRow.open=true;
   window.__shell=(conversation_id,status,revision,output)=>__listeners['shell-activity']({payload:{conversation_id,id:'shell-test',status,revision,output}});
   __shell('other-chat','completed',8,'Wrong chat');
 });
 assert.equal(await page.locator('.turn-step').first().getAttribute('data-status'),'running');
 await page.evaluate(()=>__shell('c','running',3,'Still working'));
 assert.match(await page.locator('.turn-step').first().textContent(),/Still working/);
 await page.evaluate(()=>__shell('c','completed',4,'Command finished'));
 assert.equal(await page.locator('.turn-step[data-status="completed"]').count(),2);
 assert.equal(await page.evaluate(()=>__shellRow===document.querySelector('.turn-step') && __shellRow.open),true);
 await page.evaluate(()=>__shell('c','running',2,'Stale output'));
 assert.match(await page.locator('.turn-step').first().textContent(),/Command finished/);
 await page.evaluate(()=>renderMessages());
 assert.equal(await page.locator('.turn-step[data-status="completed"]').count(),2);
 assert.equal(await page.evaluate(()=>__calls.filter(call=>['execute_project_command','inspect_project_command','stop_shell'].includes(call.cmd)).length),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: single unified reasoning/activity history, stable header and expanded rows, pulsing brain, elapsed time, paced text, saved tool output, compact layout, reduced motion and correlated shell completion.');
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
