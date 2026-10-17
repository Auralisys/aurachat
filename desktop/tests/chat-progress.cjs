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
 await page.locator('#thinking-status').waitFor({state:'visible'});
 const geometry=await page.locator('#thinking-status').evaluate(el=>({bottom:el.getBoundingClientRect().bottom,composer:document.querySelector('.composer__box').getBoundingClientRect().top}));
 assert.ok(geometry.composer-geometry.bottom>=0 && geometry.composer-geometry.bottom<24);
 assert.equal(await page.locator('#thinking-status .thinking__activity').evaluate(el=>getComputedStyle(el).animationName),'reasoning-shimmer');
 await page.evaluate(()=>{
   window.__emit=(kind,text)=>window.__listeners['chat-progress']({payload:{conversation_id:'c',kind,text}});
   __emit('__reasoning','Controllo i file del progetto.');
   __emit('__activity',JSON.stringify({kind:'tool',id:'one',action:'read_project_file',path:'notes.md',arguments:{path:'notes.md'},status:'running'}));
 });
 assert.match(await page.locator('#thinking-status').innerText(),/notes.md/);
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
 const shots=resolve(__dirname,'../../artifacts/chat-progress');mkdirSync(shots,{recursive:true});
 await page.screenshot({path:resolve(shots,'streaming-desktop.png')});
 await page.evaluate(()=>window.__finish());
 await page.waitForFunction(()=>!state.busy);
 assert.equal(await page.locator('#thinking-status').isHidden(),true);
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
 assert.equal(await page.locator('#thinking-status .thinking__activity').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.evaluate(()=>{__emit('__delta','Risposta immediata.');});
 await page.waitForFunction(()=>document.querySelector('.msg--stream .turn-text')?.textContent.trim()==='Risposta immediata.');
 await page.evaluate(()=>{window.__answer='Risposta immediata.';window.__history=[];window.__finish();});
 await page.waitForFunction(()=>!state.busy);
 assert.deepEqual(errors,[]);
 console.log('PASS: actual progress events, bottom status, shimmering, paced text, saved tool output and reasoning, compact layout, reduced motion.');
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
