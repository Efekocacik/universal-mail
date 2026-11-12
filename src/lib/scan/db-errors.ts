/**
 * Drizzle hataları özgün SQLite iletisini `cause` zincirinde taşır ("Failed query: …" → LibsqlError → SqliteError).
 * Tekil indeks ihlali bu zincirin herhangi bir halkasında aranır.
 */
export function uniqueViolationOn(e: unknown, target: RegExp): boolean {
  let cur: unknown = e;
  for (let i = 0; cur && i < 6; i++) {
    const msg = String((cur as { message?: unknown }).message ?? "");
    if (/UNIQUE constraint failed/i.test(msg) && target.test(msg)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
