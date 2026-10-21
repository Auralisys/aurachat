const { chromium } = require('playwright');
const { readFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
(async () => {
 const nativeWindow=JSON.parse(readFileSync(resolve(__dirname,'../src-tauri/tauri.conf.json'),'utf8')).app.windows[0];
 assert.equal(nativeWindow.decorations,true);
 const browser=await chromium.launch({channel:process.platform==='darwin'?'chrome':'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:480,height:320}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const strings=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
 await page.addInitScript(({strings})=>{
  const config={firebase_email:'demo@example.com',firebase_project_id:'demo',firebase_api_key:'demo',firebase_auth_set:true,api_key_set:true,models:['deepseek-flash'],active_model:'deepseek-flash'};
  window.__windowEvents={};window.__windowCalls=[];window.__saveCount=0;window.__inFlight=0;window.__maxInFlight=0;
  const appWindow={close(){},minimize(){},async listen(name,callback){window.__windowEvents[name]=callback;return ()=>{};}};
  window.__TAURI__={window:{getCurrentWindow:()=>appWindow},core:{invoke:async(cmd,args)=>{
   if(cmd==='get_locale')return JSON.stringify(strings);
   if(cmd==='get_local_config'||cmd==='get_config')return config;
   if(cmd==='restore_window'){
    window.__windowCalls.push({cmd,args,splashVisible:!document.querySelector('#boot-splash').hidden});
    if(window.__restoreBlocked!==false)await new Promise(r=>{window.__releaseRestore=r;});
    return;
   }
   if(cmd==='save_window_state'){
    window.__saveCount++;window.__inFlight++;window.__maxInFlight=Math.max(window.__maxInFlight,window.__inFlight);
    window.__windowCalls.push({cmd,splashVisible:!document.querySelector('#boot-splash').hidden});
    try{
     if(window.__blockNextSave){window.__blockNextSave=false;await new Promise(r=>{window.__releaseSave=r;});}
     if(window.__failSave){window.__failSave=false;throw new Error('offline');}
    }finally{window.__inFlight--;}
    return;
   }
   if(cmd==='get_data')return {projects:[],conversations:[]};
  }}};
 },{strings});
 await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);
 assert.equal(await page.locator('#btn-minimize, #btn-close, .titlebar__controls').count(),0);
 await page.waitForFunction(()=>window.__releaseRestore);
 assert.equal(await page.locator('#boot-splash').isVisible(),true);
 assert.equal(await page.evaluate(()=>window.__saveCount),0);
 assert.deepEqual(await page.evaluate(()=>window.__windowCalls[0]),{cmd:'restore_window',args:{restore_saved:true},splashVisible:true});
 const shots=resolve(__dirname,'../../.artifact/window-state');mkdirSync(shots,{recursive:true});
 await page.screenshot({path:resolve(shots,'splash-480x320.png')});
 await page.setViewportSize({width:1080,height:880});
 await page.evaluate(()=>{window.__restoreBlocked=false;window.__releaseRestore();});
 await page.locator('#boot-splash').waitFor({state:'hidden'});
 await page.locator('#view-chat').waitFor({state:'visible'});
 // A stream of resize/move notifications produces one save after it settles.
 await page.evaluate(()=>window.__windowEvents['window-geometry-changed']());
 await page.evaluate(()=>new Promise(r=>setTimeout(r,600)));
 assert.equal(await page.evaluate(()=>window.__saveCount),0);
 await page.evaluate(()=>{for(let i=0;i<20;i++)window.__windowEvents['window-geometry-changed']();});
 await page.evaluate(()=>new Promise(r=>setTimeout(r,600)));
 assert.equal(await page.evaluate(()=>window.__saveCount),0);
 await page.waitForFunction(()=>window.__saveCount===1);
 assert.equal(await page.evaluate(()=>window.__windowCalls.filter(c=>c.cmd==='save_window_state').every(c=>!c.splashVisible)),true);
 // New changes wait behind an in-flight save, preventing out-of-order writes.
 await page.evaluate(()=>{window.__blockNextSave=true;window.__windowEvents['window-geometry-changed']();});
 await page.waitForFunction(()=>window.__releaseSave);
 await page.evaluate(()=>window.__windowEvents['window-geometry-changed']());
 await page.waitForFunction(()=>document.querySelector('#boot-splash').hidden);
 // Wait for the actual debounce timer to enqueue the save behind the blocked request.
 await page.evaluate(()=>new Promise(r=>setTimeout(r,1050)));
 assert.equal(await page.evaluate(()=>window.__saveCount),2);
 await page.evaluate(()=>window.__releaseSave());
 await page.waitForFunction(()=>window.__saveCount===3);
 assert.equal(await page.evaluate(()=>window.__maxInFlight),1);
 await page.evaluate(()=>{window.__failSave=true;window.__windowEvents['window-geometry-changed']();});
 await page.getByText(strings['errors.window_save'],{exact:true}).waitFor({state:'visible'});
 await page.evaluate(()=>window.__windowEvents['window-geometry-changed']());
 await page.waitForFunction(()=>window.__saveCount===5);
 assert.deepEqual(errors,[]);
 await browser.close();console.log('PASS: splash excluded from saves, restore before reveal, resize/move debouncing, serialized writes, failed-save feedback and retry; mocked native window and Firestore.');
})().catch(e=>{console.error(e);process.exit(1)});
