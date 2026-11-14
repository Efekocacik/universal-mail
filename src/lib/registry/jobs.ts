/**
 * Sicil işlerinin (`registry.fetch`, `registry.match`) kaydı. Çağrı yeri `src/worker/handlers.ts` →
 * `registerFaz5Handlers()` (P0 ekledi; o dosya dondurulmuştur). P0 sürümü hiçbir işleyici kaydetmez; paket R
 * `registerJobHandler(REGISTRY_FETCH_JOB, …)` ve `registerJobHandler(REGISTRY_MATCH_JOB, …)` çağrılarını buraya ekler.
 * İşleyiciler `ctx.db` kullanır (bağlantı parametresi gerekmez).
 */
export function registerRegistryJobs(): void {
  // Paket R doldurur.
}
