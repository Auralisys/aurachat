const {chromium}=require('playwright');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');

function fixture(locales) {
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const at=(daysAgo,hour,minute)=>{const date=new Date();date.setDate(date.getDate()-daysAgo);date.setHours(hour,minute,0,0);return date.getTime();};
  const picture=index=>({name:`schermata-${index}.png`,mime_type:'image/png',data:png,content:''});
  const answer=index=>({role:'assistant',content:`## Risposta ${index+1}\n\n${'Il controllo procede senza modificare i file e conserva le autorizzazioni. '.repeat(6)}\n\n- Primo punto\n- Secondo punto`});
  const turns=Array.from({length:40},(_,index)=>{
    const user={role:'user',content:`Domanda ${index+1}: come procede la verifica?`};
    if(index>=30)user.created_at=at(0,9+index-30,5);
    else if(index>=20)user.created_at=at(1,17,53);
    else if(index>=10)user.created_at=at(9,8,30);
    if(index===3){user.content='';user.attachments=[picture(1)];}
    if(index===4){user.content='Guarda queste immagini';user.attachments=[1,2,3,4,5].map(picture);}
    if(index===5){user.content='';user.attachments=[{name:'note.txt',mime_type:'text/plain',data:'',content:'appunti'}];}
    if(index===6)user.content='  Riga uno\n\n   riga   due\t tre  ';
    if(index===7)user.content='Lungo '.repeat(200);
    const reply=answer(index);
    // A reply records when its run began: older messages borrow the earliest time, stamped ones keep their own.
    if(index===8)reply.activity=[
      {kind:'tool',id:'tool-1',action:'list_project_files',path:'.',status:'completed',offset:0,at:at(4,16,42)+3000},
      {kind:'reasoning',text:'Controllo i file.',offset:0,at:at(4,16,42)+1000}
    ];
    if(index===25)reply.activity=[{kind:'reasoning',text:'Controllo i file.',offset:0,at:at(3,6,6)}];
    return [user,reply];
  }).flat();
  const archive=Array.from({length:300},(_,index)=>[
    {role:'user',content:`Richiesta ${index+1}`,...(index>=150?{created_at:at(0,10,index%60)}:{})},
    {role:'assistant',content:'Fatto. '.repeat(30)}
  ]).flat();
  window.__data={projects:[],conversations:[
    {id:'a',title:'Rifinitura della conversazione',created_at:5,updated_at:5,messages_loaded:true,messages:turns},
    {id:'b',title:'Una sola domanda',created_at:4,updated_at:4,messages_loaded:true,messages:[{role:'user',content:'Spiegami tutto.'},{role:'assistant',content:'Una risposta molto lunga.\n\n'.repeat(60)}]},
    {id:'c',title:'Tre scambi brevi',created_at:3,updated_at:3,messages_loaded:true,messages:Array.from({length:3},(_,index)=>[{role:'user',content:`Ciao ${index+1}`},{role:'assistant',content:'Ciao!'}]).flat()},
    {id:'d',title:'Archivio molto lungo',created_at:2,updated_at:2,messages_loaded:true,messages:archive}
  ]};
  window.__events={};window.__runs={};window.__calls=[];
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
      return new Promise(resolve=>{
        window.__runs[args.conversation_id]={
          finish(content){
            target.messages.push({role:'assistant',content});
            resolve({data:structuredClone(window.__data),messages:structuredClone(target.messages),usage:{total_tokens:42}});
          }
        };
      });
    }
  }}};
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
    const settled=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
    const open=async id=>{await page.evaluate(id=>openConversation(id,false),id);await settled();};
    const tick=index=>page.locator('.chat-rail__tick').nth(index);
    const card=()=>page.evaluate(()=>({
      open:document.querySelector('.chat-rail__card').classList.contains('is-open'),
      text:document.querySelector('.chat-rail__text').textContent,
      when:document.querySelector('.chat-rail__when').textContent,
      place:document.querySelector('.chat-rail__place').textContent,
      thumbs:document.querySelectorAll('.chat-rail__thumbs img').length,
      more:document.querySelector('.chat-rail__more')?.textContent||''
    }));
    const meta=()=>page.evaluate(()=>{
      const box=element=>element.getBoundingClientRect(),inner=document.querySelector('.chat-rail__inner'),pad=name=>parseFloat(getComputedStyle(inner)[name]);
      const when=box(document.querySelector('.chat-rail__when')),place=box(document.querySelector('.chat-rail__place')),edge=box(inner);
      return {left:when.left-edge.left-pad('paddingLeft'),right:edge.right-pad('paddingRight')-place.right,bottom:when.bottom-place.bottom,apart:place.left-when.right};
    });
    const rail=()=>page.evaluate(()=>{
      const nav=document.querySelector('#chat-rail'),box=document.querySelector('#messages'),track=nav.querySelector('.chat-rail__track');
      const t=track.getBoundingClientRect(),b=box.getBoundingClientRect();
      return {hidden:nav.hidden,thumbHidden:box.classList.contains('has-rail'),ticks:track.children.length,
        centre:(t.top+t.bottom)/2,screen:innerHeight/2,top:t.top,bottom:t.bottom,boxTop:b.top,boxBottom:b.bottom,right:t.right,boxRight:b.right,
        sibling:nav.parentElement===box.parentElement&&!box.contains(nav),
        edge:getComputedStyle(nav).getPropertyValue('--rail-edge'),inset:getComputedStyle(nav).getPropertyValue('--rail-inset'),
        label:nav.getAttribute('aria-label'),current:track.querySelector('.is-current')?.dataset.tick,
        aria:[...track.querySelectorAll('[aria-current=true]')].map(el=>el.dataset.tick),view:track.querySelectorAll('.is-view').length};
    });
    const scrollTop=()=>page.locator('#messages').evaluate(el=>el.scrollTop);
    const away=async()=>{await page.mouse.move(420,300);await settled();await page.waitForFunction(()=>!document.querySelector('.chat-rail__card').classList.contains('is-open'));};

    await open('a');await page.evaluate(()=>chatScroll.follow());await settled();

    // A scroll that is not reader input stays quiet, even when it lands in the first moments of the page.
    await page.evaluate(async()=>{
      const real=performance.now;performance.now=()=>50;
      try{document.querySelector('#messages').scrollTop=0;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
      finally{performance.now=real;}
    });
    assert.equal((await card()).open,false);
    await page.evaluate(()=>chatScroll.follow());await settled();

    // One tick per user message, centred on the window and sitting where the native thumb was.
    let state=await rail();
    assert.equal(state.hidden,false);assert.equal(state.thumbHidden,true);assert.equal(state.sibling,true);
    assert.equal(state.ticks,40);assert.equal(state.label,'Navigazione messaggi');
    assert.ok(Math.abs(state.centre-state.screen)<=2,`Rail centre ${state.centre} must match the window centre ${state.screen}`);
    assert.equal(state.edge,'4px');assert.equal(state.inset,'6px');
    assert.ok(Math.abs(state.boxRight-state.right-6)<=1,`The widget must sit 6px clear of the chat edge, not ${state.boxRight-state.right}px`);
    assert.equal(state.current,'39');assert.deepEqual(state.aria,['39']);assert.ok(state.view>=1);
    const thumb=await page.evaluate(()=>getComputedStyle(document.querySelector('#messages'),'::-webkit-scrollbar-thumb').backgroundColor);
    assert.match(thumb,/rgba\(0, 0, 0, 0\)|transparent/);

    // Hovering a tick describes that message: the time on the left, the compact position at the far right of the same baseline.
    await tick(35).hover();
    let shown=await card();
    assert.equal(shown.open,true);assert.equal(shown.text,'Domanda 36: come procede la verifica?');
    assert.match(shown.when,/^Oggi, \d{2}:\d{2}$/);assert.equal(shown.place,'36/40');
    assert.match(await tick(35).getAttribute('aria-label'),/^Domanda 36: come procede la verifica\? — Oggi, \d{2}:\d{2} · Messaggio 36 di 40$/);
    let line=await meta();
    assert.ok(Math.abs(line.left)<=1&&Math.abs(line.right)<=1&&Math.abs(line.bottom)<=1&&line.apart>=11,JSON.stringify(line));
    const lit=await page.evaluate(()=>[...document.querySelectorAll('.chat-rail__tick')].map(el=>el.style.getPropertyValue('--m')));
    const pitch=await page.evaluate(()=>parseFloat(document.querySelector('.chat-rail__track').style.getPropertyValue('--step')));
    const neighbour=String(Math.round((1+Math.cos(Math.PI*pitch/60))*50)/100);
    assert.equal(lit[35],'1');assert.equal(lit[34],neighbour);assert.equal(lit[36],neighbour);assert.equal(lit[28],'');assert.equal(lit[0],'');
    assert.equal(await tick(35).evaluate(el=>el.classList.contains('is-hot')),true);
    // Old messages without a time borrow their reply's first activity; a stamped message keeps its own time; with neither, only the position shows.
    await tick(25).hover();shown=await card();assert.match(shown.when,/^Ieri, 17:53$/);assert.equal(shown.place,'26/40');
    await tick(15).hover();shown=await card();assert.match(shown.when,/^\d{1,2} \p{L}+\.?( \d{4})?, 08:30$/u);assert.equal(shown.place,'16/40');
    await tick(8).hover();shown=await card();assert.match(shown.when,/^\d{1,2} \p{L}+\.?( \d{4})?, 16:42$/u);assert.equal(shown.place,'9/40');
    await tick(2).hover();shown=await card();assert.equal(shown.when,'');assert.equal(shown.place,'3/40');
    line=await meta();assert.ok(Math.abs(line.right)<=1,JSON.stringify(line));
    assert.match(await tick(2).getAttribute('aria-label'),/^Domanda 3: come procede la verifica\? — Messaggio 3 di 40$/);
    await tick(3).hover();shown=await card();
    assert.equal(shown.text,'Immagine');assert.equal(shown.thumbs,1);assert.equal(shown.more,'');
    await tick(4).hover();shown=await card();
    assert.equal(shown.text,'Guarda queste immagini');assert.equal(shown.thumbs,3);assert.equal(shown.more,'+2');
    await tick(5).hover();shown=await card();assert.equal(shown.text,'note.txt');assert.equal(shown.thumbs,0);
    await tick(6).hover();assert.equal((await card()).text,'Riga uno riga due tre');
    await tick(7).hover();shown=await card();assert.equal(shown.text.length,401);assert.ok(shown.text.endsWith('…'));
    const inside=await page.evaluate(()=>{const c=document.querySelector('.chat-rail__card').getBoundingClientRect(),n=document.querySelector('#chat-rail').getBoundingClientRect();return c.top>=n.top&&c.bottom<=n.bottom&&c.left>=n.left&&c.right<=n.right;});
    assert.equal(inside,true);
    await away();
    assert.equal(await page.evaluate(()=>document.querySelector('.chat-rail__tick.is-hot')),null);
    assert.equal((await page.evaluate(()=>[...document.querySelectorAll('.chat-rail__tick')].filter(el=>el.style.getPropertyValue('--m')).length)),0);

    // Jumping lands the message just below the top edge and marks it current.
    await tick(12).click();await settled();
    const jump=await page.evaluate(()=>{const node=document.querySelectorAll('#messages > .msg--user[data-message-index]')[12],box=document.querySelector('#messages');return {offset:node.getBoundingClientRect().top-box.getBoundingClientRect().top,focus:document.activeElement.id};});
    assert.ok(Math.abs(jump.offset-24)<=2,`Jump offset ${jump.offset}`);assert.equal(jump.focus,'messages');
    state=await rail();assert.equal(state.current,'12');assert.deepEqual(state.aria,['12']);
    await page.waitForTimeout(250);assert.equal(await page.locator('#chat-latest').isVisible(),true);

    // The wheel over the rail scrolls the chat, and reader scrolling briefly peeks at the current message.
    await away();
    const before=await scrollTop();
    await page.locator('.chat-rail__tick').nth(20).hover();await page.mouse.wheel(0,200);await settled();
    assert.ok(Math.abs(await scrollTop()-before-200)<=1);
    await away();
    await page.mouse.wheel(0,-300);
    await page.waitForFunction(()=>document.querySelector('.chat-rail__card').classList.contains('is-open'));
    await page.waitForFunction(()=>!document.querySelector('.chat-rail__card').classList.contains('is-open'),null,{timeout:4000});

    // Dragging along the rail scrubs the conversation and does not click-jump twice.
    const track=await page.locator('.chat-rail__track').boundingBox(),step=track.height/40;
    await page.mouse.move(track.x+track.width-6,track.y+step*5.5);await page.mouse.down();
    await page.mouse.move(track.x+track.width-6,track.y+step*18.5,{steps:8});await page.mouse.up();await settled();
    state=await rail();assert.equal(state.current,'18');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'messages');
    await away();

    // Keyboard: one roving tab stop, arrows move, Enter jumps, Escape returns to the chat.
    assert.equal(await page.locator('.chat-rail__tick[tabindex="0"]').count(),1);
    await page.locator('.chat-rail__tick[tabindex="0"]').focus();await page.keyboard.press('ArrowUp');
    shown=await card();
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.tick),'17');
    assert.equal(shown.open,true);assert.equal(shown.text,'Domanda 18: come procede la verifica?');
    await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.dataset.tick),'39');
    await page.keyboard.press('Home');await page.keyboard.press('Enter');await settled();
    assert.equal(await scrollTop()<=1,true);assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('chat-rail__tick')),true);
    await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'messages');
    await away();

    // The rail follows the window centre and the chat area: window height, activity dock, tall composer and compact widths.
    await page.setViewportSize({width:1440,height:640});await settled();
    state=await rail();assert.ok(Math.abs(state.centre-state.screen)<=2);
    await page.click('#activity-toggle');await settled();
    state=await rail();assert.ok(Math.abs(state.boxRight-state.right-6)<=1);assert.ok(Math.abs(state.centre-state.screen)<=2);
    await page.click('#activity-toggle');await settled();
    state=await rail();assert.ok(Math.abs(state.boxRight-state.right-6)<=1);
    await page.setViewportSize({width:1440,height:500});await settled();
    state=await rail();assert.ok(state.top>=state.boxTop+23&&state.bottom<=state.boxBottom-23,'The rail must stay clear of the header and the composer');
    await page.setViewportSize({width:768,height:900});await settled();
    state=await rail();assert.equal(state.hidden,false);assert.equal(state.edge,'3px');assert.equal(state.inset,'4px');
    assert.ok(Math.abs(state.boxRight-state.right-4)<=1);assert.ok(Math.abs(state.centre-state.screen)<=2);
    await tick(30).hover();
    assert.equal(await page.evaluate(()=>{const c=document.querySelector('.chat-rail__card').getBoundingClientRect(),n=document.querySelector('#chat-rail').getBoundingClientRect();return c.left>=n.left&&c.right<=n.right&&c.top>=n.top&&c.bottom<=n.bottom;}),true);
    await away();
    await page.setViewportSize({width:1440,height:900});await settled();

    // A new message gets a tick at once and keeps its node when the backend echoes it.
    await open('a');await page.evaluate(()=>chatScroll.follow());await settled();
    await page.fill('#composer-input','Nuovo messaggio dal rail.');await page.click('#composer-send');
    await page.waitForFunction(()=>window.__runs.a);await settled();
    assert.equal((await rail()).ticks,41);
    await tick(40).hover();shown=await card();assert.equal(shown.text,'Nuovo messaggio dal rail.');assert.match(shown.when,/^Oggi, \d{2}:\d{2}$/);assert.equal(shown.place,'41/41');
    await away();
    await page.evaluate(()=>{window.__node=[...document.querySelectorAll('#messages > .msg--user[data-message-index]')].at(-1);__runs.a.finish('Fatto.');});
    await page.waitForFunction(()=>!state.busy);await settled();
    assert.equal(await page.evaluate(()=>[...document.querySelectorAll('#messages > .msg--user[data-message-index]')].at(-1)===window.__node),true);
    assert.equal((await rail()).ticks,41);

    // Long archives group messages per tick; the card shows the first message's time and the compact range.
    await open('d');await page.evaluate(()=>chatScroll.follow());await settled();
    state=await rail();assert.ok(state.ticks>2&&state.ticks<300);assert.ok(Math.abs(state.centre-state.screen)<=2);
    await tick(0).hover();shown=await card();
    const range=shown.place.match(/^1–(\d+)\/300$/);assert.ok(range,shown.place);assert.equal(shown.when,'');
    const size=Number(range[1]);assert.equal(state.ticks,Math.ceil(300/size));
    await tick(state.ticks-1).hover();shown=await card();
    assert.match(shown.when,/^Oggi, \d{2}:\d{2}$/);assert.match(shown.place,/^\d+–300\/300$/);
    assert.match(await tick(state.ticks-1).getAttribute('aria-label'),/^Richiesta \d+ — Oggi, \d{2}:\d{2} · Messaggi \d+–300 di 300$/);
    await away();

    // Short or single-turn chats keep the native scrollbar and show no rail.
    for(const id of ['b','c']){
      await open(id);state=await rail();
      assert.equal(state.hidden,true,`Chat ${id} must not show the rail`);assert.equal(state.thumbHidden,false);
    }
    await open('a');assert.equal((await rail()).hidden,false);
    assert.deepEqual(errors,[]);
    console.log('PASS: one tick per user message, centred on the window 6px clear of the chat edge and of header/composer, hover/peek/keyboard/scrub navigation, card with the message time (own or borrowed from its reply) on the left and the compact position on the right, image thumbnails, grouped ticks for long archives, optimistic messages and hidden rail on short chats.');
  } finally {await browser.close();}
}
module.exports={fixture};
if(require.main===module)run().catch(error=>{console.error(error);process.exit(1);});
