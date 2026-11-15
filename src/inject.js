/**
 * Anti-Cookies Sheep — inject.js
 * Girato nel MAIN world della pagina, PRIMA degli script del sito
 * (document_start + async=false). Neutralizza le API di fingerprinting,
 * di tracking e, se richiesto, lo storage.
 *
 * Regola d'oro: non rompere il sito più del necessario.
 * Ogni patch è difensiva e silenziosa.
 */
(() => {
  'use strict';

  /* ---- flags passati dal content script ---- */
  let flags = {};
  try {
    const meta = document.getElementById('__acs_flags__');
    flags = meta ? JSON.parse(meta.getAttribute('data-acs') || '{}') : {};
  } catch { flags = {}; }

  if (window.__acs_installed__) return;
  Object.defineProperty(window, '__acs_installed__', { value: true, enumerable: false });

  const report = (what) => {
    try {
      if (window.__acs_report__) window.__acs_report__(what);
    } catch { /* noop */ }
  };

  // segnala al content script (in modo discreto) i blocchi di fingerprinting
  window.__acs_report__ = (what) => {
    try {
      window.dispatchEvent(new CustomEvent('acs:blocked', { detail: what }));
    } catch { /* noop */ }
  };

  const define = (obj, prop, value) => {
    try {
      Object.defineProperty(obj, prop, { value, writable: false, configurable: true, enumerable: false });
    } catch { /* proprietà non configurabile */ }
  };

  /* ================================================================ */
  /* 1. CANVAS — rumore deterministico per sessione                    */
  /* ================================================================ */

  if (flags.blockFingerprinting) {
    // Rumore basato sull'host: stabile nella pagina, diverso fra siti
    const seed = [...(flags.host || 'x')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);
    const noise = (i) => ((seed * (i + 1)) % 7) / 100; // ±0.07 sul canale

    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      const data = origGetImageData.apply(this, args);
      try {
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          const n = noise(i);
          d[i] = Math.min(255, Math.max(0, d[i] + (n < 0.5 ? -1 : 1)));
          d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + (n < 0.25 ? -1 : 1)));
        }
      } catch { /* noop */ }
      report('canvas');
      return data;
    };

    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      report('canvas');
      return origToDataURL.apply(this, args);
    };

    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      report('canvas');
      return origToBlob.apply(this, args);
    };

    /* ---- WEBGL ---- */
    const patchGL = (proto) => {
      if (!proto) return;
      const origGetParameter = proto.getParameter;
      proto.getParameter = function (p) {
        // UNMASKED_RENDERER_WEBGL / UNMASKED_VENDOR_WEBGL
        if (p === 0x9246) return 'Google Inc.';
        if (p === 0x9245) return 'WebKit';
        return origGetParameter.call(this, p);
      };
      const origGetExtension = proto.getExtension;
      proto.getExtension = function (name) {
        if (name === 'WEBGL_debug_renderer_info') {
          report('webgl');
          return null; // niente info dettagliate sulla GPU
        }
        return origGetExtension.apply(this, [name]);
      };
      const origReadPixels = proto.readPixels;
      proto.readPixels = function (...a) {
        report('webgl');
        return origReadPixels.apply(this, a);
      };
    };
    if (window.WebGLRenderingContext) patchGL(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patchGL(WebGL2RenderingContext.prototype);

    /* ---- AUDIO CONTEXT (fingerprint audio) ---- */
    const patchAudio = (Ctx) => {
      if (!Ctx) return;
      const origCreateOscillator = Ctx.prototype.createOscillator;
      const origCreateAnalyser = Ctx.prototype.createAnalyser;
      const origCreateDynamicsCompressor = Ctx.prototype.createDynamicsCompressor;
      const mark = function () { report('audio'); };
      Ctx.prototype.createOscillator = function (...a) { mark(); return origCreateOscillator.apply(this, a); };
      Ctx.prototype.createAnalyser = function (...a) { mark(); return origCreateAnalyser.apply(this, a); };
      Ctx.prototype.createDynamicsCompressor = function (...a) { mark(); return origCreateDynamicsCompressor.apply(this, a); };

      const origGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function (arr) {
        origGetFloatFrequencyData.apply(this, [arr]);
        try { for (let i = 0; i < arr.length; i += 50) arr[i] += (Math.random() - 0.5) * 0.001; } catch { /* noop */ }
        return undefined;
      };
    };
    patchAudio(window.AudioContext || window.webkitAudioContext);
    patchAudio(window.OfflineAudioContext);

    /* ---- FONTS — lista limitata a quelle generiche ---- */
    try {
      if (document.fonts) {
        const origCheck = document.fonts.check.bind(document.fonts);
        document.fonts.check = function (font) {
          // se il font non è tra i generici, dichiariamo che non è disponibile
          if (!/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|math)$/i.test(String(font).replace(/^.*?(\d|px)/g, '').trim())) {
            report('fonts');
            return false;
          }
          return origCheck(font);
        };
      }
    } catch { /* noop */ }

    /* ---- screen / hardware fingerprinting ---- */
    try {
      define(screen, 'colorDepth', 24);
      define(screen, 'pixelDepth', 24);
      define(navigator, 'hardwareConcurrency', 4);
      define(navigator, 'deviceMemory', 4);
      define(navigator, 'maxTouchPoints', 0);
      // plugin e mimeType sempre uguali per tutti
      define(navigator, 'plugins', Object.freeze([]));
      define(navigator, 'mimeTypes', Object.freeze([]));
    } catch { /* noop */ }

    /* ---- WebRTC: niente IP locale (leak) ---- */
    try {
      const origRTC = window.RTCPeerConnection;
      if (origRTC) {
        const Patched = function (cfg, ...rest) {
          const safe = { ...(cfg || {}), iceCandidatePoolSize: 0 };
          // obbliga il relay: niente candidati host/srflx con IP locale
          safe.iceTransportPolicy = 'relay';
          return new origRTC(safe, ...rest);
        };
        Patched.prototype = origRTC.prototype;
        Object.setPrototypeOf(Patched, origRTC);
        define(window, 'RTCPeerConnection', Patched);
        define(window, 'webkitRTCPeerConnection', Patched);
      }
    } catch { /* noop */ }

    /* ---- Battery / Connection / DeviceMemory ---- */
    try {
      if (navigator.getBattery) define(navigator, 'getBattery', undefined);
      if (navigator.connection) {
        define(navigator.connection, 'rtt', 100);
        define(navigator.connection, 'downlink', 10);
        define(navigator.connection, 'effectiveType', '4g');
      }
    } catch { /* noop */ }
  }

  /* ================================================================ */
  /* 2. TOPICS API / FLoC / Attribution Reporting                      */
  /* ================================================================ */

  if (flags.blockFloc) {
    try {
      if (document.browsingTopics) {
        define(document, 'browsingTopics', () => Promise.resolve([]));
        report('topics');
      }
      if (window.browsingTopics) define(window, 'browsingTopics', () => Promise.resolve([]));
      if (navigator.interestCohort) define(navigator, 'interestCohort', () => Promise.resolve({}));
      if (window.sharedStorage) {
        define(window, 'sharedStorage', {
          set: () => Promise.resolve(),
          append: () => Promise.resolve(),
          delete: () => Promise.resolve(),
          clear: () => Promise.resolve(),
          worklet: () => Promise.resolve(null)
        });
        report('sharedStorage');
      }
      if (window.ProtectedAudience) define(window, 'ProtectedAudience', undefined);
    } catch { /* noop */ }
  }

  /* ================================================================ */
  /* 3. Client Hints (userAgentData ad alta entropia)                  */
  /* ================================================================ */

  if (flags.blockClientHints) {
    try {
      if (navigator.userAgentData) {
        define(navigator.userAgentData, 'getHighEntropyValues', () => Promise.resolve({
          architecture: '',
          bitness: '',
          brands: navigator.userAgentData.brands || [],
          mobile: false,
          model: '',
          platform: 'Windows',
          platformVersion: '',
          uaFullVersion: '',
          fullVersionList: [],
          wow64: false
        }));
        report('clientHints');
      }
      // riduce anche il client hint via HTTP? gestito in background (header)
    } catch { /* noop */ }
  }

  /* ================================================================ */
  /* 4. Beacon / ping di tracking                                      */
  /* ================================================================ */

  if (flags.blockBeacons) {
    try {
      const origBeacon = navigator.sendBeacon?.bind(navigator);
      if (origBeacon) {
        define(navigator, 'sendBeacon', function (url, data) {
          // lascia passare solo i beacon verso il sito stesso
          try {
            const u = new URL(url, location.href);
            if (u.hostname !== location.hostname) { report('beacon'); return true; }
          } catch { /* url relativa */ }
          return origBeacon(url, data);
        });
      }
    } catch { /* noop */ }
  }

  /* ================================================================ */
  /* 5. STORAGE (opzionale, può rompere i siti)                        */
  /* ================================================================ */

  if (flags.blockStorage) {
    // Memoria volatile per la pagina: il sito funziona ma non lascia traccia
    const mem = new Map();
    const fakeStorage = {
      getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
      setItem: (k, v) => { mem.set(String(k), String(v)); },
      removeItem: (k) => { mem.delete(String(k)); },
      clear: () => mem.clear(),
      key: (i) => [...mem.keys()][i] ?? null,
      get length() { return mem.size; }
    };
    try {
      define(window, 'localStorage', fakeStorage);
      define(window, 'sessionStorage', fakeStorage);
      report('storage');
    } catch { /* noop */ }

    try {
      // indexedDB disattivato: i DB restano su disco solo se il sito insiste
      define(window, 'indexedDB', undefined);
      report('indexedDB');
    } catch { /* noop */ }

    try {
      if (window.caches) define(window, 'caches', undefined);
      if (navigator.storage) {
        define(navigator.storage, 'estimate', () => Promise.resolve({ usage: 0, quota: 0 }));
      }
    } catch { /* noop */ }
  }

  /* ================================================================ */
  /* 6. SERVICE WORKER (opzionale)                                     */
  /* ================================================================ */

  if (flags.blockServiceWorkers) {
    try {
      if (navigator.serviceWorker) {
        define(navigator, 'serviceWorker', undefined);
        report('serviceWorker');
      }
    } catch { /* noop */ }
  }

  /* ================================================================ */
  /* 7. Blocca i CMP che ri-scrivono i cookie dopo il rifiuto          */
  /* ================================================================ */

})();
