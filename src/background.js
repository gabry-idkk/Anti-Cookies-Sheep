/**
 * Anti-Cookies Sheep — service worker (MV3)
 * ------------------------------------------------------------------
 * Blocca cookie, tracker, fingerprinting e telemetria su tutti i siti.
 * Nessuna dipendenza esterna, nessuna rete: tutto in locale.
 */

const LOG_PREFIX = '[ACS]';
const log = (...a) => console.debug(LOG_PREFIX, ...a);

/* ------------------------------------------------------------------ */
/* 1. Impostazioni predefinite                                         */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  enabled: true,

  // --- Cookie ---
  blockThirdPartyCookies: true,   // cookie di terze parti
  blockAllCookies: false,         // tutti i cookie (sessione temporanea, niente login)
  sessionCookiesOnly: false,      // consenti solo cookie di sessione (no persistenti)
  autoClearOnClose: false,        // cancella i cookie alla chiusura della scheda
  clearOnStartup: false,          // pulizia all'avvio del browser

  // --- Rete / tracker ---
  blockTrackers: true,            // liste DNR statiche (tracker + telemetria)
  blockTelemetry: true,
  blockBeacons: true,             // navigator.sendBeacon + ping
  stripTrackingHeaders: true,     // Referer/X-Client-Data/Raw-Sec-CH...
  blockCnameCloaking: true,       // tracker mascherati sul dominio del sito
  gpc: true,                      // Global Privacy Control (Sec-GPC: 1)
  dnt: true,                      // Do Not Track (DNT: 1)

  // --- Fingerprinting / API invasive ---
  blockFingerprinting: true,      // canvas, WebGL, AudioContext, fonts, WebRTC...
  blockClientHints: true,         // high-entropy client hints
  blockFloc: true,                // Topics API / FLoC / Attribution Reporting
  blockStorage: false,            // localStorage / IndexedDB / sessionStorage
  blockServiceWorkers: false,

  // --- Anti cookie-wall ---
  autoRejectBanners: true,        // clicca "Rifiuta" sui banner cookie
  hideBanners: true,              // nasconde i banner residui

  // --- Liste ---
  whitelist: [],                  // domini con blocco disattivato
  blacklist: [],                  // domini da bloccare con priorità
  siteOverrides: {}               // { "example.com": { blockAllCookies: true, ... } }
};

let settings = { ...DEFAULT_SETTINGS };
let hooksInstalled = false;

/* ------------------------------------------------------------------ */
/* 2. Storage helpers                                                  */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  return settings;
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
  await applySettings();
  broadcast({ type: 'settings-changed', settings });
  return settings;
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* nessun listener: ok */ });
}

/** Profilo "massima protezione" per i domini in blacklist. */
const BLACKLIST_PRESET = {
  enabled: true,
  blockAllCookies: true,
  blockFingerprinting: true,
  blockStorage: true,
  blockTrackers: true,
  blockTelemetry: true
};

/** Impostazioni effettive per un dato hostname (tiene conto di whitelist/blacklist/override). */
function effectiveSettings(hostname) {
  if (!hostname) return settings;
  const host = hostname.replace(/^www\./, '');

  const inList = (list) => (list || []).some((d) => {
    const dd = String(d).replace(/^www\./, '').toLowerCase();
    return host === dd || host.endsWith('.' + dd);
  });

  if (inList(settings.whitelist)) {
    return { ...settings, enabled: false };
  }

  const override = settings.siteOverrides?.[host] || {};
  const base = inList(settings.blacklist) ? { ...settings, ...BLACKLIST_PRESET } : settings;
  return { ...base, ...override };
}

/* ------------------------------------------------------------------ */
/* 3. Statistiche                                                      */
/* ------------------------------------------------------------------ */

const STATS_KEY = 'stats';
let stats = {
  cookiesBlocked: 0,
  headersStripped: 0,
  bannersRejected: 0,
  fingerprintBlocks: 0,
  perTab: {},        // tabId -> { host, count }
  perDomain: {},     // host -> count
  topDomains: []     // calcolato al volo
};

