// Project documents use the browser's tab strip, never a privileged file:// webview.
function displayFilePath(path) {
  return path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
}

function fileTabIcon(path) {
  const name=pathName(path).toLowerCase();
  if (/^\.git(?:attributes|ignore|modules)$/.test(name)) return 'GitBranch';
  if (/\.html?$/.test(name)) return 'Globe';
  if (/\.(md|markdown)$/.test(name)) return 'BookOpen';
  if (/\.jsonl?$/.test(name)) return 'Braces';
  if (/\.xml$/.test(name)) return 'CodeXml';
  if (/\.(csv|tsv)$/.test(name)) return 'Table2';
  return {image:'Image',document:'FileText',code:'FileCode',data:'Settings2',log:'FileTerminal',file:'File'}[artifactType({path})];
}

function projectFileLocation(input) {
  let path = displayFilePath(input);
  if (/^file:/i.test(path)) {
    const url = new URL(path);
    if (url.host || /%2f|%5c/i.test(url.pathname)) throw Error('invalid_path');
    path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
  }
  if (!/^(?:[a-z]:[\\/]|\/(?!\/))/i.test(path) || /[\u0000-\u001f]/.test(path)) throw Error('invalid_path');
  const windows = /^[a-z]:/i.test(path);
  const parts = path.replaceAll('\\','/').split('/');
  const url = new URL(`file://${windows ? '/' : ''}${parts.map((p,i) => windows && !i ? p : encodeURIComponent(p)).join('/')}`);
  return {path:windows ? path.replaceAll('/','\\') : path, url:url.href};
}

function previewError(error) {
  const code = error?.message || String(error);
  if (code === 'outside_project') return t('preview.outside');
  if (code === 'file_unavailable') return t('mentions.unavailable');
  return localizeError(code);
}

async function openProjectFile(input, projectId = mentionProjectId()) {
  let location;
  try {location = projectFileLocation(input);}
  catch (_) {showError(t('errors.invalid_path'));return;}
  if (remoteTarget(state.activeConversationId)) {showError(t('preview.remote'));return;}
  const existing = browserPage.tabs.find(tab => tab.file?.projectId === projectId && tab.file.url === location.url);
  if (existing) {selectPanelTab(existing,{focus:true});return;}
  const project = state.data.projects.find(project=>project.id===projectId);
  const separator=location.path.includes('\\') ? '\\' : '/';
  const roots=(project?.source_folders || []).map(displayFilePath).sort((a,b)=>b.length-a.length);
  const root=roots.find(folder=>location.path.startsWith(folder.replace(/[\\/]$/,'')+separator));
  const file = {...location, projectId, projectName:project?.name, relative:root ? location.path.slice(root.length).replace(/^[\\/]+/,'') : location.path,
    html:/\.html?$/i.test(location.path), view:activityText('div','','file-preview'), icon:fileTabIcon(location.path)};
  $('#file-previews').append(file.view);
  const tab = newPanelTab(null,crypto.randomUUID(),false,file);
  await loadProjectFile(tab);
}

function disposeFilePreview(file) {
  file.view.remove();
}

function reloadFileTab(tab) {
  if (!tab.busy && !tab.loading && (!tab.file.dirty || confirm(t('preview.discard')))) loadProjectFile(tab);
}

function followFileLink(href, file, event) {
  event.preventDefault();
  try {
    const url = new URL(href,file.url);
    if (url.protocol==='file:') return openProjectFile(url.href,file.projectId);
    if (/^https?:$/.test(url.protocol)) return openLink(url.href,event);
  } catch (_) { /* Invalid addresses are reported below. */ }
  showError(t('errors.browser_invalid_url'));
}

function fileLines(text) {
  return Array.from({length:1+(text.match(/\n/g)?.length || 0)}, (_,i)=>i+1).join('\n');
}

