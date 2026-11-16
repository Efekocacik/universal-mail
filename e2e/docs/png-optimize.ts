import zlib from "node:zlib";

/**
 * Kayıpsız PNG küçültücü (ek bağımlılık yok; yalnızca node:zlib). Kullanım kılavuzu ekran görüntüleri için:
 * Chrome'un hızlı sıkıştırdığı PNG'yi çözer, tamamen opak RGBA'yı RGB'ye indirir, her satır için en iyi süzgeci
 * (0–4; "en küçük mutlak toplam" sezgisi) seçer ve en yüksek deflate düzeyiyle yeniden yazar. Piksel değişmez; yalnızca
 * 8 bit, taramasız (non-interlaced) RGB/RGBA desteklenir, diğer her biçim olduğu gibi döner. Sonuç daha büyükse özgün
 * dosya döner. Doğruluk, docs-screenshots çalıştırmasında her görüntü için tarayıcının kendi çözücüsüyle karşılaştırılır.
 */

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Görüntüyü etkilemeyen, yeniden yazımda atılan yardımcı parçalar (metin, zaman, fiziksel boyut). */
const DROP = new Set(["tEXt", "zTXt", "iTXt", "tIME", "pHYs"]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Süzgeçli satırları ham piksellere çevirir (PNG spesifikasyonu, bölüm 9). */
function unfilter(raw: Buffer, height: number, stride: number, bpp: number): Buffer {
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[dst - stride + x - bpp] : 0;
      let r: number;
      switch (type) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + b;
          break;
        case 3:
          r = v + ((a + b) >> 1);
          break;
        case 4:
          r = v + paeth(a, b, c);
          break;
        default:
          throw new Error(`Bilinmeyen PNG süzgeci: ${type}`);
      }
      out[dst + x] = r & 0xff;
    }
  }
  return out;
}

/** Her satır için 5 süzgeci dener, işaretli bayt toplamı en küçük olanı seçer. */
function filter(px: Buffer, height: number, stride: number, bpp: number): Buffer {
  const out = Buffer.alloc(height * (stride + 1));
  const cand = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const sums = [0, 0, 0, 0, 0];
    for (let x = 0; x < stride; x++) {
      const v = px[row + x];
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const b = y > 0 ? px[row - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[row - stride + x - bpp] : 0;
      const f = [v, v - a, v - b, v - ((a + b) >> 1), v - paeth(a, b, c)];
      for (let t = 0; t < 5; t++) {
        const byte = f[t] & 0xff;
        cand[t][x] = byte;
        sums[t] += byte < 128 ? byte : 256 - byte;
      }
    }
    let best = 0;
    for (let t = 1; t < 5; t++) if (sums[t] < sums[best]) best = t;
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
  }
  return out;
}

/** PNG'yi 8 bit RGB piksellere çözer; desteklenmeyen biçimde `null`. Yardımcı parçalar (ör. sRGB) korunur. */
function decode(input: Buffer): { width: number; height: number; rgb: Buffer; extra: Buffer[] } | null {
  if (input.length < 8 || !input.subarray(0, 8).equals(SIGNATURE)) return null;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  const extra: Buffer[] = [];
  for (let o = 8; o + 12 <= input.length; ) {
    const len = input.readUInt32BE(o);
    const type = input.toString("ascii", o + 4, o + 8);
    const data = input.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    else if (!DROP.has(type)) extra.push(chunk(type, Buffer.from(data)));
    o += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) return null;
  const bpp = colorType === 6 ? 4 : 3;
  const px = unfilter(zlib.inflateSync(Buffer.concat(idat)), height, width * bpp, bpp);
  if (bpp === 3) return { width, height, rgb: px, extra };
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
    if (px[i + 3] !== 255) return null; // saydamlık varsa dokunulmaz
    rgb[j] = px[i];
    rgb[j + 1] = px[i + 1];
    rgb[j + 2] = px[i + 2];
  }
  return { width, height, rgb, extra };
}

type Box = { colors: number[]; weight: number; range: number; channel: number };

function makeBox(colors: number[], hist: Map<number, number>): Box {
  let weight = 0;
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (const c of colors) {
    weight += hist.get(c)!;
    for (let ch = 0; ch < 3; ch++) {
      const v = (c >> (16 - 8 * ch)) & 0xff;
      if (v < min[ch]) min[ch] = v;
      if (v > max[ch]) max[ch] = v;
    }
  }
  let channel = 0;
  for (let ch = 1; ch < 3; ch++)
    if (max[ch] - min[ch] > max[channel] - min[channel]) channel = ch;
  return { colors, weight, range: max[channel] - min[channel], channel };
}

/**
 * En çok `maxColors` renklik palet: en sık görülen renkler (düz arka planlar, düğmeler) palete AYNEN girer; kalan yer
 * ağırlıklı medyan kesimle doldurulur ve birkaç k-ortalama turuyla iyileştirilir. Titreşim (dithering) yoktur: arayüz
 * görüntülerinde gürültü üretir ve sıkıştırmayı bozar.
 */
