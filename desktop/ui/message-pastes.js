// Display-only ranges: content remains the complete plain text sent to the model.
function messageParts(message) {
  const content = message.content || '', ranges = message.pastes;
  if (ranges == null || (Array.isArray(ranges) && !ranges.length)) return [{text:content}];
  let end = 0;
  const boundary = n => !(n > 0 && n < content.length && /[\uD800-\uDBFF]/.test(content[n - 1]) && /[\uDC00-\uDFFF]/.test(content[n]));
  if (!Array.isArray(ranges) || ranges.length > 100 || !ranges.every(range => {
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
      range.start < end || range.end <= range.start || range.end > content.length || !boundary(range.start) || !boundary(range.end)) return false;
    end = range.end;return true;
  })) {
    console.warn('Invalid pasted-text ranges; displaying the complete message');
    return [{text:content}];
  }
  const parts = [];end = 0;
  for (const range of ranges) {
    if (range.start > end) parts.push({text:content.slice(end, range.start)});
    parts.push({text:content.slice(range.start, range.end), pasted:true, ...(range.kind === 'file' ? {kind:'file'} : {})});end = range.end;
  }
  if (end < content.length) parts.push({text:content.slice(end)});
  return parts;
}

function composerMessage(parts = composerParts()) {
  const raw = parts.map(part => part.text).join('');
  const content = raw.trim(), left = raw.length - raw.trimStart().length, right = left + content.length;
  let offset = 0;
  const pastes = [];
  for (const part of parts) {
    const start = Math.max(offset, left), end = Math.min(offset + part.text.length, right);
    if (part.pasted && end > start) {
      // A mention cut by trimming is no longer a whole path: it stays an ordinary block.
      pastes.push({start:start - left, end:end - left, ...(part.kind === 'file' && end - start === part.text.length ? {kind:'file'} : {})});
    }
    offset += part.text.length;
  }
  if (pastes.length > 100) {
    console.warn('Too many pasted-text blocks; displaying the complete message');
    return {content};
  }
  return {content, ...pasteMetadata({pastes})};
}

function pasteMetadata(message) {
  return message.pastes?.length ? {pastes:message.pastes} : {};
}

function restoreMessageDraft(message, append = false) {
  const existing = append && composerText().trim() ? [...composerParts(), {text:'\n'}] : [];
  setComposerParts([...existing, ...messageParts(message)]);
}

function messagePreview(message) {
  return messageParts(message).map(part => part.kind === 'file' ? pathName(part.text) : part.pasted ? pastedLabel(part.text) : part.text).join(' ');
}

function pastedLabel(text) {
  return t('chat.pasted_lines').replace('{count}', String(pastedLineCount(text)));
}

function renderMessagePastes(target, message) {
  for (const part of messageParts(message)) {
    if (!part.pasted) {target.append(document.createTextNode(part.text));continue;}
    const chip = document.createElement('button');chip.type = 'button';chip.className = 'paste-token message-paste';
    if (part.kind === 'file') {
      chip.classList.add('mention-token');chip.title = part.text;
      chip.setAttribute('aria-label', `${t('mentions.open')}: ${part.text}`);
      chip.append(fileIcon(part.text), document.createTextNode(pathName(part.text)));
      chip.onclick = () => openMentionedPath(part.text);
      target.append(chip);continue;
    }
    chip.setAttribute('aria-haspopup', 'dialog');chip.setAttribute('aria-label', `${t('chat.open_paste')}: ${pastedLabel(part.text)}`);
    chip.append(icon('file'), document.createTextNode(pastedLabel(part.text)));
    chip.onclick = () => openMessagePaste(part.text, chip);
    target.append(chip);
  }
}

function openMessagePaste(text, opener) {
  if (document.querySelector('.message-paste-viewer[open]')) return;
  const dialog = document.createElement('dialog');dialog.className = 'project-dialog message-paste-viewer';
  dialog.setAttribute('aria-labelledby', 'message-paste-title');
  const header = document.createElement('header');header.className = 'project-dialog__header';
  const title = document.createElement('h2');title.id = 'message-paste-title';title.textContent = pastedLabel(text);
  const actions = document.createElement('div');actions.className = 'message-paste-viewer__actions';
  const copy = messageAction('copy', 'chat.copy', button => copyText(text, button));
  const close = messageAction('close', 'chat.close_paste', () => dialog.close());
  actions.append(copy, close);header.append(title, actions);
  const body = document.createElement('pre');body.className = 'message-paste-viewer__text';body.tabIndex = 0;body.textContent = text;
  dialog.append(header, body);document.body.append(dialog);
  dialog.addEventListener('close', () => {dialog.remove();if (opener.isConnected) opener.focus();}, {once:true});
  dialog.showModal();close.focus();
}
