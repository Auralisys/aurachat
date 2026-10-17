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
 try {
 const page=await browser.newPage({viewport:{width:1080,height:880}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const locales=JSON.parse(readFileSync(resolve(root,'locales/it.json'),'utf8'));
 await page.addInitScript(({locales})=>{
  window.__calls=[];window.__listeners={};window.__model={ready:false,busy:false,downloaded:0,total:1994857346};window.__tracks=[];
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
   if(cmd==='download_speech_model'){
    window.__model={...window.__model,busy:true,downloaded:1000000000};window.__listeners['speech-model-progress']?.({payload:window.__model});
    return new Promise((resolve,reject)=>{window.__finishDownload=()=>{window.__model={...window.__model,busy:false,ready:true,downloaded:window.__model.total};resolve(window.__model);};window.__cancelDownload=()=>{window.__model.busy=false;reject('speech_cancelled');};});
   }
   if(cmd==='cancel_speech_download'){window.__cancelDownload();return;}
   if(cmd==='remove_speech_model'){window.__model={ready:false,busy:false,downloaded:0,total:1994857346};return window.__model;}
   if(cmd==='choose_chat_files')return [{name:'notes.md',content:'Existing attachment'}];
   if(cmd==='transcribe_audio'){
    if(window.__delayTranscript)return new Promise(resolve=>window.__finishTranscript=()=>resolve('test dettatura'));
    return 'test dettatura';
   }
   if(cmd==='chat'){
    const conv=window.__store.conversations.find(c=>c.id===args.conversation_id);
    conv.messages=[{role:'user',content:args.content,attachments:args.attachments},{role:'assistant',content:'Ricevuto'}];
    return {data:structuredClone(window.__store),messages:conv.messages,usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}};
   }
  }}};
 },{locales});
 await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.locator('#boot-splash').waitFor({state:'hidden'});
 await page.click('#composer-mic');await page.locator('#settings-voice').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>window.__tracks.length),0);
 await page.click('#voice-download');await page.waitForFunction(()=>window.__finishDownload);
 assert.match(await page.locator('#voice-model-status').textContent(),/50%/);
 await page.click('#voice-download-cancel');await page.getByRole('button',{name:'Riprendi download',exact:true}).waitFor();
 assert.equal(await page.locator('#voice-error').textContent(),'');
 await page.click('#voice-download');await page.evaluate(()=>window.__finishDownload());await page.waitForFunction(()=>document.querySelector('#voice-download').hidden);
 assert.match(await page.locator('#voice-model-status').textContent(),/Installato/);
 const shots=resolve(__dirname,'../../artifacts/chat-alignment');mkdirSync(shots,{recursive:true});
 await page.screenshot({path:resolve(shots,'voice-settings.png')});await page.click('#modal-close');
 await page.fill('#composer-input','Testo già scritto');await page.click('#composer-attach');await page.locator('#composer-attachments .attachment-chip').waitFor();
 const record=async()=>{await page.click('#composer-mic');await page.locator('#voice-stop').waitFor({state:'visible'});await page.waitForFunction(()=>voice.recording?.count>4000);};
 await record();
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
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='transcribe_audio').length),calls);
 // Late inference results cannot land in a different draft.
 await page.evaluate(()=>window.__delayTranscript=true);await record();await page.click('#voice-stop');await page.waitForFunction(()=>window.__finishTranscript);
 await page.click('#nav-home');await page.fill('#composer-input','Nuova bozza');await page.evaluate(()=>window.__finishTranscript());
 await page.waitForFunction(()=>!voice.transcribing);assert.equal(await page.locator('#composer-input').inputValue(),'Nuova bozza');
 await page.evaluate(()=>window.__denyMedia=true);await page.click('#composer-mic');await page.locator('#composer-status').waitFor({state:'visible'});
 assert.match(await page.locator('#composer-status').textContent(),/negato/);assert.equal(await page.locator('#composer-mic').isEnabled(),true);
 assert.equal(await page.evaluate(()=>window.__tracks.every(t=>t.readyState==='ended')),true);
 assert.deepEqual(errors,[]);
 console.log('PASS: real AudioWorklet/fake microphone PCM capture, waveform, download progress/pause/resume, stop without send, combined auto-send + attachments, cancel, navigation and permission denial; native model mocked (tested separately).');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1)});
