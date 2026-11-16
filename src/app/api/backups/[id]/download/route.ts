import fs from "node:fs";
import { Readable } from "node:stream";
import { database, intParam } from "@/lib/api/http";
import { backupFileForDownload } from "@/lib/backup/service";
import { audit } from "@/lib/db/audit";
import { lifecycleRoute } from "../../http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Şifreli yedek dosyasını indirir (akış; içerik zaten parolayla şifrelidir). Yol yalnızca satırdan kurulur.
 * 404 NOT_FOUND; 410 BACKUP_FILE_MISSING. Denetim: `backup.download`.
 */
export const GET = lifecycleRoute(async (_req: Request, ctx: Ctx) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const f = await backupFileForDownload(db, id);
  await audit(db, "backup.download", "backup", id, { size: f.size });
  const stream = Readable.toWeb(fs.createReadStream(f.file)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(f.size),
      "Content-Disposition": `attachment; filename="${f.fileName}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
