// Balance of the model provider behind the active API key. It belongs to the
// account rather than to a chat, so it is shown in the usage popover and in the
// provider editor. Only providers the backend flags with `balance: true` take part.

const BALANCE_TTL_MS = 60000;
const balanceEntries = new Map();
const balanceViews = new Set();
// Bumped whenever a reading may be out of date (a reply spent credit, or the
// provider settings changed). Older readings stay on screen while a new one loads.
let balanceEpoch = 0;

function balanceProviderFor(model) {
  return (state.config?.providers || []).find(provider => provider.balance && provider.api_key_set && provider.models.some(item => item.id === model)) || null;
}

function balanceEntry(providerId) {
  if (!balanceEntries.has(providerId)) balanceEntries.set(providerId, { data: null, error: '', revision: 0, loadedAt: 0, validEpoch: -1, request: null, requestEpoch: -1, linkError: false });
  return balanceEntries.get(providerId);
}

function balanceFresh(entry) {
  return entry.loadedAt > 0 && !entry.error && entry.validEpoch === balanceEpoch && Date.now() - entry.loadedAt < BALANCE_TTL_MS;
}

async function balanceRead(providerId) {
  try {
    const data = await invoke('provider_balance', { provider_id: providerId });
    return Array.isArray(data?.infos) ? { data } : { error: 'balance_unavailable' };
  } catch (e) {
    return { error: errText(e) };
  }
}

function balanceEnsure(providerId, force) {
  const entry = balanceEntry(providerId);
  if (entry.request && entry.requestEpoch === balanceEpoch) return;
  if (!force && balanceFresh(entry)) return;
  const epoch = balanceEpoch;
  entry.error = '';
  entry.linkError = false;
  const request = balanceRead(providerId).then(result => {
    if (balanceEntries.get(providerId) !== entry || entry.request !== request) return;
    entry.request = null;
    entry.revision++;
    if (result.data) Object.assign(entry, { data: result.data, loadedAt: Date.now(), validEpoch: epoch });
    else entry.error = result.error;
    balanceRender();
  });
  entry.request = request;
  entry.requestEpoch = epoch;
  balanceRender();
}

function invalidateBalances() {
  balanceEpoch++;
}

function resetBalances() {
  balanceEntries.clear();
  balanceEpoch++;
  updateContextInfo();
  balanceRender();
}

function balanceText(key, values) {
  return t(key).replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
}

