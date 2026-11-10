// Isolated contenteditable/clipboard tests; no system clipboard, account or model calls.
const {chromium} = require('playwright');
const {readFileSync, mkdirSync} = require('node:fs');
const {resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    const errors = [];page.on('pageerror', error => errors.push(error.message));
    const locales = JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
    await page.addInitScript(({locales}) => {
      window.__calls = [];window.__events = {};
      window.__data = {projects:[],conversations:['a','b'].map(id => ({
        id,title:`Chat ${id}`,created_at:1,updated_at:1,messages:[{role:'user',content:'Appunti della riunione'}]
      }))};
      const config = {firebase_auth_set:true,api_key_set:true,models:['demo'],active_model:'demo'};
      window.__TAURI__ = {window:{getCurrentWindow:() => ({minimize(){},close(){},async listen(name,fn){window.__events[name]=fn;return()=>{};}})},
        core:{invoke:async(cmd,args) => {
          window.__calls.push({cmd,args:structuredClone(args)});
          if (cmd === 'get_locale') return JSON.stringify(locales);
          if (['get_config','get_local_config'].includes(cmd)) return config;
          if (['get_data','refresh_data'].includes(cmd)) return structuredClone(window.__data);
          if (cmd === 'get_conversation') return {...structuredClone(__data.conversations.find(chat=>chat.id===args.conversation_id)),messages_loaded:true};
          if (cmd === 'save_data') {window.__data=structuredClone(args.data);return structuredClone(window.__data);}
          if (['list_shells','list_approvals','list_questions'].includes(cmd)) return [];
          if (cmd === 'speech_model_status') return {ready:false,busy:false};
          if (cmd === 'project_skills') return {skills:[{name:'review',description:'Review notes',root:0,scope:'global',path:'.agents/skills/review/SKILL.md'}],truncated:false};
          if (cmd === 'chat') return new Promise(resolve => {window.__finish = () => {
            const chat = __data.conversations.find(chat=>chat.id===args.conversation_id);
            chat.messages.push({role:'user',content:args.content},{role:'assistant',content:'Ricevuto.'});
            resolve({cancelled:false,data:structuredClone(__data),messages:structuredClone(chat.messages)});
          };});
        }}};
    }, {locales});
    await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);
    await page.locator('#boot-splash').waitFor({state:'hidden'});
    const open = async id => {
      await page.locator(`#recent-chats [data-conversation-id="${id}"] .tree-conv__title`).click();
      await page.waitForFunction(id=>state.activeConversationId===id&&!state.loadingConversation,id);
    };
    const paste = async text => {
      await page.locator('#composer-input').focus();
      await page.evaluate(text => {
        const clipboardData=new DataTransfer();clipboardData.setData('text/plain',text);
        composerEl().dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));
      },text);
    };
    const text = () => page.evaluate(()=>composerText());
    const token = page.locator('#composer-input .paste-token');
    const dialog = page.locator('dialog.paste-preview');
    const lines = count => Array.from({length:count},(_,i)=>`Riga ${i+1}: dettagli della riunione`).join('\n');
    await open('a');

    await page.locator('#composer-input').focus();
    await page.keyboard.type('Bozza da cancellare');
    assert.equal(await page.locator('#composer-input').evaluate(el=>getComputedStyle(el,'::before').content),'none','The placeholder hides while typing');
    await page.keyboard.press('Control+a');await page.keyboard.press('Delete');
    assert.equal(await page.locator('#composer-input').evaluate(el=>getComputedStyle(el,'::before').content!=='none'),true,'Deleting everything restores the placeholder');

    await paste(lines(20));
    assert.equal(await token.count(),0,'The threshold is strictly over 20 logical lines');
    assert.equal(await text(),lines(20));
    await page.keyboard.press('Control+a');await page.keyboard.press('Delete');
    await paste(lines(21));
    assert.equal(await text(),lines(21),'A chip pasted into an emptied field has no trailing newline');
    await page.evaluate(()=>setComposerText(''));
    await paste(lines(21));
    assert.equal(await token.innerText(),'21 righe');
    assert.equal(await text(),lines(21));
    await page.keyboard.press('Control+z');
    assert.equal(await text(),'','Paste is one undo operation');
    await page.keyboard.press('Control+y');
    assert.equal(await text(),lines(21));
    await page.evaluate(()=>setComposerText(''));
    await paste(`${lines(20)}\n/review`);
    assert.equal(await page.locator('#skill-chooser').isHidden(),true,'Commands inside a pasted block do not trigger the skill picker');

    // Replacement at a selection, CRLF, HTML-looking text and subsequent typing remain literal.
    const long = `${lines(87)}\n<img src=x onerror="window.__unsafe=true">`.replaceAll('\n','\r\n');
    await page.evaluate(()=>{setComposerText('Prima | dopo');const range=composerRange(6,7);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
    await paste(long);
    assert.equal(await token.innerText(),'88 righe');
    assert.equal(await text(),`Prima ${long} dopo`);
    assert.equal(await page.evaluate(()=>!!window.__unsafe),false);
    assert.equal(await page.locator('#composer-input img').count(),0);
    await page.keyboard.type(' nota');
    assert.equal(await text(),`Prima ${long} nota dopo`);
    assert.equal(await page.evaluate(()=>caretOffset()),6+long.length+5);
    await page.evaluate(()=>{setCaretOffset(composerText().length);insertComposerText('\nFine');});
    const expected = `Prima ${long} nota dopo\nFine`;
    assert.equal(await text(),expected);
    const copied = await page.evaluate(()=>{
      const range=document.createRange();range.selectNodeContents(composerEl());
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      const clipboardData=new DataTransfer();
      composerEl().dispatchEvent(new ClipboardEvent('copy',{clipboardData,bubbles:true,cancelable:true}));
      return clipboardData.getData('text/plain');
    });
    assert.equal(copied,expected,'Copy exports expanded text, never the chip label');
    await token.focus();await page.keyboard.press('Enter');
    await dialog.waitFor();
    assert.equal(await dialog.locator('textarea').inputValue(),long.replaceAll('\r\n','\n'));
    assert.equal(await page.evaluate(()=>__calls.filter(call=>call.cmd==='chat').length),0,'Enter on the chip does not send');
    await dialog.locator('textarea').fill('Scartato');
    await page.keyboard.press('Escape');
    assert.equal(await text(),expected,'Cancel does not modify the paste');
    await token.click();await dialog.getByRole('button',{name:locales['project.save'],exact:true}).click();
    assert.equal(await text(),expected,'Saving an unchanged preview preserves CRLF');
    await open('b');await paste(lines(22));
    await open('a');
    assert.equal(await token.innerText(),'88 righe');
    assert.equal(await text(),expected,'Draft switching preserves chip boundaries and full content');
    await token.click();
    await dialog.locator('textarea').fill(lines(89));
    await dialog.getByRole('button',{name:locales['project.save'],exact:true}).click();
    assert.equal(await token.innerText(),'89 righe');
    assert.equal(await text(),`Prima ${lines(89)} nota dopo\nFine`);
    await token.focus();await page.keyboard.press('Delete');
    assert.equal(await token.count(),0);
    await page.keyboard.press('Control+z');
    assert.equal(await token.innerText(),'89 righe','Removal can be undone');

    const shots=resolve(__dirname,'../../.artifact/paste');mkdirSync(shots,{recursive:true});
    await page.evaluate(()=>placeCaretAtEnd(composerEl()));
    for (const width of [1440,768,390]) {
      await page.setViewportSize({width,height:900});
      await page.screenshot({path:resolve(shots,`composer-${width}.png`)});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      assert.ok((await page.locator('#composer-input').boundingBox()).height<100,'The full paste does not expand the field');
      const summary=await page.locator('#activity-dock').boundingBox(), main=await page.locator('.main').boundingBox();
      assert.ok(summary.x>=main.x&&summary.x+summary.width<=main.x+main.width,'The summary stays inside the chat');
    }
    await token.click();await page.screenshot({path:resolve(shots,'preview-390.png')});
    assert.equal(await dialog.locator('textarea').evaluate(el=>el.scrollTop),0,'Preview starts at the beginning');
    await dialog.getByRole('button',{name:locales['project.cancel'],exact:true}).click();
    await page.setViewportSize({width:1440,height:900});
    await page.evaluate(()=>placeCaretAtEnd(composerEl()));
    await paste(lines(21));
    assert.equal(await token.count(),2,'Independent pastes stay separate');
    const beforeCut=await text();
    const cut=await page.evaluate(()=>{
      const range=document.createRange();range.selectNode(composerEl().querySelector('.paste-token:last-of-type'));
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      const clipboardData=new DataTransfer();
      composerEl().dispatchEvent(new ClipboardEvent('cut',{clipboardData,bubbles:true,cancelable:true}));
      return clipboardData.getData('text/plain');
    });
    assert.equal(cut,lines(21));
    assert.equal(await token.count(),1);
    await page.keyboard.press('Control+z');
    assert.equal(await text(),beforeCut);
    await page.evaluate(()=>placeCaretAtEnd(composerEl()));
    await page.keyboard.type(' /rev');
    await page.locator('#skill-options [role=option]').waitFor();
    await page.keyboard.press('Enter');
    assert.equal(await text(),`${beforeCut} /review `,'Skill offsets work after multiple collapsed pastes');
    assert.equal(await token.count(),2);
    const sent = await text();
    await page.click('#composer-send');
    await page.waitForFunction(()=>window.__finish);
    assert.equal(await page.evaluate(()=>__calls.find(call=>call.cmd==='chat').args.content),sent.trim());
    assert.equal(await token.count(),0);
    await page.evaluate(()=>window.__finish());
    await page.waitForFunction(()=>!state.busy);
    assert.deepEqual(errors,[]);
    console.log('PASS long paste threshold, inline position, preview/edit/cancel, raw copy, CRLF, undo, drafts, send and compact layouts.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
