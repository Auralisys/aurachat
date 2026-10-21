const {chromium}=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');
const {resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
  await page.addInitScript(({locales})=>{
   window.__events={};window.__calls=[];window.__questions=[];window.__answers=[];window.__fail=false;
   const chat=id=>({id,title:`Chat ${id}`,created_at:1,updated_at:id==='a'?2:1,context_tokens:0,messages:[]});
   const data={projects:[],conversations:[chat('a'),chat('b')]};
   const config={firebase_email:'demo@example.com',firebase_auth_set:true,api_key_set:true,models:['test'],active_model:'test'};
   window.__TAURI__={window:{getCurrentWindow:()=>({async listen(name,fn){window.__events[name]=fn;return()=>{};}})},core:{invoke:async(cmd,args)=>{
    window.__calls.push({cmd,args});
    if(cmd==='get_locale')return JSON.stringify(locales);
    if(['get_config','get_local_config'].includes(cmd))return config;
    if(cmd==='get_data')return structuredClone(data);
    if(cmd==='save_data')return args.data;
    if(['list_shells','list_approvals'].includes(cmd))return [];
    if(cmd==='list_questions')return structuredClone(window.__questions.filter(item=>item.conversation_id===args.conversation_id&&item.status==='pending'));
    if(cmd==='answer_question'){
     if(window.__fail){window.__fail=false;throw new Error('Network test failure');}
     const item=window.__questions.find(item=>item.id===args.id&&item.conversation_id===args.conversation_id&&item.status==='pending');
     if(!item)throw new Error('question_not_found');
     window.__answers.push(args);item.status='answered';window.__events['question-activity']({payload:structuredClone(item)});
    }
   }}};
   window.__ask=(id,multi_select=false,conversation_id='a',choices=['Opzione A','Opzione B'],step=null)=>{
    const item={id,conversation_id,question:'Come procediamo? <img src=x onerror="window.__unsafe=true">',choices,multi_select,status:'pending',...(step?{step}:{})};
    window.__questions.push(item);window.__events['question-activity']({payload:structuredClone(item)});
   };
  },{locales});
  await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);await page.locator('#boot-splash').waitFor({state:'hidden'});
  await page.evaluate(()=>window.__ask('q1'));
  const tray=page.locator('#question-requests');
  await tray.waitFor({state:'visible'});
  assert.equal(await tray.locator('.question-step').count(),0,'Standalone questions have no invented step count');
  assert.equal(await tray.locator('img').count(),0);
  assert.equal(await tray.getByRole('button',{name:'Invia risposta',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.__answers.length),0);
  await tray.getByRole('radio',{name:'Opzione A',exact:true}).check();
  await tray.getByRole('radio',{name:'Opzione B',exact:true}).check();
  assert.equal(await tray.locator('input:checked').count(),1);
  await tray.getByLabel('Risposta personalizzata',{exact:true}).fill('Contesto aggiuntivo');
  await page.getByRole('button',{name:'Chat b',exact:true}).click();
  assert.equal(await tray.isVisible(),false);
  await page.getByRole('button',{name:'Chat a',exact:true}).click();
  assert.equal(await tray.getByLabel('Risposta personalizzata',{exact:true}).inputValue(),'Contesto aggiuntivo');
  assert.equal(await tray.getByRole('radio',{name:'Opzione B',exact:true}).isChecked(),true);
  await page.evaluate(()=>window.__fail=true);
  await tray.getByRole('button',{name:'Invia risposta',exact:true}).click();
  await tray.getByText('Network test failure',{exact:false}).waitFor();
  assert.equal(await tray.getByRole('button',{name:'Invia risposta',exact:true}).isEnabled(),true);
  await tray.getByRole('button',{name:'Invia risposta',exact:true}).click();await tray.waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.__answers[0].answer),{action:'answer',selected:['Opzione B'],custom:'Contesto aggiuntivo'});
  await page.evaluate(()=>window.__events['question-activity']({payload:{...window.__questions[0],status:'pending'}}));
  assert.equal(await tray.isVisible(),false,'A stale event cannot reopen an answered request');
  await page.evaluate(()=>window.__ask('q2',true));
  await tray.getByRole('checkbox',{name:'Opzione A',exact:true}).check();
  await tray.getByRole('checkbox',{name:'Opzione B',exact:true}).check();
  const shots=resolve(__dirname,'../../.artifact/questions');mkdirSync(shots,{recursive:true});
  await page.screenshot({path:resolve(shots,'multiple-desktop.png')});
  await page.setViewportSize({width:720,height:680});
  await page.screenshot({path:resolve(shots,'multiple-compact.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await tray.getByRole('button',{name:'Invia risposta',exact:true}).click();await tray.waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.__answers.at(-1).answer.selected),['Opzione A','Opzione B']);
  await page.evaluate(()=>window.__ask('q3'));
  await tray.getByLabel('Risposta personalizzata',{exact:true}).fill('Una proposta diversa');
  await tray.getByRole('button',{name:'Invia risposta',exact:true}).click();await tray.waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.__answers.at(-1).answer),{action:'answer',selected:[],custom:'Una proposta diversa'});
  await page.evaluate(()=>window.__ask('q4'));
  await tray.getByRole('radio',{name:'Opzione A',exact:true}).check();
  await tray.getByLabel('Risposta personalizzata',{exact:true}).fill('Confrontiamo i vantaggi');
  await tray.getByRole('button',{name:'Parliamone',exact:true}).click();await tray.waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.__answers.at(-1).answer),{action:'discuss',selected:[],custom:'Confrontiamo i vantaggi'});
  // Dependent questions arrive one at a time, after the prior answer.
  await page.evaluate(()=>window.__ask('step1',false,'a',['Profilo','Home'],{current:1,total:3}));
  assert.equal(await tray.locator('.question-step').innerText(),'Passaggio 1 di 3');
  assert.equal(await tray.getByRole('progressbar').getAttribute('value'),'1');
  await tray.getByRole('radio',{name:'Profilo',exact:true}).check();
  await tray.getByRole('button',{name:'Invia risposta',exact:true}).click();await tray.waitFor({state:'hidden'});
  await page.evaluate(()=>{
   const area=window.__answers.at(-1).answer.selected[0];
   window.__ask('step2',false,'a',[`${area}: pagina cane`,`${area}: pagina utente`],{current:2,total:3});
  });
  assert.equal(await tray.locator('.question-step').innerText(),'Passaggio 2 di 3');
  await tray.getByRole('button',{name:'Parliamone',exact:true}).click();await tray.waitFor({state:'hidden'});
  await page.evaluate(()=>window.__ask('step2-retry',false,'a',['Profilo: pagina cane','Profilo: pagina utente'],{current:2,total:3}));
  assert.equal(await tray.locator('.question-step').innerText(),'Passaggio 2 di 3','Discussion must not advance the step');
  await tray.getByRole('radio',{name:'Profilo: pagina cane',exact:true}).check();
  await page.getByRole('button',{name:'Chat b',exact:true}).click();
  await page.getByRole('button',{name:'Chat a',exact:true}).click();
  assert.equal(await tray.locator('.question-step').innerText(),'Passaggio 2 di 3');
  assert.equal(await tray.getByRole('radio',{name:'Profilo: pagina cane',exact:true}).isChecked(),true);
  await page.setViewportSize({width:1440,height:960});
  await page.screenshot({path:resolve(shots,'steps-desktop.png')});
  await page.setViewportSize({width:720,height:680});
  await page.screenshot({path:resolve(shots,'steps-compact.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await tray.getByRole('button',{name:'Invia risposta',exact:true}).click();await tray.waitFor({state:'hidden'});
  await page.evaluate(()=>{
   const page=window.__answers.at(-1).answer.selected[0];
   window.__ask('step3',false,'a',[`${page}: layout`,`${page}: form`],{current:3,total:3});
  });
  assert.equal(await tray.locator('.question-step').innerText(),'Passaggio 3 di 3');
  assert.equal(await tray.getByRole('progressbar').getAttribute('max'),'3');
  await tray.getByRole('radio',{name:'Profilo: pagina cane: form',exact:true}).check();
  await tray.getByRole('button',{name:'Invia risposta',exact:true}).click();await tray.waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.__answers.at(-1).answer.selected),['Profilo: pagina cane: form']);
  // A known batch stays entirely in the UI until the final explicit submission.
  const long='Etichetta lunga, con accenti àèì e emoji 🐕: '.repeat(3);
  await page.evaluate(long=>{
   const item={id:'batch',conversation_id:'a',status:'pending',questions:[
    {question:'T1 singola',choices:['A','B','C']},
    {question:'T2 multipla',choices:[long,'Seconda'],multi_select:true},
    {question:'T3 testo libero',choices:[]},
   ]};
   window.__questions.push(item);window.__events['question-activity']({payload:structuredClone(item)});
  },long);
  const before=await page.evaluate(()=>window.__answers.length);
  await tray.getByRole('radio',{name:'A',exact:true}).check();
  await tray.getByRole('button',{name:'Avanti',exact:true}).click();
  assert.equal(await tray.locator('.question-step').innerText(),'Passaggio 2 di 3');
  assert.equal(await page.evaluate(()=>window.__answers.length),before);
  await tray.getByRole('checkbox',{name:long,exact:true}).check();
  await tray.getByRole('checkbox',{name:'Seconda',exact:true}).check();
  await tray.getByRole('button',{name:'Indietro',exact:true}).click();
  assert.equal(await tray.getByRole('radio',{name:'A',exact:true}).isChecked(),true);
  await tray.getByRole('radio',{name:'B',exact:true}).check();
  await tray.getByRole('button',{name:'Avanti',exact:true}).click();
  assert.equal(await tray.getByRole('checkbox',{name:long,exact:true}).isChecked(),true);
  const checkDiscuss = async () => {
   const style = await tray.locator('.question-discuss').evaluate(button => {
    const computed=getComputedStyle(button);
    return {background:computed.backgroundColor,color:computed.color,first:button===button.parentElement.firstElementChild};
   });
   assert.deepEqual(style,{background:'rgb(255, 255, 255)',color:'rgb(0, 0, 0)',first:true});
   const discussBox=await tray.getByRole('button',{name:'Parliamone',exact:true}).boundingBox();
   const backBox=await tray.getByRole('button',{name:'Indietro',exact:true}).boundingBox();
   assert.ok(discussBox.x+discussBox.width<=backBox.x,'Discuss is separated on the left of the other actions');
   const headerBox=await tray.locator('.question-header').boundingBox();
   const stepBox=await tray.locator('.question-step').boundingBox();
   assert.ok(Math.abs(stepBox.x+stepBox.width/2-headerBox.x-headerBox.width/2)<1,'Step label and progress are horizontally centered in the header');
   const labelBox=await tray.locator('.question-step > span').boundingBox();
   const progressBox=await tray.getByRole('progressbar').boundingBox();
   assert.ok(progressBox.y>=labelBox.y+labelBox.height,'Progress sits below the step label');
   assert.ok(Math.abs(progressBox.x+progressBox.width/2-labelBox.x-labelBox.width/2)<1,'Progress and step label share the same horizontal center');
  };
  await page.setViewportSize({width:1440,height:960});
  await checkDiscuss();
  await page.screenshot({path:resolve(shots,'batch-desktop.png')});
  await page.setViewportSize({width:720,height:680});
  await checkDiscuss();
  await page.screenshot({path:resolve(shots,'batch-compact.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await tray.getByRole('button',{name:'Avanti',exact:true}).click();
  await page.getByRole('button',{name:'Chat b',exact:true}).click();
  await page.getByRole('button',{name:'Chat a',exact:true}).click();
  assert.equal(await tray.locator('.question-step').innerText(),'Passaggio 3 di 3');
  const custom='  CUSTOM-TEST-42 con spazi, accenti àèì e emoji 🐕  ';
  await tray.getByLabel('Risposta personalizzata',{exact:true}).fill(custom);
  assert.equal(await page.evaluate(()=>window.__answers.length),before);
  await tray.getByRole('button',{name:'Invia risposta',exact:true}).click();await tray.waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.__answers.at(-1).answer),{action:'answer',answers:[
   {action:'answer',selected:['B'],custom:''},{action:'answer',selected:[long,'Seconda'],custom:''},{action:'answer',selected:[],custom},
  ]});
  const batchAgain=async id=>page.evaluate(id=>{
   const item={...window.__questions.find(q=>q.id==='batch'),id,status:'pending'};
   window.__questions.push(item);window.__events['question-activity']({payload:structuredClone(item)});
  },id);
  await batchAgain('batch-skip');
  await tray.getByRole('button',{name:'Salta',exact:true}).click();
  await tray.getByRole('button',{name:'Parliamone',exact:true}).click();await tray.waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.__answers.at(-1).answer),{action:'discuss',answers:[
   {action:'skip',selected:[],custom:''},{action:'discuss',selected:[],custom:''},
  ]});
  await batchAgain('batch-close');
  await tray.getByRole('radio',{name:'C',exact:true}).check();
  await tray.getByRole('button',{name:'Avanti',exact:true}).click();
  await tray.getByRole('checkbox',{name:'Seconda',exact:true}).check();
  await tray.getByRole('button',{name:'Chiudi questionario e invia le risposte precedenti',exact:true}).click();await tray.waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.__answers.at(-1).answer),{action:'cancel',answers:[{action:'answer',selected:['C'],custom:''}]});
  await page.evaluate(()=>window.__ask('eight',false,'a',Array.from({length:8},(_,i)=>`Scelta ${i+1}`)));
  assert.equal(await tray.getByRole('radio').count(),8);
  await tray.getByRole('radio',{name:'Scelta 8',exact:true}).check();
  const actions=await tray.locator('.approval-card__actions').boundingBox();
  const card=await tray.locator('.question-card').boundingBox();
  assert.ok(actions.y+actions.height<=card.y+card.height,'Actions stay inside the card even with eight choices');
  await tray.getByRole('button',{name:'Invia risposta',exact:true}).click();await tray.waitFor({state:'hidden'});
  // Native summary events are real user messages, preserving the previous live segment.
  await page.evaluate(()=>{
   const messages=[];
   state.runs.set('a',{pending:true,since:Date.now(),messages,stream:{content:'Prima del questionario',shown:22,activity:[],frame:null}});
   state.messages=messages;
   window.__events['chat-progress']({payload:{conversation_id:'a',kind:'__question_summary',text:JSON.stringify({role:'user',content:'T1 singola\nB\n\nT3 testo libero\nCUSTOM-TEST-42',activity:[],attachments:[]})}});
  });
  assert.match(await page.locator('#messages .msg--user').innerText(),/T1 singola\nB/);
  assert.equal(await page.evaluate(()=>state.runs.get('a').messages[0].content),'Prima del questionario');
  await page.evaluate(()=>{state.runs.get('a').pending=false;renderMessages();});
  await page.screenshot({path:resolve(shots,'recap-compact.png')});
  // Opening a question shrinks the message viewport: retain bottom-follow, not history-reading.
  await page.evaluate(()=>{
   state.messages.splice(0,state.messages.length,...Array.from({length:25},(_,i)=>({role:i%2?'assistant':'user',content:`Messaggio ${i}\n\n${'Contenuto della cronologia. '.repeat(10)}`})));
   renderMessages();
   const box=document.querySelector('#messages');box.scrollTop=box.scrollHeight;
  });
  await page.evaluate(()=>window.__ask('scroll-bottom'));
  assert.ok(await page.evaluate(()=>{const box=document.querySelector('#messages');return box.scrollHeight-box.scrollTop-box.clientHeight<2;}),'Opening ask_user follows the bottom after the composer grows');
  await tray.getByRole('button',{name:'Salta',exact:true}).click();await tray.waitFor({state:'hidden'});
  const historyTop=await page.evaluate(()=>{
   const box=document.querySelector('#messages');box.scrollTop=100;return box.scrollTop;
  });
  await page.evaluate(()=>window.__ask('scroll-history'));
  assert.ok(Math.abs(await page.locator('#messages').evaluate(box=>box.scrollTop)-historyTop)<2,'Opening ask_user does not pull the reader out of history');
  await tray.getByRole('button',{name:'Salta',exact:true}).click();await tray.waitFor({state:'hidden'});
  await page.evaluate(()=>window.__ask('background',false,'b',[]));
  assert.equal(await tray.isVisible(),false);
  await page.getByRole('button',{name:'Chat b',exact:true}).click();await tray.waitFor({state:'visible'});
  assert.equal(await tray.locator('input').count(),0);
  await page.evaluate(()=>window.__events['question-activity']({payload:{...window.__questions.at(-1),status:'cancelled'}}));
  await tray.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>!!window.__unsafe),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: single/multiple/custom, exact Unicode/whitespace, dependent steps, local batch back/next, no intermediate native responses, skip/discuss/partial close, eight choices, real user recap, drafts/navigation, isolation and compact layout.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
