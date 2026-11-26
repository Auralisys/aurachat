// Dettatura nelle risposte personalizzate di Ask User: stessa pipeline dei commenti, con il testo fissato alla richiesta e al passaggio.
const {chromium}=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');const {resolve,extname}=require('node:path');const http=require('node:http');const assert=require('node:assert/strict');
(async()=>{
  // Servita via HTTP: l'AudioWorklet della dettatura non si carica da file://.
  const root=resolve(__dirname,'../ui');
  const server=http.createServer((req,res)=>{
    try{const path=resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));if(!path.startsWith(root))throw Error();
      const file=req.url==='/'?resolve(root,'index.html'):path;
      res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');res.end(readFileSync(file));
    }catch(_){res.statusCode=404;res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:960}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
    await page.addInitScript(({locales})=>{
      window.__events={};window.__calls=[];window.__questions=[];window.__answers=[];
      const chat=id=>({id,title:`Chat ${id}`,created_at:1,updated_at:id==='a'?2:1,context_tokens:0,messages:[]});
      const data={projects:[],conversations:[chat('a'),chat('b')]};
      const config={firebase_email:'demo@example.com',firebase_auth_set:true,api_key_set:true,models:['test'],active_model:'test'};
      window.__TAURI__={window:{getCurrentWindow:()=>({async listen(name,fn){window.__events[name]=fn;return()=>{};}})},core:{invoke:async(cmd,args)=>{
        window.__calls.push({cmd,args:structuredClone(args)});
        if(cmd==='get_locale')return JSON.stringify(locales);
        if(['get_config','get_local_config'].includes(cmd))return config;
        if(cmd==='speech_model_status')return {ready:true,busy:false,loading:false,loaded:true,downloaded:1,total:1};
        if(cmd==='pause_dictation_media'){window.__paused=(window.__paused||0)+1;return;}
        if(cmd==='resume_dictation_media'){window.__resumed=(window.__resumed||0)+1;return;}
        if(cmd==='preview_audio')return {text:window.__liveText||'',committed:'',advance:0};
        if(cmd==='transcribe_audio'){
          if(window.__transcribeError){window.__transcribeError=false;throw 'speech_engine: test failure';}
          if(window.__delayTranscript)return new Promise(resolve=>window.__finishTranscript=()=>{window.__finishTranscript=null;resolve(window.__transcript||'test dettatura');});
          return window.__transcript||'test dettatura';
        }
        if(['get_data','refresh_data'].includes(cmd))return structuredClone(data);
        if(cmd==='save_data')return args.data;
        if(['list_shells','list_approvals'].includes(cmd))return [];
        if(cmd==='list_questions')return structuredClone(window.__questions.filter(item=>item.conversation_id===args.conversation_id&&item.status==='pending'));
        if(cmd==='answer_question'){
          const item=window.__questions.find(item=>item.id===args.id&&item.status==='pending');
          window.__answers.push(args);item.status='answered';window.__events['question-activity']({payload:structuredClone(item)});
        }
      }}};
      window.__ask=item=>{item={conversation_id:'a',status:'pending',...item};window.__questions.push(item);window.__events['question-activity']({payload:structuredClone(item)});};
    },{locales});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.locator('#boot-splash').waitFor({state:'hidden'});
    await page.evaluate(()=>openConversation('a',false));

    const tray=page.locator('#question-requests');
    const card=tray.locator('.question-card');
    const mic=card.locator('.question-custom__mic');
    const strip=card.locator('.annotator__voice');
    const field=card.locator('textarea[name="custom"]');
    const submit=card.locator('.approval-allow');
    const draft=(id,index=0)=>page.evaluate(([id,index])=>{const item=questionRecord('a').get(id);return {...item.draft.answers[index]};},[id,index]);
    const focused=()=>page.evaluate(()=>({tag:document.activeElement.tagName,cls:document.activeElement.className}));
    const record=async()=>{await mic.click();await page.waitForFunction(()=>voice.field?.recording?.count>4000);};
    const mediaBack=()=>page.waitForFunction(()=>window.__paused>0&&window.__resumed===window.__paused);
    const idle=()=>page.waitForFunction(()=>!voice.field&&!voice.jobs.length&&!voice.transcribing);
    const transcriptions=async()=>(await page.evaluate(()=>window.__calls.filter(call=>call.cmd==='transcribe_audio').length));

    // Il microfono sta accanto al titolo del campo, che resta la sua etichetta.
    await page.evaluate(()=>window.__ask({id:'q1',question:'Come procediamo?',choices:['A','B']}));
    await tray.waitFor({state:'visible'});
    assert.equal(await mic.isEnabled(),true);
    assert.equal(await mic.getAttribute('aria-label'),locales['questions.dictate']);
    assert.equal(await card.getByLabel(locales['questions.custom'],{exact:true}).evaluate(el=>el.tagName),'TEXTAREA');
    assert.equal(await strip.isHidden(),true);
    assert.equal(await submit.isDisabled(),true);

    // Registra e trascrive nel punto del cursore, senza toccare il compositore.
    await field.fill('ab cd');await field.evaluate(el=>{el.focus();el.setSelectionRange(2,2);});
    await record();
    assert.equal(await strip.isVisible(),true);
    assert.equal(await mic.isHidden(),true);
    assert.equal(await page.locator('#composer-mic').isDisabled(),true);
    assert.equal(await submit.isDisabled(),true,'rispondere perderebbe la trascrizione in arrivo');
    assert.equal(await page.evaluate(()=>window.__paused),1);
    assert.equal((await focused()).cls.includes('annotator__voice-stop'),true);
    const shots=resolve(__dirname,'../../.artifact/chat-alignment');mkdirSync(shots,{recursive:true});
    await page.screenshot({path:resolve(shots,'question-dictation-recording.png')});
    await page.evaluate(()=>window.__delayTranscript=true);
    await strip.locator('.annotator__voice-stop').click();await page.waitForFunction(()=>window.__finishTranscript);
    assert.equal(await strip.locator('.annotator__voice-status').textContent(),locales['voice.transcribing']);
    await page.screenshot({path:resolve(shots,'question-dictation-transcribing.png')});
    assert.equal(await submit.isDisabled(),true);
    await page.evaluate(()=>{window.__delayTranscript=false;window.__finishTranscript();});
    await page.waitForFunction(()=>document.querySelector('#question-requests textarea[name="custom"]').value.includes('dettatura'));
    assert.equal(await field.inputValue(),'ab test dettatura cd');
    assert.equal((await draft('q1')).custom,'ab test dettatura cd','la bozza segue il campo');
    assert.equal(await strip.isHidden(),true);
    assert.equal(await submit.isEnabled(),true);
    assert.deepEqual(await field.evaluate(el=>[document.activeElement===el,el.selectionStart,el.selectionEnd]),[true,17,17]);
    assert.equal((await page.locator('#composer-input').textContent()).trim(),'','la trascrizione non finisce nel compositore');
    await mediaBack();

    // The same textbox receives partial text before Stop; the existing words never fade again.
    await field.fill('prima dopo');await field.evaluate(el=>el.setSelectionRange(5,5));
    await page.evaluate(()=>window.__liveText='test');
    await record();await page.waitForFunction(()=>document.querySelector('#question-requests textarea').value==='prima test dopo');
    assert.equal(await page.evaluate(()=>!!voice.field?.recording),true);
    assert.equal(await submit.isDisabled(),true);
    const mirror=card.locator('.voice-field-reveal');
    await mirror.waitFor();
    assert.equal(await mirror.getAttribute('aria-hidden'),'true');
    assert.equal(await mirror.locator('.voice-reveal-word').allTextContents().then(words=>words.join('')).then(text=>text.trim()),'test');
    await page.screenshot({path:resolve(shots,'question-live.png')});
    await page.waitForFunction(()=>!document.querySelector('.voice-field-revealing'));
    assert.notEqual(await field.evaluate(el=>getComputedStyle(el).color),'rgba(0, 0, 0, 0)','Native text is restored after the reveal');
    await page.screenshot({path:resolve(shots,'question-live-complete.png')});
    await page.evaluate(()=>window.__liveText='test dettatura');
    await page.waitForFunction(()=>document.querySelector('#question-requests textarea').value==='prima test dettatura dopo');
    await strip.locator('.annotator__voice-stop').click();await idle();
    assert.equal(await field.inputValue(),'prima test dettatura dopo');
    assert.equal((await draft('q1')).custom,'prima test dettatura dopo');
    await mediaBack();
    await record();await page.waitForFunction(()=>document.querySelector('#question-requests textarea').value.includes('test dettatura test dettatura'));
    await strip.locator('.annotator__voice-cancel').click();await idle();await mediaBack();
    assert.equal(await field.inputValue(),'prima test dettatura dopo');
    // Reduced motion changes presentation only: live text still arrives, without mirror/animation.
    await page.emulateMedia({reducedMotion:'reduce'});
    await record();await page.waitForFunction(()=>document.querySelector('#question-requests textarea').value.includes('test dettatura test dettatura'));
    assert.equal(await mirror.count(),0);
    await strip.locator('.annotator__voice-cancel').click();await idle();await mediaBack();
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>window.__liveText='');
    await field.fill('ab test dettatura cd');

    // Annullare, anche con Esc, scarta l'audio prima che arrivi al motore.
    const sent=await transcriptions();
    await record();await strip.locator('.annotator__voice-cancel').click();await page.waitForFunction(()=>!voice.field);
    await record();await page.keyboard.press('Escape');await page.waitForFunction(()=>!voice.field);
    await mediaBack();
    assert.equal(await transcriptions(),sent);
    assert.equal(await field.inputValue(),'ab test dettatura cd');
    assert.equal((await focused()).tag,'TEXTAREA');

    // Un errore del motore compare nella card e la risposta resta com'era.
    await page.evaluate(()=>window.__transcribeError=true);
    await record();await strip.locator('.annotator__voice-stop').click();
    await card.locator('.question-error').filter({hasText:locales['voice.error']}).waitFor();
    assert.equal(await field.inputValue(),'ab test dettatura cd');
    await idle();

    // Il limite del campo tronca la trascrizione e lo dice.
    await field.fill('x'.repeat(15990));await field.evaluate(el=>{el.focus();el.setSelectionRange(el.value.length,el.value.length);});
    await page.evaluate(()=>window.__transcript='y'.repeat(50));
    await record();await strip.locator('.annotator__voice-stop').click();
    await card.locator('.question-error').filter({hasText:locales['questions.dictation_limit']}).waitFor();
    assert.equal((await field.inputValue()).length,16000);
    await page.evaluate(()=>window.__transcript=null);
    await idle();await field.fill('');await mediaBack();

    // La richiesta chiusa durante la trascrizione non riceve il testo né un errore.
    await page.evaluate(()=>{window.__delayTranscript=true;});
    await field.fill('base');await record();await strip.locator('.annotator__voice-stop').click();await page.waitForFunction(()=>window.__finishTranscript);
    await page.evaluate(()=>window.__events['question-activity']({payload:{...window.__questions[0],status:'cancelled'}}));
    await tray.waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>[!!voice.field,voice.jobs.filter(job=>!job.cancelled).length]),[false,0]);
    await page.evaluate(()=>{window.__delayTranscript=false;window.__finishTranscript();});
    await idle();
    assert.equal((await draft('q1')).custom,'base');

    // Un lotto: la trascrizione di un passaggio resta in quel passaggio anche se si torna indietro.
    await page.evaluate(()=>window.__ask({id:'batch',questions:[{question:'T1',choices:['A','B']},{question:'T2 libero',choices:[]}]}));
    await card.getByRole('radio',{name:'A',exact:true}).check();
    await card.getByRole('button',{name:'Avanti',exact:true}).click();
    assert.equal(await card.locator('.question-step').innerText(),'Passaggio 2 di 2');
    await page.evaluate(()=>window.__delayTranscript=true);
    await record();
    await card.getByRole('button',{name:'Indietro',exact:true}).click();
    await page.waitForFunction(()=>!voice.field);
    assert.equal(await card.locator('.question-step').innerText(),'Passaggio 1 di 2');
    assert.equal(await transcriptions(),(await transcriptions()),'la registrazione abbandonata non parte');
    await mediaBack();
    await card.getByRole('button',{name:'Avanti',exact:true}).click();
    await record();await strip.locator('.annotator__voice-stop').click();await page.waitForFunction(()=>window.__finishTranscript);
    assert.equal(await card.getByRole('button',{name:'Invia risposta',exact:true}).isDisabled(),true);
    await card.getByRole('button',{name:'Indietro',exact:true}).click();
    assert.equal(await field.count(),1);
    assert.equal(await strip.isHidden(),true,'il passaggio 1 non mostra la dettatura del passaggio 2');
    await page.evaluate(()=>{window.__delayTranscript=false;window.__finishTranscript();});
    await idle();
    assert.deepEqual(await draft('batch',1),{action:'answer',selected:[],custom:'test dettatura'});
    assert.equal(await field.inputValue(),'');
    await card.getByRole('button',{name:'Avanti',exact:true}).click();
    assert.equal(await field.inputValue(),'test dettatura');
    await card.getByRole('button',{name:'Invia risposta',exact:true}).click();
    await tray.waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>window.__answers.at(-1).answer),{action:'answer',answers:[{action:'answer',selected:['A'],custom:''},{action:'answer',selected:[],custom:'test dettatura'}]});
    await mediaBack();

    // Cambiando chat la registrazione si ferma; il microfono torna disponibile al ritorno.
    await page.evaluate(()=>window.__ask({id:'q2',question:'Ancora?',choices:['A']}));
    await record();
    await page.evaluate(()=>openConversation('b',false));
    await page.waitForFunction(()=>!voice.field);
    await page.evaluate(()=>openConversation('a',false));
    await tray.waitFor({state:'visible'});
    assert.equal(await mic.isEnabled(),true);
    assert.equal(await strip.isHidden(),true);
    await mediaBack();

    assert.deepEqual(errors,[]);
    console.log('PASS: question dictation: caret insert, draft, submit lock, cancel/Esc, errors, limit, closed request, batch steps, chat switch.');
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exit(1);});
