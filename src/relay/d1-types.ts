/**
 * Cloudflare D1 istemci arayüzünün bu projede KULLANILAN en küçük alt kümesi (`@cloudflare/workers-types` bağımlılığı
 * eklenmez). Yalnızca belgelenmiş çağrılar: `prepare` → `bind` → `run` / `all` / `first`, ve `batch` (tek işlem,
 * hepsi ya da hiçbiri). Testlerde aynı arayüz SQLite üzerinde taklit edilir (tests/helpers/fake-d1.ts).
 */

export type D1Value = string | number | null;

export interface D1Meta {
  /** Değişen satır sayısı (INSERT/UPDATE/DELETE). */
  changes?: number;
  [key: string]: unknown;
}

export interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
