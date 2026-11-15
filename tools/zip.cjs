/* Crea docs/anti-cookies-sheep.zip con il pacchetto dell'estensione
   (solo i file necessari, senza tools/, docs/ e repo files). */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const outFile = path.join(root, 'docs', 'anti-cookies-sheep.zip');

const INCLUDE = [
  'manifest.json',
  '_locales/it/messages.json',
  '_locales/en/messages.json',
  'src/background.js',
  'src/content.js',
  'src/inject.js',
  'src/rules/trackers.json',
  'src/rules/telemetry.json',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  'options/options.html',
  'options/options.css',
  'options/options.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'README.md',
  'LICENSE'
];

/* ---------- zip minimale (deflate) ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const entries = [];
let offset = 0;
const locals = [];

for (const rel of INCLUDE) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) { console.warn('manca', rel); continue; }
  const data = fs.readFileSync(abs);
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(rel.replace(/\\/g, '/'), 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);        // version needed
  local.writeUInt16LE(0x0800, 6);    // utf8 flag
  local.writeUInt16LE(8, 8);         // deflate
  local.writeUInt16LE(0, 10);        // time
  local.writeUInt16LE(0x21, 12);     // date (1980-01-01)
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  locals.push(Buffer.concat([local, nameBuf, comp]));

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(offset, 42);

  entries.push(Buffer.concat([central, nameBuf]));
  offset += local.length + nameBuf.length + comp.length;
}

const centralDir = Buffer.concat(entries);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralDir.length, 12);
eocd.writeUInt32LE(offset, 16);

fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(outFile, Buffer.concat([...locals, centralDir, eocd]));
console.log(`docs/anti-cookies-sheep.zip — ${entries.length} file, ${(fs.statSync(outFile).size / 1024).toFixed(1)} KB`);
