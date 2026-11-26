const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const locales = JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
  const open = async (latest) => {
    const page = await browser.newPage({viewport:{width:1080,height:880}});
    page.on('pageerror', e => { throw e; });
    await page.addInitScript(({locales,latest}) => {
      const chat = (id,title,updated_at) => ({id,title,updated_at,messages:[]});
      const data = {
        projects:[
          {id:'a',name:'Alfa',source_folders:['C:\\a'],conversations:[chat('a1','Chat alfa',latest === 'a1' ? 9 : 1)]},
          {id:'b',name:'Beta',source_folders:['C:\\b'],conversations:[chat('b1','Chat beta',latest === 'b1' ? 9 : 2)]},
          {id:'c',name:'Gamma',source_folders:['C:\\c'],conversations:[chat('c1','Chat gamma',3)]},
        ],
        conversations:[chat('free','Chat libera',latest === 'free' ? 9 : 0)],
      };
      const config = {firebase_auth_set:true,firebase_email:'test@aurachat.test',api_key_set:true,models:['demo'],active_model:'demo'};
      window.__TAURI__ = {window:{getCurrentWindow:()=>({async listen(){return ()=>{};}})},core:{invoke:async (cmd) => {
        if(cmd === 'get_locale') return JSON.stringify(locales);
        if(['get_config','get_local_config'].includes(cmd)) return config;
        if(['get_data','refresh_data'].includes(cmd)) return data;
        if(cmd === 'project_folder_access') return [];
      }}};
    },{locales,latest});
    await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);
    await page.locator('#boot-splash').waitFor({state:'hidden'});
    return page;
  };
  const opened = page => page.locator('.tree-project').evaluateAll(list => list.filter(el => el.open).map(el => el.dataset.projectId));

  let page = await open('b1');
  assert.deepEqual(await opened(page),['b'],'Only the project of the last used chat starts open');
  assert.equal(await page.locator('.tree-conv.is-active').count(),1);
  await page.locator('.tree-project[data-project-id="a"] .tree-project__head').click();
  await page.locator('#recent-chats .tree-conv', {hasText:'Chat libera'}).click();
  assert.deepEqual(await opened(page),['a','b'],'Opening more projects keeps them open across re-renders');
  await page.locator('.tree-project[data-project-id="b"] .tree-project__head').click();
  assert.deepEqual(await opened(page),['a']);
  await page.click('#nav-back');
  assert.deepEqual(await opened(page),['a','b'],'History navigation reveals the chat inside its project');
  await page.close();

  page = await open('free');
  assert.deepEqual(await opened(page),[],'A last chat outside any project leaves every project closed');
  await page.close();

  await browser.close();console.log('PASS: only the last used project starts open; manual opening survives re-renders.');
})().catch(e=>{console.error(e);process.exit(1);});