let statsLoaded = false;
async function loadStats() {
  if (statsLoaded) return;
  const s = await chrome.storage.local.get(STATS_KEY);
  stats = { ...stats, ...(s[STATS_KEY] || {}) };
  stats.perTab = {};
  statsLoaded = true;
}

let persistTimer = null;
function bumpStat(kind, tabId, host) {
  if (kind === 'cookie') stats.cookiesBlocked++;
  if (kind === 'header') stats.headersStripped++;
  if (kind === 'banner') stats.bannersRejected++;
  if (kind === 'fingerprint') stats.fingerprintBlocks++;

  if (host) {
    stats.perDomain[host] = (stats.perDomain[host] || 0) + 1;
    // limita la mappa per non farla crescere all'infinito
    const keys = Object.keys(stats.perDomain);
    if (keys.length > 500) {
      keys.sort((a, b) => stats.perDomain[a] - stats.perDomain[b])
        .slice(0, 100)
        .forEach((k) => delete stats.perDomain[k]);
    }
  }
  if (tabId != null && tabId >= 0) {
    const t = (stats.perTab[tabId] = stats.perTab[tabId] || { host, count: 0 });
    t.host = host || t.host;
    t.count++;
  }

  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.local.set({ [STATS_KEY]: {
      cookiesBlocked: stats.cookiesBlocked,
      headersStripped: stats.headersStripped,
      bannersRejected: stats.bannersRejected,
      fingerprintBlocks: stats.fingerprintBlocks,
      perDomain: stats.perDomain
    }});
  }, 1500);
}

/* ------------------------------------------------------------------ */
/* 4. Applicazione impostazioni al browser                             */
/* ------------------------------------------------------------------ */

async function applySettings() {
  try {
    // 4a. Impostazioni native di Chrome sui cookie (cintura + bretelle)
    if (chrome.privacy?.websites?.thirdPartyCookiesAllowed) {
      await chrome.privacy.websites.thirdPartyCookiesAllowed.set({
        value: !(settings.enabled && settings.blockThirdPartyCookies)
      });
    }

    // 4b. Do Not Track
    if (chrome.privacy?.websites?.doNotTrackEnabled) {
      await chrome.privacy.websites.doNotTrackEnabled.set({ value: !!settings.dnt });
    }

    // 4c. Livello cookie per sito
    const cookieSetting = settings.blockAllCookies
      ? 'block'
      : (settings.sessionCookiesOnly ? 'session_only' : 'allow');

    await chrome.contentSettings.cookies.set({
      primaryPattern: '<all_urls>',
      setting: cookieSetting
    });

    // 4d. Javascript non deve poter leggere/scrivere cookie di terze parti:
    //     le regole DNR dinamiche gestiscono i domini custom
    await syncDynamicRules();
  } catch (err) {
    log('applySettings error', err);
  }
}

/** Applica il livello cookie di Chrome anche per singolo host (whitelist/blacklist/override). */
async function applyHostCookieRule(host, mode) {
  const setting = mode === 'allow' ? 'allow' : (mode === 'block' ? 'block' : 'session_only');
  const patterns = [`https://${host}/*`, `https://*.${host}/*`, `http://${host}/*`, `http://*.${host}/*`];
  for (const primaryPattern of patterns) {
    try {
      await chrome.contentSettings.cookies.set({ primaryPattern, setting, scope: 'regular' });
    } catch (e) { log('contentSettings', primaryPattern, e); }
  }
}

