// Annotazioni sulle immagini e browser interno: editor, dettatura nei commenti, invio, visore, cattura della pagina e link della chat.
const {chromium}=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');const {resolve,extname}=require('node:path');const http=require('node:http');const assert=require('node:assert/strict');
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
(async()=>{
  // Servita via HTTP: l'AudioWorklet della dettatura non si carica da file://.
  const root=resolve(__dirname,'../ui');
  const server=http.createServer((req,res)=>{
    try{const path=resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));if(!path.startsWith(root))throw Error();
      const file=req.url==='/'?resolve(root,'index.html'):path;
      res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');res.end(readFileSync(file));
    }catch(_){res.statusCode=404;res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage({viewport:{width:1400,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
  await page.addInitScript(({locales,PNG})=>{
    const chat=(id,title,at,messages=[])=>({id,title,created_at:at,updated_at:at,messages});
    window.__data={projects:[],conversations:[chat('a','Chat A',2),chat('b','Chat B',1,[{role:'user',content:'link?'},{role:'assistant',content:'Vedi [la guida](https://example.com/docs).'}])]};
    window.__calls=[];window.__runs={};window.__events={};
    const config={firebase_auth_set:true,api_key_set:true,models:['demo'],active_model:'demo'};
    const conversation=id=>window.__data.conversations.find(c=>c.id===id);
    window.__TAURI__={window:{getCurrentWindow:()=>({async listen(name,callback){window.__events[name]=callback;return()=>{};},minimize(){},close(){}})},core:{invoke:async(cmd,args)=>{
      window.__calls.push({cmd,args:structuredClone(args)});
      if(cmd==='get_locale')return JSON.stringify(locales);
      if(['get_config','get_local_config'].includes(cmd))return config;
      if(cmd==='speech_model_status')return window.__noModel?{ready:false,busy:false,loading:false,loaded:false,downloaded:0,total:1000}:{ready:true,busy:false,loading:false,loaded:true,downloaded:1,total:1};
      if(cmd==='pause_dictation_media'){window.__paused=(window.__paused||0)+1;return;}
      if(cmd==='resume_dictation_media'){window.__resumed=(window.__resumed||0)+1;return;}
      if(cmd==='preview_audio'){
        if(window.__delayPreview)return new Promise(resolve=>window.__finishPreview=()=>{window.__finishPreview=null;resolve({text:window.__liveText||'',committed:'',advance:0});});
        return {text:window.__liveText||'',committed:'',advance:0};
      }
      if(cmd==='transcribe_audio'){
        if(window.__transcribeError){window.__transcribeError=false;throw 'speech_engine: test failure';}
        if(window.__delayTranscript)return new Promise(resolve=>window.__finishTranscript=()=>{window.__finishTranscript=null;resolve('test dettatura');});
        return 'test dettatura';
      }
      if(['get_data','refresh_data'].includes(cmd))return structuredClone(window.__data);
      if(cmd==='list_shells')return [];if(cmd==='get_conversation')return {...structuredClone(conversation(args.conversation_id)),messages_loaded:true};if(cmd==='save_data'){window.__data=structuredClone(args.data);return structuredClone(window.__data);}
      if(cmd==='browser_open'){const url=args.url.includes('://')?args.url:`https://${args.url}/`;return {url,capture:true};}
      if(cmd==='browser_capture'&&window.__delayCapture)await new Promise(resolve=>window.__releaseCapture=resolve);
      if(cmd==='browser_capture')return {data:PNG,mime_type:'image/png',url:'https://user:pw@example.com/pagina?token=segreto#x',title:'Esempio'};
      if(cmd==='chat'){
        const id=args.conversation_id;
        conversation(id).messages.push({role:'user',content:args.content,attachments:args.attachments});
        return new Promise(resolveRun=>{window.__runs[id]={args,finish(reply){
          const target=conversation(id);target.messages.push({role:'assistant',content:reply});target.updated_at=Date.now();
          resolveRun({cancelled:false,data:structuredClone(window.__data),messages:structuredClone(target.messages),usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}});
        }};});
      }
    }}};
  },{locales,PNG});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.locator('#boot-splash').waitFor({state:'hidden'});
  const row=id=>page.locator(`#recent-chats [data-conversation-id="${id}"]`);
  const open=async id=>{await row(id).locator('.tree-conv__title').click();await page.waitForFunction(id=>state.activeConversationId===id&&!state.loadingConversation,id);};
  const paste=name=>page.evaluate(([name,PNG])=>{
    const bytes=Uint8Array.from(atob(PNG),c=>c.charCodeAt(0));const dt=new DataTransfer();
    dt.items.add(new File([bytes],name,{type:'image/png'}));
    document.querySelector('#composer-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
  },[name,PNG]);
  const calls=cmd=>page.evaluate(cmd=>window.__calls.filter(call=>call.cmd===cmd).map(call=>call.args),cmd);
  const lastBounds=async()=>{await page.evaluate(()=>new Promise(requestAnimationFrame));await page.evaluate(()=>new Promise(requestAnimationFrame));return (await calls('browser_bounds')).at(-1);};
  const annotator=page.locator('dialog.annotator');
  const canvas=annotator.locator('.annotator__canvas');
  const tiles=page.locator('#composer-attachments .image-tile:not(.image-tile--pending)');

  await open('a');

  // Un'immagine incollata si annota: due punti, uno senza testo viene scartato al salvataggio.
  await paste('schermo.png');
  await tiles.first().locator('img[src^="blob:"]').waitFor();
  const annotate=tiles.first().getByRole('button',{name:'Annota immagine: schermo.png',exact:true});
  await annotate.click();
  await annotator.waitFor();
  assert.equal(await annotator.locator('#annotator-title').textContent(),'Annota immagine');
  assert.equal(await annotator.locator('.annotator__save').isDisabled(),true);
  const box=await canvas.boundingBox();
  await page.mouse.click(box.x+box.width*0.25,box.y+box.height*0.5);
  await page.keyboard.type('Ingrandisci il titolo');
  await page.mouse.click(box.x+box.width*0.75,box.y+box.height*0.2);
  assert.equal(await annotator.locator('.annotator__status').textContent(),locales['annotations.empty_dropped']);
  assert.equal(await annotator.locator('.annotator__markers .annotation-marker').count(),2);
  // Le frecce spostano il marker selezionato dell'1%.
  await annotator.locator('.annotator__markers .annotation-marker').first().focus();
  await page.keyboard.press('ArrowRight');
  await annotator.locator('.annotator__save').click();
  await page.waitForFunction(()=>!document.querySelector('dialog.annotator').open);
  const saved=await page.evaluate(()=>state.attachments[0].annotation);
  assert.equal(saved.version,1);assert.equal(saved.source,'image');assert.equal(saved.width,1);assert.equal(saved.height,1);
  assert.equal(saved.comments.length,1);assert.equal(saved.comments[0].text,'Ingrandisci il titolo');
  assert.ok(Math.abs(saved.comments[0].x-0.26)<0.02&&Math.abs(saved.comments[0].y-0.5)<0.02,JSON.stringify(saved.comments[0]));
  assert.equal(await tiles.first().locator('.annotation-badge').textContent(),'1');
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('image-tile__annotate')),true);

  // Annulla (Esc) non cambia i commenti già salvati.
  await tiles.first().locator('.image-tile__annotate').click();await annotator.waitFor();
  assert.equal(await annotator.locator('.annotator__item textarea').inputValue(),'Ingrandisci il titolo');
  await annotator.locator('.annotator__item textarea').fill('cambiato');
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('dialog.annotator').open);
  assert.equal(await page.evaluate(()=>state.attachments[0].annotation.comments[0].text),'Ingrandisci il titolo');

  // Dettatura nei commenti: stessa pipeline del compositore, ma il testo arriva solo nel commento scelto.
  const item=n=>annotator.locator('.annotator__item').nth(n);
  const texts=()=>annotator.evaluate(dialog=>dialog._comments.map(comment=>comment.text));
  const focused=()=>page.evaluate(()=>({tag:document.activeElement.tagName,cls:document.activeElement.className,comment:document.activeElement.closest('[data-comment]')?.dataset.comment}));
  const recordField=async n=>{await item(n).locator('.annotator__mic').click();await page.waitForFunction(()=>voice.field?.recording?.count>4000);};
  const transcriptions=async()=>(await calls('transcribe_audio')).length;
  const mediaBack=()=>page.waitForFunction(()=>window.__paused>0&&window.__resumed===window.__paused);
  await tiles.first().locator('.image-tile__annotate').click();await annotator.waitFor();
  await page.mouse.click(box.x+box.width*0.7,box.y+box.height*0.7);await page.keyboard.type('ab cd');
  await item(1).locator('textarea').evaluate(el=>{el.focus();el.setSelectionRange(2,2);});
  await recordField(1);
  assert.equal(await item(1).locator('.annotator__voice').isVisible(),true);
  assert.equal(await item(1).locator('.annotator__mic').isHidden(),true);
  assert.equal(await item(0).locator('.annotator__mic').isDisabled(),true,'un solo commento detta alla volta');
  assert.equal(await page.locator('#composer-mic').isDisabled(),true,'il compositore non registra insieme al commento');
  assert.equal(await annotator.locator('.annotator__save').isDisabled(),true,'salvare perderebbe la trascrizione in arrivo');
  assert.equal(await annotator.locator('.annotator__status').textContent(),locales['annotations.dictation_wait']);
  assert.equal(await page.evaluate(()=>window.__paused),1);
  assert.equal((await focused()).cls.includes('annotator__voice-stop'),true);
  const shots=resolve(__dirname,'../../.artifact/chat-alignment');mkdirSync(shots,{recursive:true});
  await page.screenshot({path:resolve(shots,'annotator-dictation-recording.png')});
  await page.evaluate(()=>window.__delayTranscript=true);
  await item(1).locator('.annotator__voice-stop').click();await page.waitForFunction(()=>window.__finishTranscript);
  await page.screenshot({path:resolve(shots,'annotator-dictation-transcribing.png')});
  assert.equal(await item(1).locator('.annotator__voice-status').textContent(),locales['voice.transcribing']);
  assert.equal((await texts())[1],'ab cd');
  await page.evaluate(()=>{window.__delayTranscript=false;window.__finishTranscript();});
  await page.waitForFunction(()=>document.querySelectorAll('.annotator__item textarea')[1].value.includes('dettatura'));
  assert.deepEqual(await texts(),['Ingrandisci il titolo','ab test dettatura cd']);
  assert.equal(await item(1).locator('.annotator__voice').isHidden(),true);
  assert.equal(await annotator.locator('.annotator__save').isEnabled(),true);
  assert.deepEqual(await item(1).locator('textarea').evaluate(el=>[document.activeElement===el,el.selectionStart,el.selectionEnd]),[true,17,17]);
  assert.equal((await page.locator('#composer-input').textContent()).trim(),'','la trascrizione non finisce nel compositore');
  await mediaBack();

  // Esc durante la registrazione la annulla senza chiudere l'annotatore; X scarta allo stesso modo.
  const sent0=await transcriptions();
  await recordField(0);
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!voice.field);
  assert.equal(await annotator.evaluate(dialog=>dialog.open),true);
  assert.equal(await item(0).locator('.annotator__voice').isHidden(),true);
  assert.deepEqual(await focused(),{tag:'TEXTAREA',cls:'',comment:await item(0).getAttribute('data-comment')});
  await recordField(0);
  await item(0).locator('.annotator__voice-cancel').click();
  await page.waitForFunction(()=>!voice.field);
  await mediaBack();
  assert.equal(await transcriptions(),sent0,'l\'audio scartato non arriva al motore');
  assert.equal((await texts())[0],'Ingrandisci il titolo');
  assert.equal(await page.evaluate(()=>window.__paused),3);

  // Un errore del motore compare nel piede e non tocca il testo.
  await page.evaluate(()=>window.__transcribeError=true);
  await recordField(0);await item(0).locator('.annotator__voice-stop').click();
  await page.waitForFunction(label=>document.querySelector('.annotator__status').textContent===label,locales['voice.error']);
  assert.equal((await texts())[0],'Ingrandisci il titolo');
  await item(0).locator('textarea').press('End');await page.keyboard.type('!');
  assert.equal(await annotator.locator('.annotator__status').textContent(),'');
  await item(0).locator('textarea').fill('Ingrandisci il titolo');

  // Chiuso l'annotatore durante la trascrizione, il risultato non entra nemmeno nel commento riaperto con lo stesso id.
  await page.evaluate(()=>window.__delayTranscript=true);
  await recordField(0);await item(0).locator('.annotator__voice-stop').click();await page.waitForFunction(()=>window.__finishTranscript);
  await annotator.locator('.annotator__cancel').click();
  await page.waitForFunction(()=>!document.querySelector('dialog.annotator').open);
  assert.deepEqual(await page.evaluate(()=>[!!voice.field,voice.jobs.filter(job=>!job.cancelled).length]),[false,0]);
  await tiles.first().locator('.image-tile__annotate').click();await annotator.waitFor();
  assert.equal(await item(0).locator('.annotator__voice').isHidden(),true);
  assert.equal(await item(0).locator('.annotator__mic').isEnabled(),true);
  await page.evaluate(()=>{window.__delayTranscript=false;window.__finishTranscript();});
  await page.waitForFunction(()=>!voice.jobs.length&&!voice.transcribing);
  assert.deepEqual(await texts(),['Ingrandisci il titolo']);
  assert.equal(await page.evaluate(()=>state.attachments[0].annotation.comments[0].text),'Ingrandisci il titolo');
  await annotator.locator('.annotator__cancel').click();
  await page.waitForFunction(()=>!document.querySelector('dialog.annotator').open);

  // Modello in caricamento o assente: stessi stati e messaggi del compositore.
  await tiles.first().locator('.image-tile__annotate').click();await annotator.waitFor();
  await page.evaluate(()=>window.__liveText='test dettatura');
  await recordField(0);
  await page.waitForFunction(()=>document.querySelector('.annotator__item textarea').value.includes('test dettatura'));
  assert.equal(await page.evaluate(()=>!!voice.field?.recording),true);
  assert.equal(await annotator.locator('.annotator__save').isDisabled(),true);
  await page.screenshot({path:resolve(shots,'annotator-live.png')});
  await item(0).locator('.annotator__voice-stop').click();await page.waitForFunction(()=>!voice.jobs.length);
  assert.equal((await texts())[0],'Ingrandisci il titolo test dettatura');
  await mediaBack();
  await item(0).locator('textarea').fill('Ingrandisci il titolo');
  await page.evaluate(()=>window.__delayPreview=true);
  await recordField(0);await page.waitForFunction(()=>window.__finishPreview);
  await annotator.locator('.annotator__cancel').click();
  await tiles.first().locator('.image-tile__annotate').click();await annotator.waitFor();
  await page.evaluate(()=>{window.__delayPreview=false;window.__finishPreview();window.__liveText='';});
  await page.waitForFunction(()=>!voice.previewWorker);await mediaBack();
  assert.equal((await texts())[0],'Ingrandisci il titolo','Late preview cannot reach a reopened annotation');
  await page.evaluate(()=>{voice.loading=true;voiceUi();});
  assert.equal(await item(0).locator('.annotator__mic').isDisabled(),true);
  assert.equal(await item(0).locator('.annotator__mic').getAttribute('title'),locales['voice.loading_model']);
  await page.evaluate(()=>{voice.loading=false;voiceUi();});
  assert.equal(await item(0).locator('.annotator__mic').isEnabled(),true);
  await page.evaluate(()=>window.__noModel=true);
  const pausedBefore=await page.evaluate(()=>window.__paused);
  await item(0).locator('.annotator__mic').click();
  await page.waitForFunction(label=>document.querySelector('.annotator__status').textContent===label,locales['voice.speech_model_missing']);
  assert.deepEqual(await page.evaluate(()=>[!!voice.field,window.__paused]),[false,pausedBefore]);
  await page.evaluate(()=>window.__noModel=false);
  await annotator.locator('.annotator__cancel').click();
  await page.waitForFunction(()=>!document.querySelector('dialog.annotator').open);
  // Il microfono del compositore resta com'era; mentre registra, i commenti non possono dettare.
  await page.click('#composer-mic');await page.locator('#voice-stop').waitFor({state:'visible'});await page.waitForFunction(()=>voice.recording?.count>4000);
  await tiles.first().locator('.image-tile__annotate').click();await annotator.waitFor();
  assert.equal(await item(0).locator('.annotator__mic').isDisabled(),true);
  assert.match(await item(0).locator('.annotator__mic').getAttribute('aria-label'),new RegExp(locales['annotations.dictate_busy'].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  await annotator.locator('.annotator__cancel').click();
  await page.waitForFunction(()=>!document.querySelector('dialog.annotator').open);
  await page.click('#voice-stop');
  await page.waitForFunction(()=>document.querySelector('#composer-input').textContent.includes('test dettatura'));
  assert.deepEqual(await page.evaluate(()=>[voice.jobs.length,voice.field]),[0,null]);
  await page.fill('#composer-input','');
  assert.equal(await annotator.evaluate(dialog=>dialog.open),false);

  // L'invio porta id e annotazione; il visore mostra marker e note.
  await page.fill('#composer-input','Sistema questo');await page.click('#composer-send');
  await page.waitForFunction(()=>window.__runs.a);
  const sent=await page.evaluate(()=>window.__runs.a.args.attachments[0]);
  assert.match(sent.id,/^img-[0-9a-f]{12}$/);assert.equal(sent.annotation.comments[0].text,'Ingrandisci il titolo');
  await page.evaluate(()=>window.__runs.a.finish('Fatto.'));
  await page.waitForFunction(()=>!state.busy);
  const thumb=page.locator('.msg--user .image-thumb').last();
  assert.match(await thumb.getAttribute('aria-label'),/\(1 commento\)$/);
  const [thumbBox,badgeBox]=await Promise.all([thumb.boundingBox(),thumb.locator('.annotation-badge').boundingBox()]);
  assert.ok(badgeBox.x>=thumbBox.x&&badgeBox.y>=thumbBox.y&&badgeBox.x+badgeBox.width<=thumbBox.x+thumbBox.width&&badgeBox.y+badgeBox.height<=thumbBox.y+thumbBox.height);
  await thumb.click();
  const viewer=page.locator('dialog.image-viewer');await viewer.waitFor();
  assert.equal(await viewer.locator('.annotation-layer .annotation-marker').count(),1);
  assert.equal(await viewer.locator('.annotation-notes li').textContent(),'1Ingrandisci il titolo');
  await viewer.locator('.annotation-notes').click();assert.equal(await viewer.evaluate(v=>v.open),true);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog.image-viewer').open);

  // Il pannello a schede si apre senza nascondere il riepilogo.
  await page.click('#panel-toggle');
  assert.equal(await page.locator('#browser-panel').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'browser-address');
  assert.equal(await page.locator('#browser-empty').isVisible(),true);
  assert.equal(await page.locator('#activity-dock').isVisible(),true);
  await page.fill('#browser-address','example.com');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.__calls.some(call=>call.cmd==='browser_open'));
  const opened=(await calls('browser_open'))[0];
  const view=await page.locator('#browser-view').boundingBox();
  assert.equal(opened.url,'example.com');
  assert.deepEqual(opened.bounds,{x:Math.round(view.x),y:Math.round(view.y),width:Math.round(view.width),height:Math.round(view.height)});
  await page.evaluate(()=>window.__events['browser-state']({payload:{tab_id:activePanelTab().id,url:'https://example.com/',title:'Example',loading:true}}));
  assert.equal(await page.locator('#browser-progress').isVisible(),true);
  assert.equal(await page.locator('#browser-reload').getAttribute('aria-label'),'Interrompi caricamento');
  await page.evaluate(()=>window.__events['browser-state']({payload:{tab_id:activePanelTab().id,url:'https://example.com/',title:'Example',loading:false}}));
  assert.equal(await page.locator('#browser-address').inputValue(),'https://example.com/');
  assert.equal((await lastBounds()).visible,true);

  // Un menu sopra il pannello nasconde la pagina nativa; chiuso il menu torna visibile.
  await page.evaluate(()=>{const menu=document.querySelector('#tree-menu');const r=document.querySelector('#browser-view').getBoundingClientRect();Object.assign(menu.style,{left:`${r.left+10}px`,top:`${r.top+10}px`});menu.hidden=false;});
  assert.equal((await lastBounds()).visible,false);
  await page.evaluate(()=>{document.querySelector('#tree-menu').hidden=true;});
  assert.equal((await lastBounds()).visible,true);

  // Cattura: annotatore sopra il browser (pagina nascosta), poi allegato con URL ripulito.
  await page.click('#browser-capture');
  await annotator.waitFor();
  assert.equal(await annotator.locator('#annotator-title').textContent(),'Annota schermata');
  assert.equal(await annotator.locator('.annotator__source').textContent(),'Esempio');
  assert.equal(await annotator.locator('.annotator__save').isEnabled(),true);
  assert.equal((await lastBounds()).visible,false);
  const shot=await canvas.boundingBox();
  await page.mouse.click(shot.x+shot.width*0.5,shot.y+shot.height*0.5);await page.keyboard.type('Questo pulsante');
  await annotator.locator('.annotator__save').click();
  await page.waitForFunction(()=>state.attachments.some(file=>file.annotation?.source==='browser'));
  const capture=await page.evaluate(()=>state.attachments.find(file=>file.annotation?.source==='browser'));
  assert.match(capture.name,/^example\.com-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/);
  assert.equal(capture.annotation.url,'https://example.com/pagina');assert.equal(capture.annotation.title,'Esempio');
  assert.equal(typeof capture.annotation.captured_at,'number');
  assert.equal(await page.locator('#browser-status').textContent(),'Schermata allegata al messaggio.');
  assert.equal((await lastBounds()).visible,true);

  // Una cattura annullata non viene allegata.
  const before=await page.evaluate(()=>state.attachments.length);
  await page.click('#browser-capture');await annotator.waitFor();
  await annotator.locator('.annotator__cancel').click();
  await page.waitForFunction(()=>!document.querySelector('dialog.annotator').open);
  assert.equal(await page.evaluate(()=>state.attachments.length),before);

  // I link delle risposte si aprono nel browser interno; Ctrl+clic usa il browser di sistema.
  await open('b');
  const link=page.locator('.msg--assistant a[href="https://example.com/docs"]');
  await link.click();
  await page.waitForFunction(()=>window.__calls.filter(call=>call.cmd==='browser_open').length===2);
  assert.equal((await calls('browser_open'))[1].url,'https://example.com/docs');
  await link.click({modifiers:['Control']});
  await page.waitForFunction(()=>window.__calls.some(call=>call.cmd==='open_external_url'));
  assert.equal((await calls('open_external_url'))[0].url,'https://example.com/docs');

  // Riepilogo e schede sono indipendenti; nascondere il pannello non chiude le pagine.
  await page.click('#activity-toggle');
  assert.equal(await page.locator('#browser-panel').isVisible(),true);
  assert.equal(await page.locator('#activity-dock').isHidden(),true);
  await page.click('#activity-toggle');
  assert.equal(await page.locator('#activity-dock').evaluate(d=>d.classList.contains('is-visible')),true);
  assert.equal(await page.locator('#panel-tabs [role=tab]').count(),2);
  assert.equal((await calls('browser_close')).length,0);
  await page.click('#browser-close');
  assert.equal(await page.locator('#browser-panel').isHidden(),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'panel-toggle');
  await page.click('#panel-toggle');
  assert.equal(await page.locator('#browser-address').inputValue(),'https://example.com/docs');
  assert.equal((await calls('browser_open')).length,2);
  await page.locator('.panel-tab.is-active .panel-tab__close').click();
  await page.waitForFunction(()=>window.__calls.some(call=>call.cmd==='browser_close'));
  assert.equal((await calls('browser_close'))[0].tab_id,(await calls('browser_open'))[1].tab_id);

  // An account change while capture is pending must never attach the old page.
  const attachmentsBeforeLogout=await page.evaluate(()=>state.attachments.length);
  await page.evaluate(()=>window.__delayCapture=true);
  await page.click('#browser-capture');
  await page.waitForFunction(()=>window.__releaseCapture);
  await page.evaluate(()=>{state.config.firebase_auth_set=false;renderActivity();window.__releaseCapture();});
  await page.evaluate(async()=>{await browserQueue;await new Promise(requestAnimationFrame);});
  assert.equal(await page.evaluate(()=>state.attachments.length),attachmentsBeforeLogout);
  assert.equal(await page.locator('dialog.annotator[open]').count(),0);
  assert.deepEqual(errors,[]);
  await browser.close();server.close();
  console.log('image annotations and browser ok');
})().catch(error=>{console.error(error);process.exit(1);});
