// Contenteditable composer helpers.
// A <textarea> cannot style substrings, so the composer is a contenteditable
// element where skill tokens are real <span class="skill-token"> nodes. These
// helpers expose a textarea-like API: plain text, caret offset and DOM ranges.

function composerEl() {
  return document.getElementById('composer-input');
}

// Plain-text value of the composer. <br> counts as a newline; skill spans are
// flattened to their visible text ("/name").
function composerText() {
  const el = composerEl();
  if (!el) return '';
  let out = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent;
    else if (node.nodeName === 'BR') out += '\n';
  }
  return out;
}

// Replace the whole composer content with plain text and move the caret to the end.
function setComposerText(text) {
  const el = composerEl();
  if (!el) return;
  el.textContent = text == null ? '' : String(text);
  placeCaretAtEnd(el);
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
  if (anchor.nodeType !== Node.TEXT_NODE) return 0;
  let offset = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    if (node === anchor) return offset + Math.min(selection.anchorOffset, anchor.textContent.length);
    if (node.nodeType === Node.TEXT_NODE) offset += node.textContent.length;
    else if (node.nodeName === 'BR') offset += 1;
  }
  return offset;
}

// Place the caret at a character offset relative to the start of the composer
// text (same convention as caretOffset()). Used after live re-coloring.
function setCaretOffset(offset) {
  const el = composerEl();
  if (!el) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node, pos = 0;
  const range = document.createRange();
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (offset <= pos + len) {
      range.setStart(node, Math.max(0, Math.min(offset - pos, len)));
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    pos += len;
  }
  placeCaretAtEnd(el);
}

// Build a DOM Range covering the [start, end) character range of the composer
// text (same convention as composerText()).
function composerRange(start, end) {
  const el = composerEl();
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let pos = 0, startSet = false, endSet = false;
  let node;
  while ((node = walker.nextNode())) {
    const isText = node.nodeType === Node.TEXT_NODE;
    const len = isText ? node.textContent.length : (node.nodeName === 'BR' ? 1 : 0);
    const nodeStart = pos, nodeEnd = pos + len;
    if (!startSet && start >= nodeStart && start <= nodeEnd) {
      if (isText) range.setStart(node, start - nodeStart);
      else range.setStartBefore(node);
      startSet = true;
    }
    if (!endSet && end >= nodeStart && end <= nodeEnd) {
      if (isText) range.setEnd(node, end - nodeStart);
      else range.setEndBefore(node);
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
  if (!selection || !selection.rangeCount) return;
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