/** Regole DNR dinamiche: blacklist personale + blocchi configurabili. */
async function syncDynamicRules() {
  const rules = [];
  let id = 1;

  const addDomainRule = (domain, types) => {
    const clean = String(domain).trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\.?/, '');
    if (!clean || clean.length < 3) return;
    rules.push({
      id: id++,
      priority: 100,
      action: { type: 'block' },
      condition: {
        urlFilter: `||${clean}^`,
        resourceTypes: types || ['script', 'image', 'xmlhttprequest', 'sub_frame', 'ping', 'media', 'other', 'websocket']
      }
    });
  };

  // Blacklist: blocca tutto il traffico verso quei domini
  (settings.blacklist || []).forEach((d) => addDomainRule(d));

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules.slice(0, 400)
  });

  // Abilita/disabilita le liste statiche in base alle impostazioni
  const enableRuleset = async (idName, on) => {
    try {
      const list = await chrome.declarativeNetRequest.getEnabledRulesets();
      const isOn = list.includes(idName);
      if (on && !isOn) await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [idName] });
      if (!on && isOn) await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [idName] });
    } catch (e) { log('ruleset', idName, e); }
  };
  await enableRuleset('trackers', settings.enabled && settings.blockTrackers);
  await enableRuleset('telemetry', settings.enabled && settings.blockTelemetry);
}

/* ------------------------------------------------------------------ */
/* 5. Pulizia cookie                                                   */
/* ------------------------------------------------------------------ */

/**
 * Cancella i cookie bloccati.
 * - blockAllCookies  -> tutti i cookie di tutti i siti
 * - blockThirdParty  -> tutti i cookie non di prima parte
 */
async function purgeCookies(scope = 'all') {
  await loadSettings();
  const query = scope === 'all' ? {} : { domain: scope };
  const cookies = await chrome.cookies.getAll(query);

  let removed = 0;
  for (const c of cookies) {
    // non toccare mai i cookie delle estensioni
    if (c.storeId === 'extension') continue;

    const eff = effectiveSettings(c.domain.replace(/^\./, ''));
    if (!eff.enabled) continue;

    const firstParty = await isFirstPartyCookie(c);
    const mustBlock =
      eff.blockAllCookies ||
      (eff.blockThirdPartyCookies && !firstParty);

    if (!mustBlock) continue;

    const url = buildCookieUrl(c);
    try {
      await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId, partitionKey: c.partitionKey });
      removed++;
      bumpStat('cookie', null, c.domain.replace(/^\./, ''));
    } catch (e) { log('remove cookie', c.name, e); }
  }
  return removed;
}

function buildCookieUrl(c) {
  const scheme = c.secure ? 'https' : 'http';
  const domain = c.domain.replace(/^\./, '');
  return `${scheme}://${domain}${c.path || '/'}`;
}

/**
 * Determina se un cookie è di prima parte rispetto al sito visitato.
 * Usiamo l'initiator registrato in webRequest (per-tab) e fallback su eTLD+1.
 */
const tabSiteMap = new Map(); // tabId -> hostname del sito di primo livello

async function isFirstPartyCookie(cookie) {
  const cookieDomain = cookie.domain.replace(/^\./, '').toLowerCase();
  const sites = [...tabSiteMap.values()];
  if (sites.length === 0) {
    // fallback: consideriamo di prima parte se il dominio è "semplice" (2 etichette + tld)
    return cookieDomain.split('.').length <= 2;
  }
  return sites.some((s) => {
    const site = s.replace(/^www\./, '').toLowerCase();
    return cookieDomain === site || site.endsWith('.' + cookieDomain) || cookieDomain.endsWith('.' + site);
  });
}

/* ------------------------------------------------------------------ */
/* 6. webRequest: rimozione header di tracking + blocco cookie         */
/* ------------------------------------------------------------------ */

const TRACKING_HEADERS = [
  'x-client-data',       // Chrome experimentation id (Google)
  'x-google-client-data',
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-model',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-wow64',
  'sec-ch-ua-form-factors',
  'x-purpose',
  'x-moz',
  'x-att-deviceid'
];

