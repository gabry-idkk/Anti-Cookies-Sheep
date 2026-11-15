/* Anti-Cookies Sheep — pagina impostazioni */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let settings = {};

async function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || {})));
}

const fmt = (n) => {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n ?? 0);
};

const status = (txt, isError = false) => {
  const el = $('#status');
  el.textContent = txt;
  el.style.color = isError ? 'var(--danger)' : 'var(--accent)';
  clearTimeout(status._t);
  status._t = setTimeout(() => { el.textContent = ''; }, 3000);
};

/* ---------------- render ---------------- */

function render() {
  $('#master').checked = !!settings.enabled;

  $$('input[data-key]').forEach((el) => {
    el.checked = !!settings[el.dataset.key];
  });

  renderChips('#whitelist', settings.whitelist || [], 'whitelist');
  renderChips('#blacklist', settings.blacklist || [], 'blacklist');
}

function renderChips(sel, list, kind) {
  const box = $(sel);
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<span style="color:var(--muted);font-size:12px">Nessun dominio</span>';
    return;
  }
  list.forEach((d) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `<span></span><button title="Rimuovi" aria-label="Rimuovi">×</button>`;
    chip.querySelector('span').textContent = d;
    chip.querySelector('button').addEventListener('click', () => removeFromList(kind, d));
    box.appendChild(chip);
  });
}

async function renderStats() {
  const state = await send({ type: 'get-state' });
  const g = state.global || {};
  $('#g-cookies').textContent = fmt(g.cookiesBlocked);
  $('#g-headers').textContent = fmt(g.headersStripped);
  $('#g-banners').textContent = fmt(g.bannersRejected);
  $('#g-fp').textContent = fmt(g.fingerprintBlocks);

  const ul = $('#top-domains');
  const top = state.topDomains || [];
  if (!top.length) {
    ul.innerHTML = '<li class="empty">Nessun dato ancora.</li>';
    return;
  }
  ul.innerHTML = top
    .map(([d, n]) => `<li><span>${escapeHtml(d)}</span><b>${fmt(n)}</b></li>`)
    .join('');
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

/* ---------------- azioni ---------------- */

async function update(patch) {
  const res = await send({ type: 'update-settings', patch });
  if (res.settings) { settings = res.settings; render(); }
}

async function removeFromList(kind, domain) {
  const list = (settings[kind] || []).filter((d) => d !== domain);
  await update({ [kind]: list });
  status(`Rimosso ${domain} da ${kind}.`);
}

function normalizeDomain(v) {
  return String(v || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/^\./, '');
}

async function addToList(kind, inputSel) {
  const raw = $(inputSel).value;
  const d = normalizeDomain(raw);
  if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
    status('Dominio non valido. Esempio: esempio.com', true);
    return;
  }
  const other = kind === 'whitelist' ? 'blacklist' : 'whitelist';
  const list = new Set(settings[kind] || []);
  list.add(d);
  const otherList = (settings[other] || []).filter((x) => x !== d);
  await update({ [kind]: [...list], [other]: otherList });
  $(inputSel).value = '';
  status(`${d} aggiunto.`);
}

/* ---------------- eventi ---------------- */

$('#master').addEventListener('change', (e) => update({ enabled: e.target.checked }));

$$('input[data-key]').forEach((el) => {
  el.addEventListener('change', () => update({ [el.dataset.key]: el.checked }));
});

$('#wl-add').addEventListener('click', () => addToList('whitelist', '#wl-input'));
$('#bl-add').addEventListener('click', () => addToList('blacklist', '#bl-input'));
$('#wl-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addToList('whitelist', '#wl-input'); });
$('#bl-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addToList('blacklist', '#bl-input'); });

$('#purge').addEventListener('click', async () => {
  const res = await send({ type: 'purge-cookies', scope: 'all' });
  status(`Pulizia completata: ${res.removed ?? 0} cookie rimossi.`);
  renderStats();
});

$('#wipe').addEventListener('click', async () => {
  if (!confirm('Cancellare cookie, localStorage, IndexedDB, cache e service worker di tutti i siti? Verrai disconnesso ovunque.')) return;
  await send({ type: 'clear-all-browsing' });
  status('Dati di navigazione cancellati.');
  renderStats();
});

$('#reset').addEventListener('click', async () => {
  if (!confirm('Ripristinare tutte le impostazioni predefinite?')) return;
  await send({ type: 'reset-settings' });
  await load();
  status('Impostazioni ripristinate.');
});

/* ---------------- bootstrap ---------------- */

async function load() {
  const state = await send({ type: 'get-state' });
  settings = state.settings || {};
  render();
  await renderStats();
}

const manifest = chrome.runtime.getManifest();
$('#version').textContent = `v${manifest.version}`;

load();
setInterval(renderStats, 4000);
