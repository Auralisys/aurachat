// Contenteditable composer helpers.
// A <textarea> cannot style substrings, so the composer is a contenteditable
// element where skill tokens are real <span class="skill-token"> nodes. These
// helpers expose a textarea-like API: plain text, caret offset and DOM ranges.

function composerEl() {
  return document.getElementById('composer-input');
}

const PASTE_COLLAPSE_LINES = 20;

// All offsets use the message text, never the visible label of a collapsed paste.
function* composerNodes(root = composerEl()) {
  for (const node of root?.childNodes || []) {
    if (node.nodeType === Node.TEXT_NODE) yield {node, text:node.textContent};
    else if (node.classList?.contains('paste-token')) yield {node, text:JSON.parse(node.dataset.pasteText), pasted:true};
    else if (node.nodeName === 'BR') yield {node, text:'\n'};
    else yield* composerNodes(node);
  }
}

function composerText(root = composerEl()) {
  return [...composerNodes(root)].map(part => part.text).join('');
}

function composerParts() {
  return [...composerNodes()].map(({text, pasted}) => pasted ? {text, pasted:true} : {text});
}

function composerPastedAt(offset) {
  let position = 0;
  for (const part of composerNodes()) {
    if (part.pasted && offset >= position && offset < position + part.text.length) return part.node;
    position += part.text.length;
  }
  return null;
}

function setComposerParts(parts) {
  const el = composerEl();
  if (!el) return;
  document.querySelector('.paste-preview[open]')?.close();
  el.replaceChildren(...parts.map(part => part.pasted ? pastedTextToken(part.text) : document.createTextNode(part.text)));
  placeCaretAtEnd(el);
}

// Replace the whole composer content with plain text and move the caret to the end.
function setComposerText(text) {
  setComposerParts([{text:text == null ? '' : String(text)}]);
}

function clearComposer() {
  setComposerText('');
}

