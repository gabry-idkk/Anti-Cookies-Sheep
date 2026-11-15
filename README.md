# Anti-Cookies Sheep 🐑

**Blocco totale di cookie, tracker, fingerprinting e telemetria su tutti i siti.**
Estensione Manifest V3 per Chrome, Edge, Brave, Opera, Vivaldi (e qualsiasi browser Chromium ≥ 120).

Nessun server. Nessun account. Nessun dato che esce dal browser. Tutto il codice è qui e puoi leggerlo.

---

## Cosa fa

| Area | Cosa blocca |
|---|---|
| **Cookie** | cookie di terze parti, tutti i cookie (modalità totale), cookie persistenti, rimozione immediata di ogni cookie reimpostato dopo il blocco, pulizia alla chiusura scheda / avvio |
| **Tracker di rete** | 90 domini pubblicitari (DoubleClick, Google Ads, Meta, TikTok, LinkedIn, Criteo, Taboola, Outbrain, reti programmatiche…) + 49 domini di telemetria (Sentry, Datadog, Hotjar, LogRocket, Segment, Amplitude…) via `declarativeNetRequest` |
| **Header** | `X-Client-Data`, client hint ad alta entropia, `Referer` ridotto all'origine, `Set-Cookie` di terze parti rimossi dalla risposta |
| **Link** | rimozione di `fbclid`, `gclid`, `msclkid`, `ttclid`, `utm_*` e altri 30 parametri di tracciamento, anche dall'URL della pagina |
| **Fingerprinting** | rumore su Canvas e `getImageData`, WebGL (`WEBGL_debug_renderer_info` rimosso), AudioContext, font, `screen`, `hardwareConcurrency`, `deviceMemory`, WebRTC forzato su relay (niente IP locale) |
| **Pubblicità comportamentale** | Topics API, FLoC, `interestCohort`, Shared Storage, Protected Audience |
| **Beacon** | `navigator.sendBeacon` e `ping` verso domini terzi |
| **Banner cookie** | click automatico su "Rifiuta tutto" nei CMP più diffusi (OneTrust, Cookiebot, Iubenda, Didomi, Usercentrics, Complianz, CookieYes, Quantcast, Osano, Klaro, TrustArc, Google FC) + CSS che nasconde i banner residui |
| **Segnali privacy** | `Sec-GPC: 1` (Global Privacy Control) e `DNT: 1` |
| **Modalità estrema (opzionale)** | localStorage, IndexedDB, Cache API e service worker disattivati |

## Cosa **non** fa

- Non usa liste remote (niente aggiornamenti da server di terzi, niente telemetria).
- Non fa "spoofing" del browser: preferisce rompere il tracker, non il sito.
- Non sostituisce un DNS filtrante o una VPN: lavora dentro il browser.

---

## Installazione (30 secondi)

1. Scarica o clona questa repository.
2. Apri `chrome://extensions` (su Edge: `edge://extensions`).
3. Attiva **Modalità sviluppatore** in alto a destra.
4. Clicca **Carica estensione non pacchettizzata** e seleziona la cartella `anti-cookies-sheep`.
5. Fissa l'icona 🐑 nella barra e sei protetto.

> Vuoi provarla prima? C'è anche la pagina `docs/index.html`, che spiega l'estensione e fa un test di tracking in tempo reale dal browser.

---

## Uso

- **Popup** (click sull'icona): attiva/disattiva tutto, scegli la modalità per il sito corrente (**Normale / Consenti / Blocca tutto**), vedi i contatori in tempo reale, pulisci i cookie con un click.
- **Impostazioni** (ingranaggio o tasto destro → Opzioni): tutte le 20 protezioni, whitelist e blacklist per dominio, statistiche e domini più attivi.

### Consigli pratici

- Se un sito non ti fa loggare, mettilo in **Consenti** dal popup (o in whitelist nelle opzioni).
- La modalità **Blocca tutto** è per i siti che ti infastidiscono: cookie, storage e fingerprinting giù, login impossibile.
- Con **Blocca tutti i cookie** attivo a livello globale, le sessioni valgono solo finché la pagina è aperta: utile per il browsing "usa e getta".

---

## Struttura del progetto

```
anti-cookies-sheep/
├── manifest.json           Manifest V3
├── src/
│   ├── background.js       service worker: regole DNR, purge cookie, header, statistiche
│   ├── content.js          banner CMP, link tracking, iniezione nel MAIN world
│   ├── inject.js           anti-fingerprinting e anti-storage nel MAIN world
│   └── rules/
│       ├── trackers.json   90 regole DNR (pubblicità e analytics)
│       └── telemetry.json  49 regole DNR (error reporting, session recording)
├── popup/                  interfaccia rapida
├── options/                pagina impostazioni completa
├── icons/                  icone 16/32/48/128
├── tools/make-icons.cjs    genera le icone (PNG senza dipendenze)
└── docs/                   landing page + zip scaricabile
```

## Come funziona (in breve)

1. **`declarativeNetRequest`** blocca le richieste verso i domini noti *prima* che partano: zero JavaScript, zero latenza percepibile.
2. **`webRequest` blocking** toglie header di tracking in andata e `Set-Cookie` di terze parti al ritorno.
3. **`chrome.cookies.onChanged`** è la rete di sicurezza: qualunque cookie bloccato che un sito prova a riscrivere viene rimosso entro pochi millisecondi.
4. **`inject.js`** gira nel *main world* a `document_start`, prima degli script del sito, e applica rumore deterministico per host su canvas/audio/WebGL: il fingerprint diventa stabile nella pagina ma inutile come identificatore tra siti.
5. **`content.js`** clicca "Rifiuta tutto" sui CMP e ripulisce i link dai parametri di tracciamento.

---

## Test

Dopo l'installazione, verifica su:

- `https://coveryourtracks.eff.org/` — fingerprint del tuo browser
- `https://browserleaks.com/canvas` e `/webgl` — deve mostrare valori non univoci
- `https://www.whatismybrowser.com/detect/what-http-headers-is-my-browser-sending` — niente `X-Client-Data`
- `https://globalprivacycontrol.org/` — deve leggere il segnale GPC

## Licenza

MIT — vedi [LICENSE](LICENSE). Fanne quello che vuoi, anche commercialmente.
