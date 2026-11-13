// Navigation rail for long chats: one tick per user message in place of the scroll thumb.
// Hovering a tick, scrolling or moving focus into the rail opens a card describing that message.
const chatRail = (() => {
  const REACH = 60, PEEK = 900, LINGER = 90, PREVIEW = 400, LABEL = 140, THUMBS = 3, INSET = 24, DRAG = 4;
  const SCROLL_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
  const previews = new WeakMap(), formats = new Map();
  let box, nav, track, card, headline, stamped, position, gallery;
  let ready = false, active = false, queued = 0, key = '';
  let nodes = [], ticks = [], marks = [], lit = new Map();
  let count = 0, step = 12, size = 1, navHeight = 0, trackTop = 0, cardHeight = 0;
  let current = 0, first = 0, last = 0, pinned = -1, travel = null;
  let hovered = -1, focused = -1, stopped = -1, hot = -1, shown = '', pointerY = null;
  let peeking = false, lastTop = 0, lastInput = -Infinity, peekTimer = 0, closeTimer = 0;
  let press = null, scrubbing = false, suppress = false, scrubbed = -1;

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const tickOf = turn => Math.floor(turn / size);
  const messageOf = node => state.messages[Number(node.dataset.messageIndex)];
  const assign = (el, name, value) => {if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);};
  const cached = (id, make) => {if (!formats.has(id)) formats.set(id, make());return formats.get(id);};

  function stamp(at) {
    if (typeof at !== 'number' || !Number.isFinite(at)) return '';
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return '';
    const lang = document.documentElement.lang || 'it';
    try {
      const midnight = value => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
      const now = new Date(), ago = Math.max(0, Math.round((midnight(now) - midnight(date)) / 864e5));
      let day;
      if (ago < 2) {
        day = cached('relative:' + lang, () => new Intl.RelativeTimeFormat(lang, {numeric:'auto'})).format(ago ? -1 : 0, 'day');
        day = day.charAt(0).toLocaleUpperCase(lang) + day.slice(1);
      } else {
        const year = date.getFullYear() !== now.getFullYear();
        day = cached('date:' + year + lang, () => {
          const options = {day:'numeric', month:'short'};
          if (year) options.year = 'numeric';
          return new Intl.DateTimeFormat(lang, options);
        }).format(date);
      }
      return `${day}, ${cached('time:' + lang, () => new Intl.DateTimeFormat(lang, {hour:'2-digit', minute:'2-digit'})).format(date)}`;
    } catch (_) {
      return date.toLocaleString();
    }
  }

  function preview(node) {
    const message = messageOf(node) || {};
    let words = previews.get(node);
    if (words === undefined) {
      words = String(message.content || '').slice(0, 1000).replace(/\s+/g, ' ').trim();
      if (words.length > PREVIEW) words = words.slice(0, PREVIEW) + '…';
      previews.set(node, words);
    }
    if (words) return words;
    const files = Array.isArray(message.attachments) ? message.attachments : [];
    if (files.some(isImageAttachment)) return t('chat.rail_image');
    return files.length ? files[0].name || t('chat.rail_attachment') : '…';
  }

  function pictures(node) {
    const files = messageOf(node)?.attachments;
    return Array.isArray(files) ? files.filter(isImageAttachment) : [];
  }

  // Messages saved before `created_at` existed borrow the earliest activity time of their reply, usually seconds after sending.
  function sentAt(node) {
    const at = Number(node.dataset.messageIndex), message = state.messages[at];
    if (Number.isFinite(message?.created_at)) return message.created_at;
    let earliest = Infinity;
    for (let next = at + 1; next < state.messages.length && state.messages[next].role !== 'user'; next++)
      for (const event of state.messages[next].activity || []) {
        const time = event?.at ?? event?.started_at ?? event?.created_at;
        if (Number.isFinite(time) && time < earliest) earliest = time;
      }
    return Number.isFinite(earliest) ? earliest : null;
  }

  // A tick covers `size` consecutive turns on very long chats and previews the first one.
  // `place` is the compact position shown on the card; `spoken` is its long form for the tick's accessible name.
  function describe(index) {
    const from = index * size, to = Math.min(count, from + size) - 1, node = nodes[from];
    if (!node) return {node, words:'', when:'', place:'', spoken:''};
    const single = from === to;
    const place = single ? `${from + 1}/${count}` : `${from + 1}–${to + 1}/${count}`;
    const spoken = single
      ? t('chat.rail_position').replace('{current}', from + 1).replace('{total}', count)
      : t('chat.rail_range').replace('{from}', from + 1).replace('{to}', to + 1).replace('{total}', count);
    return {node, words:preview(node), when:stamp(sentAt(node)), place, spoken};
  }

  function collect() {
    const next = [...box.querySelectorAll(':scope > .msg--user[data-message-index]:not(.msg--queued)')];
    if (next.length === nodes.length && next.every((node, index) => node === nodes[index])) return;
    nodes = next;pinned = -1;key = '';travel = null;shown = '';
  }

  function refresh() {
    if (!ready) return;
    collect();
    schedule();
  }

  function schedule() {
    if (!ready || queued) return;
    queued = requestAnimationFrame(update);
  }

  function build() {
    const keep = track.contains(document.activeElement) ? ticks.indexOf(document.activeElement) : -1;
    const total = Math.ceil(count / size);
    ticks = [];
    for (let index = 0; index < total; index++) {
      const tick = document.createElement('button');
      tick.type = 'button';tick.className = 'chat-rail__tick';tick.tabIndex = -1;tick.dataset.tick = String(index);
      const {words, when, spoken} = describe(index);
      tick.setAttribute('aria-label', `${words.length > LABEL ? words.slice(0, LABEL) + '…' : words} — ${when ? `${when} · ${spoken}` : spoken}`);
      ticks.push(tick);
    }
    track.replaceChildren(...ticks);
    marks = [];lit = new Map();stopped = -1;hot = -1;shown = '';
    if (keep >= 0) ticks[Math.min(keep, total - 1)]?.focus({preventScroll:true});
  }

  // Ticks sit on the window's vertical centre, kept clear of the header and the composer.
  function layout(height) {
    const room = Math.max(60, Math.min(height - 96, height * .72));
    step = clamp(Math.floor(room / count), 6, 12);
    size = Math.ceil(count / Math.max(2, Math.floor(room / step)));
    const wanted = `${count}:${step}:${size}`;
    if (wanted !== key) {key = wanted;build();}
    const length = ticks.length * step, margin = Math.min(24, Math.max(0, (height - length) / 2));
    const middle = window.innerHeight / 2 - box.getBoundingClientRect().top;
    trackTop = Math.round(clamp(middle - length / 2, margin, height - length - margin));
    assign(nav, 'left', box.offsetLeft + 'px');assign(nav, 'top', box.offsetTop + 'px');
    assign(nav, 'width', box.offsetWidth + 'px');assign(nav, 'height', height + 'px');
    assign(track, 'top', trackTop + 'px');assign(track, 'height', length + 'px');assign(track, '--step', step + 'px');
  }

  function measure(height) {
    const edge = box.getBoundingClientRect().top, top = box.scrollTop, floor = Math.max(0, box.scrollHeight - height);
    const turnAt = line => {
      let low = 0, high = count - 1, found = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (nodes[middle].getBoundingClientRect().top <= line) {found = middle;low = middle + 1;} else high = middle - 1;
      }
      return found;
    };
    first = Math.max(0, turnAt(edge));
    last = Math.max(first, turnAt(edge + height - 1));
    const reading = top >= floor - 2 ? count - 1 : Math.max(0, turnAt(edge + 40));
    const now = performance.now();
    if (travel && (Math.abs(top - travel.target) <= 1.5 || now > travel.until)) travel = null;
    if (pinned >= 0 && !travel && (pinned < first || pinned > last)) pinned = -1;
    current = pinned >= 0 ? pinned : reading;
    // Only reader input opens the card: follow, restore and jump scrolls stay quiet.
    if (Math.abs(top - lastTop) > .5 && now - lastInput < 400) peek();
    lastTop = top;
  }

  function paint() {
    const from = tickOf(first), to = tickOf(last), at = tickOf(current);
    for (let index = 0; index < ticks.length; index++) {
      const mask = (index >= from && index <= to ? 1 : 0) | (index === at ? 2 : 0);
      if (marks[index] === mask) continue;
      marks[index] = mask;
      const tick = ticks[index];
      tick.classList.toggle('is-view', !!(mask & 1));
      tick.classList.toggle('is-current', !!(mask & 2));
      if (mask & 2) tick.setAttribute('aria-current', 'true'); else tick.removeAttribute('aria-current');
    }
    if (!track.contains(document.activeElement)) setStop(at);
  }

  function setStop(index) {
    if (index === stopped || !ticks[index]) return;
    if (ticks[stopped]) ticks[stopped].tabIndex = -1;
    stopped = index;ticks[index].tabIndex = 0;
  }

  function update() {
    queued = 0;
    if (nodes.length && !(nodes[0].isConnected && nodes[nodes.length - 1].isConnected)) collect();
    count = nodes.length;
    const height = box.clientHeight;
    if (count < 2 || height <= 0 || box.scrollHeight - height <= 8) {
      if (active) {active = false;nav.hidden = true;box.classList.remove('has-rail');dismiss();}
      return;
    }
    if (!active) {active = true;nav.hidden = false;box.classList.add('has-rail');}
    navHeight = height;
    layout(height);
    measure(height);
    paint();
    syncCard();
  }

  function peek() {
    peeking = true;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {peekTimer = 0;peeking = false;syncCard();}, PEEK);
  }

  function syncCard() {
    let target = hovered >= 0 ? hovered : focused >= 0 ? focused : peeking && active ? tickOf(current) : -1;
    if (target >= ticks.length) target = -1;
    if (target >= 0) open(target);
    else if (card.classList.contains('is-open') && !closeTimer) closeTimer = setTimeout(shut, LINGER);
    magnify(target);
  }

  function open(index) {
    clearTimeout(closeTimer);closeTimer = 0;
    const fresh = !card.classList.contains('is-open'), id = key + ':' + index;
    if (fresh || id !== shown) {fill(index);shown = id;}
    place(index, fresh);
    if (fresh) {void card.offsetWidth;card.classList.add('is-open');}
  }

  function shut() {
    closeTimer = 0;shown = '';
    card.classList.remove('is-open', 'is-gliding');
  }

  function fill(index) {
    const {node, words, when, place} = describe(index);
    headline.textContent = words;stamped.textContent = when;position.textContent = place;
    const files = node ? pictures(node) : [], items = [];
    for (const file of files.slice(0, THUMBS)) {
      const url = imageURL(file);
      if (!url) continue;
      const img = document.createElement('img');
      img.src = url;img.alt = '';img.decoding = 'async';img.draggable = false;
      items.push(img);
    }
    if (files.length > THUMBS) {
      const more = document.createElement('span');
      more.className = 'chat-rail__more';more.textContent = '+' + (files.length - THUMBS);
      items.push(more);
    }
    gallery.replaceChildren(...items);gallery.hidden = !items.length;
    cardHeight = card.offsetHeight;
  }

  // The card hangs beside its tick; the genie origin is the tick itself.
  function place(index, fresh) {
    const center = trackTop + (index + .5) * step;
    const y = Math.round(Math.max(8, Math.min(center - 20, navHeight - cardHeight - 8)));
    card.classList.toggle('is-gliding', !fresh);
    assign(card, '--y', y + 'px');assign(card, '--oy', Math.round(clamp(center - y, 0, cardHeight)) + 'px');
  }

  // Dock-style magnification around the pointer, or around the target tick without one.
  function magnify(target) {
    const y = pointerY !== null ? pointerY : target >= 0 ? (target + .5) * step : null;
    const next = new Map();
    if (y !== null) {
      const span = Math.ceil(REACH / step) + 1, middle = Math.floor(y / step);
      for (let index = Math.max(0, middle - span); index <= Math.min(ticks.length - 1, middle + span); index++) {
        const distance = Math.abs((index + .5) * step - y);
        if (distance < REACH) next.set(index, Math.round((1 + Math.cos(Math.PI * distance / REACH)) * 50) / 100);
      }
    }
    for (const index of lit.keys()) if (!next.has(index)) ticks[index]?.style.removeProperty('--m');
    for (const [index, value] of next) if (lit.get(index) !== value) ticks[index].style.setProperty('--m', String(value));
    lit = next;
    if (hot !== target) {
      ticks[hot]?.classList.remove('is-hot');ticks[target]?.classList.add('is-hot');hot = target;
    }
  }

  function dismiss() {
    clearTimeout(peekTimer);clearTimeout(closeTimer);peekTimer = closeTimer = 0;
    hovered = focused = -1;pointerY = null;peeking = false;
    track.classList.remove('is-tracking');
    shut();magnify(-1);
  }

  function go(index, instant) {
    const node = nodes[index * size];
    if (!node) return;
    const distance = box.scrollTop, height = box.clientHeight;
    const top = clamp(distance + node.getBoundingClientRect().top - box.getBoundingClientRect().top - INSET, 0, Math.max(0, box.scrollHeight - height));
    pinned = index * size;
    if (Math.abs(top - distance) >= 1) {
      // Leaving the live edge must not be undone by the next streamed chunk.
      if (top < distance) chatScroll.follower?.pause();
      const smooth = !instant && Math.abs(top - distance) <= 3 * height && !matchMedia('(prefers-reduced-motion: reduce)').matches;
      travel = smooth ? {target:top, until:performance.now() + 900} : null;
      box.scrollTo({top, behavior:smooth ? 'smooth' : 'auto'});
    }
    schedule();
  }

  function locate(event) {
    const y = event.clientY - track.getBoundingClientRect().top;
    return {y, index:clamp(Math.floor(y / step), 0, ticks.length - 1)};
  }

  function releaseHover() {
    hovered = -1;pointerY = null;
    track.classList.remove('is-tracking');
    syncCard();
  }

  function bindTrack() {
    track.addEventListener('pointerdown', event => {
      if (event.button === 0) press = {x:event.clientX, y:event.clientY, id:event.pointerId};
    });
    track.addEventListener('pointermove', event => {
      if (!ticks.length) return;
      const {y, index} = locate(event);
      if (press && !scrubbing && Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG) {
        scrubbing = true;scrubbed = -1;
        try {track.setPointerCapture(press.id);} catch (_) {}
      }
      if (scrubbing && index !== scrubbed) {scrubbed = index;go(index, true);}
      if (event.pointerType === 'touch' && !scrubbing) return;
      hovered = index;pointerY = y;
      track.classList.add('is-tracking');
      syncCard();
    });
    track.addEventListener('pointerleave', () => {if (!scrubbing) releaseHover();});
    const release = event => {
      if (!press && !scrubbing) return;
      const dragged = scrubbing;
      press = null;scrubbing = false;
      if (dragged) {
        suppress = true;setTimeout(() => {suppress = false;}, 0);
        box.focus({preventScroll:true});
      }
      if (event.pointerType === 'touch') releaseHover();
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) track.addEventListener(type, release);
    track.addEventListener('click', event => {
      const tick = event.target.closest('.chat-rail__tick');
      if (!tick || suppress) return;
      go(Number(tick.dataset.tick));
      // Keyboard activation keeps focus on the rail; a mouse click hands it back to the chat.
      if (event.detail > 0) box.focus({preventScroll:true});
    });
    // The rail sits outside the scroller, so its wheel is forwarded.
    track.addEventListener('wheel', event => {
      if (event.ctrlKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? box.clientHeight : 1;
      lastInput = performance.now();pinned = -1;
      box.scrollTop += event.deltaY * unit;
    }, {passive:false});
    track.addEventListener('keydown', event => {
      if (event.key === 'Escape') {box.focus({preventScroll:true});return;}
      const at = ticks.indexOf(document.activeElement), jump = {ArrowUp:-1, ArrowDown:1, PageUp:-5, PageDown:5}[event.key];
      let to = -1;
      if (event.key === 'Home') to = 0;
      else if (event.key === 'End') to = ticks.length - 1;
      else if (jump !== undefined && at >= 0) to = clamp(at + jump, 0, ticks.length - 1);
      if (to < 0) return;
      event.preventDefault();ticks[to].focus({preventScroll:true});
    });
    track.addEventListener('focusin', event => {
      const index = ticks.indexOf(event.target);
      if (index < 0) return;
      setStop(index);
      focused = event.target.matches(':focus-visible') ? index : -1;
      syncCard();
    });
    track.addEventListener('focusout', event => {
      if (track.contains(event.relatedTarget)) return;
      focused = -1;syncCard();schedule();
    });
  }

  function setup() {
    box = $('#messages');nav = $('#chat-rail');
    track = nav.querySelector('.chat-rail__track');card = nav.querySelector('.chat-rail__card');
    headline = card.querySelector('.chat-rail__text');stamped = card.querySelector('.chat-rail__when');
    position = card.querySelector('.chat-rail__place');gallery = card.querySelector('.chat-rail__thumbs');
    const input = () => {lastInput = performance.now();pinned = -1;};
    for (const type of ['wheel', 'touchstart', 'pointerdown']) box.addEventListener(type, input, {passive:true});
    box.addEventListener('keydown', event => {if (SCROLL_KEYS.includes(event.key)) input();});
    window.addEventListener('resize', schedule);
    // The chat column is centered with padding, so opening the activity dock changes only the border box.
    const resized = new ResizeObserver(() => {
      if (queued) {cancelAnimationFrame(queued);queued = 0;}
      update();
    });
    try {resized.observe(box, {box:'border-box'});} catch (_) {resized.observe(box);}
    bindTrack();
    lastTop = box.scrollTop;
    ready = true;
    refresh();
  }

  return {setup, refresh, schedule};
})();