const TRACKING_PARAMS = [
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'twclid', 'ttclid',
  'li_fat_id', 'igshid', 'yclid', 'wbraid', 'gbraid', 'srsltid',
  'mc_eid', 'mkt_tok', '_hsenc', '_hsmi', 'vero_id', 'oly_anon_id',
  'oly_enc_id', 'rb_clickid', 'sc_cid', 'epik', 'pk_campaign', 'pk_kwd'
];

function installWebRequestHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const filter = { urls: ['<all_urls>'] };

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (!settings.enabled) return;

      const eff = effectiveSettings(hostFromUrl(details.url) || hostFromUrl(details.initiator));
      if (!eff.enabled) return;

      const headers = details.requestHeaders || [];
      let changed = false;
      const out = [];

      for (const h of headers) {
        const name = h.name.toLowerCase();

        // 6a. rimozione header di tracking / client hints
        if (eff.stripTrackingHeaders && TRACKING_HEADERS.includes(name)) {
          changed = true;
          bumpStat('header', details.tabId, hostFromUrl(details.url));
          continue;
        }

        // 6b. Referer ridotto a origin (nessun path = nessuna query string)
        if (eff.stripTrackingHeaders && name === 'referer') {
          try {
            const u = new URL(h.value);
            h.value = u.origin + '/';
            changed = true;
          } catch { /* valore non valido: lascia stare */ }
          out.push(h);
          continue;
        }

        // 6c. Global Privacy Control + DNT
        if (eff.gpc && name === 'sec-gpc') { out.push({ name: 'Sec-GPC', value: '1' }); changed = true; continue; }
        if (eff.dnt && name === 'dnt') { out.push({ name: 'DNT', value: '1' }); changed = true; continue; }

        out.push(h);
      }

      if (eff.gpc && !out.some((h) => h.name.toLowerCase() === 'sec-gpc')) {
        out.push({ name: 'Sec-GPC', value: '1' }); changed = true;
      }
      if (eff.dnt && !out.some((h) => h.name.toLowerCase() === 'dnt')) {
        out.push({ name: 'DNT', value: '1' }); changed = true;
      }

      // 6d. Cookie: se il sito è in "blocca tutti" togliamo l'header Cookie
      if (eff.blockAllCookies) {
        const filtered = out.filter((h) => h.name.toLowerCase() !== 'cookie');
        if (filtered.length !== out.length) { changed = true; bumpStat('cookie', details.tabId, hostFromUrl(details.url)); }
        if (changed) return { requestHeaders: filtered };
      }

      // 6e. Rimozione parametri di tracking dall'URL (fbclid, gclid, ...)
      //     DNR non può riscrivere la query: lo facciamo con un redirect? No.
      //     Lo gestiamo lato content script per i link cliccati.

      return changed ? { requestHeaders: out } : undefined;
    },
    filter,
    ['blocking', 'requestHeaders', 'extraHeaders']
  );

  // 6f. Blocco dei beacon / ping a domini di tracking
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!settings.enabled) return;
      const eff = effectiveSettings(hostFromUrl(details.url) || hostFromUrl(details.initiator));
      if (!eff.enabled) return;

      if (eff.blockBeacons && details.type === 'ping') {
        bumpStat('header', details.tabId, hostFromUrl(details.url));
        return { cancel: true };
      }
      return undefined;
    },
    { urls: ['<all_urls>'], types: ['ping'] },
    ['blocking']
  );

  // 6g. Risposta: rimuovi header di tracking in uscita dal server (Set-Cookie di terze parti)
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (!settings.enabled) return;
      const eff = effectiveSettings(hostFromUrl(details.url) || hostFromUrl(details.initiator));
      if (!eff.enabled) return;
      if (!eff.blockThirdPartyCookies && !eff.blockAllCookies) return;

      const headers = details.responseHeaders || [];
      if (!headers.some((h) => h.name.toLowerCase() === 'set-cookie')) return undefined;

      // Sito visitato: initiator, oppure l'host del frame principale
      const site = details.initiator ? hostFromUrl(details.initiator) : null;
      const target = hostFromUrl(details.url);
      if (!target) return undefined;

      // Se non sappiamo chi ha chiesto la risorsa non tocchiamo niente:
      // è quasi sempre un cookie di prima parte e romperemmo il login.
      if (!site) return undefined;

      const thirdParty = !isSameSite(site, target);
      if (!(eff.blockAllCookies || (eff.blockThirdPartyCookies && thirdParty))) return undefined;

      const out = headers.filter((h) => h.name.toLowerCase() !== 'set-cookie');
      if (out.length !== headers.length) {
        bumpStat('cookie', details.tabId, target);
        return { responseHeaders: out };
      }
      return undefined;
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'image'] },
    ['blocking', 'responseHeaders', 'extraHeaders']
  );
}

