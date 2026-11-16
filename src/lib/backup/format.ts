import crypto from "node:crypto";
import fs from "node:fs";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { z } from "zod";
import { BACKUP_KINDS } from "@/lib/db/schema";
import { LifecycleError } from "./errors";
import { lifecycleError, normalizePassphrase } from "./passphrase";

/**
 * Faz 6 (paket Y.1): şifreli yedek dosyası biçimi `.umbk`, sürüm 1. Tüm tamsayılar büyük-endian; başlık doğrulanır.
 *
 * ```
 * 0   8  "UMBACKUP"                9  1 kdf = 1 (scrypt)     10 1 log2N (14..18)   11 1 r (=8)   12 1 p (=1)
 * 8   1  biçim sürümü = 1          13 16 tuz
 * 29  12 doğrulayıcı nonce         41 32 doğrulayıcı = AES-256-GCM(anahtar, 16 sıfır bayt, AAD = bayt[0..29)) (16+16)
 * 73  12 yük nonce                 85 4  metaLen (≤ 4096)      89 …  meta JSON (kişisel veri yok)
 * …   …  yük = AES-256-GCM(gzip(u32 manifestLen | manifest JSON | veritabanı baytları)), AAD = bayt[0..89+metaLen)
 * son 16 yük etiketi
 * ```
 * Hatalar: doğrulayıcı tutmazsa `BACKUP_WRONG_PASSPHRASE`; doğrulayıcı tutar ama yük etiketi/özeti tutmazsa
 * `BACKUP_CORRUPT`; sihirli sözcük, sürüm, parametre veya meta bozuksa `BACKUP_BAD_FORMAT`.
 *
 * Şifre çözme geçici dosyaya akar; çağıran sonucu YALNIZCA bu modül başarıyla döndükten sonra (etiket doğrulandı,
 * boyut ve SHA-256 tuttu) kullanır. Başarısızlıkta geçici dosya silinir.
 */

export const MAGIC = Buffer.from("UMBACKUP", "ascii");
export const FORMAT_VERSION = 1;
export const KDF_SCRYPT = 1;
export const LOG2N_MIN = 14;
export const DEFAULT_LOG2N = 17;
/** Okumada kabul edilen en yüksek scrypt maliyeti: başlık doğrulanmadan önce çalıştığı için DEFAULT+1 ile sınırlı
 * (2^18 → ~256 MiB). Daha yükseğini bildiren dosya `BACKUP_BAD_FORMAT` (bellek/işlemci tüketme koruması). */
export const LOG2N_MAX = DEFAULT_LOG2N + 1;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const FIXED_LEN = 89;
const VERIFIER_AAD_END = 29;
const TAG_LEN = 16;
export const META_MAX = 4096;
/** Manifest (gizli bilgiler dahil) üst sınırı; aşan dosya bozuk sayılır (bellek koruması). */
const MANIFEST_MAX = 1024 * 1024;
/** Veritabanı boyutu üst sınırı (16 GiB): bunun üstünü bildiren manifest bozuk sayılır. */
const DB_MAX = 16 * 1024 * 1024 * 1024;

export const backupMetaSchema = z
  .object({
    app: z.literal("universal-mail"),
    appVersion: z.string().min(1).max(40),
    createdAt: z.number().int().nonnegative(),
    kind: z.enum(BACKUP_KINDS),
    schemaMigrations: z.number().int().min(0).max(10_000),
    includesSecrets: z.boolean(),
    compression: z.literal("gzip"),
  })
  .strict();
export type BackupMeta = z.infer<typeof backupMetaSchema>;

const manifestSchema = z
  .object({
    dbBytes: z.number().int().min(1).max(DB_MAX),
    dbSha256: z.string().regex(/^[0-9a-f]{64}$/),
    secrets: z.record(z.string().min(1).max(120), z.string().max(64 * 1024)).optional(),
  })
  .strict();
export type BackupManifest = z.infer<typeof manifestSchema>;

export interface KdfParams {
  log2N: number;
  r: number;
  p: number;
  salt: Buffer;
}

