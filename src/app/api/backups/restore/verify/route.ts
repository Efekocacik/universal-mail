import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { body, database, HttpError, json } from "@/lib/api/http";
import { lifecycleError } from "@/lib/backup/passphrase";
import { UPLOAD_MAX_BYTES, verifyAndStage, type RestoreSource } from "@/lib/backup/restore";
import { workDir } from "@/lib/backup/service";
import { lifecycleRoute } from "../../http";

export const dynamic = "force-dynamic";

const MULTIPART_OVERHEAD = 64 * 1024;

const jsonSchema = z.union([
  z.object({ backupId: z.number().int().positive(), passphrase: z.string().max(1024) }).strict(),
  z.object({ path: z.string().min(1).max(4096), passphrase: z.string().max(1024) }).strict(),
]);

/** Gövdeyi `Content-Length`'e güvenmeden, sınırı aşınca keserek okur (1 GB'lık yükleme belleğe alınmaz). */
async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw lifecycleError("BACKUP_TOO_LARGE");
  if (!req.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw lifecycleError("BACKUP_TOO_LARGE");
    }
    parts.push(value);
  }
  // Bildirilenden az bayt geldiyse gövde yolda kesilmiştir (ör. ara katmanın gövde kopyalama sınırı): eksik dosyayı
  // "bozuk yedek" diye göstermek yerine büyük dosya yolunu (masaüstünde "Dosya seç…") öneren hata döner.
  if (Number.isFinite(declared) && declared > 0 && size < declared)
    throw lifecycleError("BACKUP_TOO_LARGE");
  const out = new Uint8Array(new ArrayBuffer(size));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const badForm = () =>
  new HttpError(400, "Dosya gönderilemedi. Sayfayı yenileyip yeniden deneyin.", {
    code: "VALIDATION",
  });

/**
 * Geri yükleme doğrulaması ve hazırlığı. Kaynak: JSON `{backupId, passphrase}` (listeden), `{path, passphrase}`
 * (Electron "Dosya seç…") veya `multipart/form-data` `file` + `passphrase` (≤ 256 MiB). 200 `{stageId, expiresAt,
 * summary, migrationNeeded, hasSecrets}`. Hatalar: 404; 410 BACKUP_FILE_MISSING; 413 BACKUP_TOO_LARGE; 422
 * BACKUP_BAD_FORMAT / BACKUP_WRONG_PASSPHRASE / BACKUP_CORRUPT; 409 BACKUP_SCHEMA_NEWER / LIFECYCLE_PENDING.
 * Denetim: `backup.restore.verify` (sonuç ve kod; parola asla).
 */
export const POST = lifecycleRoute(async (req: Request) => {
  const db = await database();
  const type = req.headers.get("content-type") ?? "";
  if (/^multipart\/form-data/i.test(type)) {
    const raw = await readCapped(req, UPLOAD_MAX_BYTES + MULTIPART_OVERHEAD);
    let form: FormData;
    try {
      form = await new Response(raw, { headers: { "content-type": type } }).formData();
    } catch {
      throw badForm();
    }
    const f = form.get("file");
    const passphrase = form.get("passphrase");
    if (!f || typeof f === "string" || typeof passphrase !== "string" || passphrase.length > 1024)
      throw badForm();
    if (f.size > UPLOAD_MAX_BYTES) throw lifecycleError("BACKUP_TOO_LARGE");
    const dir = workDir();
    const file = path.join(dir, "upload.umbk");
    try {
      fs.writeFileSync(file, new Uint8Array(await f.arrayBuffer()), { mode: 0o600 });
      const source: RestoreSource = { kind: "upload", file };
      return json(await verifyAndStage(db, { source, passphrase }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const b = await body(req, jsonSchema);
  const source: RestoreSource =
    "backupId" in b ? { kind: "backup", id: b.backupId } : { kind: "path", path: b.path };
  return json(await verifyAndStage(db, { source, passphrase: b.passphrase }));
});