/* ------------------------------------------------------------------ */
/* 7. Utility domini                                                   */
/* ------------------------------------------------------------------ */

function hostFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname;
  } catch { return null; }
}

/** eTLD+1 approssimato (gestisce i suffissi più comuni a due livelli). */
const MULTI_LEVEL = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'ne.jp', 'or.jp', 'com.au',
  'net.au', 'org.au', 'co.nz', 'com.br', 'com.mx', 'com.ar', 'co.in', 'com.tr',
  'com.cn', 'com.tw', 'com.hk', 'com.sg', 'co.za', 'com.pl', 'co.kr'
]);

function registrableDomain(host) {
  const parts = String(host).toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  if (MULTI_LEVEL.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

function isSameSite(a, b) {
  return registrableDomain(a) === registrableDomain(b);
}

/* ------------------------------------------------------------------ */
/* 8. Eventi                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  await loadSettings();
  if (details.reason === 'install') {
    await chrome.storage.local.set({ settings });
  }
  await applySettings();
  await purgeCookies('all');
  log('installato', details.reason);
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  await applySettings();
  if (settings.clearOnStartup) await purgeCookies('all');
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  tabSiteMap.delete(tabId);
  delete stats.perTab[tabId];
  if (settings.autoClearOnClose) {
    // cancella i cookie impostati di recente (ultima ora) dai domini non whitelisted
    const since = Date.now() / 1000 - 3600;
    const cookies = await chrome.cookies.getAll({});
    for (const c of cookies) {
      if (c.storeId === 'extension') continue;
      if (c.lastUpdate && c.lastUpdate < since) continue;
      const eff = effectiveSettings(c.domain.replace(/^\./, ''));
      if (!eff.enabled) continue;
      try {
        await chrome.cookies.remove({
          url: buildCookieUrl(c), name: c.name, storeId: c.storeId, partitionKey: c.partitionKey
        });
        bumpStat('cookie', null, c.domain.replace(/^\./, ''));
      } catch { /* già rimosso */ }
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading' && tab.url) {
    const h = hostFromUrl(tab.url);
    if (h) {
      tabSiteMap.set(tabId, h);
      // aggiorna badge
      const count = stats.perTab?.[tabId]?.count || 0;
      chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#2e7d32' }).catch(() => {});
    }
  }
});