function buildPalette(hist: Map<number, number>, maxColors: number): number[] {
  const all = [...hist.keys()];
  if (all.length <= maxColors) return all;
  const byFreq = all.sort((a, b) => hist.get(b)! - hist.get(a)!);
  const fixedCount = Math.min(64, maxColors >> 2);
  const fixed = byFreq.slice(0, fixedCount);
  const rest = byFreq.slice(fixedCount);
  const boxes: Box[] = [makeBox(rest, hist)];
  while (boxes.length < maxColors - fixedCount) {
    let pick = -1;
    let score = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const s = b.colors.length > 1 ? b.range * Math.sqrt(b.weight) : 0;
      if (s > score) {
        score = s;
        pick = i;
      }
    }
    if (pick < 0) break;
    const box = boxes[pick];
    const shift = 16 - 8 * box.channel;
    const sorted = box.colors.sort((a, b) => ((a >> shift) & 0xff) - ((b >> shift) & 0xff));
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += hist.get(sorted[i])!;
      if (acc >= box.weight / 2) {
        cut = i + 1;
        break;
      }
    }
    boxes.splice(pick, 1, makeBox(sorted.slice(0, cut), hist), makeBox(sorted.slice(cut), hist));
  }
  const mean = (colors: number[]) => {
    let w = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const c of colors) {
      const n = hist.get(c)!;
      w += n;
      r += ((c >> 16) & 0xff) * n;
      g += ((c >> 8) & 0xff) * n;
      b += (c & 0xff) * n;
    }
    return (Math.round(r / w) << 16) | (Math.round(g / w) << 8) | Math.round(b / w);
  };
  let free = boxes.map((b) => mean(b.colors));
  // k-ortalama: yalnızca sabit olmayan girdiler hareket eder.
  for (let iter = 0; iter < 3; iter++) {
    const palette = [...fixed, ...free];
    const groups: number[][] = free.map(() => []);
    for (const c of rest) {
      const i = nearest(palette, c);
      if (i >= fixed.length) groups[i - fixed.length].push(c);
    }
    free = free.map((p, i) => (groups[i].length ? mean(groups[i]) : p));
  }
  return [...fixed, ...free];
}

function nearest(palette: number[], c: number): number {
  const r = (c >> 16) & 0xff;
  const g = (c >> 8) & 0xff;
  const b = c & 0xff;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = ((p >> 16) & 0xff) - r;
    const dg = ((p >> 8) & 0xff) - g;
    const db = (p & 0xff) - b;
    // Algısal ağırlık (yaklaşık): yeşil en, mavi en az duyarlı.
    const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
      if (d === 0) break;
    }
  }
  return best;
}

export type OptimizeResult = { png: Buffer; lossless: boolean };

/**
 * Ekran görüntüsünü küçültür. Önce kayıpsız yeniden sıkıştırma denenir (yeniden süzme + deflate 9); görüntü
 * `maxColors`'tan fazla renk içeriyorsa ve paletli sürüm daha küçükse, en çok `maxColors` renkli paletli PNG
 * döner (arayüz görüntülerinde gözle fark edilmez). Hiçbiri küçültmezse özgün dosya döner.
 */
export function optimizePng(input: Buffer, maxColors = 256): OptimizeResult {
  const img = decode(input);
  if (!img) return { png: input, lossless: true };
  const { width, height, rgb, extra } = img;
  const ihdr = (colorType: number) => {
    const h = Buffer.alloc(13);
    h.writeUInt32BE(width, 0);
    h.writeUInt32BE(height, 4);
    h[8] = 8;
    h[9] = colorType;
    return chunk("IHDR", h);
  };
  const deflate = (data: Buffer) => zlib.deflateSync(data, { level: 9, memLevel: 9 });

  let best: OptimizeResult = { png: input, lossless: true };
  const truecolor = Buffer.concat([
    SIGNATURE,
    ihdr(2),
    ...extra,
    chunk("IDAT", deflate(filter(rgb, height, width * 3, 3))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  if (truecolor.length < best.png.length) best = { png: truecolor, lossless: true };

  const hist = new Map<number, number>();
  for (let i = 0; i < rgb.length; i += 3) {
    const c = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
    hist.set(c, (hist.get(c) ?? 0) + 1);
  }
  const palette = buildPalette(hist, maxColors);
  const index = new Map<number, number>();
  for (const c of hist.keys()) index.set(c, nearest(palette, c));
  const indexed = Buffer.alloc(width * height);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j++)
    indexed[j] = index.get((rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2])!;
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach((p, i) => {
    plte[i * 3] = (p >> 16) & 0xff;
    plte[i * 3 + 1] = (p >> 8) & 0xff;
    plte[i * 3 + 2] = p & 0xff;
  });
  // Paletli görüntüde süzgeç çoğu zaman zarar verir: süzgeçsiz ve uyarlamalı sürümden küçük olanı alınır.
  const none = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) indexed.copy(none, y * (width + 1) + 1, y * width, (y + 1) * width);
  const idat = [deflate(none), deflate(filter(indexed, height, width, 1))].sort(
    (a, b) => a.length - b.length,
  )[0];
  const paletted = Buffer.concat([
    SIGNATURE,
    ihdr(3),
    ...extra,
    chunk("PLTE", plte),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  if (paletted.length < best.png.length)
    best = { png: paletted, lossless: hist.size <= maxColors };
  return best;
}
