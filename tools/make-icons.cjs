const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- PNG encoder minimale (RGBA, nessuna dipendenza) ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filtro none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- disegno: pecora su scudo verde ---------- */

function drawIcon(size) {
  const S = size;
  const buf = Buffer.alloc(S * S * 4);

  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    // alpha blending su quello che c'è
    const sa = a / 255;
    buf[i] = Math.round(buf[i] * (1 - sa) + r * sa);
    buf[i + 1] = Math.round(buf[i + 1] * (1 - sa) + g * sa);
    buf[i + 2] = Math.round(buf[i + 2] * (1 - sa) + b * sa);
    buf[i + 3] = Math.max(buf[i + 3], a);
  };

  const scale = S / 128;
  const cx = S / 2, cy = S / 2;
  const R = S * 0.47;

  // scudo / cerchio di sfondo verde
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x - cx) / R, dy = (y - cy) / R;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= 1) {
        // gradiente verticale
        const t = y / S;
        const r = Math.round(16 + (30 - 16) * t);
        const g = Math.round(120 + (180 - 120) * t);
        const b = Math.round(90 + (120 - 90) * t);
        set(x, y, r, g, b, d > 0.96 ? 120 : 255);
      }
    }
  }

  // corpo della pecora: nuvola di cerchi bianchi
  const wool = [
    [0.50, 0.46, 0.19], [0.38, 0.50, 0.15], [0.62, 0.50, 0.15],
    [0.44, 0.38, 0.14], [0.57, 0.38, 0.14], [0.50, 0.58, 0.15],
    [0.35, 0.42, 0.11], [0.65, 0.42, 0.11]
  ];
  wool.forEach(([wx, wy, wr]) => {
    const r = wr * S;
    for (let y = Math.floor(wy * S - r); y <= wy * S + r; y++) {
      for (let x = Math.floor(wx * S - r); x <= wx * S + r; x++) {
        const dx = x - wx * S, dy = y - wy * S;
        if (dx * dx + dy * dy <= r * r) {
          // ombra leggera in basso a destra
          const shade = (dx > 0 && dy > 0) ? 225 : 255;
          set(x, y, shade, shade, shade, 255);
        }
      }
    }
  });

  // testa (ellisse scura) a destra
  const hx = 0.70 * S, hy = 0.44 * S, hrx = 0.13 * S, hry = 0.15 * S;
  for (let y = Math.floor(hy - hry); y <= hy + hry; y++) {
    for (let x = Math.floor(hx - hrx); x <= hx + hrx; x++) {
      const dx = (x - hx) / hrx, dy = (y - hy) / hry;
      if (dx * dx + dy * dy <= 1) set(x, y, 38, 44, 52, 255);
    }
  }
  // occhio
  const ex = 0.74 * S, ey = 0.41 * S, er = Math.max(1, 0.022 * S);
  for (let y = Math.floor(ey - er); y <= ey + er; y++) {
    for (let x = Math.floor(ex - er); x <= ex + er; x++) {
      const dx = x - ex, dy = y - ey;
      if (dx * dx + dy * dy <= er * er) set(x, y, 240, 245, 250, 255);
    }
  }
  // orecchie
  const ears = [[0.60, 0.31, 0.055], [0.68, 0.29, 0.05]];
  ears.forEach(([ex2, ey2, rr]) => {
    const r = rr * S;
    for (let y = Math.floor(ey2 * S - r); y <= ey2 * S + r; y++) {
      for (let x = Math.floor(ex2 * S - r); x <= ex2 * S + r; x++) {
        const dx = x - ex2 * S, dy = y - ey2 * S;
        if (dx * dx + dy * dy <= r * r) set(x, y, 38, 44, 52, 255);
      }
    }
  });

  // zampa/divieto: barra diagonale rossa (blocco)
  if (S >= 32) {
    const w = Math.max(2, 0.045 * S);
    for (let t = 0; t < 1; t += 0.002) {
      const px = 0.26 * S + t * 0.48 * S;
      const py = 0.76 * S - t * 0.48 * S;
      for (let o = -w; o <= w; o++) {
        set(Math.round(px + o * 0.7071), Math.round(py + o * 0.7071), 226, 62, 62, 230);
      }
    }
  }

  void scale;
  return encodePNG(S, S, buf);
}

/* ---------- scrittura file ---------- */

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

[16, 32, 48, 128].forEach((size) => {
  const png = drawIcon(size);
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`icons/icon${size}.png  ${png.length} byte`);
});

// favicon per la landing page
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'favicon.png'), drawIcon(64));
console.log('docs/favicon.png');
