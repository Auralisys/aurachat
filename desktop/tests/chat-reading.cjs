const {chromium}=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');
const {resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');

function fixture(locales) {
  const messages=Array.from({length:8},(_,index)=>[
    {role:'user',content:`Verifica ${index+1}: come procede il progetto?`},
    {role:'assistant',content:'## Stato della verifica\n\nLa conversazione conserva messaggi, allegati e operazioni. Puoi rileggere i passaggi precedenti senza interrompere il lavoro.\n\n- File controllati nel progetto\n- Modifiche ancora locali\n- Nessuna pubblicazione automatica'}
  ]).flat();
  window.__data={projects:[],conversations:[
    {id:'a',title:'Rifinitura della conversazione',created_at:2,updated_at:2,messages_loaded:true,messages},
    {id:'b',title:'Una seconda conversazione',created_at:1,updated_at:1,messages_loaded:true,messages:[{role:'user',content:'Appunti per domani.'}]}
  ]};
  window.__events={};window.__runs={};window.__calls=[];window.__copied=[];
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.__copied.push(text)}});
  const config={firebase_auth_set:true,api_key_set:true,models:['deepseek-flash'],active_model:'deepseek-flash'};
  const chat=id=>window.__data.conversations.find(chat=>chat.id===id);
  window.__TAURI__={window:{getCurrentWindow:()=>({async listen(name,callback){(window.__events[name]||=[]).push(callback);return()=>{};},minimize(){},close(){}})},core:{invoke:async(cmd,args)=>{
    window.__calls.push({cmd,args});
    if(cmd==='get_locale')return JSON.stringify(locales);
    if(['get_config','get_local_config'].includes(cmd))return config;
    if(cmd==='speech_model_status')return {ready:true,busy:false,loaded:true,loading:false,downloaded:1,total:1};
    if(['get_data','refresh_data'].includes(cmd))return structuredClone(window.__data);
    if(cmd==='list_shells')return [];
    if(cmd==='get_conversation')return structuredClone(chat(args.conversation_id));
    if(cmd==='save_data'){window.__data=structuredClone(args.data);return structuredClone(window.__data);}
    if(cmd==='chat'){
      const target=chat(args.conversation_id);
      target.messages.push({role:'user',content:args.content,attachments:args.attachments||[]});
      return new Promise((resolve,reject)=>{
        window.__runs[args.conversation_id]={
          fail:reject,
          finish(content,activity){
            target.messages.push({role:'assistant',content,activity});
            resolve({data:structuredClone(window.__data),messages:structuredClone(target.messages),usage:{total_tokens:42}});
          }
        };
      });
    }
  }}};
  window.__emit=(kind,text,id='a')=>(window.__events['chat-progress']||[]).forEach(listener=>listener({payload:{conversation_id:id,kind,text}}));
}

