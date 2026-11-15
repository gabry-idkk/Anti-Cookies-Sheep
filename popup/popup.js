/* Anti-Cookies Sheep — popup */

let TAB_ID = null;
let HOST = null;
let STATE = null;

const $ = (id) => document.getElementById(id);

async function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || {})));
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  TAB_ID = tab?.id ?? null;
  HOST = tab?.url ? hostOf(tab.url) : null;

  STATE = await send({ type: 'get-state', tabId: TAB_ID });
  render();
}

function render() {
  if (!STATE) return;
  const { settings, effective, host, tabStats, global } = STATE;

  $('host').textContent = host || 'Pagina interna';
  $('master').checked = !!settings.enabled;

  // statistiche globali
  $('s-cookies').textContent = fmt(global?.cookiesBlocked || 0);
  $('s-headers').textContent = fmt(global?.headersStripped || 0);
  $('s-banners').textContent = fmt(global?.bannersRejected || 0);
  $('s-fp').textContent = fmt(global?.fingerprintBlocks || 0);
  $('blocked-tab').textContent = tabStats?.count || 0;

  // toggle principali (valori globali)
  $('t-third').checked = !!settings.blockThirdPartyCookies;
  $('t-all').checked = !!settings.blockAllCookies;
  $('t-trackers').checked = !!settings.blockTrackers;
  $('t-fp').checked = !!settings.blockFingerprinting;
  $('t-banners').checked = !!settings.autoRejectBanners;

  // modalità per questo sito
  const hostClean = (host || '').replace(/^www\./, '');
  const inWL = (settings.whitelist || []).some((d) => hostClean === d || hostClean.endsWith('.' + d));
  const inBL = (settings.blacklist || []).some((d) => hostClean === d || hostClean.endsWith('.' + d));
  const mode = inWL ? 'allow' : (inBL ? 'block' : 'default');
  document.querySelectorAll('#site-mode button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });

  const hints = {
    default: hostClean ? `Protezione normale su ${hostClean}.` : 'Nessun sito attivo.',
    allow: 'Blocco disattivato: i cookie di questo sito sono permessi.',
    block: 'Massima protezione: cookie, storage e fingerprinting bloccati.'
  };
  $('site-hint').textContent = hints[mode];

  // disabilita la modalità sito se non c'è un host
  document.querySelectorAll('#site-mode button').forEach((b) => { b.disabled = !hostClean; });
}

function fmt(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/* ---- eventi ---- */

$('master').addEventListener('change', async (e) => {
  await send({ type: 'update-settings', patch: { enabled: e.target.checked } });
  refresh();
});

const bindToggle = (id, key) => {
  $(id).addEventListener('change', async (e) => {
    await send({ type: 'update-settings', patch: { [key]: e.target.checked } });
    refresh();
  });
};
bindToggle('t-third', 'blockThirdPartyCookies');
bindToggle('t-all', 'blockAllCookies');
bindToggle('t-trackers', 'blockTrackers');
bindToggle('t-fp', 'blockFingerprinting');
bindToggle('t-banners', 'autoRejectBanners');

$('site-mode').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn || !HOST) return;
  await send({ type: 'toggle-site', host: HOST, mode: btn.dataset.mode });
  refresh();
});

$('purge').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = 'Pulizia…';
  const res = await send({ type: 'purge-cookies', scope: 'all' });
  btn.textContent = `Rimossi ${res.removed ?? 0}`;
  setTimeout(() => { btn.textContent = 'Pulisci cookie ora'; btn.disabled = false; refresh(); }, 1200);
});

$('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

refresh();
