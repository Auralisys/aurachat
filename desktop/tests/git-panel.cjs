// Native Git and model mocked; actual Git operations are covered by Rust temp-repo tests.
const {chromium}=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');
const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:960}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
    await page.addInitScript(({locales})=>{
      window.__events={};window.__calls=[];window.__pushed=false;window.__committed=false;window.__index=new Set();window.__revision=0;
      const data={projects:[{id:'p',name:'Progetto Git',source_folders:['C:\\fixture'],conversations:[{id:'c',title:'Git test',created_at:1,updated_at:1,messages:[
        {role:'user',content:'Prepara i file finali.'},
        {role:'assistant',content:'Fatto.',activity:[
          {kind:'tool',action:'write_project_file',status:'completed',output:JSON.stringify({path:'C:\\fixture\\scratch.md',written_bytes:10})},
          {kind:'tool',action:'edit_project_file',status:'completed',output:JSON.stringify({path:'C:\\fixture\\app.js',written_bytes:20})},
          {kind:'agent',title:'Report agent',activity:[{kind:'tool',action:'publish_project_output',status:'completed',output:JSON.stringify({path:'C:\\fixture\\report.md',written_bytes:50,final_output:true})}]}
        ]}
      ]}]}],conversations:[]};
      const config={firebase_email:'demo@example.com',firebase_project_id:'demo',firebase_api_key:'demo',firebase_auth_set:true,api_key_set:true,models:['test'],active_model:'test'};
      const stats=()=>({branch:'main',head:'abc',revision:String(__revision),upstream:'origin/main',ahead:window.__pushed?0:1,behind:0,added:window.__newFile?13:12,removed:3,files:window.__committed?[]:[
        {path:'report.md',status:__index.has('report.md')?'A ':'??',added:10,removed:0,binary:false,
          staged:__index.has('report.md')?{added:10,removed:0,binary:false}:null,unstaged:__index.has('report.md')?null:{added:10,removed:0,binary:false}},
        {path:'src/app.js',status:__index.has('src/app.js')?'MM':' M',added:2,removed:3,binary:false,
          staged:__index.has('src/app.js')?{added:1,removed:1,binary:false}:null,unstaged:{added:1,removed:2,binary:false}},
        ...(window.__newFile?[{path:'new.txt',status:__index.has('new.txt')?'A ':'??',added:1,removed:0,binary:false,staged:__index.has('new.txt')?{added:1,removed:0,binary:false}:null,unstaged:__index.has('new.txt')?null:{added:1,removed:0,binary:false}}]:[])
      ]});
      window.__TAURI__={window:{getCurrentWindow:()=>({minimize(){},close(){},async listen(name,fn){const previous=window.__events[name];window.__events[name]=event=>{previous?.(event);fn(event);};return()=>{};}})},core:{invoke:async(cmd,args)=>{
        window.__calls.push({cmd,args});
        if(cmd==='get_locale')return JSON.stringify(locales);
        if(['get_local_config','get_config'].includes(cmd))return config;
        if(cmd==='get_data')return structuredClone(data);
        if(cmd==='project_permission_mode')return 'auto';
        if(cmd==='speech_model_status')return {ready:false,busy:false};
        if(['list_shells','list_approvals','list_questions','project_folder_access'].includes(cmd))return [];
        if(cmd==='project_git'){
          if(args.action==='status')return stats();
          if(['stage','unstage'].includes(args.action)){
            if(window.__delayStage)await new Promise(resolve=>window.__finishStage=resolve);
            if(window.__failStage){window.__failStage=false;throw Error('Git: stage failed');}
            if(args.revision!==String(__revision))throw Error('Staging changed');
            for(const path of args.paths){if(args.action==='stage')__index.add(path);else __index.delete(path);}
            __revision++;return {revision:String(__revision)};
          }
          if(args.action==='preview')return {revision:'abc:tree',index_revision:String(__revision),diff:'diff --git a/report.md b/report.md\n+Final report'};
          if(args.action==='generate')return {revision:'abc:tree',index_revision:String(__revision),diff:'diff --git a/report.md b/report.md\n+Final report',message:'Add final report'};
          if(args.action==='commit'){if(window.__stale)throw new Error('Staging/HEAD changed after preview.');window.__committed=true;__index.clear();__revision++;return {head:'new'};}
          if(args.action==='push_preview')return {revision:'push-revision',remote:'origin',target:'refs/heads/main',head:'new'};
          if(args.action==='push'){if(window.__pushFail)throw new Error('Git: authentication failed');window.__pushed=true;return {head:'new'};}
        }
      }}};
    },{locales});
    await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);
    await page.locator('#boot-splash').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Git test',exact:true}).first().click();
    const card=page.locator('[data-activity-focus="group:git"]');
    await page.waitForFunction(()=>document.querySelector('.git-stats')?.textContent.includes('+12'));
    assert.match(await card.innerText(),/Cambiamenti.*\+12.*−3/s);
    assert.equal(await page.locator('.git-group button').count(),1);
    assert.equal(await page.locator('.git-group .activity-pill').count(),0);
    const shots=resolve(__dirname,'../../.artifact/git');mkdirSync(shots,{recursive:true});
    await card.hover();
    await page.screenshot({path:resolve(shots,'recap-desktop.png')});
    assert.equal(await page.locator('#activity-card [data-activity-focus="group:outputs"]').innerText(),'Output\n1');
    assert.equal(await page.locator('#activity-card').getByRole('button',{name:/scratch.md/}).count(),0);
    assert.equal(await page.locator('#activity-card .activity-group').first().getAttribute('class'),'activity-group git-group');
    assert.ok(await card.evaluate(el=>parseFloat(getComputedStyle(el).paddingLeft)>=8));
    assert.ok(await page.locator('#activity-card .activity-row').first().evaluate(el=>parseFloat(getComputedStyle(el).paddingLeft)>=8));
    await card.click();
    assert.equal(await page.locator('#activity-panel').isVisible(),false, 'Recap opens a dropdown, not full details');
    await page.getByRole('menuitem',{name:'Apri dettaglio completo',exact:true}).waitFor();
    await page.screenshot({path:resolve(shots,'changes-menu-desktop.png')});
    await page.evaluate(()=>{state.busy=true;__newFile=true;__events['chat-progress']({payload:{conversation_id:'c',kind:'__activity',text:JSON.stringify({id:'write-new',kind:'tool',action:'write_project_file',status:'completed'})}});renderActivity();});
    await page.waitForFunction(()=>gitView.data?.added===13,null,{timeout:1800});
    assert.equal(await page.getByRole('menuitem',{name:'Apri dettaglio completo',exact:true}).isVisible(),true,'Refresh does not close the menu');
    await page.evaluate(()=>{state.busy=false;});
    await page.getByRole('menuitem',{name:'Commit…',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Aggiungi allo stage'}).waitFor();
    assert.equal(await page.locator('#activity-panel input[type=checkbox]').count(),0);
    // Native acknowledgement can be slow: feedback is synchronous, other rows/chat stay usable,
    // queued requests use the preceding acknowledgement's revision, and a failure rolls back.
    await page.evaluate(()=>window.__delayStage=true);
    const feedback=await page.evaluate(()=>{
      const start=performance.now();gitStage('unstaged',['report.md']);
      return {ms:performance.now()-start,pending:!!document.querySelector('.git-file[aria-busy=true]'),working:gitView.working};
    });
    assert(feedback.ms<100,`Immediate feedback took ${feedback.ms}ms`);assert(feedback.pending);assert.equal(feedback.working,false);
    assert.equal(await page.getByRole('button',{name:'Aggiungi allo stage · new.txt',exact:true}).isEnabled(),true);
    await page.getByRole('button',{name:'Aggiungi allo stage · new.txt',exact:true}).click();
    assert.equal(await page.locator('.git-file[aria-busy=true]').count(),2);
    assert.equal(await page.getByRole('button',{name:'Commit…',exact:true}).isDisabled(),true);
    await page.fill('#composer-input','La chat resta utilizzabile');
    assert.equal(await page.locator('#composer-input').inputValue(),'La chat resta utilizzabile');
    await page.screenshot({path:resolve(shots,'staging-pending-desktop.png')});
    await page.setViewportSize({width:720,height:820});await page.screenshot({path:resolve(shots,'staging-pending-compact.png')});
    await page.setViewportSize({width:1440,height:960});
    await page.evaluate(()=>{window.__delayStage=false;window.__finishStage();});
    await page.waitForFunction(()=>!gitView.staging&&!gitView.loading);
    assert.equal(await page.evaluate(()=>__index.size),2);
    await page.getByRole('button',{name:'Unstage tutti',exact:true}).click();
    await page.waitForFunction(()=>!gitView.staging&&__index.size===0);
    await page.evaluate(()=>window.__failStage=true);
    await page.getByRole('button',{name:'Aggiungi allo stage · report.md',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Git: stage failed'}).waitFor();
    await page.waitForFunction(()=>!gitView.staging&&!gitView.loading);
    assert.equal(await page.evaluate(()=>__index.size),0);
    assert.equal(await page.getByRole('button',{name:'Aggiungi allo stage · report.md',exact:true}).isEnabled(),true);
    await page.getByRole('button',{name:'Aggiungi allo stage · report.md',exact:true}).click();
    await page.waitForFunction(()=>!gitView.staging);
    await page.locator('[data-git-side=staged] .git-file').first().waitFor();
    assert.equal(await page.locator('[data-git-side=staged] .git-file').count(),1);
    await page.getByRole('button',{name:'Stage tutti',exact:true}).click();
    await page.waitForFunction(()=>!gitView.staging&&gitView.data.files.filter(f=>f.staged).length===3);
    await page.getByRole('button',{name:'Unstage tutti',exact:true}).click();
    await page.waitForFunction(()=>!gitView.staging&&gitView.data.files.every(f=>!f.staged));
    await page.getByRole('button',{name:'Aggiungi allo stage · src/app.js',exact:true}).click();
    await page.waitForFunction(()=>!gitView.staging&&gitView.data.files.find(f=>f.path==='src/app.js')?.unstaged);
    assert.equal(await page.locator('[data-git-side=staged] .git-file').filter({hasText:'src/app.js'}).count(),1);
    assert.equal(await page.locator('[data-git-side=unstaged] .git-file').filter({hasText:'src/app.js'}).count(),1,'Partially staged files appear in both groups');
    await page.getByRole('button',{name:'Rimuovi dallo stage · src/app.js',exact:true}).click();
    await page.waitForFunction(()=>!gitView.staging);
    await page.getByRole('button',{name:'Aggiungi allo stage · report.md',exact:true}).click();
    await page.waitForFunction(()=>!gitView.staging);
    assert.equal(await page.getByRole('button',{name:'Conferma commit',exact:true}).count(),0);
    await page.getByRole('button',{name:'Commit…',exact:true}).click();
    await page.getByLabel('Messaggio del commit', {exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Conferma commit',exact:true}).isDisabled(),true);
    assert.equal(await page.evaluate(()=>__calls.filter(c=>c.cmd==='project_git'&&c.args.action==='commit').length),0);
    await page.getByRole('button',{name:'Genera con AI',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#git-message')?.value==='Add final report');
    await page.locator('#git-message').fill('Add reviewed final report');
    // Streaming/activity rerenders must not destroy an editable Git message.
    await page.evaluate(()=>{window.__messageNode=document.querySelector('#git-message');__messageNode.focus();__messageNode.setSelectionRange(3,7);renderActivity();});
    assert.equal(await page.evaluate(()=>__messageNode===document.querySelector('#git-message')),true);
    await page.evaluate(async()=>{__newFile=false;await refreshGit(true);});
    assert.equal(await page.evaluate(()=>__messageNode===document.activeElement&&__messageNode.selectionStart===3&&__messageNode.selectionEnd===7),true,'Background updates preserve editor focus and selection');
    await page.evaluate(async()=>{__revision++;await refreshGit(true);});
    assert.equal(await page.getByRole('button',{name:'Conferma commit',exact:true}).isDisabled(),true,'External staging invalidates the preview');
    assert.equal(await page.locator('#git-message').inputValue(),'Add reviewed final report');
    await page.getByRole('button',{name:'Commit…',exact:true}).click();
    assert.equal(await page.locator('#git-message').inputValue(),'Add reviewed final report');
    await page.evaluate(()=>{__newFile=true;});
    await page.waitForFunction(()=>gitView.data?.added===13,null,{timeout:2800});
    await page.evaluate(()=>window.__stale=true);
    await page.getByRole('button',{name:'Conferma commit',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Staging/HEAD changed'}).waitFor();
    assert.equal(await page.locator('#git-message').inputValue(),'Add reviewed final report');
    await page.evaluate(()=>window.__stale=false);
    await page.screenshot({path:resolve(shots,'review-desktop.png')});
    await page.setViewportSize({width:720,height:820});
    await page.screenshot({path:resolve(shots,'review-compact.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.setViewportSize({width:1440,height:960});
    await page.getByRole('button',{name:'Conferma commit',exact:true}).click();
    await page.getByText('Nessun cambiamento da salvare.',{exact:true}).waitFor();
    const commits=await page.evaluate(()=>__calls.filter(c=>c.cmd==='project_git'&&c.args.action==='commit'));
    assert.equal(commits.at(-1).args.paths,undefined,'Commit never stages working files');
    assert.equal(commits.at(-1).args.message,'Add reviewed final report');
    await page.getByRole('button',{name:'Push',exact:true}).click();
    await page.locator('#git-push-confirm').waitFor();
    assert.equal(await page.evaluate(()=>__pushed),false);
    await page.locator('#git-push-confirm').getByRole('button',{name:'Annulla',exact:true}).click();
    assert.equal(await page.evaluate(()=>__pushed),false);
    await page.evaluate(()=>window.__pushFail=true);
    await page.getByRole('button',{name:'Push',exact:true}).click();
    await page.locator('#git-push-confirm').getByRole('button',{name:'Push',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'authentication failed'}).waitFor();
    assert.equal(await page.evaluate(()=>__committed),true);
    await page.evaluate(()=>window.__pushFail=false);
    await page.getByRole('button',{name:'Push',exact:true}).click();
    await page.locator('#git-push-confirm').getByRole('button',{name:'Push',exact:true}).click();
    await page.waitForFunction(()=>__pushed&&!gitView.working);
    await page.evaluate(()=>{__committed=false;__pushed=false;});
    await page.getByRole('button',{name:'Aggiorna',exact:true}).click();
    await page.getByRole('button',{name:'Aggiungi allo stage · report.md',exact:true}).click();
    await page.waitForFunction(()=>!gitView.staging);
    await page.getByRole('button',{name:'Altre azioni Git',exact:true}).click();
    await page.getByRole('menuitem',{name:'Commit e push…',exact:true}).click();
    await page.getByRole('button',{name:'Conferma commit, poi push…',exact:true}).waitFor();
    await page.click('#activity-close');
    await page.setViewportSize({width:720,height:820});
    await page.locator('[data-activity-focus="group:git"]').click();
    await page.getByRole('menuitem',{name:'Apri dettaglio completo',exact:true}).waitFor();
    await page.screenshot({path:resolve(shots,'changes-menu-compact.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
    console.log('PASS Git dropdown above Output, padded hover, prompt active-turn/event and external-file updates, real stage/unstage groups and bulk actions without checkboxes, partial staging, stable editable messages, stale protection, confirmed commit/push and compact layout.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
