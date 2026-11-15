/* Verifica statica del progetto prima del commit:
   - JSON validi
   - file referenziati dal manifest esistenti
   - sintassi JS (via new Function / vm)
   - regole DNR valide (no wildcard, id unici, urlFilter o regexFilter)
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let errors = 0;
const fail = (m) => { console.error('✗', m); errors++; };
const ok = (m) => console.log('✓', m);

/* ---------- JSON ---------- */
const jsonFiles = [
  'manifest.json',
  '_locales/it/messages.json',
  '_locales/en/messages.json',
  'src/rules/trackers.json',
  'src/rules/telemetry.json'
];
const parsed = {};
for (const f of jsonFiles) {
  try {
    parsed[f] = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    ok(`JSON ${f}`);
  } catch (e) { fail(`JSON ${f}: ${e.message}`); }
}

/* ---------- manifest ---------- */
const m = parsed['manifest.json'];
if (m) {
  if (m.manifest_version !== 3) fail('manifest_version deve essere 3');
  const refs = [
    m.background?.service_worker,
    m.action?.default_popup,
    m.options_ui?.page,
    ...Object.values(m.icons || {}),
    ...Object.values(m.action?.default_icon || {}),
    ...(m.content_scripts || []).flatMap((c) => c.js || []),
    ...(m.web_accessible_resources || []).flatMap((w) => w.resources || []),
    ...(m.declarative_net_request?.rule_resources || []).map((r) => r.path)
  ].filter(Boolean);
  for (const r of refs) {
    if (!fs.existsSync(path.join(root, r))) fail(`file mancante nel manifest: ${r}`);
  }
  ok(`${refs.length} risorse del manifest presenti`);

  // popup/options devono esistere i file html e i loro asset
  for (const page of ['popup/popup.html', 'options/options.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((x) => x[1])
      .filter((u) => !u.startsWith('http') && !u.startsWith('#'));
    for (const a of assets) {
      const p = path.join(root, path.dirname(page), a);
      if (!fs.existsSync(p)) fail(`${page}: asset mancante ${a}`);
    }
    ok(`${page}: ${assets.length} asset ok`);
  }
}

/* ---------- regole DNR ---------- */
for (const file of ['src/rules/trackers.json', 'src/rules/telemetry.json']) {
  const rules = parsed[file];
  if (!Array.isArray(rules)) { fail(`${file}: non è un array`); continue; }
  const ids = new Set();
  let bad = 0;
  for (const r of rules) {
    if (typeof r.id !== 'number' || ids.has(r.id)) { fail(`${file}: id duplicato/non valido ${r.id}`); bad++; }
    ids.add(r.id);
    if (!r.action || r.action.type !== 'block') { fail(`${file}: azione non block (id ${r.id})`); bad++; }
    const c = r.condition || {};
    if (!c.urlFilter && !c.regexFilter) { fail(`${file}: nessun filtro (id ${r.id})`); bad++; }
    if (c.urlFilter && /[*|]/.test(c.urlFilter.replace(/^\|\|/, '').replace(/\^$/, ''))) {
      fail(`${file}: wildcard non supportata in urlFilter (id ${r.id})`);
      bad++;
    }
    if (c.regexFilter) { try { new RegExp(c.regexFilter); } catch (e) { fail(`${file}: regex non valida (id ${r.id})`); bad++; } }
  }
  if (!bad) ok(`${file}: ${rules.length} regole valide`);
}

/* ---------- sintassi JS ---------- */
const jsFiles = [
  'src/background.js', 'src/content.js', 'src/inject.js',
  'popup/popup.js', 'options/options.js', 'tools/make-icons.cjs'
];
for (const f of jsFiles) {
  const code = fs.readFileSync(path.join(root, f), 'utf8');
  try {
    new vm.Script(code, { filename: f }); // solo parsing, non esegue
    ok(`JS ${f}`);
  } catch (e) { fail(`JS ${f}: ${e.message}`); }
}

/* ---------- CSS/HTML minimi ---------- */
for (const f of ['popup/popup.css', 'options/options.css']) {
  const css = fs.readFileSync(path.join(root, f), 'utf8');
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  if (open !== close) fail(`${f}: graffe sbilanciate (${open}/${close})`);
  else ok(`CSS ${f}`);
}

console.log('\n' + (errors ? `❌ ${errors} problemi` : '✅ tutto ok'));
process.exit(errors ? 1 : 0);
