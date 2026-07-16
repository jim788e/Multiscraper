// Generates the extension's PNG icons (16/32/48/128) with no external deps —
// a purple rounded tile with a white 3x3 "post grid" motif. Re-run after tweaking
// COLORS below:  node tools/generate-icons.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "extension", "icons");
const BG = [122, 90, 248]; // #7A5AF8 purple (matches popup accent)
const FG = [255, 255, 255]; // white grid dots

// --- tiny PNG encoder (RGBA, 8-bit) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
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
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- drawing ---
function inRoundedRect(x, y, w, h, rad) {
  let cx, cy;
  if (x < rad && y < rad) [cx, cy] = [rad, rad];
  else if (x > w - 1 - rad && y < rad) [cx, cy] = [w - 1 - rad, rad];
  else if (x < rad && y > h - 1 - rad) [cx, cy] = [rad, h - 1 - rad];
  else if (x > w - 1 - rad && y > h - 1 - rad) [cx, cy] = [w - 1 - rad, h - 1 - rad];
  else return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
}

function render(S) {
  const buf = Buffer.alloc(S * S * 4); // transparent
  const set = (x, y, [r, g, b]) => {
    const i = (y * S + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  };

  const rad = Math.round(S * 0.22);
  const pad = Math.round(S * 0.24);
  const gap = Math.max(1, Math.round(S * 0.09));
  const cell = (S - 2 * pad - 2 * gap) / 3;
  const dot = Math.round(cell * 0.16); // corner radius of each grid square

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!inRoundedRect(x, y, S, S, rad)) continue;
      set(x, y, BG);
      // grid dots
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const x0 = pad + c * (cell + gap);
          const y0 = pad + r * (cell + gap);
          if (x >= x0 && x < x0 + cell && y >= y0 && y < y0 + cell) {
            if (inRoundedRect(x - x0, y - y0, cell, cell, dot)) set(x, y, FG);
          }
        }
      }
    }
  }
  return buf;
}

fs.mkdirSync(OUT, { recursive: true });
for (const S of [16, 32, 48, 128]) {
  const png = encodePNG(S, S, render(S));
  fs.writeFileSync(path.join(OUT, `icon${S}.png`), png);
  console.log(`wrote icons/icon${S}.png (${png.length} bytes)`);
}