function balanceMoney(value, currency) {
  try {
    return new Intl.NumberFormat(lang, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
  } catch (_) {
    return `${Number(value).toFixed(2)} ${currency}`;
  }
}

function balanceTime(ms) {
  return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(ms);
}

function balanceHost(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

function balanceMessage(code) {
  const key = 'errors.' + code;
  return code !== 'invalid_provider' && t(key) !== key ? t(key) : t('errors.balance_unavailable');
}

function balanceKind(entry) {
  if (!entry.data) return entry.error ? 'error' : 'loading';
  if (!entry.data.is_available) return 'depleted';
  return entry.data.infos.length ? 'ready' : 'empty';
}

function balanceList(infos) {
  const list = usageElement('dl', 'usage-list balance__list');
  for (const info of infos) {
    const label = t('usage.balance_available') + (infos.length > 1 ? ` (${info.currency})` : '');
    const total = usageRow(label, balanceMoney(info.total, info.currency));
    total.classList.add('balance__primary');
    list.append(total);
    // The split only says something when both parts exist.
    if (!(info.topped_up > 0 && info.granted > 0)) continue;
    for (const [key, value] of [['usage.balance_topped_up', info.topped_up], ['usage.balance_granted', info.granted]]) {
      const part = usageRow(t(key), balanceMoney(value, info.currency));
      part.classList.add('usage-row--nested');
      list.append(part);
    }
  }
  return list;
}

function balanceTopUp(entry, primary) {
  const url = entry.data.top_up_url;
  const button = usageElement('button', 'balance__action balance__topup' + (primary ? ' balance__action--primary' : ''), t('usage.balance_top_up'));
  button.type = 'button';
  button.dataset.balanceAction = 'topup';
  button.title = balanceHost(url);
  button.append(icon('external'));
  button.onclick = async () => {
    try { await invoke('open_external_url', { url }); }
    catch (_) { entry.linkError = true; balanceRender(); }
  };
  return button;
}

function balanceNodes(view, entry, kind) {
  if (kind === 'loading') return [usageElement('p', 'balance__status', t('usage.balance_loading'))];
  if (kind === 'error') {
    const retry = usageElement('button', 'balance__action', t('usage.balance_retry'));
    retry.type = 'button';
    retry.onclick = () => { view.refresh.focus(); balanceEnsure(view.provider.id, true); };
    return [usageElement('p', 'balance__note balance__note--error', balanceMessage(entry.error)), retry];
  }
  const { data } = entry;
  const time = balanceTime(entry.loadedAt);
  const nodes = [];
  if (kind === 'depleted') nodes.push(usageElement('span', 'balance__flag', t('usage.balance_insufficient')), usageElement('p', 'balance__note', t('usage.balance_insufficient_note')));
  if (kind === 'empty') nodes.push(usageElement('p', 'balance__note', t('usage.balance_empty')));
  if (data.infos.length) nodes.push(balanceList(data.infos));
  if (entry.error) nodes.push(usageElement('p', 'balance__note balance__note--error', balanceMessage(entry.error)), usageElement('p', 'balance__note', balanceText('usage.balance_stale', { time })));
  else nodes.push(usageElement('p', 'balance__note', balanceText('usage.balance_updated', { time })));
  nodes.push(balanceTopUp(entry, kind === 'depleted'));
  if (entry.linkError) {
    const note = usageElement('p', 'balance__note balance__note--error', t('chat.link_failed') + ' ');
    note.append(usageElement('span', 'balance__url', data.top_up_url));
    nodes.push(note);
  }
  return nodes;
}

function balanceRenderView(view) {
  const entry = balanceEntry(view.provider.id);
  const kind = balanceKind(entry);
  const loading = !!entry.request;
  view.refresh.classList.toggle('is-loading', loading);
  view.body.setAttribute('aria-busy', String(loading));
  // A refresh that leaves the reading unchanged keeps the body, so assistive tech is not told twice.
  const key = [kind, entry.revision, entry.error, entry.linkError].join('|');
  if (key === view.key) return;
  view.key = key;
  const action = view.body.contains(document.activeElement) ? document.activeElement.dataset?.balanceAction : '';
  view.root.dataset.state = kind;
  view.body.replaceChildren(...balanceNodes(view, entry, kind));
  if (action) view.body.querySelector(`[data-balance-action="${action}"]`)?.focus();
  // The failure note sits below the button; keep it visible inside a scrolling popover.
  if (entry.linkError) view.body.querySelector('.balance__url')?.parentElement.scrollIntoView({ block: 'nearest' });
}

function balanceRender() {
  for (const view of balanceViews) if (view.root.isConnected) balanceRenderView(view);
}

function balanceMount(parent, provider, variant, load) {
  for (const view of balanceViews) if (!view.root.isConnected) balanceViews.delete(view);
  const root = usageElement('section', 'balance balance--' + variant);
  const head = usageElement('header', 'balance__head');
  const title = usageElement(variant === 'popover' ? 'h2' : 'h4', 'balance__title', balanceText('usage.balance_title', { provider: provider.name }));
  title.title = title.textContent;
  const refresh = usageElement('button', 'icon-button balance__refresh');
  refresh.type = 'button';
  refresh.append(icon('reload'));
  refresh.setAttribute('aria-label', t('usage.balance_refresh'));
  refresh.title = t('usage.balance_refresh');
  refresh.onclick = () => balanceEnsure(provider.id, true);
  head.append(title, refresh);
  const body = usageElement('div', 'balance__body');
  body.setAttribute('aria-live', 'polite');
  root.append(head, body);
  parent.append(root);
  const view = { root, body, refresh, provider, variant, key: '' };
  balanceViews.add(view);
  if (load) balanceEnsure(provider.id);
  balanceRenderView(view);
  return root;
}

function appendPopoverBalance(panel, open) {
  const provider = balanceProviderFor(activeModel());
  return provider ? balanceMount(panel, provider, 'popover', open) : null;
}

function appendProviderBalance(form, provider) {
  return provider?.balance && provider.api_key_set ? balanceMount(form, provider, 'settings', true) : null;
}

function setupBalance() {
  $('#context-info').addEventListener('toggle', event => {
    if (!event.currentTarget.open) return;
    for (const view of balanceViews) if (view.variant === 'popover' && view.root.isConnected) balanceEnsure(view.provider.id);
  });
}
