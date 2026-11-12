const { chromium }=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1409,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
 await page.addInitScript(({locales})=>{
  window.__store={projects:[],conversations:[{id:'c',title:'test ciao',created_at:1,updated_at:1,context_tokens:97,messages:[{role:'user',content:'test ciao'},{role:'assistant',content:'Ciao! Test ricevuto. Come posso aiutarti?'}]}]};
  window.__calls=[];window.__copied=[];window.__spoken=[];window.__ttsStarted=[];window.__ttsContexts=[];window.__ttsInstalled=false;
  window.__ttsStatus={ready:false,busy:false,loading:false,loaded:false,downloaded:0,total:353746785};
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.__copied.push(text)}});
  window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
  Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{speaking:false,cancel(){this.speaking=false;},speak(utterance){window.__spoken.push(utterance.text);utterance.onstart?.();queueMicrotask(()=>utterance.onend?.());}}});
  window.AudioContext=class{
   constructor(){if(window.__ttsContextFails)throw new Error('audio_device_failed');this.destination={};this.info={activated:navigator.userActivation.isActive,closed:false};window.__ttsContexts.push(this.info);}
   createBuffer(_channels,length,sampleRate){window.__ttsStarted.push({length,sampleRate});return{copyToChannel(){}};}
   createBufferSource(){return{connect(){},start(){if(window.__ttsHoldPlayback)window.__ttsEnd=()=>this.onended?.();else queueMicrotask(()=>this.onended?.());},stop(){},onended:null};}
   resume(){return window.__ttsResumeFails?Promise.reject(new Error('audio_resume_failed')):Promise.resolve();}
   close(){this.info.closed=true;return Promise.resolve();}
  };

  const config={firebase_email:'demo@example.com',firebase_project_id:'demo',firebase_api_key:'demo',firebase_auth_set:true,api_key_set:true,models:['deepseek-flash'],active_model:'deepseek-flash'};
  window.__TAURI__={window:{getCurrentWindow:()=>({minimize(){},close(){},async listen(){return()=>{};}})},core:{invoke:async(cmd,args)=>{
   window.__calls.push({cmd,args});
   if(window.__ttsWait===cmd)await new Promise((resolve,reject)=>{window.__ttsRelease=resolve;window.__ttsReject=reject;});
   if(cmd==='speech_model_status')return {ready:false,busy:false,downloaded:0,total:1994857346};
   if(cmd==='tts_model_status')return window.__ttsStatus;
   if(cmd==='download_tts_model'){window.__ttsStatus={...window.__ttsStatus,ready:true,downloaded:window.__ttsStatus.total};return window.__ttsStatus;}
   if(cmd==='remove_tts_model'){window.__ttsStatus={...window.__ttsStatus,ready:false,downloaded:0,loaded:false};return window.__ttsStatus;}
   if(cmd==='prepare_tts_model'){if(!window.__ttsInstalled)throw new Error('tts_model_missing');return;}
   if(cmd==='synthesize_tts'){
    if(typeof args?.text!=='string'||!args.text.trim())throw new Error('tts_invalid_text');
    return {sample_rate:24000,samples:[0.1,0.2]};
   }
   if(cmd==='get_locale')return JSON.stringify(locales);
   if(['get_local_config','get_config'].includes(cmd))return config;
   if(['get_data','refresh_data'].includes(cmd))return structuredClone(window.__store);
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
 await page.evaluate(()=>openConversation('c',false));
 const shots=resolve(__dirname,'../../.artifact/chat-alignment');mkdirSync(shots,{recursive:true});
 await page.click('#sidebar-collapse');
 await page.screenshot({path:resolve(shots,'conversation-desktop.png')});
 assert.match(await page.locator('.msg__text').first().evaluate(el=>getComputedStyle(el).fontFamily),/Segoe UI/);
 assert.equal(await page.locator('.msg__meta').count(),0);
 await page.getByRole('button',{name:'Copia messaggio',exact:true}).last().click();assert.equal(await page.evaluate(()=>window.__copied.at(-1)),'Ciao! Test ricevuto. Come posso aiutarti?');
 await page.getByRole('button',{name:'Leggi ad alta voce',exact:true}).click();await page.waitForFunction(()=>window.__spoken.length===1);
 assert.equal(await page.evaluate(()=>window.__spoken[0]?.trim()),'Ciao! Test ricevuto. Come posso aiutarti?');
 await page.evaluate(()=>window.__ttsInstalled=true);
 await page.getByRole('button',{name:'Leggi ad alta voce',exact:true}).click();await page.waitForFunction(()=>window.__ttsStarted.length===1);
 assert.deepEqual(await page.evaluate(()=>window.__ttsStarted[0]),{length:2,sampleRate:24000});
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='synthesize_tts').at(-1).args.text.trim()),'Ciao! Test ricevuto. Come posso aiutarti?');
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='synthesize_tts').at(-1).args.voice),'if_sara');
 // Preparation stays visible and cancellable through both native stages.
 await page.evaluate(()=>{window.__ttsWait='prepare_tts_model';window.__ttsHoldPlayback=true;});
 await page.getByRole('button',{name:'Leggi ad alta voce',exact:true}).click();
 await page.waitForFunction(()=>typeof window.__ttsRelease==='function');
 const cancelReading=page.getByRole('button',{name:'Annulla preparazione audio',exact:true});
 assert.equal(await cancelReading.getAttribute('aria-busy'),'true');
 assert.equal(await cancelReading.evaluate(el=>el.classList.contains('is-loading')),true);
 assert.equal(await page.locator('.read-aloud-status').innerText(),'Caricamento del modello locale…');
 assert.equal(await page.evaluate(()=>window.__ttsContexts.at(-1).activated),true);
 await page.screenshot({path:resolve(shots,'read-aloud-loading-desktop.png')});
 await page.setViewportSize({width:720,height:680});await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await cancelReading.evaluate(el=>getComputedStyle(el,'::after').animationName),'none');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:resolve(shots,'read-aloud-loading-compact.png')});
 await page.setViewportSize({width:1409,height:1000});await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(()=>{window.__ttsWait='synthesize_tts';const release=window.__ttsRelease;window.__ttsRelease=null;release();});
 await page.waitForFunction(()=>typeof window.__ttsRelease==='function');
 assert.equal(await page.locator('.read-aloud-status').innerText(),'Sintesi vocale in corso…');
 await cancelReading.press('Enter');
 assert.equal(await page.locator('.read-aloud-status').count(),0);
 assert.equal(await page.evaluate(()=>window.__ttsContexts.at(-1).closed),true);
 await page.evaluate(()=>{window.__ttsWait=null;window.__ttsRelease();window.__ttsRelease=null;});
 await page.waitForFunction(()=>readAloud.button===null);
 assert.equal(await page.evaluate(()=>window.__ttsStarted.length),1,'a cancelled synthesis must not start playback');
 // Cancellation during loading must not start synthesis when loading completes.
 const callsBeforeCancel=await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='synthesize_tts').length);
 await page.evaluate(()=>window.__ttsWait='prepare_tts_model');
 await page.getByRole('button',{name:'Leggi ad alta voce',exact:true}).click();
 await page.waitForFunction(()=>typeof window.__ttsRelease==='function');
 await cancelReading.click();
 await page.evaluate(()=>{window.__ttsWait=null;window.__ttsRelease();window.__ttsRelease=null;});
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='synthesize_tts').length),callsBeforeCancel);
 // A successful preparation switches to Stop only once audio starts.
 await page.getByRole('button',{name:'Leggi ad alta voce',exact:true}).click();
 await page.getByRole('button',{name:'Interrompi lettura',exact:true}).waitFor();
 assert.equal(await page.locator('.read-aloud-status').count(),0);
 assert.equal(await page.getByRole('button',{name:'Interrompi lettura',exact:true}).getAttribute('aria-busy'),'false');
 await page.evaluate(()=>{window.__ttsEnd();window.__ttsHoldPlayback=false;});
 await page.getByRole('button',{name:'Leggi ad alta voce',exact:true}).waitFor();
 // Native and audio-device errors must clear the loader and remain retryable.
 await page.evaluate(()=>window.__ttsWait='synthesize_tts');
 await page.getByRole('button',{name:'Leggi ad alta voce',exact:true}).click();
 await page.waitForFunction(()=>typeof window.__ttsRelease==='function');
 await page.evaluate(()=>{window.__ttsWait=null;window.__ttsReject(new Error('tts_engine'));window.__ttsRelease=null;});
 await page.getByRole('button',{name:'Leggi ad alta voce',exact:true}).waitFor();
 assert.equal(await page.locator('.read-aloud-status').count(),0);
 assert.equal(await page.evaluate(()=>window.__ttsContexts.at(-1).closed),true);
 assert.equal(await page.locator('#composer-status').innerText(),locales['voice.tts_error']);
 for(const failure of ['__ttsContextFails','__ttsResumeFails']){
  await page.evaluate(failure=>{composerStatus('');window[failure]=true;},failure);
  await page.getByRole('button',{name:'Leggi ad alta voce',exact:true}).click();
  await page.getByRole('button',{name:'Leggi ad alta voce',exact:true}).waitFor();
  assert.equal(await page.locator('.read-aloud-status').count(),0);
  assert.equal(await page.locator('#composer-status').innerText(),locales['voice.tts_error']);
  await page.evaluate(failure=>window[failure]=false,failure);
 }
 await page.evaluate(()=>composerStatus(''));
 assert.equal(await page.evaluate(()=>readAloudText('## Un titolo\n\nUn **paragrafo** con [link](https://example.com)\n\n- Primo punto\n- Secondo punto\n\nPrima riga  \nSeconda riga')),
  'Un titolo.\nUn paragrafo con link.\nPrimo punto.\nSecondo punto.\nPrima riga.\nSeconda riga.');
 assert.equal(await page.evaluate(()=>readAloudText('| Nome | Nota |\n| --- | --- |\n| Sara | Già pronta |\n\nÈ pronto? **Sì!**')),
  'Nome, Nota.\nSara, Già pronta.\nÈ pronto? Sì!');
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
 await page.getByRole('button',{name:'Leggi ad alta voce',exact:true}).click();await page.waitForFunction(()=>window.__ttsStarted.length===3);
 const spokenMarkdown=await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='synthesize_tts').at(-1).args.text);
 assert.match(spokenMarkdown,/Una risposta leggibile/);assert.match(spokenMarkdown,/Testo importante e una fonte/);
 assert.doesNotMatch(spokenMarkdown,/<[^>]*>|\*\*|## |\[fonte\]/);
 await page.getByRole('button',{name:'Copia codice',exact:true}).click();assert.match(await page.evaluate(()=>window.__copied.at(-1)),/console.log/);
 await page.getByRole('link',{name:'fonte',exact:true}).click();await page.waitForFunction(()=>window.__calls.some(c=>c.cmd==='browser_open'));
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='browser_open').at(-1).args.url),'https://example.com/');
 await page.evaluate(()=>closeBrowser());
 await page.getByRole('link',{name:'fonte',exact:true}).click({modifiers:['Control']});assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='open_external_url').at(-1).args.url),'https://example.com/');
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
 await page.click('#nav-home');await page.click('#composer-mic');await page.locator('#settings-voice').waitFor({state:'visible'});assert.equal(await page.locator('#composer-input').textContent(),'');
 assert.equal(await page.locator('#settings-voice [data-i18n="voice.tts_title"]').innerText(),'Lettura ad alta voce · Kokoro');
 assert.equal(await page.locator('#tts-voice option').count(),2);assert.equal(await page.locator('#tts-download').isVisible(),true);
 await page.click('#tts-download');await page.waitForFunction(()=>window.__ttsStatus.ready);assert.equal(await page.locator('#tts-remove').isVisible(),true);
 await page.click('#tts-remove');await page.waitForFunction(()=>!window.__ttsStatus.ready);assert.equal(await page.locator('#tts-remove').isVisible(),false);await page.click('#modal-close');
 await page.evaluate(()=>window.__nextFiles=Array.from({length:5},()=>({name:'x.txt',content:'x'})));await page.click('#composer-attach');await page.locator('#composer-status').waitFor({state:'visible'});
 assert.equal(await page.locator('#composer-attachments').isVisible(),false);
 await page.click('#nav-home');await page.evaluate(()=>delete window.__nextFiles);await page.click('#composer-attach');await page.fill('#composer-input','Riassumi queste note e proponi i prossimi passi.');
 await page.setViewportSize({width:720,height:680});await page.screenshot({path:resolve(shots,'composer-compact.png')});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS: chat layout, safe Markdown, copy/code/link, feedback, read aloud/dictation contract, regenerate/edit, failure preservation and text attachments; mocked services.');
})().catch(e=>{console.error(e);process.exit(1)});
