const { chromium } = require('playwright');
const { readFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
(async () => {
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1080,height:880},reducedMotion:'reduce'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
 await page.addInitScript(({locales})=>{
  window.__store=sessionStorage.getItem('empty') ? {projects:[],conversations:[]} : {projects:[{id:'p',name:'Website',source_folders:['C:\\Work\\Website'],conversations:[{id:'c',title:'Identita del prodotto',created_at:1,updated_at:1,context_tokens:0,messages:[]}]}],conversations:[]};
  window.__grants={p:['C:\\Work\\Website']};window.__calls=[];
  const config={firebase_email:'demo@example.com',firebase_project_id:'demo',firebase_api_key:'demo',firebase_auth_set:true,api_key_set:true,models:['deepseek-flash'],active_model:'deepseek-flash'};
  window.__TAURI__={window:{getCurrentWindow:()=>({close(){},minimize(){},async listen(){return ()=>{};}})},core:{invoke:async(cmd,args)=>{
   window.__calls.push({cmd,args});
   if(cmd==='get_locale')return JSON.stringify(locales);
   if(['get_local_config','get_config'].includes(cmd))return config;
   if(cmd==='get_data')return structuredClone(window.__store);
   if(cmd==='save_data'){
    if(window.__failSave){window.__failSave=false;throw new Error('Test network unavailable');}
    window.__store=structuredClone(args.data);return structuredClone(args.data);
   }
   if(cmd==='project_folder_access')return window.__grants[args.project_id]||[];
   if(cmd==='choose_project_folder'){
    const path=window.__nextFolder===undefined?'C:\\Work\\New app':window.__nextFolder;
    if(path){const paths=window.__grants[args.project_id]||=[];if(!paths.includes(path))paths.push(path);}
    return path;
   }
   if(cmd==='prune_folder_access'){
    for(const [id,paths] of Object.entries(window.__grants)){
     const project=window.__store.projects.find(p=>p.id===id);
     window.__grants[id]=project?paths.filter(path=>project.source_folders.includes(path)):[];
    }
   }
   if(cmd==='chat'){
    const tree=structuredClone(window.__store);
    const chat=[...tree.conversations,...tree.projects.flatMap(p=>p.conversations)].find(c=>c.id===args.conversation_id);
    chat.messages=[{role:'user',content:args.content},{role:'assistant',content:'Risposta di prova.'}];chat.title=args.content;window.__store=tree;
    return {data:tree,messages:chat.messages,usage:{prompt_tokens:1,completion_tokens:1}};
   }
  }}};
 },{locales});
 const shots=resolve(__dirname,'../../.artifact/project-model');mkdirSync(shots,{recursive:true});
 const url=pathToFileURL(resolve(__dirname,'../ui/index.html')).href;
 await page.goto(url);await page.locator('#boot-splash').waitFor({state:'hidden'});
 assert.equal(await page.locator('.tree-folder').count(),0);
 const section=page.locator('#projects-section'), recent=page.locator('#recents-section');
 await page.locator('#composer-input').hover();
 assert.equal(await section.locator('.section-actions').evaluate(el=>getComputedStyle(el).opacity),'0');
 await section.locator(':scope > summary').hover();
 assert.equal(await section.locator('.section-actions').evaluate(el=>getComputedStyle(el).opacity),'1');
 await section.locator('.section-label').click();assert.equal(await page.locator('#sidebar-tree').isVisible(),false);
 await section.locator('.section-label').click();
 await recent.locator('.section-label').click();assert.equal(await page.locator('#recent-chats').isVisible(),false);
 await recent.locator('.section-label').click();
 const original=page.locator('[data-project-id="p"]');
 await original.locator('summary').hover();await page.locator('#project-preview').waitFor({state:'visible'});
 assert.match(await page.locator('#project-preview').innerText(),/C:\\Work\\Website/);
 await page.screenshot({path:resolve(shots,'project-hover-desktop.png')});
 await page.keyboard.press('Escape');
 await original.getByRole('button',{name:'Opzioni',exact:true}).first().click();
 const menu=page.locator('#tree-menu');
 assert.match(await menu.innerText(),/1 chat/);assert.match(await menu.innerText(),/Modifica progetto/);
 assert.equal(await menu.getByText('Nuova cartella',{exact:true}).count(),0);
 await menu.getByRole('menuitem',{name:'Modifica progetto',exact:true}).click();
 const dialog=page.locator('#project-dialog');await dialog.waitFor({state:'visible'});
 await page.getByText('Lettura consentita su questo dispositivo',{exact:true}).waitFor();
 await page.screenshot({path:resolve(shots,'edit-project-desktop.png')});
 await page.fill('#project-name-input','Website aggiornato');
 await page.evaluate(()=>window.__failSave=true);await page.click('#project-save');
 await page.locator('#project-error').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>window.__store.projects[0].name),'Website');
 await page.click('#project-save');await dialog.waitFor({state:'hidden'});
 assert.equal(await page.evaluate(()=>window.__store.projects[0].name),'Website aggiornato');
 // Canceling or denying folder selection cannot create a project or grant.
 await page.evaluate(()=>window.__nextFolder=null);
 await section.locator(':scope > summary').hover();await page.click('#btn-new-project');
 await dialog.waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#project-add-source').disabled);
 assert.equal(await page.locator('#project-save').isDisabled(),true);
 assert.equal(await page.evaluate(()=>window.__store.projects.length),1);
 await page.click('#project-cancel');await dialog.waitFor({state:'hidden'});
 // The picker is the first action of project creation, then its name is editable.
 await page.evaluate(()=>delete window.__nextFolder);
 await section.locator(':scope > summary').hover();await page.click('#btn-new-project');
 await page.waitForFunction(()=>document.querySelector('#project-name-input').value==='New app');
 assert.equal(await page.locator('#project-save').isDisabled(),false);
 await page.fill('#project-name-input','AuraChat');await page.click('#project-save');await dialog.waitFor({state:'hidden'});
 const newId=await page.evaluate(()=>window.__store.projects[1].id);
 const project=page.locator(`[data-project-id="${newId}"]`);
 assert.equal(await page.evaluate(()=>window.__store.projects[1].conversations.length),0);
 assert.equal(await page.evaluate(()=>Object.hasOwn(window.__store.projects[1],'folders')),false);
 assert.equal(await project.getByText('Avvia la prima chat',{exact:true}).isVisible(),true);
 const savesBefore=await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='save_data').length);
 await project.locator('summary').hover();await project.locator('summary').getByRole('button',{name:'Nuova chat',exact:true}).click();
 assert.equal(await page.locator('#project-name').innerText(),'AuraChat');
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='save_data').length),savesBefore);
 await page.fill('#composer-input','Una chat diretta nel progetto');await page.click('#composer-send');
 await page.locator('#messages').getByText('Risposta di prova.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__store.projects[1].conversations.length),1);
 assert.equal(await page.evaluate(()=>window.__store.conversations.length),0);
 // Row chat menu, section menu and collapsed project survive subsequent renders.
 await original.locator('summary').click();assert.equal(await original.getAttribute('open'),null);
 await page.locator('#recent-chats .tree-conv').first().click({button:'right'});
 await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Elimina');
 await page.keyboard.press('Escape');
 await recent.locator(':scope > summary').hover();await page.click('#recents-options');
 await menu.getByRole('menuitem',{name:'Nuova chat',exact:true}).click();
 assert.equal(await page.locator('#project-name').innerText(),'Senza progetto');
 assert.equal(await original.getAttribute('open'),null);
 // Adding a real source never creates a virtual chat grouping; removing it keeps chats.
 await project.locator('summary').hover();await project.locator('summary').getByRole('button',{name:'Opzioni',exact:true}).click();
 await menu.getByRole('menuitem',{name:'Modifica progetto',exact:true}).click();
 await page.evaluate(()=>window.__nextFolder='C:\\Work\\Shared assets');await page.click('#project-add-source');
 await page.waitForFunction(()=>document.querySelectorAll('.project-source').length===2);
 await page.locator('.project-source').first().getByRole('button',{name:'Rimuovi dal progetto',exact:true}).click();
 await page.setViewportSize({width:720,height:680});await page.screenshot({path:resolve(shots,'edit-project-compact.png')});
 await page.click('#project-save');await dialog.waitFor({state:'hidden'});
 assert.deepEqual(await page.evaluate(()=>window.__store.projects[1].source_folders),['C:\\Work\\Shared assets']);
 assert.equal(await page.evaluate(()=>window.__store.projects[1].conversations.length),1);
 assert.deepEqual(await page.evaluate(id=>window.__grants[id],newId),['C:\\Work\\Shared assets']);
 // Empty sections offer one aligned action without a redundant empty label.
 await page.evaluate(()=>sessionStorage.setItem('empty','1'));await page.reload();await page.locator('#boot-splash').waitFor({state:'hidden'});
 assert.equal(await section.locator('.tree-empty').count(),0);
 assert.equal(await recent.locator('.tree-empty').count(),0);
 assert.equal(await section.getByRole('button',{name:'Crea progetto',exact:true}).isVisible(),true);
 assert.equal(await recent.locator('#recent-chats').getByRole('button',{name:'Nuova chat',exact:true}).isVisible(),true);
 const projectAction = await section.locator('.tree-empty-action').boundingBox();
 const recentAction = await recent.locator('.tree-empty-action').boundingBox();
 assert.equal(projectAction.x,recentAction.x);
 await page.screenshot({path:resolve(shots,'empty-sections-compact.png')});
 assert.equal(await page.locator('svg:not(.ui-icon)').count(),0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);await browser.close();
 console.log('PASS: collapsible headers/hover actions, distinct empty states, source-folder picker/consent contract, project editing, direct draft chats, preservation, save rollback and compact layout; mocked native dialogs and backend.');
})().catch(e=>{console.error(e);process.exit(1)});