async function run() {
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
    await page.addInitScript(fixture,locales);
    await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);
    await page.locator('#boot-splash').waitFor({state:'hidden'});
    await page.evaluate(()=>openConversation('a',false));
    assert.equal(await page.getByRole('heading',{name:'Rifinitura della conversazione',level:1}).isVisible(),true);
    await page.click('#activity-toggle');
    const bottom=()=>page.evaluate(()=>{const box=document.querySelector('#messages');return box.scrollHeight-box.clientHeight-box.scrollTop;});
    const settled=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await settled();assert.ok(await bottom()<=2);
    await page.fill('#composer-input','Confronta i file e spiegami le modifiche.');
    await page.click('#composer-send');await page.waitForFunction(()=>window.__runs.a);
    const live=page.locator('.msg--stream'),history=live.locator('.turn-history');

    // Reasoning bursts are painted once per frame, not once per token.
    await page.evaluate(()=>{
      window.__paints=0;const render=renderTurnBody;
      renderTurnBody=(...args)=>{window.__paints++;return render(...args);};
      for(let i=0;i<100;i++)__emit('__reasoning',`**Passaggio ${i}**\n\nControllo permessi e strumenti.\n\n`);
      window.__burstPaints=window.__paints;
    });
    assert.equal(await page.evaluate(()=>__burstPaints),0);
    await page.waitForFunction(()=>document.querySelector('.turn-history__preview')?.textContent.includes('Controllo permessi'));
    assert.ok(await page.evaluate(()=>__paints)<=2);
    assert.equal(await live.locator('.turn-step__body').textContent(),'');
    await history.locator(':scope > summary').click();
    await live.locator('.turn-step > summary').click();
    await live.locator('.markdown--reasoning strong').first().waitFor();
    assert.equal(await live.locator('.markdown--reasoning strong').first().textContent(),'Passaggio 0');
    const reasoning=live.locator('.turn-step__body');
    assert.ok(await reasoning.evaluate(el=>el.scrollHeight>el.clientHeight));
    await reasoning.evaluate(el=>{el.scrollTop=70;});
    await settled();
    const readingTop=await reasoning.evaluate(el=>el.scrollTop);
    await page.evaluate(()=>__emit('__reasoning','Ultimo controllo completato.\n\n'));
    await settled();
    assert.equal(await reasoning.evaluate(el=>el.scrollTop),readingTop);
    await page.evaluate(()=>chatScroll.follow());

    // Completed Markdown keeps its DOM identity and works before completion.
    const first='## Modifiche locali\n\nUna risposta **leggibile**, con [documentazione](https://example.com).\n\n```js\n'+
      'const risultato = "'+'a'.repeat(220)+'";\n```\n\n| File | Esito |\n| --- | --- |\n| chat.js | pronto |\n\n';
    await page.evaluate(text=>__emit('__delta',text),first);
    await live.locator('.turn-text .markdown-table').waitFor();
    assert.equal(await live.locator('.turn-step').getAttribute('data-status'),'completed');
    await live.getByRole('button',{name:'Copia codice',exact:true}).click();
    assert.match(await page.evaluate(()=>__copied.at(-1)),/const risultato/);
    await live.getByRole('link',{name:'documentazione'}).click({modifiers:['Control']});
    assert.equal(await page.evaluate(()=>__calls.filter(call=>call.cmd==='open_external_url').at(-1).args.url),'https://example.com/');
    await page.evaluate(()=>{
      window.__paragraph=document.querySelector('.msg--stream .turn-text p');
      window.__code=document.querySelector('.msg--stream .turn-text pre');__code.scrollLeft=130;
      const range=document.createRange();range.selectNodeContents(__paragraph);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    });
    await page.evaluate(()=>__emit('__delta','## Risultato\n\n'+('Il lavoro resta locale e rispetta le autorizzazioni. '.repeat(80))));
    await settled();
    assert.equal(await page.evaluate(()=>__paragraph===document.querySelector('.msg--stream .turn-text p')),true);
    assert.equal(await page.evaluate(()=>__code===document.querySelector('.msg--stream .turn-text pre')&&__code.scrollLeft===130),true);
    assert.match(await page.evaluate(()=>getSelection().toString()),/leggibile/);
    await page.evaluate(()=>getSelection().removeAllRanges());
    assert.ok(await bottom()<=2);

    // A small scroll up must release following even inside the former 90px tolerance.
    await page.evaluate(()=>{document.querySelector('#messages').scrollTop-=40;renderMessages();});await settled();
    assert.ok(await bottom()>=39);
    const top=await page.locator('#messages').evaluate(el=>el.scrollTop);
    await page.evaluate(()=>__emit('__delta',' Ancora contenuto.'.repeat(120)));await settled();
    assert.ok(Math.abs(await page.locator('#messages').evaluate(el=>el.scrollTop)-top)<=1);
    assert.equal(await page.locator('#chat-latest').isVisible(),true);
    await page.evaluate(()=>renderMessages());await settled();
    assert.ok(Math.abs(await page.locator('#messages').evaluate(el=>el.scrollTop)-top)<=1);
    assert.equal(await history.evaluate(el=>el.open),true);
    assert.equal(await live.locator('.turn-step').evaluate(el=>el.open),true);

    // Navigation keeps each conversation's reading position, including a live turn.
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>{
      __emit('__delta',' Il testo continua mentre leggi un’altra chat.'.repeat(30));
      openConversation('b',false);
    });await settled();
    assert.equal(await page.evaluate(()=>{const stream=state.runs.get('a').stream;return stream.frame===null&&stream.shown===stream.content.length;}),true,'Inactive chats must stop their already scheduled reveal frames');
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(()=>__emit('__delta',' Arrivato in background.'));
    await page.evaluate(()=>openConversation('a',false));await settled();
    assert.ok(Math.abs(await page.locator('#messages').evaluate(el=>el.scrollTop)-top)<=1);
    await page.click('#chat-latest');await settled();assert.ok(await bottom()<=2);
    assert.equal(await page.locator('#chat-latest').isHidden(),true);
    await page.evaluate(()=>{document.querySelector('#messages').scrollTop-=50;});await settled();
    await page.evaluate(()=>{const box=document.querySelector('#messages');box.scrollTop=box.scrollHeight;});await settled();
    await page.evaluate(()=>__emit('__delta',' Ritorno spontaneo in fondo.'.repeat(15)));await settled();
    assert.ok(await bottom()<=2);
    // Closing the side panel widens the chat and clamps its scroll; reopening must stay at the bottom.
    for(const control of ['#activity-toggle','#activity-toggle','#panel-toggle','#browser-close','#panel-toggle','#browser-close']){
      await page.click(control);await settled();
      assert.ok(await bottom()<=2,`Chat must stay at the bottom after ${control}`);
    }
    assert.equal(await page.locator('#chat-latest').isHidden(),true);

    // Growing code and tables cannot widen the chat or force the transcript sideways.
    await page.evaluate(()=>__emit('__delta','\n\n<img src=x onerror="window.__xss=true"><script>window.__xss=true</script>\n\nTesto **sicuro**.'));
    await settled();
    assert.equal(await live.locator('img,script,[onerror]').count(),0);
    assert.equal(await page.evaluate(()=>!!window.__xss),false);
    const shots=resolve(__dirname,'../../.artifact/chat-reading');mkdirSync(shots,{recursive:true});
    await page.screenshot({path:resolve(shots,'desktop.png')});
    await page.evaluate(()=>{const stream=state.runs.get('a').stream;__runs.a.finish(stream.content,stream.activity);});
    await page.waitForFunction(()=>!state.busy);await settled();
    const final=page.locator('.msg--assistant').last();
    assert.equal(await final.locator('.turn-history').evaluate(el=>el.open),true);
    assert.equal(await final.locator('.turn-step').evaluate(el=>el.open),true);
    assert.equal(await final.locator('[data-live-history]').count(),0);

    for(const width of [768,390]){
      await page.setViewportSize({width,height:900});await settled();
      assert.equal(await page.locator('.sidebar').isVisible(),false);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.equal(await page.locator('#messages').evaluate(el=>el.scrollWidth>el.clientWidth),false);
      await page.click('#sidebar-collapse');assert.equal(await page.locator('.sidebar').isVisible(),true);
      await page.keyboard.press('Escape');assert.equal(await page.locator('.sidebar').isVisible(),false);
      await page.screenshot({path:resolve(shots,`compact-${width}.png`)});
    }
    // A server-side output limit remains an error with the partial text visible.
    await page.fill('#composer-input','Continua');await page.click('#composer-send');
    await page.waitForFunction(()=>state.busy);
    await page.evaluate(()=>{__emit('__delta','Risposta parziale');__runs.a.fail('response_truncated');});
    await page.locator('.msg--error').waitFor();
    assert.match(await page.locator('.msg--error').textContent(),/incompleta/);
    assert.match(await page.locator('.msg--assistant').last().textContent(),/Risposta parziale/);
    // Rebuilding nested disclosures restores inner positions before the outer list.
    await page.evaluate(()=>{
      state.messages=[{role:'assistant',content:'Verifica dettagli',activity:[
        {kind:'reasoning',text:'Un passaggio lungo da rileggere.\n\n'.repeat(80),offset:0},
        ...Array.from({length:12},(_,i)=>({id:`tool-${i}`,kind:'tool',action:'read_project_file',path:`file-${i}.js`,status:'completed',output:'Letto',offset:0}))
      ]}];
      renderMessages();
    });
    const nested=page.locator('.msg--assistant .turn-history');
    await nested.locator(':scope > summary').click();
    await nested.locator('.turn-step > summary').first().click();await settled();
    await nested.evaluate(el=>{
      el.lastElementChild._follow.restore(false,90);
      el.querySelector('.turn-step__body')._follow.restore(false,75);
    });
    await page.evaluate(()=>renderMessages());await settled();
    assert.deepEqual(await nested.evaluate(el=>[el.lastElementChild.scrollTop,el.querySelector('.turn-step__body').scrollTop]),[90,75]);
    await nested.evaluate(el=>{
      el.querySelector('.turn-step__body')._follow.bottom();
      el.lastElementChild._follow.bottom();
    });
    await page.evaluate(()=>renderMessages());await settled();
    assert.equal(await nested.evaluate(el=>[el.lastElementChild,el.querySelector('.turn-step__body')].every(node=>node._follow.following&&node.scrollHeight-node.clientHeight-node.scrollTop<=2)),true);
    assert.deepEqual(errors,[]);
    console.log('PASS: frame-batched thinking, live preview/Markdown, independent scroll, stable Markdown DOM/selection/code, reading memory, final disclosure state, compact navigation and incomplete output.');
  } finally {await browser.close();}
}
module.exports={fixture};
if(require.main===module)run().catch(error=>{console.error(error);process.exit(1);});