// Messaggi dal content script e dalla UI
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await loadSettings();

    switch (msg?.type) {
      case 'get-state': {
        const tab = msg.tabId ? await chrome.tabs.get(msg.tabId).catch(() => null) : null;
        const host = hostFromUrl(tab?.url);
        sendResponse({
          settings,
          effective: effectiveSettings(host),
          host,
          tabStats: stats.perTab?.[msg.tabId] || { count: 0 },
          global: {
            cookiesBlocked: stats.cookiesBlocked,
            headersStripped: stats.headersStripped,
            bannersRejected: stats.bannersRejected,
            fingerprintBlocks: stats.fingerprintBlocks
          },
          topDomains: Object.entries(stats.perDomain)
            .sort((a, b) => b[1] - a[1]).slice(0, 8)
        });
        break;
      }

      case 'update-settings': {
        await saveSettings(msg.patch || {});
        await purgeCookies('all');
        sendResponse({ ok: true, settings });
        break;
      }

      case 'toggle-site': {
        const host = (msg.host || '').replace(/^www\./, '');
        const wl = new Set(settings.whitelist || []);
        const bl = new Set(settings.blacklist || []);
        if (msg.mode === 'allow') { wl.add(host); bl.delete(host); }
        else if (msg.mode === 'block') { bl.add(host); wl.delete(host); }
        else { wl.delete(host); bl.delete(host); }

        // il livello cookie di Chrome vale anche per i documenti (contentSettings)
        await applyHostCookieRule(host, msg.mode);

        await saveSettings({ whitelist: [...wl], blacklist: [...bl] });
        if (msg.mode !== 'allow') await purgeCookies(host);
        sendResponse({ ok: true });
        break;
      }

      case 'set-site-override': {
        const host = (msg.host || '').replace(/^www\./, '');
        const overrides = { ...(settings.siteOverrides || {}) };
        if (msg.patch && Object.keys(msg.patch).length) overrides[host] = { ...(overrides[host] || {}), ...msg.patch };
        else delete overrides[host];
        await saveSettings({ siteOverrides: overrides });
        sendResponse({ ok: true });
        break;
      }

      case 'purge-cookies': {
        const n = await purgeCookies(msg.scope || 'all');
        sendResponse({ ok: true, removed: n });
        break;
      }

      case 'clear-all-browsing': {
        await chrome.browsingData.remove({ since: 0 }, {
          cookies: true,
          localStorage: true,
          indexedDB: true,
          cacheStorage: true,
          serviceWorkers: true
        });
        sendResponse({ ok: true });
        break;
      }

      case 'banner-rejected': {
        bumpStat('banner', sender.tab?.id, hostFromUrl(sender.tab?.url));
        sendResponse({ ok: true });
        break;
      }

      case 'fingerprint-blocked': {
        bumpStat('fingerprint', sender.tab?.id, hostFromUrl(sender.tab?.url));
        sendResponse({ ok: true });
        break;
      }

      case 'get-settings': {
        sendResponse({ settings });
        break;
      }

      case 'reset-settings': {
        settings = { ...DEFAULT_SETTINGS };
        await chrome.storage.local.set({ settings });
        await applySettings();
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true; // risposta asincrona
});

// Cambi di cookie: se qualcuno prova a reimpostare un cookie bloccato, lo rimuoviamo subito
chrome.cookies.onChanged.addListener(async (info) => {
  if (info.removed) return;
  const c = info.cookie;
  if (!c || c.storeId === 'extension') return;
  if (info.cause === 'explicit' && c.name.startsWith('acs_')) return;

  const eff = effectiveSettings(c.domain.replace(/^\./, ''));
  if (!eff.enabled) return;

  const firstParty = await isFirstPartyCookie(c);
  const mustBlock = eff.blockAllCookies || (eff.blockThirdPartyCookies && !firstParty);
  if (!mustBlock) return;

  try {
    await chrome.cookies.remove({
      url: buildCookieUrl(c), name: c.name, storeId: c.storeId, partitionKey: c.partitionKey
    });
    bumpStat('cookie', null, c.domain.replace(/^\./, ''));
  } catch (e) { log('rimozione immediata fallita', c.name, e); }
});

/* ------------------------------------------------------------------ */
/* 9. Bootstrap                                                        */
/* ------------------------------------------------------------------ */

(async () => {
  await loadSettings();
  await loadStats();
  await applySettings();
  installWebRequestHooks();

  // riallinea i livelli cookie per i domini salvati nelle liste
  for (const h of settings.whitelist || []) await applyHostCookieRule(h, 'allow');
  for (const h of settings.blacklist || []) await applyHostCookieRule(h, 'block');

  log('pronto', settings.enabled ? 'attivo' : 'disattivato');
})();
