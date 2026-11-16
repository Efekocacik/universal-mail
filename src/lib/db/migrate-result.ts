import fs from "node:fs";
import path from "node:path";

/**
 * Faz 6 (P0.6; sahibi: paket K): şema geçişi betiğinin (`migrate.cjs`) SONUÇ dosyası. Electron ana süreci geçiş alt süreci
 * sıfırdan farklı kodla çıkınca bunu okur ve kullanıcıya koda özel bir iletişim kutusu gösterir
 * (`electron/migration-recovery.ts`). Dosya `<dataDir>/migrate-result.json`; kişisel veri ve veri klasörü DIŞINDA yol
 * içermez (yalnızca kod, sayılar ve veri klasöründeki yedeğin yolu).
 *
 * Dayanıklılık: atomik yazım (geçici dosya + yeniden adlandırma). Okuma, bozuk/eksik/yabancı dosyada `null` döner
 * (çağıran bunu "bilinmeyen hata" sayar); asla fırlatmaz.
 */

export const MIGRATE_RESULT_FILENAME = "migrate-result.json";

export const MIGRATE_RESULT_CODES = [
  "OK",
  "BLOCKED",
  "VERIFY_FAILED",
  "DISK_FULL",
  "CORRUPT",
  "FAILED",
] as const;
export type MigrateResultCode = (typeof MIGRATE_RESULT_CODES)[number];

export interface MigrateResult {
  v: 1;
  ok: boolean;
  code: MigrateResultCode;
  /** Geçişten önce alınan otomatik yedek (yalnızca `<dataDir>/backups` içindeyse yazılır). */
  backupPath?: string;
  /** Bu çalıştırmada uygulanan geçiş sayısı (başarısızlıkta 0). */
  applied: number;
  /** Sürümdeki toplam geçiş sayısı (bilinmiyorsa 0). */
  total: number;
  at: number;
}

const isInside = (dir: string, p: string): boolean => {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** Sonucu atomik olarak yazar. Yazılamazsa sessizce geçer (geçiş sonucu değişmez; Electron genel iletiyi gösterir). */
export function writeMigrateResult(
  dataDir: string,
  r: Omit<MigrateResult, "v" | "at"> & { at?: number },
): void {
  const out: MigrateResult = {
    v: 1,
    ok: r.ok,
    code: r.code,
    applied: Math.max(0, Math.trunc(r.applied)),
    total: Math.max(0, Math.trunc(r.total)),
    at: r.at ?? Date.now(),
  };
  if (r.backupPath && isInside(path.join(dataDir, "backups"), r.backupPath))
    out.backupPath = path.resolve(r.backupPath);
  const file = path.join(dataDir, MIGRATE_RESULT_FILENAME);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* yoksay */
    }
  }
}

/** Sonucu okur ve doğrular; yoksa/bozuksa null. */
export function readMigrateResult(dataDir: string): MigrateResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dataDir, MIGRATE_RESULT_FILENAME), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const int = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0;
  if (
    o.v !== 1 ||
    typeof o.ok !== "boolean" ||
    !(MIGRATE_RESULT_CODES as readonly unknown[]).includes(o.code) ||
    !int(o.applied) ||
    !int(o.total) ||
    !int(o.at)
  )
    return null;
  const out: MigrateResult = {
    v: 1,
    ok: o.ok,
    code: o.code as MigrateResultCode,
    applied: o.applied as number,
    total: o.total as number,
    at: o.at as number,
  };
  if (typeof o.backupPath === "string" && isInside(path.join(dataDir, "backups"), o.backupPath))
    out.backupPath = o.backupPath;
  return out;
}

/** Geçiş hatasını koda çevirir (ileti metnine değil, hata türüne ve SQLite koduna bakar). */
export function classifyMigrationError(e: unknown): MigrateResultCode {
  const err = e as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown } | null;
  const name = typeof err?.name === "string" ? err.name : "";
  if (name === "MigrationBlockedError") return "BLOCKED";
  if (name === "MigrationVerificationError") return "VERIFY_FAILED";
  const codes: string[] = [];
  for (let x: unknown = e, i = 0; x && typeof x === "object" && i < 5; i++) {
    const c = (x as { code?: unknown }).code;
    if (typeof c === "string") codes.push(c);
    x = (x as { cause?: unknown }).cause;
  }
  if (codes.some((c) => c === "ENOSPC" || c.startsWith("SQLITE_FULL"))) return "DISK_FULL";
  if (codes.some((c) => c.startsWith("SQLITE_CORRUPT") || c.startsWith("SQLITE_NOTADB")))
    return "CORRUPT";
  return "FAILED";
}

/** Hata nesnesinde (varsa) geçiş öncesi yedeğin yolu (`MigrationVerificationError.backupPath` vb.). */
export function backupPathOf(e: unknown): string | undefined {
  const p = (e as { backupPath?: unknown } | null)?.backupPath;
  return typeof p === "string" && p ? p : undefined;
}
