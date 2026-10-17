const {chromium}=require('playwright');const {readFileSync}=require('node:fs');const {resolve}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
 await page.addInitScript(({locales})=>{
  window.__calls=[];window.__loads={};
  const config={firebase_email:'demo@example.com',firebase_auth_set:true,api_key_set:true,models:['test'],active_model:'test'};
  const summaries=['a','b'].map((id,i)=>({id,title:'Chat '+id,created_at:1,updated_at:2-i,context_tokens:50,messages:[],messages_loaded:false,revision:null}));
  window.__TAURI__={window:{getCurrentWindow:()=>({minimize(){},close(){},async listen(){return()=>{};}})},core:{invoke:async(cmd,args)=>{
   window.__calls.push({cmd,args});if(cmd==='get_locale')return JSON.stringify(locales);if(['get_config','get_local_config'].includes(cmd))return config;
   if(cmd==='get_data')return {projects:[],conversations:structuredClone(summaries)};
   if(cmd==='get_conversation')return new Promise((resolve,reject)=>window.__loads[args.conversation_id]={resolve:()=>resolve({...summaries.find(c=>c.id===args.conversation_id),messages_loaded:true,revision:'r1',messages:[{role:'user',content:'Domanda '+args.conversation_id},{role:'assistant',content:'Risposta '+args.conversation_id}]}),reject});
   if(cmd==='save_data')return args.data;
  }}};
 },{locales});
 await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);await page.locator('#boot-splash').waitFor({state:'hidden'});
 assert.equal(await page.locator('#composer-send').isDisabled(),true);
 assert.equal(await page.locator('.empty').count(),0);
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.cmd==='get_conversation').length),1);
 // Switching before a response cannot put one chat's messages in another chat.
 await page.getByRole('button',{name:'Chat b',exact:true}).click();await page.waitForFunction(()=>window.__loads.b);
 await page.evaluate(()=>window.__loads.a.resolve());assert.equal(await page.locator('#conversation-title').textContent(),'Chat b');
 await page.evaluate(()=>window.__loads.b.resolve());await page.locator('#messages').getByText('Risposta b',{exact:true}).waitFor();
 assert.equal(await page.getByText('Risposta a',{exact:true}).count(),0);assert.equal(await page.locator('#composer-send').isEnabled(),true);
 await page.getByRole('button',{name:'Chat a',exact:true}).click();await page.evaluate(()=>window.__loads.a.reject('incomplete_conversation'));
 await page.locator('#composer-status').waitFor({state:'visible'});assert.equal(await page.locator('#composer-send').isDisabled(),true);
 await page.getByRole('button',{name:'Chat a',exact:true}).click();await page.evaluate(()=>window.__loads.a.resolve());await page.locator('#messages').getByText('Risposta a',{exact:true}).waitFor();
 assert.equal(await page.locator('#composer-send').isEnabled(),true);assert.deepEqual(errors,[]);
 console.log('PASS: metadata-only startup, lazy loading, send blocked until loaded, navigation race isolation, load failure and retry; mocked Firestore.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
