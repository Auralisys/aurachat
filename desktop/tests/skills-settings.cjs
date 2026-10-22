const {chromium} = require('playwright');
const {readFileSync, mkdirSync} = require('node:fs');
const {resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1200,height:900}});
    const errors = [];page.on('pageerror',e => errors.push(e.message));
    const strings = JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
    await page.addInitScript(({strings}) => {
      const config = {firebase_email:'demo@example.com',firebase_project_id:'demo',firebase_api_key:'demo',firebase_auth_set:true,api_key_set:true,models:['test'],active_model:'test'};
      const skills = [{name:'impeccable',description:'Design interfaces with care',id:'global:impeccable',root:0,path:'.agents/skills/impeccable/SKILL.md',scope:'global',enabled:true},
        {name:'review',description:'Review project code',id:'project:review',root:0,path:'.agents/skills/review/SKILL.md',scope:'project',enabled:true}];
      window.__calls=[];window.__toggleFail=false;window.__searchFail=false;window.__installFail=false;
      window.__TAURI__ = {window:{getCurrentWindow:() => ({async listen(){return () => {};}})},core:{invoke:async(cmd,args={}) => {
        __calls.push({cmd,args});
        if (cmd==='get_locale') return JSON.stringify(strings);
        if (['get_config','get_local_config'].includes(cmd)) return config;
        if (cmd==='get_data') return {projects:[{id:'p',name:'Project P',conversations:[]}],conversations:[]};
        if (cmd==='speech_model_status') return {ready:false,busy:false,downloaded:0,total:1};
        if (cmd==='project_skills') return {skills:structuredClone(skills.filter(s => (s.scope==='global'||args.project_id==='p') && (args.include_disabled||s.enabled))),truncated:false};
        if (cmd==='set_skill_enabled') {
          if (__toggleFail) throw new Error('Unable to save skill preference');
          skills.find(s => s.id===args.id).enabled=args.enabled;return;
        }
        if (cmd==='search_skills') {
          if (__searchFail) throw new Error('Directory offline');
          return {skills:args.query==='none' ? [] : [{name:'new-skill',source:'example/skills'}]};
        }
        if (cmd==='install_skill') {
          if (__installFail) throw new Error('Node.js unavailable');
          skills.push({name:args.name,description:'New skill',id:'global:new',root:0,path:`.agents/skills/${args.name}/SKILL.md`,scope:'global',enabled:true});
        }
      }}};
    },{strings});
    await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);
    await page.locator('#boot-splash').waitFor({state:'hidden'});
    assert.equal(await page.locator('#view-chat').isVisible(),true,JSON.stringify(errors));
    await page.click('#btn-settings');await page.click('[data-settings-tab=skills]');
    const rows=page.locator('#skills-installed .skill-setting-row');
    await rows.first().waitFor();assert.equal(await rows.count(),1);
    const toggle=rows.first().getByRole('switch');
    assert.equal(await toggle.isChecked(),true);await toggle.uncheck();
    await page.waitForFunction(() => __calls.some(c => c.cmd==='set_skill_enabled' && !c.args.enabled));
    await page.click('#skills-refresh');await rows.first().waitFor();assert.equal(await toggle.isChecked(),false);
    await page.evaluate(() => __toggleFail=true);await toggle.click();
    await page.locator('#skills-settings-error').waitFor({state:'visible'});
    assert.equal(await toggle.isChecked(),false);
    await page.evaluate(() => __toggleFail=false);await toggle.check();
    await page.selectOption('#skills-project','p');await page.waitForFunction(() => document.querySelectorAll('#skills-installed .skill-setting-row').length===2);
    await page.fill('#skills-query','impeccable');assert.equal(await rows.count(),1);
    await page.fill('#skills-query','none');assert.equal(await rows.count(),0);
    assert.equal(await page.locator('#skills-search-directory').isEnabled(),true);
    await page.click('#skills-search-directory');await page.waitForFunction(text => document.querySelector('#skills-settings-status').textContent===text,strings['skills.directory_empty']);
    await page.fill('#skills-query','new');await page.click('#skills-search-directory');
    const install=page.locator('#skills-directory button');await install.waitFor();
    page.once('dialog',d => d.dismiss());await install.click();
    assert.equal(await page.evaluate(() => __calls.filter(c => c.cmd==='install_skill').length),0);
    await page.evaluate(() => __installFail=true);page.once('dialog',d => d.accept());await install.click();
    await page.waitForFunction(() => document.querySelector('#skills-settings-error').textContent.includes('Node.js'));
    assert.equal(await install.isEnabled(),true);
    await page.evaluate(() => __installFail=false);page.once('dialog',d => d.accept());await install.click();
    await page.waitForFunction(() => document.querySelectorAll('#skills-installed .skill-setting-row').length===3);
    assert.equal(await rows.filter({hasText:'/new-skill'}).getByRole('switch').isChecked(),true);
    const shots=process.env.AURACHAT_TEST_SHOTS || resolve(__dirname,'../../.artifact/settings');
    mkdirSync(shots,{recursive:true});
    await page.screenshot({path:resolve(shots,'skills-desktop.png')});
    await page.setViewportSize({width:520,height:780});
    await page.screenshot({path:resolve(shots,'skills-compact.png')});
    assert.equal(await page.evaluate(() => document.querySelector('.settings-content').scrollWidth<=document.querySelector('.settings-content').clientWidth),true);
    await page.fill('#skills-query','error');await page.evaluate(() => __searchFail=true);await page.click('#skills-search-directory');
    await page.waitForFunction(() => document.querySelector('#skills-settings-error').textContent.includes('Directory offline'));
    assert.equal(await page.locator('#skills-search-directory').isEnabled(),true);
    assert.deepEqual(errors,[]);
    console.log('PASS global/project settings, persisted toggles, rollback, local filtering, directory search/empty/error, install confirmation/failure/success, enabled default and responsive layout.');
  } finally {await browser.close();}
})().catch(e => {console.error(e);process.exit(1);});
