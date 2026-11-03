// Immagini: Ctrl+V e Allega nel composer, anteprime, invio, visore e immagini restituite dai tool.
const {chromium}=require('playwright');
const {readFileSync}=require('node:fs');const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
  await page.addInitScript(({locales,PNG})=>{
    const chat=(id,title,at)=>({id,title,created_at:at,updated_at:at,messages:[]});
    window.__data={projects:[],conversations:[chat('a','Chat A',2),chat('b','Chat B',1)]};window.__calls=[];window.__runs={};window.__events={};
    const config={firebase_auth_set:true,api_key_set:true,models:['demo'],active_model:'demo'};
    const conversation=id=>window.__data.conversations.find(c=>c.id===id);
    window.__TAURI__={window:{getCurrentWindow:()=>({async listen(name,callback){window.__events[name]=callback;return()=>{};},minimize(){},close(){}})},core:{invoke:async(cmd,args)=>{
      window.__calls.push({cmd,args});
      if(cmd==='get_locale')return JSON.stringify(locales);
      if(['get_config','get_local_config'].includes(cmd))return config;
      if(cmd==='speech_model_status')return {ready:true,busy:false,loading:false,loaded:true,downloaded:1,total:1};
      if(['get_data','refresh_data'].includes(cmd))return structuredClone(window.__data);
      if(cmd==='list_shells')return [];if(cmd==='get_conversation')return {...structuredClone(conversation(args.conversation_id)),messages_loaded:true};if(cmd==='save_data'){window.__data=structuredClone(args.data);return structuredClone(window.__data);}
      // Il selettore nativo restituisce le immagini grezze in base64 e i file di testo gia letti.
      if(cmd==='choose_chat_files')return [{name:'foto.png',mime_type:'image/png',data:PNG,content:''},{name:'note.txt',content:'appunti'}];
      if(cmd==='chat'){
        const id=args.conversation_id;
        conversation(id).messages.push({role:'user',content:args.content,attachments:args.attachments});
        return new Promise(resolveRun=>{window.__runs[id]={args,finish(reply,activity){
          const target=conversation(id);target.messages.push({role:'assistant',content:reply,activity});target.updated_at=Date.now();
          resolveRun({cancelled:false,data:structuredClone(window.__data),messages:structuredClone(target.messages),usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}});
        }};});
      }
    }}};
  },{locales,PNG});
  await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);await page.locator('#boot-splash').waitFor({state:'hidden'});
  const row=id=>page.locator(`#recent-chats [data-conversation-id="${id}"]`);
  const open=async id=>{await row(id).locator('.tree-conv__title').click();await page.waitForFunction(id=>state.activeConversationId===id&&!state.loadingConversation,id);};
  // Ctrl+V: file negli appunti come li mette il sistema (screenshot, immagini copiate), con testo opzionale.
  const paste=(names,{text='',body=null}={})=>page.evaluate(([names,text,body,PNG])=>{
    const bytes=Uint8Array.from(atob(PNG),c=>c.charCodeAt(0));const dt=new DataTransfer();
    for(const name of names)dt.items.add(new File([body??bytes],name,{type:'image/png'}));
    if(text)dt.setData('text/plain',text);
    document.querySelector('#composer-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
  },[names,text,body,PNG]);
  const tiles=page.locator('#composer-attachments .image-tile:not(.image-tile--pending)');
  const skeletons=page.locator('#composer-attachments .image-tile--pending');
  const draftImages=()=>page.evaluate(()=>state.attachments.filter(isImageAttachment).map(f=>f.name));
  const status=()=>page.locator('#composer-status').textContent();
  const composer=async()=>(await page.locator('#composer-input').textContent()).trim();
  const viewer=page.locator('dialog.image-viewer');
  const viewerClosed=()=>page.waitForFunction(()=>!document.querySelector('dialog.image-viewer')?.open);
  const progress=(kind,item)=>page.evaluate(([kind,text])=>window.__events['chat-progress']({payload:{conversation_id:'a',kind,text}}),[kind,JSON.stringify(item)]);

  await open('a');

  // Uno screenshot incollato diventa un'anteprima quadrata con la X, senza testo nel composer.
  await paste(['shot.png']);
  await tiles.first().locator('img[src^="blob:"]').waitFor();
  assert.equal(await tiles.count(),1);assert.equal(await composer(),'');
  assert.equal(await tiles.first().getByRole('button',{name:'Apri immagine: shot.png',exact:true}).count(),1);
  const box=await tiles.first().boundingBox();assert.ok(Math.abs(box.width-120)<1&&Math.abs(box.height-120)<1,JSON.stringify(box));
  await tiles.first().getByRole('button',{name:'Rimuovi allegato: shot.png',exact:true}).click();
  assert.equal(await page.locator('#composer-attachments .image-tile').count(),0);
  assert.equal(await page.locator('#composer-attachments').isHidden(),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'composer-input');

  // Da fogli di calcolo e documenti arrivano testo e immagine insieme: vince il testo.
  await paste(['celle.png'],{text:'A1 B1'});
  assert.equal(await composer(),'A1 B1');
  assert.equal(await page.locator('#composer-attachments .image-tile').count(),0);
  await page.fill('#composer-input','');

  // Allega: le immagini diventano anteprime, i file di testo restano chip; i nomi doppi si distinguono.
  await page.click('#composer-attach');
  await tiles.first().locator('img[src^="blob:"]').waitFor();
  assert.equal(await page.locator('#composer-attachments .attachment-chip').count(),1);
  assert.equal(await page.locator('#attachment-note').isVisible(),true);
  await paste(['foto.png']);
  await page.waitForFunction(()=>state.attachments.filter(isImageAttachment).length===2);
  assert.deepEqual(await draftImages(),['foto.png','foto-2.png']);
  await tiles.nth(1).locator('img[src^="blob:"]').waitFor();

  // Invio: il backend riceve le immagini in base64 accanto al testo e ai file.
  await page.fill('#composer-input','Cosa vedi?');await page.click('#composer-send');
  await page.waitForFunction(()=>window.__runs.a);
  const sent=await page.evaluate(()=>window.__runs.a.args.attachments);
  assert.deepEqual(sent.map(f=>[f.name,f.mime_type??null,f.data===undefined?null:f.data.length]),[['note.txt',null,null],['foto.png','image/png',PNG.length],['foto-2.png','image/png',PNG.length]]);
  assert.ok(sent.filter(f=>f.data).every(f=>f.data===PNG&&f.content===''));
  assert.equal(await page.locator('#composer-attachments .image-tile').count(),0);
  const mine=page.locator('#messages .msg--user').last();
  await mine.locator('.message-images .image-thumb img[src^="blob:"]').first().waitFor();
  assert.equal(await mine.locator('.message-images .image-thumb').count(),2);
  assert.equal(await mine.locator('.message-attachments .attachment-chip').textContent(),'note.txt');
  assert.equal(await mine.locator('.msg__text').textContent(),'Cosa vedi?');

  // Visore: si apre dalla miniatura, le frecce scorrono (in cerchio), Esc chiude e ridà il focus.
  const thumb=mine.getByRole('button',{name:'Apri immagine: foto.png',exact:true});
  await thumb.click();await viewer.waitFor();
  assert.equal(await viewer.evaluate(d=>d.open),true);
  assert.deepEqual([await viewer.locator('#image-viewer-name').textContent(),await viewer.locator('.image-viewer__count').textContent()],['foto.png','1 / 2']);
  assert.match(await viewer.locator('.image-viewer__image').getAttribute('src'),/^blob:/);
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Chiudi');
  await page.keyboard.press('ArrowRight');
  assert.deepEqual([await viewer.locator('#image-viewer-name').textContent(),await viewer.locator('.image-viewer__count').textContent()],['foto-2.png','2 / 2']);
  await page.keyboard.press('ArrowRight');
  assert.equal(await viewer.locator('.image-viewer__count').textContent(),'1 / 2');
  await viewer.getByRole('button',{name:'Immagine precedente',exact:true}).click();
  assert.equal(await viewer.locator('.image-viewer__count').textContent(),'2 / 2');
  await page.keyboard.press('Escape');await viewerClosed();
  assert.equal(await thumb.evaluate(el=>el===document.activeElement),true);
  assert.equal(await viewer.locator('.image-viewer__image').getAttribute('src'),null);

  // Le immagini restituite da un tool (es. screenshot del browser) compaiono nel passaggio espanso.
  const step={kind:'tool',id:'t1',at:5,action:'browser_screenshot',arguments:{url:'https://example.com'}};
  await progress('__activity',{...step,status:'running'});
  await progress('__tool_images',{id:'t1',at:5,images:[{mime_type:'image/png',data:PNG},{mime_type:'text/plain',data:'eA=='}]});
  await progress('__activity',{...step,status:'completed',output:'{"ok":true}'});
  const live=page.locator('#messages .msg--stream');
  await live.locator('.turn-step[data-step-id="t1"]').waitFor({state:'attached'});
  await live.locator('.turn-history').evaluate(d=>{d.open=true;});
  await live.locator('.turn-step[data-step-id="t1"]').evaluate(d=>{d.open=true;});
  const toolThumbs=live.locator('.turn-step[data-step-id="t1"] .turn-step__images .turn-step__image');
  await toolThumbs.first().locator('img[src^="blob:"]').waitFor();
  assert.equal(await toolThumbs.count(),1);
  await toolThumbs.first().click();await viewer.waitFor();
  assert.equal(await viewer.locator('#image-viewer-name').textContent(),'Immagine dello strumento 1');
  assert.equal(await viewer.locator('.image-viewer__nav--next').isHidden(),true);
  await viewer.getByRole('button',{name:'Chiudi',exact:true}).click();await viewerClosed();

  // A fine turno il passaggio salvato mostra ancora le immagini del tool (per questa sessione).
  await page.evaluate(step=>window.__runs.a.finish('Vedo una pagina di esempio.',[{...step,status:'completed',output:'{"ok":true}',offset:0}]),step);
  await page.locator('#messages').getByText('Vedo una pagina di esempio.').waitFor();
  const reply=page.locator('#messages .msg--assistant').last();
  await reply.locator('.turn-history').evaluate(d=>{d.open=true;});
  await reply.locator('.turn-step[data-step-id="t1"]').evaluate(d=>{d.open=true;});
  assert.equal(await reply.locator('.turn-step__images .turn-step__image').count(),1);

  // Cambio chat mentre l'immagine si prepara: resta nella chat d'origine, e quella incollata
  // nell'altra chat aspetta il suo turno senza confondersi.
  await page.evaluate(()=>{window.__normalize=normalizeImage;window.__holds=[];window.normalizeImage=async(...args)=>{await new Promise(r=>window.__holds.push(r));return window.__normalize(...args);};});
  const release=async()=>{await page.waitForFunction(()=>window.__holds.length===1);await page.evaluate(()=>window.__holds.shift()());};
  await paste(['origine.png']);
  await skeletons.first().waitFor();
  assert.equal(await skeletons.getAttribute('aria-label'),"Preparo l'immagine…");
  assert.equal(await page.locator('#composer-send').isDisabled(),true);
  await open('b');
  assert.equal(await page.locator('#composer-attachments .image-tile').count(),0);
  assert.equal(await page.locator('#composer-send').isDisabled(),false);
  await paste(['altra.png']);await skeletons.first().waitFor();
  await release();
  await page.waitForFunction(()=>state.drafts.get('a')?.attachments.some(f=>f.name==='origine.png'));
  assert.equal(await tiles.count(),0);assert.equal(await skeletons.count(),1);
  await release();
  await tiles.first().locator('img[src^="blob:"]').waitFor();
  assert.deepEqual(await draftImages(),['altra.png']);assert.equal(await skeletons.count(),0);
  await open('a');
  assert.deepEqual(await draftImages(),['origine.png']);assert.equal(await skeletons.count(),0);
  await page.evaluate(()=>{window.normalizeImage=window.__normalize;});

  // Oltre 8 immagini per messaggio le eccedenti vengono scartate con un messaggio chiaro.
  await paste(Array.from({length:8},(_,i)=>`lotto-${i+1}.png`));
  await page.waitForFunction(()=>!imageJobs.size);
  assert.equal((await draftImages()).length,8);assert.equal(await tiles.count(),8);
  assert.equal(await status(),locales['errors.invalid_attachments']);
  assert.equal(await page.locator('#composer-send').isDisabled(),false);

  // Un file che non e un'immagine valida non entra e lo dice.
  await open('b');
  await paste(['rotto.png'],{body:'non sono un png'});
  await page.waitForFunction(()=>!imageJobs.size);
  assert.equal(await status(),locales['errors.image_unreadable']);
  assert.deepEqual(await draftImages(),['altra.png']);

  // Messaggio di sola immagine: nessun fumetto di testo vuoto e niente "Copia" a vuoto.
  await page.click('#composer-send');
  await page.waitForFunction(()=>window.__runs.b);
  assert.equal(await page.evaluate(()=>window.__runs.b.args.content),'');
  const only=page.locator('#messages .msg--user').last();
  await only.locator('.message-images--single .image-thumb img[src^="blob:"]').waitFor();
  assert.equal(await only.locator('.msg__text').count(),0);
  assert.equal(await only.getByRole('button',{name:'Copia messaggio',exact:true}).count(),0);
  await page.evaluate(()=>window.__runs.b.finish('Ricevuta.'));
  await page.locator('#messages').getByText('Ricevuta.').waitFor();

  assert.deepEqual(errors,[]);
  console.log('image attachments ok');
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
