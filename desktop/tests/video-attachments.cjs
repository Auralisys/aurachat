// Real browser decoding, no provider calls or user conversations.
const {chromium}=require('playwright');
const {readFileSync,mkdirSync}=require('node:fs');
const {resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1400,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const locales=JSON.parse(readFileSync(resolve(__dirname,'../ui/locales/it.json'),'utf8'));
    await page.addInitScript(({locales})=>{
      window.__data={projects:[],conversations:['a','b'].map(id=>({id,title:`Video ${id}`,created_at:1,updated_at:1,messages:[]}))};
      window.__calls=[];window.__events={};window.__picked=[];window.__videos={};window.__failVideo=false;
      const config={firebase_auth_set:true,api_key_set:true,models:['demo'],active_model:'demo'};
      const conversation=id=>window.__data.conversations.find(chat=>chat.id===id);
      window.__TAURI__={window:{getCurrentWindow:()=>({async listen(name,callback){window.__events[name]=callback;return()=>{};}})},core:{invoke:async(cmd,args)=>{
        window.__calls.push({cmd,args});
        if(cmd==='get_locale')return JSON.stringify(locales);
        if(['get_config','get_local_config'].includes(cmd))return config;
        if(cmd==='speech_model_status')return {ready:true,busy:false,loading:false,loaded:true,downloaded:1,total:1};
        if(['get_data','refresh_data'].includes(cmd))return structuredClone(window.__data);
        if(cmd==='list_shells')return [];
        if(cmd==='get_conversation')return {...structuredClone(conversation(args.conversation_id)),messages_loaded:true};
        if(cmd==='save_data'){window.__data=structuredClone(args.data);return structuredClone(window.__data);}
        if(cmd==='choose_chat_files')return structuredClone(window.__picked);
        if(cmd==='read_chat_video'){
          if(window.__holdRead)await new Promise(resolve=>window.__releaseRead=resolve);
          if(window.__failVideo)throw 'video_unavailable';return window.__videos[args.id];
        }
        if(cmd==='chat'){
          const target=conversation(args.conversation_id);
          target.messages.push({role:'user',content:args.content,attachments:args.attachments},{role:'assistant',content:'Fixture ricevuta.'});
          return {data:structuredClone(window.__data),messages:structuredClone(target.messages),usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
        }
      }}};
    },{locales});
    await page.goto(pathToFileURL(resolve(__dirname,'../ui/index.html')).href);
    await page.locator('#boot-splash').waitFor({state:'hidden'});
    const open=async id=>{
      await page.locator(`#recent-chats [data-conversation-id="${id}"] .tree-conv__title`).click();
      await page.waitForFunction(id=>state.activeConversationId===id&&!state.loadingConversation,id);
    };
    await open('a');
    const fixture=await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
      const context=canvas.getContext('2d'),stream=canvas.captureStream(30);
      const mime='video/mp4;codecs=avc1.42001E';
      if(!MediaRecorder.isTypeSupported(mime))throw Error('The MP4 fixture needs an H.264 encoder');
      const recorder=new MediaRecorder(stream,{mimeType:mime}),chunks=[];
      recorder.ondataavailable=event=>chunks.push(event.data);
      const stopped=new Promise(resolve=>recorder.onstop=resolve);
      let colour='#ff0000';
      const paint=()=>{context.fillStyle=colour;context.fillRect(0,0,320,180);};
      paint();recorder.start();const timer=setInterval(paint,33);
      for(const next of ['#ff0000','#00ff00','#0000ff']){
        colour=next;paint();await new Promise(resolve=>setTimeout(resolve,650));
      }
      clearInterval(timer);recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());
      const data=await blobBase64(new Blob(chunks,{type:'video/mp4'}));
      const source={name:'colour-test.mp4',path:'C:\\fixtures\\colour-test.mp4',video_mime:'video/mp4',video_data:data,video_id:'c'.repeat(64)};
      window.__videos[source.video_id]=data;window.__picked=[source];return source;
    });
    const plan=await page.evaluate(()=>({short:videoSamples(2,8),long:videoSamples(120,8),small:videoSamples(0.05,1)}));
    assert.deepEqual(plan.short,[0,0.5,1,1.5,1.99]);
    assert.equal(plan.long.length,64);assert.equal(plan.long[63],119.99);
    assert.deepEqual(plan.small,[0,0.04]);
    await page.evaluate(PNG=>{setComposerText('Testo preesistente');state.attachments=[{name:'kept.png',mime_type:'image/png',data:PNG,content:''}];renderDraft();},PNG);
    await page.click('#composer-attach');
    await page.waitForFunction(()=>state.attachments.some(isVideoAttachment)&&!imageJobs.size);
    assert.equal(await page.locator('#composer-input').textContent(),'Testo preesistente');
    const attachments=await page.evaluate(()=>structuredClone(state.attachments));
    assert.equal(attachments.find(file=>file.name==='kept.png').data,PNG);
    const video=attachments.find(file=>file.video),catalog=JSON.parse(attachments.find(file=>file.name.endsWith('.json')).content);
    assert.equal(video.video.id,fixture.video_id);assert.equal(video.video.mime_type,'video/mp4');
    assert.equal(await page.locator('#attachment-note').textContent(),locales['chat.video_attachment_note']);
    assert.ok(catalog.duration_seconds>1.5&&catalog.duration_seconds<3,JSON.stringify(catalog));
    assert.equal(catalog.frame_count,catalog.frames.length);
    assert.ok(catalog.frames.every((frame,index)=>index===0||frame.time_seconds>catalog.frames[index-1].time_seconds));
    assert.ok(catalog.frames.every(frame=>attachments.some(file=>file.name===frame.sheet&&file.data)));
    assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call.cmd==='chat'||call.cmd==='read_chat_video').length),0);
    const colours=await page.evaluate(async ({catalog,fixture})=>{
      const sheet=state.attachments.find(file=>file.name===catalog.frames[0].sheet);
      const image=new Image();image.src=imageURL(sheet);await image.decode();
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);
      const frames=[catalog.frames[0],catalog.frames[2],catalog.frames.at(-1)];
      const actual=frames.map(frame=>Array.from(context.getImageData((frame.column-1)*512+256,(frame.row-1)*312+168,1,1).data).slice(0,3));
      // MediaRecorder uses real wall-clock capture timestamps, which move under CPU load.
      // Compare against independent playback at each catalog time, after two rendered frames.
      const player=document.createElement('video'),url=URL.createObjectURL(new Blob([base64Bytes(fixture.video_data)],{type:'video/mp4'}));
      player.muted=true;document.body.append(player);
      await new Promise((resolve,reject)=>{player.onloadeddata=resolve;player.onerror=reject;player.src=url;});
      const expected=[];
      for(const frame of frames){
        if(player.currentTime!==frame.time_seconds)await new Promise(resolve=>{player.onseeked=resolve;player.currentTime=frame.time_seconds;});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        context.drawImage(player,0,0,320,180);expected.push(Array.from(context.getImageData(160,90,1,1).data).slice(0,3));
      }
      player.removeAttribute('src');player.load();player.remove();URL.revokeObjectURL(url);
      return {actual,expected};
    },{catalog,fixture});
    assert.ok(colours.actual[0][0]>220&&colours.actual.at(-1)[2]>220,JSON.stringify(colours));
    for(let i=0;i<3;i++)for(let channel=0;channel<3;channel++)assert.ok(Math.abs(colours.actual[i][channel]-colours.expected[i][channel])<10,JSON.stringify(colours));
    const thumb=page.locator('#composer-attachments .video-thumb');
    await thumb.locator('img[src^="blob:"]').waitFor();
    assert.equal(await thumb.getAttribute('aria-label'),'Apri video: colour-test.mp4');
    await thumb.click();
    const viewer=page.locator('dialog.video-viewer');
    await page.waitForFunction(()=>document.querySelector('dialog.video-viewer video')?.readyState>=2);
    assert.equal(await viewer.locator('video').evaluate(video=>video.controls),true);
    await viewer.locator('video').evaluate(async video=>{await video.play();});
    await page.waitForFunction(()=>document.querySelector('dialog.video-viewer video').currentTime>0.2);
    await viewer.locator('video').evaluate(video=>video.pause());
    await viewer.getByRole('button',{name:locales['chat.video_side_panel'],exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.video-preview video')?.readyState>=2);
    assert.equal(await viewer.evaluate(dialog=>dialog.open),false);
    assert.ok(await page.locator('.video-preview video').evaluate(video=>video.currentTime>0.1));
    assert.equal(await page.locator('#browser-panel').isVisible(),true);
    await page.locator('.video-preview').getByRole('button',{name:locales['chat.video_fullscreen'],exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('dialog.video-viewer video')?.readyState>=2);
    assert.equal(await page.locator('.video-preview video').evaluate(video=>video.paused),true);
    await page.keyboard.press('Escape');
    assert.equal(await viewer.evaluate(dialog=>dialog.open),false);
    assert.equal(await viewer.locator('video').getAttribute('src'),null);
    await page.evaluate(()=>closePanelTab(activePanelTab()));
    assert.equal(await page.locator('.video-preview video').count(),0);
    await page.evaluate(()=>closeBrowser());
    await page.click('#composer-send');
    await page.locator('#messages').getByText('Fixture ricevuta.').waitFor();
    const sent=await page.evaluate(()=>window.__calls.find(call=>call.cmd==='chat').args.attachments);
    assert.ok(sent.some(file=>file.video));assert.ok(sent.every(file=>!file.video_data&&!file.video_id));
    assert.ok(JSON.stringify(sent).length<fixture.video_data.length+100000);
    // Rehydrate from saved messages: the thumbnail and player survive a navigation and memory reset.
    await open('b');await open('a');
    const historyThumb=page.locator('#messages .msg--user .video-thumb');
    await historyThumb.locator('img[src^="blob:"]').waitFor();
    await historyThumb.click();await page.waitForFunction(()=>document.querySelector('dialog.video-viewer video')?.readyState>=2);
    await page.keyboard.press('Escape');
    await page.evaluate(()=>window.__holdRead=true);await historyThumb.click();
    await page.waitForFunction(()=>!!window.__releaseRead);await page.keyboard.press('Escape');
    await page.evaluate(()=>window.__holdRead=false);await historyThumb.click();
    await page.waitForFunction(()=>document.querySelector('dialog.video-viewer video')?.readyState>=2);
    const liveURL=await viewer.locator('video').getAttribute('src');
    await page.evaluate(()=>window.__releaseRead());
    assert.equal(await viewer.locator('video').getAttribute('src'),liveURL);
    await page.keyboard.press('Escape');
    await page.evaluate(()=>window.__failVideo=true);
    await historyThumb.click();await viewer.getByText(locales['errors.video_unavailable']).waitFor();
    await page.keyboard.press('Escape');await page.evaluate(()=>window.__failVideo=false);
    // Preparation finishes in its originating draft, including when that draft is temporarily not visible.
    await page.evaluate(fixture=>{
      window.__picked=[fixture];window.__prepareVideo=prepareVideo;
      window.prepareVideo=async(...args)=>{await new Promise(resolve=>window.__release=resolve);return window.__prepareVideo(...args);};
      setComposerText('Resta nella chat A');
    },fixture);
    await page.click('#composer-attach');await page.waitForFunction(()=>!!window.__release);
    assert.equal(await page.locator('#composer-send').isDisabled(),true);
    await open('b');await page.evaluate(()=>window.__release());
    await page.waitForFunction(()=>!imageJobs.size);
    assert.equal(await page.evaluate(()=>state.attachments.length),0);
    await open('a');assert.equal(await page.locator('#composer-input').textContent(),'Resta nella chat A');
    assert.equal(await page.locator('#composer-attachments .video-thumb').count(),1);
    await page.evaluate(()=>{window.prepareVideo=window.__prepareVideo;});
    // An unreadable source never silently adds a path or a partial frame batch.
    const before=await page.evaluate(()=>state.attachments.length);
    await page.evaluate(fixture=>window.__picked=[{...fixture,video_data:btoa('not a video')}],fixture);
    await page.click('#composer-attach');await page.waitForFunction(()=>!imageJobs.size);
    assert.equal(await page.evaluate(()=>state.attachments.length),before);
    assert.equal(await page.locator('#composer-status').textContent(),locales['errors.video_unreadable']);
    // Repeated names remain consistent with the catalog; removing one video only removes its own batch.
    await page.evaluate(fixture=>window.__picked=[fixture],fixture);await page.click('#composer-attach');
    await page.waitForFunction(()=>!imageJobs.size&&state.attachments.filter(isVideoAttachment).length===2);
    const duplicate=await page.evaluate(()=>{
      const video=state.attachments.filter(isVideoAttachment).at(-1);
      const generated=state.attachments.filter(file=>video.video.generated_ids.includes(file.id));
      const catalog=JSON.parse(generated.find(file=>file.name.endsWith('.json')).content);
      return {name:video.name,source:catalog.source,complete:catalog.frames.every(frame=>generated.some(file=>file.name===frame.sheet))};
    });
    assert.equal(duplicate.name,'colour-test-2.mp4');assert.equal(duplicate.source,duplicate.name);assert.equal(duplicate.complete,true);
    await page.locator('#composer-attachments').getByRole('button',{name:'Rimuovi allegato: colour-test-2.mp4',exact:true}).click();
    assert.equal(await page.evaluate(()=>state.attachments.length),before);
    assert.equal(await page.locator('#composer-input').textContent(),'Resta nella chat A');
    // Occupied image slots reject preparation rather than silently sending only the original.
    await open('b');
    await page.evaluate(PNG=>{state.attachments=Array.from({length:8},(_,i)=>({name:`kept-${i}.png`,mime_type:'image/png',data:PNG,content:''}));renderDraft();},PNG);
    await page.click('#composer-attach');
    assert.equal(await page.locator('#composer-status').textContent(),locales['errors.invalid_attachments']);
    assert.equal(await page.evaluate(()=>state.attachments.length),8);
    await open('a');
    // Finite-duration repair for browser-recorded WebM, using the actual decoder.
    const webm=await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=32;canvas.height=24;
      const context=canvas.getContext('2d'),stream=canvas.captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];
      recorder.ondataavailable=event=>chunks.push(event.data);const stopped=new Promise(resolve=>recorder.onstop=resolve);
      recorder.start();context.fillStyle='red';context.fillRect(0,0,32,24);await new Promise(resolve=>setTimeout(resolve,200));
      context.fillStyle='blue';context.fillRect(0,0,32,24);await new Promise(resolve=>setTimeout(resolve,200));recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());
      return await prepareVideo({name:'recorded.webm',video_id:'d'.repeat(64),video_mime:'video/webm',video_data:await blobBase64(new Blob(chunks,{type:'video/webm'}))},1);
    });
    assert.ok(webm.some(file=>file.video?.duration>0));
    const names=await page.evaluate(async fixture=>(await prepareVideo({...fixture,name:String.fromCodePoint(0x1f3ac).repeat(60)+'.mp4'},1)).map(file=>new TextEncoder().encode(file.name).length),fixture);
    assert.ok(names.every(length=>length<=255),JSON.stringify(names));
    if(process.env.AURACHAT_VIDEO_FIXTURE){
      const data=readFileSync(process.env.AURACHAT_VIDEO_FIXTURE).toString('base64');
      const reference=await page.evaluate(async data=>{
        const files=await prepareVideo({name:'reference.mp4',video_id:'e'.repeat(64),video_mime:'video/mp4',video_data:data},8);
        const catalog=JSON.parse(files[0].content);
        return {duration:catalog.duration_seconds,frames:catalog.frame_count,step:catalog.nominal_step_seconds,sheets:files.filter(isImageAttachment).length};
      },data);
      assert.ok(reference.frames>8&&reference.frames<=64);assert.equal(reference.step,0.5);
      console.log('cached reference video decoded locally:',JSON.stringify(reference));
    }
    const output=resolve(__dirname,'../../.artifact/video');mkdirSync(output,{recursive:true});
    await page.evaluate(()=>{mediaErrors.clear();composerStatus();});
    await page.locator('#composer-attachments .video-thumb').click();await page.waitForFunction(()=>document.querySelector('dialog.video-viewer video')?.readyState>=2);
    assert.equal(await viewer.locator('.video-viewer__side svg').evaluate(svg=>svg.children.length>0),true);
    await page.screenshot({path:resolve(output,'video-fullscreen.png')});
    await viewer.getByRole('button',{name:locales['chat.video_side_panel'],exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.video-preview video')?.readyState>=2);
    await page.screenshot({path:resolve(output,'video-side-panel.png')});
    await page.setViewportSize({width:800,height:750});
    await page.waitForFunction(()=>!document.querySelector('.video-preview video').seeking&&document.querySelector('.video-preview .video-player__status').hidden);
    await page.screenshot({path:resolve(output,'video-compact.png')});
    assert.deepEqual(errors,[]);
    console.log('video attachments ok: local MP4/WebM decoding, timestamps, pixels, persistence, player, side panel, drafts and errors');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
