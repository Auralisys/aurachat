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
   if(['get_data','refresh_data'].includes(cmd))return structuredClone(window.__store);
   if(cmd==='load_conversation')return {...structuredClone(window.__store.conversations.find(c=>c.id===args.conversation_id)),messages_loaded:true};
   if(cmd==='list_shells')return [];
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
   if(cmd==='preview_audio'){
    if(window.__previewError){const error=window.__previewError;window.__previewError=false;throw error===true?'speech_engine: preview failure':error;}
    if(window.__delayPreview)return new Promise(resolve=>window.__finishPreview=()=>{window.__finishPreview=null;resolve({text:window.__liveText||'',committed:'',advance:0});});
    return window.__previewResult||{text:window.__liveText||'',committed:'',advance:0};
   }
   if(cmd==='transcribe_audio'){
    if(window.__transcribeError){window.__transcribeError=false;throw 'speech_engine: test failure';}
    if(window.__delayTranscript){window.__model.busy=true;return new Promise(resolve=>window.__finishTranscript=()=>{window.__model.busy=false;window.__finishTranscript=null;resolve(window.__finalText||'test dettatura');});}
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
 assert.equal(await page.evaluate(()=>composerText()),'Testo già scritto');
 assert.equal(await page.locator('#composer-attachments .attachment-chip').count(),1);
 await page.screenshot({path:resolve(shots,'voice-waveform.png')});
 assert.equal(await page.locator('#composer-send').evaluate(el=>el.getBoundingClientRect().right<innerWidth),true);
 await page.setViewportSize({width:720,height:680});await page.screenshot({path:resolve(shots,'voice-waveform-compact.png')});
 assert.equal(await page.locator('#composer-send').evaluate(el=>el.getBoundingClientRect().right<innerWidth),true);
 await page.setViewportSize({width:1080,height:880});
 await page.click('#voice-stop');await page.waitForFunction(()=>composerText().includes('test dettatura'));
 assert.equal(await page.evaluate(()=>__playing),true);
 assert.equal(await page.evaluate(()=>__plays),1);
 const mediaOrder=await page.evaluate(()=>__calls.map(call=>call.cmd));
 assert(mediaOrder.indexOf('resume_dictation_media')<mediaOrder.indexOf('transcribe_audio'),'Resume occurs before local inference');
 assert.equal(await page.evaluate(()=>composerText()),'Testo già scritto test dettatura');
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
 await page.click('#voice-recording-cancel');assert.equal(await page.evaluate(()=>composerText()),'Da conservare');
 await page.waitForFunction(()=>!voice.mediaOperation);
 assert.equal(await page.evaluate(()=>__playing),true,'Cancel restores playback');
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='transcribe_audio').length),calls);
 // Late inference keeps running in the background and lands in the original draft.
 const originId = await page.evaluate(()=>state.activeConversationId);
 await page.evaluate(()=>window.__delayTranscript=true);await record();await page.click('#voice-stop');await page.waitForFunction(()=>window.__finishTranscript);
 await page.waitForFunction(()=>!voice.mediaOperation);
 assert.match(await page.locator('#voice-recording-status').textContent(),/Trascrizione/,'Transcribing label survives media resume');
 // Codex-style: the frozen, dimmed waveform stays and Stop turns into a spinner; the label is for screen readers.
 assert.equal(await page.locator('#voice-recording-status').evaluate(el=>el.classList.contains('sr-only')),true);
 assert.equal(await page.locator('#voice-waveform').isVisible(),true);
 assert.equal(await page.locator('#voice-stop.is-spinning').isVisible(),true);
 assert.equal(await page.locator('#voice-stop').isDisabled(),true);
 assert.equal(await page.locator('.voice-loader').isVisible(),false);
 await page.screenshot({path:resolve(shots,'voice-transcribing.png')});
 await page.click('#btn-new-chat');await page.fill('#composer-input','Nuova bozza');
 assert.equal(await page.evaluate(()=>__playing),true,'Playback has already resumed during delayed transcription');
 assert.equal(await page.locator('#composer-mic').isVisible(),true,'Another chat can record while the original transcription runs');
 // A second recording queues behind the first inference, with its own destination and send intent.
 await record();
 const secondId=await page.evaluate(()=>state.activeConversationId);
 const transcriptCalls=await page.evaluate(()=>__calls.filter(c=>c.cmd==='transcribe_audio').length);
 await page.click('#composer-send');
 await page.waitForFunction(()=>voice.jobs.length===2 && voice.jobs[1].ready);
 assert.match(await page.locator('#voice-recording-status').textContent(),/in coda/);
 assert.equal(await page.evaluate(()=>__calls.filter(c=>c.cmd==='transcribe_audio').length),transcriptCalls,'Only one native inference at a time');
 await page.click('#btn-new-chat');await page.fill('#composer-input','Terza bozza');
 await page.evaluate(()=>window.__finishTranscript());
 await page.waitForFunction(count=>__calls.filter(c=>c.cmd==='transcribe_audio').length===count+1,transcriptCalls);
 assert.equal(await page.evaluate(()=>composerText()),'Terza bozza','First transcript does not leak into the current composer');
 assert.match(await page.evaluate(id=>state.drafts.get(id)?.text || '', originId),/test dettatura$/,'Transcribed text lands in the original chat draft');
 await page.evaluate(()=>window.__finishTranscript());
 await page.waitForFunction(id=>__calls.some(c=>c.cmd==='chat' && c.args.conversation_id===id),secondId);
 const backgroundSent=await page.evaluate(id=>__calls.find(c=>c.cmd==='chat' && c.args.conversation_id===id).args,secondId);
 assert.equal(backgroundSent.content,'Nuova bozza test dettatura');
 assert.equal(await page.evaluate(()=>composerText()),'Terza bozza','Queued auto-send leaves the third composer untouched');
 await page.waitForFunction(()=>!voice.nativeOperation && !voice.transcribing && ![...state.runs.values()].some(run=>run.pending));
 // Capture origin is fixed before model preparation, and returning before completion uses the live composer.
 await page.evaluate(async id=>{await openConversation(id);window.__delayPrepare=true;},originId);
 await page.click('#composer-mic');await page.waitForFunction(()=>voice.nativeOperation?.command==='prepare_speech_model');
 await page.click('#btn-new-chat');await page.fill('#composer-input','Bozza durante preparazione');
 await page.evaluate(()=>{window.__delayPrepare=false;window.__finishPrepare();});
 await page.waitForFunction(()=>voice.recording?.count>4000);
 assert.equal(await page.evaluate(()=>voice.recording.conversationId),originId,'Preparation cannot retarget capture to the newly opened chat');
 await page.click('#voice-stop');await page.waitForFunction(()=>voice.nativeOperation?.command==='transcribe_audio');
 await page.evaluate(async id=>{await openConversation(id);setComposerText('Bozza aggiornata');},originId);
 await page.evaluate(()=>window.__finishTranscript());
 await page.waitForFunction(()=>!voice.transcribing);
 assert.equal(await page.evaluate(()=>composerText()),'Bozza aggiornata test dettatura','Returning to origin appends to the latest live draft');
 // Cancel a queued chat without cancelling a different chat's running transcription.
 await record();await page.click('#voice-stop');await page.waitForFunction(()=>voice.nativeOperation?.command==='transcribe_audio');
 const beforeCancelled=await page.evaluate(()=>__calls.filter(c=>c.cmd==='transcribe_audio').length);
 await page.evaluate(id=>openConversation(id),secondId);await record();await page.click('#voice-stop');
 await page.waitForFunction(()=>voice.jobs.length===2 && voice.jobs[1].ready);
 await page.click('#voice-recording-cancel');
 await page.evaluate(()=>window.__finishTranscript());await page.waitForFunction(()=>!voice.transcribing);
 assert.equal(await page.evaluate(()=>__calls.filter(c=>c.cmd==='transcribe_audio').length),beforeCancelled,'Cancelled queued audio never reaches the native engine');
 assert.match(await page.evaluate(id=>state.drafts.get(id)?.text || '',originId),/test dettatura test dettatura$/,'Other chat transcription survives cancellation');
 await page.click('#btn-new-chat');
 await page.fill('#composer-input','Nuova bozza');
 await page.evaluate(()=>{window.__delayTranscript=false;window.__transcribeError=true;});
 await record();await page.click('#voice-stop');await page.waitForFunction(()=>!voice.transcribing);
 assert.equal(await page.evaluate(()=>composerText()),'Nuova bozza');
 assert.equal(await page.locator('#composer-mic').isEnabled(),true);
 // Failed transcribe-and-send restores the captured text and attachments instead of losing the draft.
 await page.click('#composer-attach');await page.locator('#composer-attachments .attachment-chip').waitFor();
 await page.evaluate(()=>window.__transcribeError=true);
 await record();await page.click('#composer-send');await page.waitForFunction(()=>!voice.transcribing);
 assert.equal(await page.evaluate(()=>composerText()),'Nuova bozza');
 assert.equal(await page.locator('#composer-attachments .attachment-chip').count(),1);
 await record();await page.click('#voice-stop');await page.waitForFunction(()=>!voice.transcribing);
 assert.equal(await page.evaluate(()=>composerText()),'Nuova bozza test dettatura');
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
 // Whisper revises and retracts its tail. Publish only agreeing words, without replacing old nodes.
 await page.fill('#composer-input','Contesto');
 await page.evaluate(()=>{window.__delayPreview=true;window.__delayTranscript=true;});
 await record();
 const hypothesis=async text=>{
   await page.waitForFunction(()=>window.__finishPreview);
   await page.evaluate(text=>{window.__liveText=text;window.__finishPreview();},text);
   await page.waitForFunction(()=>!voice.previewWorker&&!voice.recording?.drip);
   return page.evaluate(()=>composerText());
 };
 assert.equal(await hypothesis('prova della dettatura internazionale.'),'Contesto');
 assert.equal(await hypothesis('prova della dettatura in tempo reale.'),'Contesto prova della dettatura');
 assert.equal(await page.evaluate(()=>__playing),false,'Live inference does not resume media');
 await page.evaluate(()=>window.__oldWords=[...composerEl().querySelectorAll('.voice-reveal-word')].map(word=>word.firstChild));
 assert.equal(await hypothesis('Prova della'),'Contesto prova della dettatura');
 assert.equal(await hypothesis('Prova della dettatura in tempo reale. Applausi.'),'Contesto prova della dettatura');
 assert.equal(await hypothesis('Prova della dettatura in tempo reale. Ancora.'),'Contesto prova della dettatura in tempo reale.');
 assert.equal(await page.evaluate(()=>__oldWords.every(n=>n.isConnected)&&!composerEl().querySelector('.voice-reveal-word .voice-reveal-word')),true);
 await page.screenshot({path:resolve(shots,'voice-live.png')});
 await page.evaluate(()=>{
   window.__delayPreview=false;
   const r=composerRange(1,12);getSelection().setBaseAndExtent(r.endContainer,r.endOffset,r.startContainer,r.startOffset);
   return stopVoice();
 });
 await page.waitForFunction(()=>window.__finishTranscript);
 assert.equal(await page.evaluate(()=>composerText()),'Contesto prova della dettatura in tempo reale.');
 await page.waitForFunction(()=>!composerEl().querySelector('.voice-reveal-word'));
 assert.equal(await page.evaluate(()=>getSelection().direction),'backward','Settling preserves the direction of a selection');
 await page.evaluate(()=>{window.__delayTranscript=false;window.__finishTranscript();});
 await page.waitForFunction(()=>!voice.transcribing);
 assert.equal(await page.evaluate(()=>composerText()),'Contesto test dettatura');
 assert.equal(await page.locator('#composer-input .voice-reveal-word').count(),0,'Final replacement has no animation');
 await page.waitForFunction(()=>!voice.mediaOperation);

 // Cancellation rolls back visible provisional words, not manual edits outside the owned range.
 await page.evaluate(()=>window.__liveText='test dettatura');
 await page.fill('#composer-input','Base');await record();
 await page.waitForFunction(()=>composerText()==='Base test dettatura');
 await page.evaluate(()=>{const node=composerEl().firstChild;node.textContent='Base aggiornata';});
 await page.click('#voice-recording-cancel');await page.waitForFunction(()=>!voice.mediaOperation);
 assert.equal(await page.evaluate(()=>composerText()),'Base aggiornata');
 // Editing dictated words takes ownership; subsequent speech remains live after those edits.
 await page.evaluate(()=>window.__liveText='test');await record();
 await page.waitForFunction(()=>composerText()==='Base aggiornata test');
 await page.fill('#composer-input','Correzione manuale');
 await page.evaluate(()=>window.__liveText='test altro testo');
 await page.waitForFunction(()=>composerText()==='Correzione manuale altro testo');
 await page.click('#voice-recording-cancel');await page.waitForFunction(()=>!voice.mediaOperation);
 assert.equal(await page.evaluate(()=>composerText()),'Correzione manuale');

 // Corrections before a published name are not new speech. Editing that name during
 // finalization keeps the edit and the not-yet-visible ending of the same recording.
 await page.fill('#composer-input','');
 await page.evaluate(()=>{window.__delayPreview=true;window.__delayTranscript=true;});
 await record();
 assert.equal(await hypothesis('chiama Anna ora'),'');
 assert.equal(await hypothesis('chiama Anna domani'),'chiama Anna');
 assert.equal(await hypothesis('chiama anche la collega Anna domani'),'chiama Anna');
 assert.equal(await hypothesis('chiama anche la collega Anna domani mattina'),'chiama Anna domani');
 await page.evaluate(()=>{window.__delayPreview=false;window.__finalText='Chiama anche la collega Anna domani mattina.';});
 await page.click('#voice-stop');await page.waitForFunction(()=>window.__finishTranscript);
 await page.fill('#composer-input','Scrivi a Luca venerdì');
 await page.evaluate(()=>{window.__finishTranscript();window.__delayTranscript=false;window.__finalText=null;});
 await page.waitForFunction(()=>!voice.transcribing);
 assert.equal(await page.evaluate(()=>composerText()),'Scrivi a Luca venerdì mattina.');

 // Stop waits for at most the in-flight preview; no final inference races the preview.
 await page.fill('#composer-input','Invio live');
 await page.evaluate(()=>{window.__liveText='test';window.__delayPreview=true;});
 await record();await page.waitForFunction(()=>window.__finishPreview);
 const beforeFinal=await page.evaluate(()=>__calls.filter(call=>call.cmd==='transcribe_audio').length);
 await page.click('#composer-send');await page.waitForFunction(()=>voice.jobs[0]?.ready);
 assert.equal(await page.evaluate(()=>__calls.filter(call=>call.cmd==='transcribe_audio').length),beforeFinal);
 await page.evaluate(()=>{window.__delayPreview=false;window.__finishPreview();});
 await page.waitForFunction(()=>__calls.some(call=>call.cmd==='chat'&&call.args.content==='Invio live test dettatura'));
 await page.waitForFunction(()=>!voice.transcribing&&!state.busy);
 await page.fill('#composer-input','Conservare');
 await page.evaluate(()=>window.__delayPreview=true);await record();await page.waitForFunction(()=>window.__finishPreview);
 await page.click('#voice-recording-cancel');await page.waitForFunction(()=>!voice.mediaOperation);
 await page.evaluate(()=>{window.__delayPreview=false;window.__finishPreview();});
 await page.waitForFunction(()=>!voice.previewWorker);
 assert.equal(await page.evaluate(()=>composerText()),'Conservare','Late cancelled preview is ignored');

 // Background live updates stay in the original draft and retain collapsed file/paste parts.
 await page.evaluate(()=>{setComposerParts([{text:'Prefisso '},{text:'@notes.md',pasted:true,kind:'file'}]);window.__liveText='live';});
 await record();await page.waitForFunction(()=>composerText().endsWith(' live'));
 const liveOrigin=await page.evaluate(()=>state.activeConversationId);
 await page.click('#btn-new-chat');await page.fill('#composer-input','Chat diversa');
 await page.evaluate(()=>window.__liveText='live aggiornato');
 await page.waitForFunction(id=>state.drafts.get(id)?.text.endsWith(' live aggiornato'),liveOrigin);
 assert.equal(await page.evaluate(()=>composerText()),'Chat diversa');
 assert.equal(await page.evaluate(id=>state.drafts.get(id)?.parts.some(part=>part.pasted&&part.kind==='file'),liveOrigin),true);
 await page.click('#voice-stop');await page.waitForFunction(()=>!voice.transcribing);
 assert.equal(await page.evaluate(id=>state.drafts.get(id)?.text,liveOrigin),'Prefisso @notes.md test dettatura');
 assert.equal(await page.evaluate(()=>composerText()),'Chat diversa');

 // Each live request is bounded even when capture has advanced by more than one window.
 await page.evaluate(()=>{window.__liveText='';window.__previewResult={text:'Prima frase. Coda.',committed:'Prima frase.',advance:16000*12};});
 await record();
 await page.evaluate(()=>{
   const r=voice.recording,rate=r.context.sampleRate;
   r.chunks=[new Float32Array(rate*35).fill(.05)];r.count=rate*35;r.lastSpeech=r.count;
   previewRecording(r);
 });
 await page.waitForFunction(()=>voice.recording?.from>0);
 const bounded=await page.evaluate(()=>({samples:__calls.filter(c=>c.cmd==='preview_audio').at(-1).args.samples.length,from:voice.recording.from/voice.recording.context.sampleRate}));
 assert.equal(bounded.samples,16000*30);assert.equal(bounded.from,12);
 await page.click('#voice-recording-cancel');await page.waitForFunction(()=>!voice.mediaOperation);
 await page.evaluate(()=>{window.__previewResult=null;window.__liveText='';});
 // A pause confirms a short utterance just once. Skipping a silent window must not swallow
 // the first word of the next phrase, including when a word is genuinely repeated.
 await page.fill('#composer-input','');await record();
 const paused=await page.evaluate(async()=>{
   const r=voice.recording,rate=r.context.sampleRate;
   const tick=async(seconds,text,speech,error=false)=>{
     r.count=seconds*rate;r.chunks=[new Float32Array(r.count).fill(.01)];
     if(speech)r.lastSpeech=r.count;
     window.__liveText=text;window.__previewError=error;
     const before=__calls.length;previewRecording(r);await voice.previewWorker;
     while(r.drip)await new Promise(resolve=>setTimeout(resolve,20));
     return [composerText(),__calls.slice(before).some(c=>c.cmd==='preview_audio')];
   };
   return [await tick(2,'ciao',true),await tick(3,'ciao',false),await tick(4,'',false),
     await tick(13,'',true,'speech_silence'),await tick(15,'sì sì',true),await tick(16,'sì sì certo',true)];
 });
 assert.deepEqual(paused,[['',true],['ciao',true],['ciao',false],['ciao',true],['ciao',true],['ciao sì sì',true]]);
 await page.click('#voice-recording-cancel');await page.waitForFunction(()=>!voice.mediaOperation);
 // Live failures are surfaced and recover on a later preview, without losing the draft.
 await page.fill('#composer-input','Base');
 await page.evaluate(()=>{window.__liveText='parole nuove';window.__previewError=true;});
 await record();await page.waitForFunction(()=>voice.recording?.previewFailed);
 assert.equal(await page.locator('#composer-status').textContent(),locales['voice.error']);
 await page.waitForFunction(()=>composerText()==='Base parole nuove'&&!voice.recording.previewFailed);
 assert.equal(await page.locator('#composer-status').textContent(),'');
 await page.evaluate(()=>window.__transcribeError=true);
 await page.click('#composer-send');await page.waitForFunction(()=>!voice.transcribing);
 assert.equal(await page.evaluate(()=>composerText()),'Base parole nuove','Failed final send leaves the visible draft exactly as it was');
 assert.equal(await page.evaluate(()=>composerEl().contentEditable),'true','The composer unlocks after a failed send');
 await page.waitForFunction(()=>!voice.mediaOperation);

 // Measure the reveal mid-flight: words arrive one per insertion, each wiped in from the left in AuraChat violet.
 await page.fill('#composer-input','Dettatura live:');
 await page.evaluate(()=>{
   window.__liveText='Il testo appare mentre parlo, senza comparire di colpo.';
   window.__wordBatches=[];
   new MutationObserver(records=>records.forEach(record=>{
     const words=[...record.addedNodes].filter(node=>node.classList?.contains('voice-reveal-word')).length;
     if(words)__wordBatches.push(words);
   })).observe(composerEl(),{childList:true,subtree:true});
 });
 await record();await page.waitForFunction(()=>composerText().includes('di colpo.'));
 const motion=await page.locator('#composer-input').evaluate(el=>{
   const word=[...el.querySelectorAll('.voice-reveal-word')].at(-1),animations=word.getAnimations();
   animations.forEach(animation=>{animation.pause();animation.currentTime=100;});
   const style=getComputedStyle(word);
   return {text:word.textContent,names:animations.map(animation=>animation.animationName).sort(),mask:style.webkitMaskPosition||style.maskPosition,color:style.color,ink:getComputedStyle(el).color};
 });
 assert.equal(motion.text,'colpo.');
 assert.deepEqual(motion.names,['voice-word-ink','voice-word-wipe']);
 assert(!['0% 0%','100% 0%'].includes(motion.mask),`The wipe is mid-way (${motion.mask})`);
 assert.notEqual(motion.color,motion.ink,'A new word lands in violet before taking the text colour');
 assert(await page.evaluate(()=>__wordBatches.length>=8&&__wordBatches.every(count=>count===1)),'Words appear one at a time');
 assert.equal(await page.evaluate(()=>composerEl().firstChild.nodeType===Node.TEXT_NODE),true,'Existing text is not animated');
 await page.screenshot({path:resolve(shots,'voice-live-reveal.png')});
 await page.locator('#composer-input').evaluate(el=>el.querySelectorAll('.voice-reveal-word').forEach(word=>word.getAnimations().forEach(animation=>animation.finish())));
 await page.screenshot({path:resolve(shots,'voice-live-complete.png')});
 await page.click('#voice-recording-cancel');await page.waitForFunction(()=>!voice.mediaOperation);
 assert.equal(await page.evaluate(()=>composerText()),'Dettatura live:');
 await page.evaluate(()=>window.__liveText='');
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
 await micPage.evaluate(()=>{composerEl().replaceChildren(document.createElement('br'));window.__liveText='Testo provvisorio';});
 await micPage.click('#composer-mic');await micPage.locator('#voice-stop').waitFor({state:'visible'});
 await micPage.waitForFunction(()=>composerText()==='Testo provvisorio');
 assert.equal(await micPage.evaluate(()=>window.__tracks.length>0),true);
 await micPage.click('#voice-recording-cancel');
 await micPage.waitForFunction(()=>!voice.mediaOperation && composerText()==='');
 await micPage.locator('#composer-input').focus();
 const emptyCaret=await micPage.evaluate(()=>{
   const el=composerEl(),marker=document.createElement('span');
   marker.style.cssText='display:inline-block;width:0;height:1em';
   getSelection().getRangeAt(0).cloneRange().insertNode(marker);
   const left=marker.getBoundingClientRect().left,start=el.getBoundingClientRect().left+parseFloat(getComputedStyle(el).paddingLeft);
   marker.remove();placeCaretAtEnd(el);return {left,start,text:composerText()};
 });
 assert.equal(emptyCaret.text,'');
 assert.ok(Math.abs(emptyCaret.left-emptyCaret.start)<1,`Cancelling live dictation leaves the caret before the placeholder: ${JSON.stringify(emptyCaret)}`);
 await micPage.screenshot({path:resolve(shots,'placeholder-after-dictation.png'),caret:'initial'});
 assert.deepEqual(errors,[]);
 console.log('PASS: real AudioWorklet/fake microphone PCM capture, waveform, model warm-up/download, pinned origin during preparation and inference, cross-chat FIFO transcription and background auto-send, queued cancellation isolation, draft/attachment recovery, media resume and permission denial; native model mocked.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1)});
