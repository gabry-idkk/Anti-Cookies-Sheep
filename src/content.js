/**
 * Anti-Cookies Sheep — content script
 * - chiede le impostazioni al service worker
 * - inietta `inject.js` nel world MAIN (fingerprinting, storage, Topics API...)
 * - rimuove i parametri di tracking dai link e dal document.referrer
 * - rifiuta automaticamente i banner cookie
 */
(() => {
  'use strict';

  const HOST = location.hostname;
  let EFF = null;
  const log = (...a) => console.debug('[ACS]', ...a);

  /* ---------------------------------------------------------------- */
  /* 1. Impostazioni                                                   */
  /* ---------------------------------------------------------------- */

  function ask(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(res || {}));
      } catch {
        resolve({});
      }
    });
  }

  async function init() {
    const state = await ask({ type: 'get-state' });
    EFF = state.effective || null;
    if (!EFF) return;

    if (EFF.enabled) {
      injectMainWorld(EFF);
      cleanTrackingLinks(EFF);
      if (EFF.autoRejectBanners) autoRejectBanners();
      if (EFF.hideBanners) hideBannerCss();
    } else {
      log('sito in whitelist: nessun blocco attivo');
    }
  }

  /* ---------------------------------------------------------------- */
  /* 2. Iniezione nel MAIN world                                       */
  /* ---------------------------------------------------------------- */

  // segnalazioni di blocco che arrivano dal MAIN world
  window.addEventListener('acs:blocked', () => {
    ask({ type: 'fingerprint-blocked' });
  });

  function injectMainWorld(eff) {
    const flags = {
      blockFingerprinting: !!eff.blockFingerprinting,
      blockStorage: !!eff.blockStorage,
      blockClientHints: !!eff.blockClientHints,
      blockFloc: !!eff.blockFloc,
      blockBeacons: !!eff.blockBeacons,
      blockServiceWorkers: !!eff.blockServiceWorkers,
      host: HOST
    };

    const run = () => {
      try {
        const target = document.head || document.documentElement;
        if (!target) return;

        // I flag passano via attributo: nessun JSON nell'URL, nessun eval
        const holder = document.createElement('meta');
        holder.id = '__acs_flags__';
        holder.setAttribute('data-acs', JSON.stringify(flags));
        target.appendChild(holder);

        const s = document.createElement('script');
        s.src = chrome.runtime.getURL('src/inject.js');
        s.async = false;               // eseguito prima degli script successivi
        s.onload = () => { s.remove(); holder.remove(); };
        s.onerror = () => { s.remove(); holder.remove(); };
        target.appendChild(s);
      } catch { /* pagina esotica: niente iniezione */ }
    };

    if (document.documentElement) run();
    else document.addEventListener('readystatechange', run, { once: true });
  }

  /* ---------------------------------------------------------------- */
  /* 3. Parametri di tracking nei link                                 */
  /* ---------------------------------------------------------------- */

  const TRACKING_PARAMS = [
    'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'twclid', 'ttclid',
    'li_fat_id', 'igshid', 'yclid', 'wbraid', 'gbraid', 'srsltid', 'epik',
    'mc_eid', 'mkt_tok', '_hsenc', '_hsmi', 'vero_id', 'oly_anon_id',
    'oly_enc_id', 'rb_clickid', 'sc_cid', 'pk_campaign', 'pk_kwd', 'pk_source',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'utm_name', 'utm_cid', 'utm_reader', 'utm_social', 'utm_brand',
    'ga_source', 'ga_medium', 'ga_campaign', 'ga_term', 'ga_content'
  ];

  function stripParams(url) {
    try {
      const u = new URL(url, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
      let touched = false;
      for (const p of TRACKING_PARAMS) {
        if (u.searchParams.has(p)) { u.searchParams.delete(p); touched = true; }
      }
      return touched ? u.toString() : url;
    } catch { return url; }
  }

  function cleanTrackingLinks(eff) {
    if (!eff.stripTrackingHeaders) return;

    // URL della pagina stessa: puliamo la barra degli indirizzi se ha solo tracking
    try {
      const clean = stripParams(location.href);
      if (clean !== location.href) {
        history.replaceState(history.state, '', clean);
      }
    } catch { /* pagine con stato particolare */ }

    const onClick = (ev) => {
      const a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      const clean = stripParams(href);
      if (clean !== href) {
        a.setAttribute('href', clean);
        // se il browser ha già letto l'href, forziamo la navigazione pulita
        if (a.target === '_blank' || ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          window.open(clean, a.target || '_blank', 'noopener,noreferrer');
        }
      }
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);

    // Risorse caricate: rimuoviamo i parametri di tracking da img/iframe/script
    const scrub = (root) => {
      root.querySelectorAll?.('img[src], iframe[src], script[src], source[src]').forEach((el) => {
        const src = el.getAttribute('src');
        if (!src) return;
        const clean = stripParams(src);
        if (clean !== src) el.setAttribute('src', clean);
      });
    };
    scrub(document);
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) scrub(n);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------------------------------------------------------------- */
  /* 4. Rifiuto automatico dei banner cookie                           */
  /* ---------------------------------------------------------------- */

  // Selettori dei pulsanti "Rifiuta" dei CMP più diffusi
  const REJECT_SELECTORS = [
    // OneTrust
    '#onetrust-reject-all-handler',
    '.ot-pc-refuse-all-handler',
    'button#onetrust-reject-all-handler',
    // Cookiebot
    '#CybotCookiebotDialogBodyButtonDecline',
    '#CybotCookiebotDialogBodyButtonRefuse',
    // Iubenda
    '.iubenda-cs-reject-btn',
    '.iubenda-cs-close-btn',
    'a.iubenda-cs-reject-btn',
    // Didomi
    '#didomi-notice-disagree-button',
    '.didomi-continue-without-agreeing',
    // Usercentrics
    '[data-testid="uc-deny-all-button"]',
    'button[data-testid="uc-deny-all-button"]',
    // Quantcast / CMP
    '.qc-cmp2-summary-buttons button[mode="secondary"]',
    'button.css-1n9f65y',
    // Complianz (WordPress)
    '.cmplz-deny',
    '#cmplz-deny',
    // CookieYes
    '.cky-btn-reject',
    // Osano
    '.osano-cm-denyAll',
    // Klaro
    '.klaro .cm-btn-decline',
    // Borlabs
    '#CookieBoxSaveButton',
    // Google Funding Choices
    '.fc-cta-do-not-consent',
    // TrustArc
    '.truste-consent-required',
    '#truste-consent-button',
    // Generic testi
    'button[aria-label="Rifiuta tutto"]',
    'button[aria-label="Rifiuta"]',
    'button[aria-label="Reject all"]',
    'button[aria-label="Decline"]',
    'button[aria-label="Deny"]'
  ];

  const REJECT_TEXT = /^(rifiuta(\s+(tutto|tutti))?|rifiuta\s+e\s+chiudi|nega(\s+tutto)?|non\s+accetto|no,?\s+grazie|solo\s+necessari|solo\s+essenziali|accetta\s+solo\s+(i\s+)?necessari|reject(\s+all)?|decline(\s+all)?|deny(\s+all)?|refuse(\s+all)?|disagree|only\s+(necessary|essential)|continue\s+without\s+(accepting|agreeing))$/i;

  let rejected = false;

  function tryReject() {
    if (rejected) return true;

    for (const sel of REJECT_SELECTORS) {
      let el;
      try { el = document.querySelector(sel); } catch { continue; }
      if (el && isVisible(el)) {
        el.click();
        rejected = true;
        ask({ type: 'banner-rejected' });
        return true;
      }
    }

    // Fallback: cerca per testo fra i bottoni
    const buttons = document.querySelectorAll(
      'button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]'
    );
    for (const b of buttons) {
      const label = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
      if (label.length > 0 && label.length < 40 && REJECT_TEXT.test(label) && isVisible(b)) {
        b.click();
        rejected = true;
        ask({ type: 'banner-rejected' });
        return true;
      }
    }
    return false;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  function autoRejectBanners() {
    // tentativi scaglionati: i CMP si caricano in momenti diversi
    const delays = [0, 300, 800, 1500, 2500, 4000, 6000, 9000];
    delays.forEach((d) => setTimeout(tryReject, d));

    const obs = new MutationObserver(() => {
      if (rejected) { obs.disconnect(); return; }
      tryReject();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 15000);
  }

  /* ---------------------------------------------------------------- */
  /* 5. Nasconde i banner rimasti                                      */
  /* ---------------------------------------------------------------- */

  const BANNER_SELECTORS = [
    '#onetrust-consent-sdk',
    '#CybotCookiebotDialog',
    '.iubenda-cs-container',
    '.iubenda-cs-overlay',
    '#didomi-host',
    '.qc-cmp2-container',
    '.cmplz-cookiebanner',
    '.cky-consent-container',
    '.osano-cm-window',
    '.klaro',
    '#usercentrics-root',
    '.truste_box_overlay',
    '.fc-consent-root',
    '#cookie-law-info-bar',
    '.cc-window',
    '#cookie-notice',
    '.cookie-banner',
    '.cookie-consent',
    '.cookie-notice'
  ];

  function hideBannerCss() {
    if (document.getElementById('__acs_hide_banners__')) return;
    const style = document.createElement('style');
    style.id = '__acs_hide_banners__';
    style.textContent = BANNER_SELECTORS.map((s) => `${s}{display:none !important;}`).join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  /* ---------------------------------------------------------------- */
  /* 6. Avvio                                                          */
  /* ---------------------------------------------------------------- */

  init();

  // reagisce ai cambi di impostazioni: aggiorna lo stato senza ricaricare
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'settings-changed') {
      chrome.runtime.sendMessage({ type: 'get-state' }, (state) => {
        EFF = state?.effective || null;
        if (EFF?.enabled) {
          if (EFF.autoRejectBanners && !rejected) autoRejectBanners();
          if (EFF.hideBanners) hideBannerCss();
        }
      });
    }
  });
})();