// Append plain text at the end, preserving existing content (and skill spans).
function appendComposerText(text) {
  const el = composerEl();
  if (!el) return;
  const current = composerText();
  const separator = current && !/\s$/.test(current) ? ' ' : '';
  el.appendChild(document.createTextNode(separator + text));
  placeCaretAtEnd(el);
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAfter(node) {
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// Character offset of the caret relative to the start of the composer text.
// Uses the same <br>=newline convention as composerText().
function caretOffset() {
  const el = composerEl();
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return 0;
  const anchor = selection.anchorNode;
  if (!anchor || !el.contains(anchor)) return 0;
  const range = document.createRange();
  range.selectNodeContents(el);range.setEnd(anchor, selection.anchorOffset);
  return composerText(range.cloneContents()).length;
}

// Place the caret at a character offset relative to the start of the composer
// text (same convention as caretOffset()). Used after live re-coloring.
function setCaretOffset(offset) {
  const el = composerEl();
  if (!el) return;
  const range = composerRange(offset, offset);
  const selection = window.getSelection();
  selection.removeAllRanges();selection.addRange(range);
}

// Build a DOM Range covering the [start, end) character range of the composer
// text (same convention as composerText()).
function composerRange(start, end) {
  const el = composerEl();
  const range = document.createRange();
  let pos = 0, startSet = false, endSet = false;
  for (const {node, text} of composerNodes(el)) {
    const isText = node.nodeType === Node.TEXT_NODE;
    const len = text.length;
    const nodeStart = pos, nodeEnd = pos + len;
    if (!startSet && start >= nodeStart && start <= nodeEnd) {
      if (isText) range.setStart(node, start - nodeStart);
      else if (start === nodeStart) range.setStartBefore(node);
      else range.setStartAfter(node);
      startSet = true;
    }
    if (!endSet && end >= nodeStart && end <= nodeEnd) {
      if (isText) range.setEnd(node, end - nodeStart);
      else if (end === nodeStart) range.setEndBefore(node);
      else range.setEndAfter(node);
      endSet = true;
    }
    if (startSet && endSet) return range;
    pos = nodeEnd;
  }
  if (!startSet) { if (el.lastChild) range.setStartAfter(el.lastChild); else range.setStart(el, 0); }
  if (!endSet) { if (el.lastChild) range.setEndAfter(el.lastChild); else range.setEnd(el, 0); }
  return range;
}

// Insert plain text at the caret (replacing any current selection).
function insertComposerText(text) {
  const selection = window.getSelection();
  if (!selection) return;
  const el = composerEl();
  // Chromium keeps a placeholder <br> in an emptied field; it must not become a trailing newline.
  if (!el.textContent && !el.querySelector('.paste-token') && el.querySelector('br')) {el.replaceChildren();placeCaretAtEnd(el);}
  if (!selection.rangeCount || !el.contains(selection.getRangeAt(0).commonAncestorContainer)) placeCaretAtEnd(el);
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function notifyComposerInput() {
  composerEl()?.dispatchEvent(new Event('input', { bubbles: true }));
}

function pastedLineCount(text) {
  return text.split(/\r\n|\r|\n/).length;
}

function pastedTextToken(text) {
  const token = document.createElement('span');
  token.className = 'paste-token';token.contentEditable = 'false';token.tabIndex = 0;
  token.dataset.pasteId = crypto.randomUUID();
  token.dataset.pasteText = JSON.stringify(text);token.setAttribute('role', 'button');token.setAttribute('aria-haspopup', 'dialog');
  const label = t('chat.pasted_lines').replace('{count}', String(pastedLineCount(text)));
  token.setAttribute('aria-label', `${t('chat.open_paste')}: ${label}`);token.title = t('chat.open_paste');
  token.append(icon('file'), document.createTextNode(label));
  return token;
}

function insertPastedNode(node) {
  const input = composerEl(), selection = window.getSelection();
  if (!selection?.rangeCount || !input.contains(selection.getRangeAt(0).commonAncestorContainer)) placeCaretAtEnd(input);
  const pastedId = node.dataset?.pasteId;
  const wrapper = document.createElement('div');wrapper.append(node);
  // The native editing command keeps the chip atomic in the undo/redo history.
  if (!document.execCommand('insertHTML', false, wrapper.innerHTML)) {
    console.error('Composer could not insert pasted text');
    composerStatus(t('chat.paste_failed'));return false;
  }
  input.focus();
  if (pastedId) placeCaretAfter(input.querySelector(`[data-paste-id="${pastedId}"]`));
  return true;
}

function insertComposerPaste(text) {
  if (pastedLineCount(text) > PASTE_COLLAPSE_LINES) insertPastedNode(pastedTextToken(text));
  else insertComposerText(text);
}

function openPastedText(token) {
  const input = composerEl();
  if (!input.contains(token) || document.querySelector('.paste-preview[open]')) return;
  const dialog = document.createElement('dialog');dialog.className = 'project-dialog paste-preview';
  dialog.setAttribute('aria-labelledby', 'paste-preview-title');
  const form = document.createElement('form');form.method = 'dialog';
  const header = document.createElement('header');header.className = 'project-dialog__header';
  const title = document.createElement('h2');title.id = 'paste-preview-title';title.textContent = t('chat.pasted_text');
  const count = document.createElement('span');count.className = 'paste-preview__count';
  const textarea = document.createElement('textarea');textarea.value = JSON.parse(token.dataset.pasteText);textarea.spellcheck = false;
  textarea.setAttribute('aria-label', t('chat.pasted_text'));
  const updateCount = () => {count.textContent = t('chat.pasted_lines').replace('{count}', String(pastedLineCount(textarea.value)));};
  textarea.addEventListener('input', updateCount);updateCount();
  const footer = document.createElement('footer');footer.className = 'project-dialog__footer';
  const button = (key, value, className = 'btn') => {
    const node = document.createElement('button');node.type = 'submit';node.className = className;node.value = value;node.textContent = t(key);return node;
  };
  footer.append(button('chat.remove_paste', 'remove'), button('project.cancel', 'cancel'), button('project.save', 'save', 'btn btn--primary'));
  header.append(title, count);form.append(header, textarea, footer);dialog.append(form);document.body.append(dialog);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const action = event.submitter?.value;
    if (action === 'cancel' || !input.contains(token)) {dialog.close();return;}
    // Textareas normalize CRLF; keep the original bytes if the content was not edited.
    const original = JSON.parse(token.dataset.pasteText), text = textarea.value === original.replace(/\r\n?|\n/g, '\n') ? original : textarea.value;
    dialog.close();input.focus();
    const range = document.createRange();range.selectNode(token);
    const selection = window.getSelection();selection.removeAllRanges();selection.addRange(range);
    if (action === 'remove' || !text) document.execCommand('delete');
    else insertPastedNode(pastedLineCount(text) > PASTE_COLLAPSE_LINES ? pastedTextToken(text) : document.createTextNode(text));
    notifyComposerInput();
  });
  dialog.addEventListener('close', () => {dialog.remove();if (input.contains(token)) token.focus();}, {once:true});
  dialog.showModal();textarea.focus();textarea.setSelectionRange(0, 0);textarea.scrollTop = 0;
}

function setupComposerPastes() {
  const input = composerEl();
  input.addEventListener('click', event => {
    const token = event.target.closest('.paste-token');
    if (token) openPastedText(token);
  });
  input.addEventListener('keydown', event => {
    const token = event.target.closest('.paste-token');
    if (!token || event.isComposing) return;
    if (['Enter', ' '].includes(event.key)) {
      event.preventDefault();event.stopImmediatePropagation();openPastedText(token);
    } else if (['Backspace', 'Delete'].includes(event.key)) {
      event.preventDefault();
      const range = document.createRange();range.selectNode(token);
      const selection = window.getSelection();selection.removeAllRanges();selection.addRange(range);
      input.focus();document.execCommand('delete');notifyComposerInput();
    }
  });
  for (const type of ['copy', 'cut']) input.addEventListener(type, event => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !input.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
    const fragment = selection.getRangeAt(0).cloneContents();
    if (!fragment.querySelector('.paste-token') || !event.clipboardData) return;
    event.preventDefault();event.clipboardData.setData('text/plain', composerText(fragment));
    if (type === 'cut') {document.execCommand('delete');notifyComposerInput();}
  });
  input.addEventListener('dragstart', event => {
    if (event.target.closest('.paste-token')) event.preventDefault();
  });
}