/** scrypt(NFC+kırpılmış parola) → 32 bayt anahtar. */
export function deriveKey(passphrase: string, k: KdfParams): Promise<Buffer> {
  const N = 2 ** k.log2N;
  return new Promise((resolve, reject) =>
    crypto.scrypt(
      normalizePassphrase(passphrase),
      k.salt,
      32,
      { N, r: k.r, p: k.p, maxmem: 2 * 128 * N * k.r + 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

function gcmEncrypt(key: Buffer, nonce: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad);
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

/** Başlık (meta dahil) baytları; yük AAD'si budur. */
function buildHeader(key: Buffer, k: KdfParams, payloadNonce: Buffer, meta: BackupMeta): Buffer {
  const metaBuf = Buffer.from(JSON.stringify(meta), "utf8");
  if (metaBuf.length > META_MAX) throw new Error("Yedek meta bilgisi çok uzun.");
  const head = Buffer.alloc(FIXED_LEN + metaBuf.length);
  MAGIC.copy(head, 0);
  head[8] = FORMAT_VERSION;
  head[9] = KDF_SCRYPT;
  head[10] = k.log2N;
  head[11] = k.r;
  head[12] = k.p;
  k.salt.copy(head, 13);
  const vNonce = crypto.randomBytes(12);
  vNonce.copy(head, 29);
  gcmEncrypt(key, vNonce, Buffer.alloc(16), head.subarray(0, VERIFIER_AAD_END)).copy(head, 41);
  payloadNonce.copy(head, 73);
  head.writeUInt32BE(metaBuf.length, 85);
  metaBuf.copy(head, FIXED_LEN);
  return head;
}

async function* payloadSource(manifest: BackupManifest, dbFile: string): AsyncGenerator<Buffer> {
  const m = Buffer.from(JSON.stringify(manifest), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(m.length, 0);
  yield Buffer.concat([len, m]);
  for await (const chunk of fs.createReadStream(dbFile)) yield chunk as Buffer;
}

export interface EncryptOptions {
  passphrase: string;
  meta: BackupMeta;
  manifest: BackupManifest;
  /** Düz veritabanı anlık görüntüsü (yük olarak akar). */
  dbFile: string;
  out: Writable;
  log2N?: number;
}

/**
 * Yedeği `out` akışına yazar (başlık → gzip → AES-GCM → etiket). Dosyanın baytı ve SHA-256 özeti döner. `out`
 * kapatılır (çağıran fsync için kendi tanıtıcısını tutabilir).
 */
export async function writeEncryptedBackup(
  o: EncryptOptions,
): Promise<{ bytes: number; sha256: string }> {
  const kdf: KdfParams = {
    log2N: o.log2N ?? DEFAULT_LOG2N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: crypto.randomBytes(16),
  };
  if (kdf.log2N < LOG2N_MIN || kdf.log2N > LOG2N_MAX) throw new Error("Geçersiz KDF parametresi.");
  const key = await deriveKey(o.passphrase, kdf);
  const payloadNonce = crypto.randomBytes(12);
  const header = buildHeader(key, kdf, payloadNonce, o.meta);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, payloadNonce);
  cipher.setAAD(header);
  const hash = crypto.createHash("sha256").update(header);
  let bytes = header.length;
  let headerSent = false;
  const tail = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const out = headerSent ? chunk : Buffer.concat([header, chunk]);
      headerSent = true;
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, out);
    },
    flush(cb) {
      const tag = cipher.getAuthTag();
      hash.update(tag);
      bytes += tag.length;
      cb(null, headerSent ? tag : Buffer.concat([header, tag]));
    },
  });
  await pipeline(
    Readable.from(payloadSource(o.manifest, o.dbFile)),
    zlib.createGzip({ level: 6 }),
    cipher,
    tail,
    o.out,
  );
  return { bytes, sha256: hash.digest("hex") };
}

export interface ParsedHeader {
  header: Buffer;
  meta: BackupMeta;
  kdf: KdfParams;
  verifierNonce: Buffer;
  verifier: Buffer;
  payloadNonce: Buffer;
  size: number;
}

function readExactly(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const n = fs.readSync(fd, buf, off, length - off, position + off);
    if (n === 0) break;
    off += n;
  }
  return off === length ? buf : buf.subarray(0, off);
}

/** Başlığı ve metayı okur ve doğrular (parola gerekmez). Biçim bozuksa `BACKUP_BAD_FORMAT`. */
export function readBackupHeader(file: string): ParsedHeader {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    throw lifecycleError("BACKUP_FILE_MISSING");
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < FIXED_LEN + TAG_LEN + 1) throw lifecycleError("BACKUP_BAD_FORMAT");
    const fixed = readExactly(fd, FIXED_LEN, 0);
    if (fixed.length !== FIXED_LEN || !fixed.subarray(0, 8).equals(MAGIC))
      throw lifecycleError("BACKUP_BAD_FORMAT");
    const [version, kdfId, log2N, r, p] = [fixed[8], fixed[9], fixed[10], fixed[11], fixed[12]];
    if (version !== FORMAT_VERSION || kdfId !== KDF_SCRYPT)
      throw lifecycleError("BACKUP_BAD_FORMAT");
    if (log2N! < LOG2N_MIN || log2N! > LOG2N_MAX || r !== SCRYPT_R || p !== SCRYPT_P)
      throw lifecycleError("BACKUP_BAD_FORMAT");
    const metaLen = fixed.readUInt32BE(85);
    if (metaLen < 2 || metaLen > META_MAX || FIXED_LEN + metaLen + TAG_LEN + 1 > size)
      throw lifecycleError("BACKUP_BAD_FORMAT");
    const metaBuf = readExactly(fd, metaLen, FIXED_LEN);
    let meta: BackupMeta;
    try {
      meta = backupMetaSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metaBuf)),
      );
    } catch {
      throw lifecycleError("BACKUP_BAD_FORMAT");
    }
    return {
      header: Buffer.concat([fixed, metaBuf]),
      meta,
      kdf: { log2N: log2N!, r: r!, p: p!, salt: Buffer.from(fixed.subarray(13, 29)) },
      verifierNonce: Buffer.from(fixed.subarray(29, 41)),
      verifier: Buffer.from(fixed.subarray(41, 73)),
      payloadNonce: Buffer.from(fixed.subarray(73, 85)),
      size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Parola doğrulayıcısı: tutmazsa `BACKUP_WRONG_PASSPHRASE`. Anahtarı döndürür. */
export async function unlockBackup(h: ParsedHeader, passphrase: string): Promise<Buffer> {
  const key = await deriveKey(passphrase, h.kdf);
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, h.verifierNonce);
    d.setAAD(h.header.subarray(0, VERIFIER_AAD_END));
    d.setAuthTag(h.verifier.subarray(16));
    const plain = Buffer.concat([d.update(h.verifier.subarray(0, 16)), d.final()]);
    if (!plain.equals(Buffer.alloc(16))) throw new Error("verifier");
  } catch {
    throw lifecycleError("BACKUP_WRONG_PASSPHRASE");
  }
  return key;
}