function sourceView(text, name) {
  const box = activityText('div','','file-source');
  const numbers = activityText('pre',fileLines(text),'file-lines');numbers.setAttribute('aria-hidden','true');
  const code = activityText('pre','','file-code');
  const json = /\.jsonl?$/i.test(name), xml = /\.xml$/i.test(name);
  const tokens = json ? /"(?:\\.|[^"\\\n])*"\s*(?=:)|"(?:\\.|[^"\\\n])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g
    : xml ? /<\/?[\w:.-]+|"[^"]*"|'[^']*'|[\w:.-]+(?:\s*=)?/g : null;
  let at = 0, spans = 0;
  if (tokens) for (const match of text.matchAll(tokens)) {
    if (xml && !/^(?:<|["'])|=$/.test(match[0])) continue;
    // Keep dense/minified data responsive; the uncoloured tail is still selectable.
    if (++spans > 10000) break;
    const token = match[0], kind = json ? (token[0] === '"' ? (text[match.index+token.length] === ':' ? 'key' : 'string') : 'value')
      : (token[0] === '<' ? 'tag' : /^['"]/.test(token) ? 'string' : 'key');
    code.append(text.slice(at,match.index),activityText('span',token,`file-token--${kind}`));
    at = match.index+token.length;
  }
  code.append(text.slice(at));box.append(numbers,code);return box;
}

function markdownFile(tab, preview) {
  const {file} = tab;
  const tools = activityText('div','','file-tools');
  const modeButton = (key,glyph) => {
    const button=document.createElement('button');button.type='button';button.className='icon-button';
    button.title=t(key);button.setAttribute('aria-label',t(key));button.append(browserIcon(glyph));return button;
  };
  const read=modeButton('preview.rendered','Eye'), edit=modeButton('preview.source','Code');
  const save=activityText('button',t('preview.save'));save.type='button';tools.append(read,edit,save);
  const body = activityText('div','','file-markdown markdown'), source = activityText('div','','file-source file-editor');
  const gutter = activityText('pre','','file-lines');gutter.setAttribute('aria-hidden','true');
  const editor = document.createElement('textarea');editor.spellcheck=false;editor.wrap='off';editor.readOnly=!!preview.truncated;
  editor.setAttribute('aria-label',t('preview.source'));editor.value=preview.content;
  source.append(gutter,editor);file.view.append(tools,body,source);
  const original = () => preview.content.replace(/\r\n?/g,'\n');
  const sync = () => {
    file.dirty = editor.value !== original();
    save.disabled = !file.dirty || tab.busy;
    gutter.textContent = fileLines(editor.value);gutter.scrollTop = editor.scrollTop;
  };
  editor.oninput=sync;editor.onscroll=()=>{gutter.scrollTop=editor.scrollTop;};
  const select = editing => {
    read.setAttribute('aria-pressed',String(!editing));edit.setAttribute('aria-pressed',String(editing));
    body.hidden=editing;source.hidden=!editing;save.hidden=!!preview.truncated || (!editing && !file.dirty);
    if (editing) editor.focus();
    else {
      renderMarkdown(body,editor.value);
      for (const link of body.querySelectorAll('a[href]')) link.onclick = event => followFileLink(link.getAttribute('href'),file,event);
    }
  };
  read.onclick=()=>select(false);edit.onclick=()=>select(true);
  save.onclick=async()=>{
    if (!file.dirty || tab.busy || preview.truncated) return;
    const content = preview.content.includes('\r\n') && !preview.content.replaceAll('\r\n','').includes('\n') ? editor.value.replaceAll('\n','\r\n') : editor.value;
    tab.busy=true;sync();renderBrowser();
    try {
      await invoke('save_project_markdown',{project_id:file.projectId,path:file.path,previous:preview.content,content});
      preview.content=content;setBrowserStatus(t('preview.saved'),tab);
    } catch (error) {setBrowserStatus(previewError(error),tab);}
    finally {tab.busy=false;sync();renderBrowser();}
  };
  editor.onkeydown = event => {if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==='s') {event.preventDefault();save.click();}};
  sync();select(false);
}

// Keep page styles and native disclosure/anchor navigation, without scripts, forms,
// network requests or access to the app. Each local asset goes through the same grant.
async function htmlFile(tab, text, current) {
  const {file} = tab;
  const doc = DOMPurify.sanitize(text, {WHOLE_DOCUMENT:true,RETURN_DOM:true,
    ALLOWED_TAGS:'html head title style link body main nav header footer section article aside div span p br hr h1 h2 h3 h4 h5 h6 strong b em i u s small sub sup ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col details summary pre code blockquote figure figcaption img a time'.split(' '),
    ALLOWED_ATTR:'class id style title lang dir href rel src alt width height colspan rowspan scope open start'.split(' '),ALLOW_DATA_ATTR:false});
  const dir = new URL('.',file.url);
  let missing=false, assetCount=0, assetBytes=0;
  for (const node of doc.querySelectorAll('link,img')) {
    const css=node.localName==='link', raw=node.getAttribute(css?'href':'src');
    if (!css && safeActivityURL(raw)?.startsWith('data:image/')) continue;
    node.removeAttribute(css?'href':'src');
    if (!raw || (css && !node.relList.contains('stylesheet'))) continue;
    try {
      const url=new URL(raw,file.url);
      if (assetCount++ >= 24 || assetBytes >= 10*1024*1024 || !url.href.startsWith(dir.href) || !(css ? /\.css$/i : /\.(png|jpe?g|gif|webp)$/i).test(url.pathname)) throw Error('unavailable');
      const asset=await invoke('preview_project_path',{project_id:file.projectId,path:projectFileLocation(url.href).path});
      if (!current()) return;
      assetBytes+=asset.size;
      if (css && asset.kind==='text' && !asset.truncated) {
        const style=doc.ownerDocument.createElement('style');style.textContent=asset.content.replace(/<\/style/gi,'<\\/style');node.replaceWith(style);
      } else if (!css && asset.kind==='image') node.setAttribute('src',`data:${asset.mime_type};base64,${asset.data}`);
      else throw Error('unavailable');
    } catch (_) {missing=true;}
  }
  for (const link of doc.querySelectorAll('a[href]')) {
    const href=link.getAttribute('href');
    if (!href.startsWith('#')) {link.dataset.previewLink=href;link.setAttribute('href','#');}
  }
  if (!current()) return;
  const csp = doc.ownerDocument.createElement('meta');
  csp.httpEquiv='Content-Security-Policy';csp.content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
  doc.querySelector('head').prepend(csp);
  const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-same-origin');frame.title=tab.title;
  // Only the trusted parent handles cross-document links. The sandbox never allows scripts.
  frame.onload=()=>{
    const page=frame.contentDocument;
    page?.addEventListener('click',event=>{
      const link=event.target.closest('a[href]');if (!link) return;
      if (link.dataset.previewLink) {followFileLink(link.dataset.previewLink,file,event);return;}
      event.preventDefault();
      const id=link.getAttribute('href').slice(1);
      page.getElementById(id)?.scrollIntoView();
    });
  };
  frame.srcdoc='<!doctype html>'+doc.outerHTML;
  file.view.append(frame);
  if (missing) file.view.prepend(activityText('p',t('preview.assets'),'file-notice'));
}

async function loadProjectFile(tab) {
  const {file}=tab, request=file.request=(file.request||0)+1;
  const current=()=>panelHasTab(tab) && file.request===request;
  file.dirty=false;file.view.replaceChildren();tab.loading=true;setBrowserStatus('',tab);renderBrowser();
  if (!file.html) {
    const header=activityText('div','','file-breadcrumb');
    if (file.projectName) header.append(activityText('span',file.projectName));
    const path=activityText('span',file.relative,'file-breadcrumb__path');path.title=file.path;
    header.append(path,activityButton(t('browser.reload'),'reload',()=>reloadFileTab(tab)));
    file.view.append(header);
  }
  try {
    if (!file.projectId) throw Error('outside_project');
    const preview=await invoke('preview_project_path',{project_id:file.projectId,path:file.path});
    if (!current()) return;
    if (preview.kind==='image') {
      const image={name:tab.title,mime_type:preview.mime_type,data:preview.data,content:''};
      file.view.append(imageThumb([image],0,'file-image'));
    } else if (preview.kind==='text') {
      if (preview.truncated) file.view.append(activityText('p',t('mentions.truncated'),'file-notice'));
      if (file.html) await htmlFile(tab,preview.content,current);
      else if (/\.(md|markdown)$/i.test(file.path)) markdownFile(tab,preview);
      else file.view.append(sourceView(preview.content,file.path));
    } else file.view.append(activityText('p',t('mentions.binary'),'file-notice'));
  } catch (error) {if (current()) setBrowserStatus(previewError(error),tab);}
  finally {if (current()) {tab.loading=false;renderBrowser();}}
}
