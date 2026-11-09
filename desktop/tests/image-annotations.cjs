// Annotazioni sulle immagini e browser interno: editor, invio, visore, cattura della pagina e link della chat.
const {chromium}=require('playwright');
const {readFileSync}=require('node:fs');const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
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
      if(cmd==='speech_model_status')return {ready:true,busy:false,loading:false,loaded:true,downloaded:1,total:1};
      if(['get_data','refresh_data'].includes(cmd))return structuredClone(window.__data);
      if(cmd==='list_shells')return [];if(cmd==='get_conversation')return {...structuredClone(conversation(args.conversation_id)),messages_loaded:true};if(cmd==='save_data'){window.__data=structuredClone(args.data);return structuredClone(window.__data);}
      if(cmd==='browser_open'){const url=args.url.includes('://')?args.url:`https://${args.url}/`;return {url,capture:true};}
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
  await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);await page.locator('#boot-splash').waitFor({state:'hidden'});
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

  // Browser interno: il globo apre il pannello vuoto con l'indirizzo a fuoco.
  await page.click('#browser-toggle');
  assert.equal(await page.locator('#browser-panel').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'browser-address');
  assert.equal(await page.locator('#browser-empty').isVisible(),true);
  assert.equal(await page.locator('#activity-dock').evaluate(d=>d.classList.contains('is-visible')),false);
  await page.fill('#browser-address','example.com');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.__calls.some(call=>call.cmd==='browser_open'));
  const opened=(await calls('browser_open'))[0];
  const view=await page.locator('#browser-view').boundingBox();
  assert.equal(opened.url,'example.com');
  assert.deepEqual(opened.bounds,{x:Math.round(view.x),y:Math.round(view.y),width:Math.round(view.width),height:Math.round(view.height)});
  await page.evaluate(()=>window.__events['browser-state']({payload:{url:'https://example.com/',title:'Example',loading:true}}));
  assert.equal(await page.locator('#browser-progress').isVisible(),true);
  assert.equal(await page.locator('#browser-reload').getAttribute('aria-label'),'Interrompi caricamento');
  await page.evaluate(()=>window.__events['browser-state']({payload:{url:'https://example.com/',title:'Example',loading:false}}));
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

  // L'attività e il browser si alternano sul lato destro.
  await page.click('#activity-toggle');
  assert.equal(await page.locator('#browser-panel').isHidden(),true);
  assert.equal(await page.locator('#activity-dock').evaluate(d=>d.classList.contains('is-visible')),true);
  assert.equal((await calls('browser_close')).length,1);
  await page.click('#browser-toggle');
  assert.equal(await page.locator('#activity-dock').evaluate(d=>d.classList.contains('is-visible')),false);
  await page.click('#browser-close');
  assert.equal(await page.locator('#browser-panel').isHidden(),true);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'browser-toggle');

  assert.deepEqual(errors,[]);
  await browser.close();
  console.log('image annotations and browser ok');
})().catch(error=>{console.error(error);process.exit(1);});
