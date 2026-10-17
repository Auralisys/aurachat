const { chromium }=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1409,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
 await page.addInitScript(({locales})=>{
  window.__store={projects:[],conversations:[{id:'c',title:'test ciao',created_at:1,updated_at:1,context_tokens:97,messages:[{role:'user',content:'test ciao'},{role:'assistant',content:'Ciao! Test ricevuto. Come posso aiutarti?'}]}]};
  window.__calls=[];window.__copied=[];window.__spoken=[];
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.__copied.push(text)}});
  window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
  Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{speaking:false,cancel(){this.speaking=false;},speak(utterance){window.__spoken.push(utterance.text);queueMicrotask(()=>utterance.onend?.());}}});

  const config={firebase_email:'demo@example.com',firebase_project_id:'demo',firebase_api_key:'demo',firebase_auth_set:true,api_key_set:true,models:['deepseek-flash'],active_model:'deepseek-flash'};
  window.__TAURI__={window:{getCurrentWindow:()=>({minimize(){},close(){},async listen(){return()=>{};}})},core:{invoke:async(cmd,args)=>{
   window.__calls.push({cmd,args});
   if(cmd==='speech_model_status')return {ready:false,busy:false,downloaded:0,total:1994857346};
   if(cmd==='get_locale')return JSON.stringify(locales);
   if(['get_local_config','get_config'].includes(cmd))return config;
   if(cmd==='get_data')return structuredClone(window.__store);
   if(cmd==='save_data'){window.__store=structuredClone(args.data);return structuredClone(args.data);}
   if(cmd==='choose_chat_files')return window.__nextFiles||[{name:'notes.md',content:'Private text selected by the user.'}];
   if(cmd==='chat'){
    if(window.__failChat){window.__failChat=false;throw new Error('Test API error');}
    const tree=structuredClone(window.__store),conv=tree.conversations.find(c=>c.id===args.conversation_id);
    const index=args.retry?conv.messages.findLastIndex(m=>m.role==='user'):args.edit_index??conv.messages.length;
    const user=args.retry?conv.messages[index]:{role:'user',content:args.content,attachments:args.attachments||[]};
    conv.messages=conv.messages.slice(0,index).concat([user,{role:'assistant',content:window.__response||'Risposta aggiornata.'}]);conv.context_tokens=97;window.__store=tree;
    return {data:structuredClone(tree),messages:structuredClone(conv.messages),usage:{prompt_tokens:33,completion_tokens:64,total_tokens:97}};
   }
  }}};
 },{locales});
 await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);await page.locator('#boot-splash').waitFor({state:'hidden'});
 const shots=resolve(__dirname,'../../artifacts/chat-alignment');mkdirSync(shots,{recursive:true});
 await page.click('#sidebar-collapse');
 await page.screenshot({path:resolve(shots,'conversation-desktop.png')});
 assert.match(await page.locator('.msg__text').first().evaluate(el=>getComputedStyle(el).fontFamily),/Segoe UI/);
 assert.equal(await page.locator('.msg__meta').count(),0);
 await page.getByRole('button',{name:'Copia messaggio',exact:true}).last().click();assert.equal(await page.evaluate(()=>window.__copied.at(-1)),'Ciao! Test ricevuto. Come posso aiutarti?');
 await page.getByRole('button',{name:'Leggi ad alta voce',exact:true}).click();assert.equal(await page.evaluate(()=>window.__spoken.length),1);
 await page.getByRole('button',{name:'Risposta utile',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Risposta utile',exact:true}).getAttribute('aria-pressed'),'true');
 assert.equal(await page.evaluate(()=>window.__store.conversations[0].messages[1].feedback),true);
 await page.getByRole('button',{name:'Risposta non utile',exact:true}).click();assert.equal(await page.evaluate(()=>window.__store.conversations[0].messages[1].feedback),false);
 // Markdown remains formatted and inert, including raw HTML from a model.
 await page.evaluate(()=>{window.__response='## Una risposta leggibile\n\nTesto **importante** e una [fonte](https://example.com).\n\n- Primo punto\n- Secondo punto\n\n```js\nconsole.log("ciao");\n```\n\n| Colonna | Valore |\n| --- | --- |\n| A | 1 |\n\n<img src=x onerror="window.__xss=true"><script>window.__xss=true</script><a href="javascript:window.__xss=true"></a>';});
 await page.getByRole('button',{name:'Rigenera risposta',exact:true}).click();await page.locator('.markdown h2').waitFor();
 assert.equal(await page.locator('.markdown strong').innerText(),'importante');assert.equal(await page.locator('.markdown ul li').count(),2);
 assert.equal(await page.locator('.markdown img,.markdown script,.markdown [onerror],.markdown a[href^="javascript:"]').count(),0);
 assert.equal(await page.evaluate(()=>!!window.__xss),false);
 await page.getByRole('button',{name:'Copia codice',exact:true}).click();assert.match(await page.evaluate(()=>window.__copied.at(-1)),/console.log/);
 await page.getByRole('link',{name:'fonte',exact:true}).click();assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='open_external_url').at(-1).args.url),'https://example.com/');
 await page.locator('#context-info summary').click();assert.match(await page.locator('#context-details').innerText(),/33/);
 await page.locator('#context-info summary').click();await page.screenshot({path:resolve(shots,'markdown-desktop.png')});
 // Editing resubmits the selected user turn and replaces its following answer.
 await page.locator('.msg--user').hover();await page.getByRole('button',{name:'Modifica messaggio',exact:true}).click();
 assert.equal(await page.locator('#editing-message').isVisible(),true);
 await page.fill('#composer-input','Messaggio modificato');await page.click('#composer-send');await page.waitForFunction(()=>window.__store.conversations[0].messages[0].content==='Messaggio modificato');
 assert.equal(await page.evaluate(()=>window.__store.conversations[0].messages.length),2);
 // A failed regeneration cannot remove the saved answer.
 const saved=await page.evaluate(()=>window.__store.conversations[0].messages);
 await page.evaluate(()=>window.__failChat=true);await page.getByRole('button',{name:'Rigenera risposta',exact:true}).click();await page.locator('.msg--error').waitFor();
 assert.deepEqual(await page.evaluate(()=>window.__store.conversations[0].messages),saved);
 await page.getByRole('button',{name:'Rigenera risposta',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.msg--error').length===0);
 // Attachments stay visible as chips and reach the backend only on send.
 await page.click('#nav-home');await page.click('#composer-attach');
 await page.locator('#composer-attachments .attachment-chip').waitFor();assert.equal(await page.locator('#attachment-note').isVisible(),true);
 await page.fill('#composer-input','Riassumi il file');await page.click('#composer-send');await page.waitForFunction(()=>window.__store.conversations.length===2);
 await page.waitForFunction(()=>document.querySelectorAll('.msg--assistant').length===1);
 const request=await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='chat').at(-1).args);
 assert.equal(request.attachments[0].name,'notes.md');assert.equal(request.attachments[0].content,'Private text selected by the user.');
 assert.equal(await page.locator('.message-attachments .attachment-chip').innerText(),'notes.md');
 assert.equal(await page.getByText('Private text selected by the user.',{exact:true}).count(),0);
 await page.click('#nav-home');await page.click('#composer-mic');await page.locator('#settings-voice').waitFor({state:'visible'});assert.equal(await page.locator('#composer-input').inputValue(),'');await page.click('#modal-close');
 await page.evaluate(()=>window.__nextFiles=Array.from({length:5},()=>({name:'x.txt',content:'x'})));await page.click('#composer-attach');await page.locator('#composer-status').waitFor({state:'visible'});
 assert.equal(await page.locator('#composer-attachments').isVisible(),false);
 await page.click('#nav-home');await page.evaluate(()=>delete window.__nextFiles);await page.click('#composer-attach');await page.fill('#composer-input','Riassumi queste note e proponi i prossimi passi.');
 await page.setViewportSize({width:720,height:680});await page.screenshot({path:resolve(shots,'composer-compact.png')});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS: chat layout, safe Markdown, copy/code/link, feedback, read aloud/dictation contract, regenerate/edit, failure preservation and text attachments; mocked services.');
})().catch(e=>{console.error(e);process.exit(1)});
