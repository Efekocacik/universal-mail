import { inflateRawSync } from "node:zlib";
import { IMPORT_LIMITS, ImportError } from "./types";

/**
 * En küçük zip okuyucu (yalnızca XLSX için; yeni bağımlılık yok). Merkez dizin + yerel başlıklar okunur; yöntem 0
 * (saklı) ve 8 (deflate, `zlib.inflateRawSync`) desteklenir.
 *
 * Güvenlik (zip bombası ve bozuk dosya):
 *  - girdi sayısı, toplam açılmış boyut ve girdi başına sıkıştırma oranı sınırlıdır (bkz. `IMPORT_LIMITS`);
 *  - beyan edilen boyuta güvenilmez: açma `maxOutputLength` ile beyan edilen boyutta kesilir, sonra boyut ve CRC-32
 *    denetlenir;
 *  - şifreli girdi, zip64, çok diskli arşiv, yinelenen ad ve sınır dışı ofsetler reddedilir.
 * Her hata `IMPORT_PARSE`'tır (ayrıntı yalnızca sunucu iletisinde; kullanıcıya genel metin gösterilir).
 */

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

export interface ZipArchive {
  entries: Map<string, ZipEntry>;
  /** Girdiyi açar (CRC ve boyut denetimli). */
  read(name: string): Buffer | null;
}

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxRatio: number;
}

const DEFAULT_LIMITS: ZipLimits = {
  maxEntries: IMPORT_LIMITS.zipMaxEntries,
  maxTotalBytes: IMPORT_LIMITS.zipMaxTotalBytes,
  maxRatio: IMPORT_LIMITS.zipMaxRatio,
};

/** Oran denetimi bu boyutun altındaki girdilere uygulanmaz: küçük girdi bomba olamaz, boş XML'ler yüksek oranlıdır. */
const RATIO_MIN_BYTES = 64 * 1024;

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const fail = (why: string): never => {
  throw new ImportError("IMPORT_PARSE", `Zip okunamadı: ${why}.`);
};

let CRC_TABLE: Uint32Array | null = null;
/** CRC-32 (IEEE). `zlib.crc32` her Electron/Node sürümünde yok; tablo bir kez kurulur. */
export function crc32(buf: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function findEocd(b: Buffer): number {
  const min = Math.max(0, b.length - 22 - 0xffff);
  for (let i = b.length - 22; i >= min; i--) if (b.readUInt32LE(i) === SIG_EOCD) return i;
  return fail("merkez dizin sonu yok");
}

export function readZip(data: Uint8Array, limits: ZipLimits = DEFAULT_LIMITS): ZipArchive {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < 22) fail("çok kısa");
  const eocd = findEocd(b);
  const disk = b.readUInt16LE(eocd + 4);
  const cdDisk = b.readUInt16LE(eocd + 6);
  const countDisk = b.readUInt16LE(eocd + 8);
  const count = b.readUInt16LE(eocd + 10);
  const cdSize = b.readUInt32LE(eocd + 12);
  const cdOffset = b.readUInt32LE(eocd + 16);
  if (
    count === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff ||
    (eocd >= 20 && b.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR)
  )
    fail("zip64 desteklenmiyor");
  if (disk !== 0 || cdDisk !== 0 || countDisk !== count) fail("çok diskli arşiv");
  if (count > limits.maxEntries) fail("çok fazla girdi");
  if (cdOffset + cdSize > eocd) fail("merkez dizin sınır dışı");

  const entries = new Map<string, ZipEntry>();
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || b.readUInt32LE(p) !== SIG_CENTRAL) fail("bozuk merkez dizin");
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const compressedSize = b.readUInt32LE(p + 20);
    const uncompressedSize = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localOffset = b.readUInt32LE(p + 42);
    if (p + 46 + nameLen > eocd) fail("bozuk girdi adı");
    const name = b.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) fail("şifreli dosya");
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    )
      fail("zip64 desteklenmiyor");
    if (method !== 0 && method !== 8) fail("desteklenmeyen sıkıştırma");
    if (entries.has(name)) fail("yinelenen girdi");
    total += uncompressedSize;
    if (total > limits.maxTotalBytes) fail("açılmış boyut sınırı aşıldı");
    if (
      uncompressedSize > RATIO_MIN_BYTES &&
      uncompressedSize > Math.max(compressedSize, 1) * limits.maxRatio
    )
      fail("sıkıştırma oranı sınırı aşıldı");
    entries.set(name, {
      name,
      method,
      flags,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
  }

  const read = (name: string): Buffer | null => {
    const e = entries.get(name);
    if (!e) return null;
    const lo = e.localOffset;
    if (lo + 30 > cdOffset || b.readUInt32LE(lo) !== SIG_LOCAL) fail("bozuk yerel başlık");
    const start = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28);
    const end = start + e.compressedSize;
    if (end > cdOffset) fail("girdi verisi sınır dışı");
    const raw = b.subarray(start, end);
    let out: Buffer;
    if (e.method === 0) out = Buffer.from(raw);
    else if (e.uncompressedSize === 0) out = Buffer.alloc(0);
    else {
      try {
        // Beyan edilenden uzun çıktı üretilmez (yalan söyleyen başlıkla bomba).
        out = inflateRawSync(raw, { maxOutputLength: e.uncompressedSize });
      } catch {
        return fail("açılamadı");
      }
    }
    if (out.length !== e.uncompressedSize) fail("boyut uyuşmuyor");
    if (crc32(out) !== e.crc32) fail("CRC uyuşmuyor");
    return out;
  };
  return { entries, read };
}
