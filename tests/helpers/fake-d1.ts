import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, type Client, type InStatement, type ResultSet } from "@libsql/client";
import type { D1Database, D1PreparedStatement, D1Result, D1Value } from "@/relay/d1-types";

/**
 * Cloudflare D1'in TEST taklidi: gerçek SQLite (libsql, geçici dosya) üzerinde `prepare/bind/run/all/first/batch`.
 * `batch` tek bir yazma işlemidir (hepsi ya da hiçbiri), D1'deki gibi. Ağ yoktur; gerçek D1'e bağlanmaz.
 *
 * Hata enjeksiyonu: `failWrites` → INSERT/UPDATE/DELETE içeren her çağrı (tekil veya toplu) istisna fırlatır;
 * `failAll` → her çağrı istisna fırlatır (D1'e ulaşılamıyor). `queries` her çalıştırılan SQL'i sayar.
 */

const WRITE_RE = /^\s*(insert|update|delete|replace|create|drop|alter)\b/i;

export class FakeD1 implements D1Database {
  failWrites = false;
  failAll = false;
  readonly queries: string[] = [];
  private constructor(
    readonly client: Client,
    readonly file: string,
  ) {}

  static async create(dir?: string): Promise<FakeD1> {
    const base = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "um-fake-d1-"));
    const file = path.join(base, "d1.sqlite");
    return new FakeD1(createClient({ url: `file:${file}` }), file);
  }

  /** Aynı veritabanı dosyasına YENİ bağlantı (Worker yeniden başlaması / başka isolate). */
  async reopen(): Promise<FakeD1> {
    return new FakeD1(createClient({ url: `file:${this.file}` }), this.file);
  }

  /** deploy/cloudflare-worker/schema.sql'i uygular (panel konsolundaki adımın eşdeğeri). */
  async applySchema(): Promise<void> {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "deploy", "cloudflare-worker", "schema.sql"),
      "utf8",
    );
    await this.client.executeMultiple(sql);
  }

  close(): void {
    this.client.close();
  }

  guard(sql: string): void {
    this.queries.push(sql);
    if (this.failAll) throw new Error("D1_ERROR: network connection lost");
    if (this.failWrites && WRITE_RE.test(sql)) throw new Error("D1_ERROR: write failed");
  }

  prepare(query: string): D1PreparedStatement {
    return new FakeStatement(this, query, []);
  }

  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    const list = statements as FakeStatement[];
    for (const s of list) this.guard(s.sql);
    const rs = await this.client.batch(
      list.map((s): InStatement => ({ sql: s.sql, args: s.args })),
      "write",
    );
    return rs.map((r) => toResult<T>(r));
  }
}

function toResult<T>(r: ResultSet): D1Result<T> {
  const results = r.rows.map((row) => {
    const o: Record<string, unknown> = {};
    r.columns.forEach((c, i) => {
      const v = row[i];
      o[c] = typeof v === "bigint" ? Number(v) : v;
    });
    return o as T;
  });
  return { results, success: true, meta: { changes: r.rowsAffected } };
}

class FakeStatement implements D1PreparedStatement {
  constructor(
    private readonly db: FakeD1,
    readonly sql: string,
    readonly args: D1Value[],
  ) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    return new FakeStatement(this.db, this.sql, values);
  }

  private async exec(): Promise<ResultSet> {
    this.db.guard(this.sql);
    return this.db.client.execute({ sql: this.sql, args: this.args });
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return toResult<T>(await this.exec());
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return toResult<T>(await this.exec());
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const r = toResult<T>(await this.exec());
    return r.results?.[0] ?? null;
  }
}
