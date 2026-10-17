const { chromium } = require('playwright');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1080,height:880}});
 const strings=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
 const config={firebase_email:'',firebase_project_id:'demo',firebase_api_key:'demo',firebase_auth_set:false,api_key_set:false,models:['DeepSeek'],active_model:'DeepSeek'};
 const data={projects:[{id:'p',name:'Project',source_folders:[],conversations:[{id:'c',title:'Saved chat',updated_at:1,messages:[]}]}]};
 let offline=false, saves=0, logins=0;
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('mockInvoke',async(cmd,args)=>{
  if(cmd==='get_locale')return JSON.stringify(strings);
  if(cmd==='get_local_config')return config;
  if(cmd==='get_config'){if(offline)throw new Error('Firestore network unavailable');return config;}
  if(cmd==='login'){logins++;if(args.password!=='valid-password')throw new Error('Invalid credentials');Object.assign(config,{firebase_email:args.email,firebase_auth_set:true});return config;}
  if(cmd==='save_config'){saves++;assert.equal(args.input.firebase_password,null);assert.ok(args.input.api_key);config.api_key_set=true;return config;}
  if(cmd==='get_data')return data;
  if(cmd==='save_data'){saves++;return args.data;}
 });
 await page.addInitScript(()=>window.__TAURI__={core:{invoke:(cmd,args)=>window.mockInvoke(cmd,args)},window:{getCurrentWindow:()=>({close(){},minimize(){},async listen(){return ()=>{};}})}});
 const url=pathToFileURL(resolve(__dirname,'../ui/index.html')).href;
 await page.goto(url);await page.locator('#login-form').waitFor({state:'visible'});
 assert.equal(await page.locator('#onboarding-form-slot').isVisible(),false);
 await page.fill('#login-form [name=email]','demo@example.com');await page.fill('#login-form [name=password]','wrong-password');await page.click('#login-form button');
 await page.locator('#login-error').waitFor({state:'visible'});assert.equal(config.firebase_auth_set,false);
 await page.fill('#login-form [name=password]','valid-password');await page.click('#login-form button');
 await page.locator('#onboarding-form-slot').waitFor({state:'visible'});
 assert.equal(await page.locator('#onboarding-form-slot [name=firebase_project_id]').isVisible(),false);
 assert.equal(await page.locator('#onboarding-form-slot [name=firebase_password]').isVisible(),false);
 await page.fill('#onboarding-form-slot [name=api_key]','test-not-a-real-key');await page.click('#onboarding-form-slot button');
 await page.locator('#sidebar').waitFor({state:'visible'});assert.equal(saves,1);
 await page.reload();await page.locator('#sidebar').waitFor({state:'visible'});assert.equal(logins,2);assert.equal(saves,1);
 offline=true;await page.reload();await page.locator('#restore-error').waitFor({state:'visible'});
 assert.equal(await page.locator('#onboarding-form-slot').isVisible(),false);assert.equal(saves,1);
 offline=false;await page.click('#retry-session');await page.locator('#sidebar').waitFor({state:'visible'});
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS: email/password only, failed login, first configuration, automatic restore on reload, network failure preserves account, retry.');
})().catch(e=>{console.error(e);process.exit(1)});
