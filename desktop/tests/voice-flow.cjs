const {chromium}=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');
const {resolve,extname}=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
(async()=>{
 const root=resolve(__dirname,'../ui');
 const server=http.createServer((req,res)=>{
  try { const path=resolve(root,'.'+decodeURIComponent(req.url.split('?')[0])); if(!path.startsWith(root))throw Error();
   const file=req.url==='/'?resolve(root,'index.html'):path;
   res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');res.end(readFileSync(file));
  }catch(_){res.statusCode=404;res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
 const TOTAL=1994857346;
 const initScript=({locales,warm,total})=>{
  window.__calls=[];window.__listeners={};window.__model=warm?{ready:true,busy:false,loading:false,loaded:false,downloaded:total,total}:{ready:false,busy:false,loading:false,loaded:false,downloaded:0,total};window.__tracks=[];
  window.__delayPrepare=!!warm;
  window.__playing=true;window.__pausedMedia=new Set();window.__plays=0;
  const getMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async constraints=>{if(window.__denyMedia)throw new DOMException('Denied','NotAllowedError');const stream=await getMedia(constraints);window.__tracks.push(...stream.getTracks());return stream;};
  const config={firebase_email:'demo@example.com',firebase_project_id:'demo',firebase_api_key:'demo',firebase_auth_set:true,api_key_set:true,models:['test'],active_model:'test'};
  window.__store={projects:[],conversations:[]};
  window.__TAURI__={window:{getCurrentWindow:()=>({async listen(name,fn){window.__listeners[name]=fn;return()=>{};},minimize(){},close(){}})},core:{invoke:async(cmd,args)=>{
   window.__calls.push({cmd,args});
   if(cmd==='get_locale')return JSON.stringify(locales);
   if(['get_local_config','get_config'].includes(cmd))return config;
   if(cmd==='get_data')return window.__store;
   if(cmd==='save_data'){window.__store=args.data;return args.data;}
   if(cmd==='speech_model_status')return {...window.__model};
   if(cmd==='prepare_speech_model'){
    if(window.__delayPrepare){window.__model={...window.__model,busy:true,loading:true};return new Promise(resolve=>window.__finishPrepare=()=>{window.__model={...window.__model,busy:false,loading:false,loaded:true};resolve();});}
    window.__model={...window.__model,loaded:true};return;
   }
   if(cmd==='pause_dictation_media'){
    if(window.__delayMedia)await new Promise(resolve=>window.__finishMedia=resolve);
    if(window.__playing){window.__pausedMedia.add(args.id);window.__playing=false;}
    return;
   }
   if(cmd==='resume_dictation_media'){
    if(window.__pausedMedia.delete(args.id)){window.__playing=true;window.__plays++;}
    return;
   }
   if(cmd==='download_speech_model'){
    window.__model={...window.__model,busy:true,downloaded:1000000000};window.__listeners['speech-model-progress']?.({payload:window.__model});
    return new Promise((resolve,reject)=>{window.__finishDownload=()=>{window.__model={...window.__model,busy:false,ready:true,downloaded:window.__model.total};resolve(window.__model);};window.__cancelDownload=()=>{window.__model.busy=false;reject('speech_cancelled');};});
   }
   if(cmd==='cancel_speech_download'){window.__cancelDownload();return;}
   if(cmd==='remove_speech_model'){window.__model={ready:false,busy:false,loading:false,loaded:false,downloaded:0,total};return window.__model;}
   if(cmd==='choose_chat_files')return [{name:'notes.md',content:'Existing attachment'}];
   if(cmd==='transcribe_audio'){
    if(window.__transcribeError){window.__transcribeError=false;throw 'speech_engine: test failure';}
    if(window.__delayTranscript){window.__model.busy=true;return new Promise(resolve=>window.__finishTranscript=()=>{window.__model.busy=false;resolve('test dettatura');});}
    return 'test dettatura';
   }
   if(cmd==='chat'){
    const conv=window.__store.conversations.find(c=>c.id===args.conversation_id);
    conv.messages=[{role:'user',content:args.content,attachments:args.attachments},{role:'assistant',content:'Ricevuto'}];
    return {data:structuredClone(window.__store),messages:conv.messages,usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}};
   }
  }}};
 };
 try {
 const page=await browser.newPage({viewport:{width:1080,height:880}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const locales=JSON.parse(readFileSync(resolve(root,'locales/it.json'),'utf8'));
 await page.addInitScript(initScript,{locales,warm:false,total:TOTAL});
 await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.locator('#boot-splash').waitFor({state:'hidden'});
 const shots=resolve(__dirname,'../../.artifact/chat-alignment');mkdirSync(shots,{recursive:true});
 // Con il modello assente non parte alcun caricamento: il microfono resta cliccabile e apre le impostazioni.
 assert.equal(await page.evaluate(()=>window.__calls.some(c=>c.cmd==='prepare_speech_model')),false);
 await page.click('#composer-mic');await page.locator('#settings-voice').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>window.__tracks.length),0);
 await page.click('#voice-download');await page.waitForFunction(()=>window.__finishDownload);
 assert.match(await page.locator('#voice-model-status').textContent(),/50%/);
 await page.click('#voice-download-cancel');await page.getByRole('button',{name:'Riprendi download',exact:true}).waitFor();
 assert.equal(await page.locator('#voice-error').textContent(),'');
 await page.click('#voice-download');await page.evaluate(()=>window.__finishDownload());await page.waitForFunction(()=>document.querySelector('#voice-download').hidden);
 assert.match(await page.locator('#voice-model-status').textContent(),/Installato/);
 // Il modello appena scaricato viene caricato in memoria senza altre azioni dell'utente.
 await page.waitForFunction(()=>voice.loaded && !voice.loading);
 assert.equal(await page.locator('#composer-mic').isEnabled(),true);
 await page.screenshot({path:resolve(shots,'voice-settings.png')});await page.click('#modal-close');
 await page.fill('#composer-input','Testo già scritto');await page.click('#composer-attach');await page.locator('#composer-attachments .attachment-chip').waitFor();
 const record=async()=>{await page.click('#composer-mic');await page.locator('#voice-stop').waitFor({state:'visible'});await page.waitForFunction(()=>voice.recording?.count>4000);};
 // An installed but busy engine must never be mistaken for a missing model.
 await page.evaluate(()=>window.__model.busy=true);await page.click('#composer-mic');
 await page.waitForFunction(()=>!voice.pending);
 assert.equal(await page.locator('#settings-overlay').isVisible(),false);
 assert.match(await page.locator('#composer-status').textContent(),/occupato/);
 await page.evaluate(()=>{window.__model.busy=false;window.__delayPrepare=true;});
 await page.click('#composer-mic');await page.waitForFunction(()=>window.__finishPrepare);
 assert.match(await page.locator('#voice-recording-status').textContent(),/modello locale/);
 assert.equal(await page.evaluate(()=>window.__tracks.length),0);
 await page.click('#voice-recording-cancel');
 assert.equal(await page.locator('#composer-mic').isVisible(),false);
 assert.match(await page.locator('#voice-recording-status').textContent(),/annullata/);
 await page.evaluate(()=>{window.__delayPrepare=false;window.__finishPrepare();});
 await page.waitForFunction(()=>!voice.nativeOperation);
 assert.equal(await page.evaluate(()=>window.__tracks.length),0);
 await record();
 assert.equal(await page.evaluate(()=>__playing),false,'Playing media pauses while recording');
 await page.waitForFunction(()=>voice.waveform.some(value=>value>0.05));
 const waveTiming=await page.evaluate(()=>({bars:voice.waveform.length,seconds:voice.recording.count/voice.recording.context.sampleRate}));
 assert.equal(waveTiming.bars,Math.min(200,Math.floor(waveTiming.seconds*10)));
 assert.equal(await page.locator('#composer-send').isEnabled(),true);
 for(const selector of ['#voice-recording-cancel','#voice-stop']) {
  const offset=await page.locator(selector).evaluate(button=>{const b=button.getBoundingClientRect(),s=button.querySelector('svg').getBoundingClientRect();return {x:Math.abs(b.x+b.width/2-s.x-s.width/2),y:Math.abs(b.y+b.height/2-s.y-s.height/2)};});
  assert(offset.x<0.5 && offset.y<0.5,`${selector} centered: ${JSON.stringify(offset)}`);
 }
 assert.equal(await page.locator('#composer-input').inputValue(),'Testo già scritto');
 assert.equal(await page.locator('#composer-attachments .attachment-chip').count(),1);
 await page.screenshot({path:resolve(shots,'voice-waveform.png')});
 assert.equal(await page.locator('#composer-send').evaluate(el=>el.getBoundingClientRect().right<innerWidth),true);
 await page.setViewportSize({width:720,height:680});await page.screenshot({path:resolve(shots,'voice-waveform-compact.png')});
 assert.equal(await page.locator('#composer-send').evaluate(el=>el.getBoundingClientRect().right<innerWidth),true);
 await page.setViewportSize({width:1080,height:880});
 await page.click('#voice-stop');await page.waitForFunction(()=>document.querySelector('#composer-input').value.includes('test dettatura'));
 assert.equal(await page.evaluate(()=>__playing),true);
 assert.equal(await page.evaluate(()=>__plays),1);
 const mediaOrder=await page.evaluate(()=>__calls.map(call=>call.cmd));
 assert(mediaOrder.indexOf('resume_dictation_media')<mediaOrder.indexOf('transcribe_audio'),'Resume occurs before local inference');
 assert.equal(await page.locator('#composer-input').inputValue(),'Testo già scritto test dettatura');
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='chat').length),0);
 assert.equal(await page.evaluate(()=>window.__tracks.every(t=>t.readyState==='ended')),true);
 const pcm=await page.evaluate(()=>window.__calls.find(c=>c.cmd==='transcribe_audio').args);
 assert.equal(pcm.language,'it');assert(pcm.samples.length>1600);assert(pcm.samples.every(Number.isFinite));
 // Send stops capture, transcribes and sends the combined text plus the existing attachment.
 await record();await page.click('#composer-send');await page.waitForFunction(()=>window.__calls.some(c=>c.cmd==='chat'));
 const sent=await page.evaluate(()=>window.__calls.find(c=>c.cmd==='chat').args);
 assert.equal(sent.content,'Testo già scritto test dettatura test dettatura');assert.equal(sent.attachments[0].name,'notes.md');
 await page.waitForFunction(()=>!state.busy);
 await page.fill('#composer-input','Da conservare');await record();
 const calls=await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='transcribe_audio').length);
 await page.click('#voice-recording-cancel');assert.equal(await page.locator('#composer-input').inputValue(),'Da conservare');
 await page.waitForFunction(()=>!voice.mediaOperation);
 assert.equal(await page.evaluate(()=>__playing),true,'Cancel restores playback');
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='transcribe_audio').length),calls);
 // Late inference keeps running in the background and lands in the original draft.
 const originId = await page.evaluate(()=>state.activeConversationId);
 await page.evaluate(()=>window.__delayTranscript=true);await record();await page.click('#voice-stop');await page.waitForFunction(()=>window.__finishTranscript);
 await page.waitForFunction(()=>!voice.mediaOperation);
 assert.match(await page.locator('#voice-recording-status').textContent(),/Trascrizione/,'Transcribing label survives media resume');
 assert.equal(await page.locator('#voice-recording-status').evaluate(el=>el.classList.contains('sr-only')),false);
 assert.equal(await page.locator('.voice-loader').isVisible(),true);
 await page.screenshot({path:resolve(shots,'voice-transcribing.png')});
 await page.click('#nav-home');await page.fill('#composer-input','Nuova bozza');
 assert.equal(await page.evaluate(()=>__playing),true,'Playback has already resumed during delayed transcription');
 assert.equal(await page.locator('#composer-mic').isVisible(),false);
 assert.match(await page.locator('#voice-recording-status').textContent(),/Trascrizione/,'Transcription keeps running after switching chat');
 await page.evaluate(()=>window.__finishTranscript());
 await page.waitForFunction(()=>!voice.nativeOperation && !voice.transcribing);
 assert.equal(await page.locator('#composer-input').inputValue(),'Nuova bozza','Transcribed text does not leak into the current composer');
 assert.match(await page.evaluate(id=>state.drafts.get(id)?.text || '', originId),/test dettatura$/,'Transcribed text lands in the original chat draft');
 await page.evaluate(()=>{window.__delayTranscript=false;window.__transcribeError=true;});
 await record();await page.click('#voice-stop');await page.waitForFunction(()=>!voice.transcribing);
 assert.equal(await page.locator('#composer-input').inputValue(),'Nuova bozza');
 assert.equal(await page.locator('#composer-mic').isEnabled(),true);
 await record();await page.click('#voice-stop');await page.waitForFunction(()=>!voice.transcribing);
 assert.equal(await page.locator('#composer-input').inputValue(),'Nuova bozza test dettatura');
 await page.evaluate(()=>window.__denyMedia=true);await page.click('#composer-mic');await page.locator('#composer-status').waitFor({state:'visible'});
 assert.match(await page.locator('#composer-status').textContent(),/negato/);assert.equal(await page.locator('#composer-mic').isEnabled(),true);
 assert.equal(await page.evaluate(()=>window.__tracks.every(t=>t.readyState==='ended')),true);
 await page.evaluate(()=>{window.__denyMedia=false;window.__playing=false;});
 const plays=await page.evaluate(()=>__plays);
 await record();await page.click('#voice-recording-cancel');await page.waitForFunction(()=>!voice.mediaOperation);
 assert.equal(await page.evaluate(()=>__playing),false,'Initially paused playback must stay paused');
 assert.equal(await page.evaluate(()=>__plays),plays);
 // Cancel while Windows is still acknowledging pause must restore exactly once afterwards.
 await page.evaluate(()=>{window.__playing=true;window.__delayMedia=true;});
 await page.click('#composer-mic');await page.waitForFunction(()=>window.__finishMedia);
 await page.click('#voice-recording-cancel');
 await page.evaluate(()=>{window.__delayMedia=false;window.__finishMedia();});
 await page.waitForFunction(()=>!voice.pending&&!voice.mediaOperation);
 assert.equal(await page.evaluate(()=>__playing),true);
 assert.equal(await page.evaluate(()=>__plays),plays+1);
 assert.equal(await page.evaluate(()=>window.__tracks.every(t=>t.readyState==='ended')),true);
 await record();await page.evaluate(()=>__listeners['dictation-cancel']());
 await page.waitForFunction(()=>!voice.mediaOperation);
 assert.equal(await page.evaluate(()=>__playing),true,'Closing to tray restores playback and stops capture');
 assert.equal(await page.evaluate(()=>window.__tracks.every(t=>t.readyState==='ended')),true);
 // Modello già installato: il caricamento parte da solo all'avvio, con loader sul microfono e click inerte.
 const micPage=await browser.newPage({viewport:{width:1080,height:880}});
 micPage.on('pageerror',e=>errors.push(e.message));
 await micPage.addInitScript(initScript,{locales,warm:true,total:TOTAL});
 await micPage.goto(`http://127.0.0.1:${server.address().port}/`);await micPage.locator('#boot-splash').waitFor({state:'hidden'});
 await micPage.waitForFunction(()=>window.__finishPrepare);
 assert.equal(await micPage.evaluate(()=>voice.loading),true);
 assert.equal(await micPage.locator('#composer-mic').isDisabled(),true);
 assert.equal(await micPage.locator('#composer-mic').evaluate(el=>el.classList.contains('is-loading')),true);
 const ring=await micPage.locator('#composer-mic').evaluate(el=>{const s=getComputedStyle(el,'::after');return {width:s.width,height:s.height,color:s.borderTopColor};});
 assert.equal(ring.width,'20px');assert.equal(ring.height,'20px');assert(ring.color!=='rgba(0, 0, 0, 0)');
 assert.equal(await micPage.locator('#composer-mic').getAttribute('aria-label'),locales['voice.loading_model']);
 await micPage.locator('#composer-mic').click({force:true,timeout:1500}).catch(()=>{});
 assert.equal(await micPage.evaluate(()=>window.__tracks.length),0);
 assert.equal(await micPage.evaluate(()=>!!voice.recording),false);
 await micPage.click('#btn-settings');await micPage.evaluate(()=>selectSettingsTab('voice'));await micPage.locator('#settings-voice').waitFor({state:'visible'});
 assert.equal(await micPage.locator('#voice-model-status').textContent(),locales['voice.loading_model']);
 assert.equal(await micPage.locator('#voice-download').isHidden(),true);
 assert.equal(await micPage.locator('#voice-remove').isDisabled(),true);
 await micPage.screenshot({path:resolve(shots,'voice-mic-loading.png')});await micPage.click('#modal-close');
 await micPage.screenshot({path:resolve(shots,'voice-mic-loader.png')});
 await micPage.evaluate(()=>{window.__delayPrepare=false;window.__finishPrepare();});
 await micPage.waitForFunction(()=>!voice.loading);
 assert.equal(await micPage.locator('#composer-mic').isEnabled(),true);
 assert.equal(await micPage.locator('#composer-mic').evaluate(el=>el.classList.contains('is-loading')),false);
 assert.equal(await micPage.locator('#composer-mic').getAttribute('aria-label'),locales['chat.dictate']);
 await micPage.click('#composer-mic');await micPage.locator('#voice-stop').waitFor({state:'visible'});
 await micPage.waitForFunction(()=>voice.recording?.count>4000);
 assert.equal(await micPage.evaluate(()=>window.__tracks.length>0),true);
 await micPage.click('#voice-recording-cancel');
 assert.deepEqual(errors,[]);
 console.log('PASS: real AudioWorklet/fake microphone PCM capture, waveform, download progress/pause/resume, stop without send, combined auto-send + attachments, cancel, navigation and permission denial; startup model warm-up with disabled microphone and loading state; native model mocked (tested separately).');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1)});
