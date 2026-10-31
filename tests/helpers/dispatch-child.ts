/**
 * İki gerçek süreçli eşzamanlılık testi için alt süreç (yalnızca testlerde, `node --import tsx` ile çalışır).
 * Verilen GEÇİCİ test veritabanı dosyasına kendi bağlantısını açar ve kendi demo sağlayıcısıyla dağıtıcıyı simüle
 * edilmiş saatle çalıştırır. Gerçek `.data` veritabanına ve ağa erişmez.
 *
 * Kullanım: dispatch-child.ts <dbFile> <startMs> <ticks> <stepMs>
 */
import { createClient } from "@libsql/client";
import { toLibsqlUrl } from "@/lib/config/paths";
import { resetConnection, trackTransactions } from "@/lib/db/client";
import { FakeMailProvider } from "@/lib/mail/provider/fake-provider";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import { wrap } from "./campaign-fixture";

async function main(): Promise<void> {
  const [file, start, ticks, step] = process.argv.slice(2);
  if (!file || !start || !ticks || !step) throw new Error("eksik argüman");
  const client = trackTransactions(
    createClient({ url: toLibsqlUrl(file), concurrency: 1, timeout: 5000 }),
  );
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 5000");
  const db = wrap(client);
  let t = Number(start);
  const provider = new FakeMailProvider({ now: () => t });
  const dispatcher = new MailDispatcher(db);
  const counts: Record<string, number> = {};
  for (let i = 0; i < Number(ticks); i++) {
    t = Number(start) + i * Number(step);
    const now = t;
    const r = await dispatcher.dispatchOnce({ now: () => now, provider });
    if (r.busy) await resetConnection(client, file); // worker'daki `onBusy` ile aynı
    const key = r.busy ? "busy" : (r.send?.outcome ?? "idle");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  client.close();
  process.stdout.write(JSON.stringify({ calls: provider.calls, counts }));
}

main().catch((e) => {
  process.stderr.write(String(e instanceof Error ? e.stack : e));
  process.exit(1);
});