/**
 * Yük çözücü: `u32 manifestLen | manifest | veritabanı`. Manifesti ayrıştırır, veritabanı baytlarını sayar ve özetler.
 * Bildirilen boyuttan fazla bayt (gzip bombası) gelir gelmez durur.
 */
class PayloadParser extends Transform {
  manifest: BackupManifest | null = null;
  private head = Buffer.alloc(0);
  private need = -1;
  private dbSeen = 0;
  private readonly hash = crypto.createHash("sha256");

  override _transform(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (e?: Error | null, d?: Buffer) => void,
  ) {
    try {
      if (this.manifest) return cb(null, this.db(chunk));
      this.head = Buffer.concat([this.head, chunk]);
      if (this.need < 0 && this.head.length >= 4) {
        this.need = this.head.readUInt32BE(0);
        if (this.need < 2 || this.need > MANIFEST_MAX) throw lifecycleError("BACKUP_CORRUPT");
      }
      if (this.need < 0 || this.head.length < 4 + this.need) return cb();
      let parsed: BackupManifest;
      try {
        parsed = manifestSchema.parse(
          JSON.parse(this.head.subarray(4, 4 + this.need).toString("utf8")),
        );
      } catch {
        throw lifecycleError("BACKUP_CORRUPT");
      }
      this.manifest = parsed;
      const rest = this.head.subarray(4 + this.need);
      this.head = Buffer.alloc(0);
      cb(null, rest.length ? this.db(rest) : undefined);
    } catch (e) {
      cb(e as Error);
    }
  }

  private db(chunk: Buffer): Buffer {
    this.dbSeen += chunk.length;
    if (this.dbSeen > this.manifest!.dbBytes) throw lifecycleError("BACKUP_CORRUPT");
    this.hash.update(chunk);
    return chunk;
  }

  override _flush(cb: (e?: Error | null) => void) {
    if (
      !this.manifest ||
      this.dbSeen !== this.manifest.dbBytes ||
      this.hash.digest("hex") !== this.manifest.dbSha256
    )
      return cb(lifecycleError("BACKUP_CORRUPT"));
    cb();
  }
}

export interface DecryptResult {
  meta: BackupMeta;
  manifest: BackupManifest;
}

/**
 * Yedeği `outDbFile`'a çözer (yalnızca etiket, boyut ve özet tuttuktan sonra başarı döner). Başarısızlıkta
 * `outDbFile` silinir. Hata kodları: BAD_FORMAT, WRONG_PASSPHRASE, CORRUPT, DISK_FULL, FILE_MISSING.
 */
export async function decryptBackup(o: {
  file: string;
  passphrase: string;
  outDbFile: string;
}): Promise<DecryptResult> {
  const h = readBackupHeader(o.file);
  const key = await unlockBackup(h, o.passphrase);
  const tagFd = fs.openSync(o.file, "r");
  let tag: Buffer;
  try {
    tag = readExactly(tagFd, TAG_LEN, h.size - TAG_LEN);
  } finally {
    fs.closeSync(tagFd);
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, h.payloadNonce);
  decipher.setAAD(h.header);
  decipher.setAuthTag(tag);
  const parser = new PayloadParser();
  try {
    await pipeline(
      fs.createReadStream(o.file, { start: h.header.length, end: h.size - TAG_LEN - 1 }),
      decipher,
      zlib.createGunzip(),
      parser,
      fs.createWriteStream(o.outDbFile, { flags: "w", mode: 0o600 }),
    );
  } catch (e) {
    fs.rmSync(o.outDbFile, { force: true });
    if (e instanceof LifecycleError) throw e;
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOSPC") throw lifecycleError("BACKUP_DISK_FULL");
    if (code === "ENOENT" && !fs.existsSync(o.file)) throw lifecycleError("BACKUP_FILE_MISSING");
    // Etiket doğrulaması, gzip veya akış hatası: dosya değiştirilmiş/kesilmiş.
    throw lifecycleError("BACKUP_CORRUPT");
  }
  return { meta: h.meta, manifest: parser.manifest! };
}
