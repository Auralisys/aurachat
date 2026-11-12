// Follow is reader intent, not a distance recomputed after every streaming chunk.
function scrollFollower(viewport, changed = () => {}) {
  let following = true, sampled = viewport.scrollTop, written = sampled;
  const floor = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const write = top => {
    viewport.scrollTop = top;
    sampled = written = viewport.scrollTop;
  };
  const controller = {
    get following() { return following; },
    pause() { following = false;changed(); },
    restore(active, top) { following = active;write(active ? floor() : top);changed(); },
    capture() {
      // Input can move the viewport before its deferred scroll event is delivered.
      if (viewport.scrollTop < sampled - .5 && floor() - viewport.scrollTop > 2) following = false;
      return following;
    },
    sync() {
      this.capture();
      if (following) write(floor());
      changed();
    },
    bottom() { this.restore(true,0); },
  };
  viewport.addEventListener('scroll', event => {
    if (event.target !== viewport) return;
    const top = viewport.scrollTop;
    if (written === null || Math.abs(top - written) > .5) {
      const atFloor = floor() - top <= 2;
      // A wider viewport clamps scrollTop to its new bottom; that is not the reader scrolling up.
      if (top < sampled - .5 && !atFloor) following = false;
      else if (top > sampled + .5 && atFloor) following = true;
    }
    sampled = top;written = null;changed();
  }, {passive:true});
  viewport.addEventListener('wheel', event => {
    if (event.deltaY >= 0) return;
    // A nested disclosure/code block owns its own scroll gesture.
    for (let node = event.target; node instanceof Element && node !== viewport; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
    }
    controller.pause();
  }, {passive:true});
  viewport.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.target.closest('input,textarea,[contenteditable="true"]')) return;
    if (['ArrowUp','PageUp','Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) controller.pause();
  });
  viewport.addEventListener('touchstart', () => controller.pause(), {passive:true});
  return controller;
}

const chatScroll = {
  conversation: null, memory: new Map(), follower: null, observer: null, observed: new Set(),
  snapshot() {
    const box = $('#messages'), top = box.getBoundingClientRect().top;
    const anchor = [...box.children].find(node => node.dataset.messageIndex != null && node.getBoundingClientRect().bottom > top + 1);
    // Closed disclosures are the rebuilt default and size their scroll on toggle; restoring
    // each one would force a layout per activity row on long histories.
    const details = [...box.querySelectorAll('.turn-history[open],.turn-step[open]')].map(node => ({
      message:node.closest('.msg')?.dataset.messageIndex,
      part:node.closest('.turn-history')?.dataset.partKey,
      step:node.dataset.stepId, open:node.open,
      top:node.lastElementChild.scrollTop, following:node.lastElementChild._follow?.capture(),
    }));
    return {following:this.follower.capture(), top:box.scrollTop,
      anchor:anchor && {index:anchor.dataset.messageIndex, offset:anchor.getBoundingClientRect().top - top}, details};
  },
  beforeRender() {
    if (!this.follower) return null;
    const previous = this.snapshot();
    this.memory.set(this.conversation, previous);
    const id = state.activeConversationId;
    const saved = id === this.conversation ? previous : this.memory.get(id);
    this.conversation = id;
    // Retain reading positions only for this account and a bounded set of recent chats.
    while (this.memory.size > 40) this.memory.delete(this.memory.keys().next().value);
    return saved || {following:true, top:0, details:[]};
  },
  afterRender(saved) {
    if (!this.follower) return;
    const box = $('#messages');
    const restored = [];
    for (const detail of saved?.details || []) {
      const message = [...box.children].find(node => node.dataset.messageIndex === detail.message);
      const history = [...message?.querySelectorAll('.turn-history') || []].find(node => node.dataset.partKey === detail.part);
      const node = detail.step == null ? history : [...history?.querySelectorAll('.turn-step') || []].find(row => row.dataset.stepId === detail.step);
      if (node) {
        const content = node.lastElementChild, reopened = detail.open && !node.open;
        // A reused node is already open: no toggle will consume the restored flag.
        if (reopened && content._reasoning != null) renderMarkdown(content,content._reasoning);
        content._restored = reopened;node.open = detail.open;
        restored.push({content,detail});
      }
    }
    // Expand every child before restoring its parent's scroll range.
    for (const {content,detail} of restored.reverse()) content._follow?.restore(detail.following ?? false, detail.top);
    let top = saved?.top || 0;
    if (saved?.anchor && !saved.following) {
      const anchor = [...box.children].find(node => node.dataset.messageIndex === saved.anchor.index);
      if (anchor) top = box.scrollTop + anchor.getBoundingClientRect().top - box.getBoundingClientRect().top - saved.anchor.offset;
    }
    this.follower.restore(saved?.following ?? true, top);
    for (const node of this.observed) if (!node.isConnected) {this.observer.unobserve(node);this.observed.delete(node);}
    for (const node of box.children) if (!this.observed.has(node)) {this.observer.observe(node);this.observed.add(node);}
  },
  sync() { this.follower?.sync(); },
  follow() { this.follower?.bottom(); },
};

function setupChatScroll() {
  const box = $('#messages'), button = $('#chat-latest');
  chatScroll.follower = scrollFollower(box, () => {
    button.hidden = box.scrollHeight - box.clientHeight - box.scrollTop <= 2 || !state.messages.length;
  });
  button.onclick = () => {chatScroll.follow();box.focus({preventScroll:true});};
  box.addEventListener('click', event => {
    if (event.target.closest('summary')) chatScroll.follower.pause();
  }, true);
  chatScroll.observer = new ResizeObserver(() => chatScroll.sync());
  chatScroll.observer.observe(box);
}
