// Real browser, isolated project and mocked IPC. No installed client, account or network.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {readFileSync,mkdirSync} = require('node:fs');
const {resolve} = require('node:path');
const {pathToFileURL} = require('node:url');

(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true,ignoreDefaultArgs:['--hide-scrollbars']});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    const errors=[], requests=[];
    page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:/,route=>{requests.push(route.request().url());return route.abort();});
    const lang=readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8');
    await page.addInitScript(lang=>{
      if (window!==top) return;
      const root='C:\\Fixture\\Archivio video', png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
      const html=`<!doctype html><html lang="it"><head><title>Scheda delle riprese</title><link rel="stylesheet" href="scheda.css"></head><body>
        <nav>ARCHIVIO VIDEO &nbsp; / &nbsp; Scheda di lavorazione</nav><main><h1>La scena in stazione</h1><p>Tre inquadrature per raccontare la partenza, dal tabellone al treno che lascia la banchina.</p>
        <a href="#ordine">Ordine delle riprese</a> &nbsp; <a href="dati.json">Apri i dati delle clip</a><h2 id="ordine">Ordine delle riprese</h2>
        <ol><li><b>Il tabellone.</b> Tenere visibili l’orologio e il binario.</li><li><b>Il primo piano.</b> Verificare la messa a fuoco.</li><li><b>La partenza.</b> Chiudere sul cartello della stazione.</li></ol>
        <details><summary>Note di montaggio</summary><p>Mantenere il suono della stazione fra le clip.</p></details><img src="segno.png" alt=""></main></body></html>`;
      const files={'scheda riprese.html':html,'scheda.css':'body{margin:0;color:#222b32;background:#f5f6f7;font:16px/1.6 system-ui}nav{background:#20332d;color:white;padding:15px 28px;font-size:12px}main{padding:10px 28px}h1{font-size:30px}a{color:#235e55}li{margin:10px 0}summary{cursor:pointer}',
        'dati.json':'{\n  "scena": "Stazione",\n  "approvata": false,\n  "clip": [\n    { "inizio": 12, "nome": "Tabellone" },\n    { "inizio": 28, "nome": "Primo piano" },\n    { "inizio": 46, "nome": "Partenza" }\n  ]\n}',
        'overview.md':'# Diario di montaggio\r\n\r\n## Scena in stazione\r\n\r\n- Conservare il **suono ambiente** tra le clip.\r\n- Verificare il fuoco sul primo piano.\r\n\r\nLe durate sono in [dati.json](dati.json).\r\n',
        'riprese.xml':'<?xml version="1.0" encoding="UTF-8"?>\n<sequenza nome="Stazione">\n  <clip inizio="12" tipo="tabellone" />\n  <clip inizio="28" tipo="primo-piano" />\n  <clip inizio="46" tipo="partenza" />\n</sequenza>',
        '.gitattributes':'* text=auto eol=lf\n','segno.png':null,'esterno.txt':null};
      const config={firebase_email:'Studio-Demo@example.test',firebase_auth_set:true,api_key_set:true,models:['deepseek-flash'],active_model:'deepseek-flash'};
      const data={projects:[{id:'p',name:'Archivio video',source_folders:[root],conversations:[{id:'c',title:'Materiali della scena',created_at:2,updated_at:2,messages:[{role:'user',content:'Prepara i materiali per la scena in stazione.'},{role:'assistant',content:'Ho raccolto la scheda delle riprese, i dati delle clip e il diario di montaggio. Puoi aprire ogni file dal pannello Output.'}]}]}],conversations:[]};
      const listeners={};window.emit=(name,payload)=>{for(const fn of listeners[name]||[])fn({payload:{conversation_id:'c',...payload}});};
      window.__files=files;window.__reads=[];window.__saves=[];window.__nativeOpens=0;
      window.__TAURI__={window:{getCurrentWindow:()=>({async listen(n,fn){(listeners[n]||=[]).push(fn);return ()=>{};}})},core:{invoke:async(cmd,args)=>{
        if(cmd==='get_locale') return lang;
        if(['get_config','get_local_config'].includes(cmd))return config;
        if(['get_data','refresh_data'].includes(cmd))return structuredClone(data);
        if(cmd==='project_git' && args.action==='discover')return {repositories:[],truncated:false};
        if(cmd==='project_permission_mode')return 'ask';
        if(['list_shells','list_questions','list_approvals'].includes(cmd))return [];
        if(cmd==='browser_open') {window.__nativeOpens++;throw Error('Local paths must not be sent to the web');}
        if(cmd==='preview_project_path'||cmd==='save_project_markdown') {
          if(args.project_id!=='p'||!args.path.startsWith(root+'\\')||args.path.endsWith('esterno.txt'))throw Error('outside_project');
          const name=args.path.slice(root.length+1);if(!(name in files))throw Error('file_unavailable');
          if(cmd==='save_project_markdown'){
            if(args.previous!==files[name])throw Error('file_edit_conflict');
            files[name]=args.content;window.__saves.push(name);return;
          }
          window.__reads.push(name);
          if(name==='segno.png')return {kind:'image',size:68,mime_type:'image/png',data:png};
          return {kind:'text',size:files[name].length,content:files[name],truncated:false};
        }
      }}};
      window.publish=(name)=>emit('artifact-created',{id:name,title:name,path:`\\\\?\\${root}\\${name}`,kind:'file',final_output:true});
    },lang);
    await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);
    await page.locator('#boot-splash').waitFor({state:'hidden'});
    await page.evaluate(()=>{['.gitattributes','segno.png','esterno.txt','riprese.xml','dati.json','overview.md','scheda riprese.html'].forEach(publish);});
    const shots=resolve(__dirname,'../../.artifact/file-preview');mkdirSync(shots,{recursive:true});
    const shot=name=>page.screenshot({path:resolve(shots,`${name}.png`)});
    const tab=name=>page.getByRole('tab',{name,exact:true});
    const view=page.locator('.file-preview:visible');
    const list=page.locator('#activity-panel-content');
    const openFromList=async name=>{await tab('Output').click();await list.getByRole('button',{name:new RegExp(name.replaceAll('.','\\.'))}).click();};
    const pressed=async(row,update)=>{
      await row.hover();await page.mouse.down();
      const before=await row.elementHandle();await page.evaluate(update);
      assert.equal(await before.evaluate(el=>el.isConnected&&el.matches(':hover')&&el===document.activeElement),true,'live update must leave the pressed button mounted');
      await page.mouse.up();
    };
    const htmlRow=page.locator('#activity-card [data-activity-focus="outputs:scheda riprese.html"]');
    await htmlRow.hover();
    assert.ok(await htmlRow.evaluate(button=>{
      emit('artifact-created',{id:'overview.md',title:'overview.md · revisione',kind:'file',path:'C:\\Fixture\\Archivio video\\overview.md',final_output:true});
      return button.isConnected && button.matches(':hover');
    }),'Changing a sibling preserves hover even before pointerdown');
    await pressed(htmlRow,()=>publish('nuovo arrivo.txt'));
    const frame=view.frameLocator('iframe');
    await frame.getByRole('heading',{name:'La scena in stazione'}).waitFor();
    assert.equal(await view.locator('iframe').evaluate(el=>el.sandbox.contains('allow-scripts')),false);
    assert.equal(await frame.locator('nav').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(32, 51, 45)');
    assert.ok(await frame.locator('img').evaluate(el=>el.complete&&el.naturalWidth===1));
    await frame.locator('summary').click();assert.ok(await frame.locator('details').evaluate(el=>el.open));
    assert.match(await page.locator('#browser-address').inputValue(),/file:\/\/\/C:\/Fixture\/Archivio%20video\/scheda%20riprese\.html/);
    await shot('html');
    await frame.getByRole('link',{name:'Apri i dati delle clip'}).click();await view.locator('.file-code').waitFor();
    assert.equal(await view.locator('.file-code').textContent(),await page.evaluate(()=>__files['dati.json']));
    assert.equal(await view.locator('.file-token--key').first().textContent(),'"scena"');
    await shot('json');
    await page.locator('#activity-card [data-activity-focus="group:outputs"]').click();
    await pressed(list.getByRole('button',{name:/overview\.md/}),()=>emit('artifact-created',{id:'overview.md',title:'overview.md',bytes:256,kind:'file',path:'C:\\Fixture\\Archivio video\\overview.md',final_output:true}));
    await view.getByRole('heading',{name:'Diario di montaggio'}).waitFor();
    const markdownIcon=page.locator('.panel-tab.is-active .file-icon');
    assert.equal(await markdownIcon.getAttribute('data-file-icon'),'BookOpen');
    await tab('Output').click();
    const outputIcon=list.getByRole('button',{name:/overview\.md/}).locator('.file-icon');
    assert.equal(await outputIcon.getAttribute('data-file-icon'),'BookOpen');
    assert.equal(await outputIcon.evaluate(el=>getComputedStyle(el).color),'rgb(160, 201, 236)');
    await shot('shared-file-icons');
    await openFromList('riprese.xml');await tab('overview.md').click();await page.click('#panel-expand');
    const glyphs=await page.locator('#panel-tabs .panel-tab__icon').evaluateAll(nodes=>nodes.map(el=>el.querySelector('svg').innerHTML));
    assert.equal(new Set(glyphs).size,glyphs.length,'HTML, JSON, XML, Markdown and the output list have distinct glyphs');
    for (const name of ['Anteprima','Sorgente']) {
      const control=view.getByRole('button',{name,exact:true});
      assert.equal(await control.innerText(),'');assert.equal(await control.getAttribute('title'),name);
      assert.equal(await control.locator('svg').count(),1);
    }
    await shot('markdown');
    await view.getByRole('button',{name:'Sorgente'}).click();
    const editor=view.locator('textarea');await editor.press('Control+End');await editor.pressSequentially('Verificare i raccordi.');
    await shot('markdown-edit');
    await page.click('#panel-expand');
    await tab('dati.json').click();await tab('overview.md').click();assert.match(await editor.inputValue(),/raccordi\.$/);
    await editor.press('Control+s');await page.waitForFunction(()=>__saves.length===1);
    assert.ok(await page.evaluate(()=>__files['overview.md'].includes('\r\n')));
    await editor.fill('Bozza non salvata');await page.evaluate(()=>{__files['overview.md']='Modifica esterna';});
    await view.getByRole('button',{name:'Salva',exact:true}).click();
    await page.locator('#browser-status').getByText(/cambiato sul disco/).waitFor();
    assert.equal(await editor.inputValue(),'Bozza non salvata');
    page.once('dialog',dialog=>dialog.dismiss());await page.locator('.panel-tab.is-active .panel-tab__close').click();
    assert.ok(await editor.isVisible());
    await openFromList('riprese.xml');await view.locator('.file-token--tag').first().waitFor();await shot('xml');
    await openFromList('.gitattributes');assert.equal(await view.locator('.file-lines').textContent(),'1\n2');
    await openFromList('segno.png');await view.locator('.file-image').click();await page.locator('dialog.image-viewer[open]').waitFor();await page.keyboard.press('Escape');
    await openFromList('esterno.txt');await page.locator('#browser-status').getByText(/cartelle del progetto/).waitFor();
    assert.equal(await page.evaluate(()=>__nativeOpens),0);
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
    console.log('PASS stable press in summary/list; HTML with local CSS, image and internal links; numbered JSON/XML/text; Markdown edit, explicit save, CRLF and conflict; image zoom and denied paths.');
  } finally {await browser.close();}
})().catch(err=>{console.error(err);process.exitCode=1;});
