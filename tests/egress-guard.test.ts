import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Faz 6 (paket G): `scripts/egress-guard.cjs` ayrı bir Node sürecinde sınanır. `block` kipinde yerel olmayan her deneme
 * hata ile biter ve kaydedilir; GERÇEK ağa hiç çıkılmaz (engelleme bağlantı/çözümleme başlamadan önce yapılır).
 */

const GUARD = path.resolve(__dirname, "..", "scripts", "egress-guard.cjs");
let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-egress-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Entry {
  t: number;
  proc: string;
  kind: string;
  host: string;
  port: number | null;
}

function runChild(script: string, mode: "block" | "record") {
  const file = path.join(dir, "child.cjs");
  const log = path.join(dir, "egress.jsonl");
  fs.writeFileSync(file, script);
  const r = spawnSync(process.execPath, ["--require", GUARD, file], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      UM_EGRESS_LOG: log,
      UM_EGRESS_MODE: mode,
      UM_EGRESS_PROC: "test-child",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  const entries: Entry[] = fs.existsSync(log)
    ? fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Entry)
    : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, entries };
}

const CHILD = String.raw`
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const dns = require("node:dns");
const dgram = require("node:dgram");
const out = {};
const settle = (name, p) => p.then((v) => (out[name] = { ok: true, v }), (e) => (out[name] = { ok: false, code: e.code ?? e.cause?.code ?? e.name }));
(async () => {
  const server = http.createServer((_q, s) => s.end("yerel"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await settle("loopbackFetch", fetch("http://127.0.0.1:" + port + "/").then((r) => r.text()));
  await settle("localhostLookup", dns.promises.lookup("localhost").then((a) => a.address));
  await settle("externalFetch", fetch("https://example.com/"));
  await settle("externalHttpGet", new Promise((res, rej) => https.get("https://example.org/", res).on("error", rej)));
  await settle("netConnect", new Promise((res, rej) => net.connect(443, "93.184.215.14", res).on("error", rej)));
  await settle("lookupCb", new Promise((res, rej) => dns.lookup("example.com", (e, a) => (e ? rej(e) : res(a)))));
  await settle("lookupPromise", dns.promises.lookup("example.net"));
  await settle("resolveMx", dns.promises.resolveMx("example.com"));
  await settle("resolveTxtCb", new Promise((res, rej) => dns.resolveTxt("example.com", (e, a) => (e ? rej(e) : res(a)))));
  await settle("resolverClass", new Promise((res, rej) => new dns.Resolver().resolve4("example.com", (e, a) => (e ? rej(e) : res(a)))));
  await settle("promiseResolverClass", new dns.promises.Resolver().resolveNs("example.com"));
  const sock = dgram.createSocket("udp4");
  await settle("udp", new Promise((res, rej) => sock.send(Buffer.from("x"), 53, "8.8.8.8", (e) => (e ? rej(e) : res(true)))));
  sock.close();
  server.close();
  process.stdout.write(JSON.stringify(out));
})();
`;

describe("egress-guard (block)", () => {
  it("yerel bağlantıya izin verir; dış fetch, http, TCP, DNS ve UDP engellenir ve kaydedilir", () => {
    const r = runChild(CHILD, "block");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, { ok: boolean; v?: unknown; code?: string }>;
    expect(out.loopbackFetch).toEqual({ ok: true, v: "yerel" });
    expect(out.localhostLookup!.ok).toBe(true);
    for (const k of ["externalFetch", "netConnect", "udp"]) {
      expect(out[k], k).toEqual({ ok: false, code: "ECONNREFUSED" });
    }
    // https.get Node sürümüne göre önce ad çözümler (ENOTFOUND) ya da doğrudan bağlanır (ECONNREFUSED); ikisi de engel.
    expect(["ECONNREFUSED", "ENOTFOUND"]).toContain(out.externalHttpGet!.code);
    expect(out.externalHttpGet!.ok).toBe(false);
    for (const k of [
      "lookupCb",
      "lookupPromise",
      "resolveMx",
      "resolveTxtCb",
      "resolverClass",
      "promiseResolverClass",
    ]) {
      expect(out[k], k).toEqual({ ok: false, code: "ENOTFOUND" });
    }
    const seen = r.entries.map((e) => `${e.kind} ${e.host}`);
    expect(seen).toEqual(
      expect.arrayContaining([
        "connect example.com",
        "connect 93.184.215.14",
        "dns.lookup example.com",
        "dns.lookup example.net",
        "dns.resolveMx example.com",
        "dns.resolveTxt example.com",
        "dns.resolve4 example.com",
        "dns.resolveNs example.com",
        "udp 8.8.8.8",
      ]),
    );
    expect(r.entries.some((e) => e.host === "example.org")).toBe(true);
    // Yerel denemeler kaydedilmez; her kayıt süreç adını taşır.
    expect(r.entries.some((e) => e.host === "127.0.0.1" || e.host === "localhost")).toBe(false);
    expect(new Set(r.entries.map((e) => e.proc))).toEqual(new Set(["test-child"]));
  });
});

describe("egress-guard (record)", () => {
  it("yalnızca yerel trafik varken kayıt boştur ve davranış değişmez", () => {
    const r = runChild(
      String.raw`
      const http = require("node:http");
      const server = http.createServer((_q, s) => s.end("ok"));
      server.listen(0, "localhost", async () => {
        const res = await fetch("http://localhost:" + server.address().port + "/");
        process.stdout.write(await res.text());
        server.close();
      });`,
      "record",
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("ok");
    expect(r.entries).toEqual([]);
  });

  it("iki kez yüklenmek yamaları iki kez uygulamaz", () => {
    const r = runChild(
      `require(${JSON.stringify(GUARD)}); const { isLoopback } = require(${JSON.stringify(GUARD)});
       process.stdout.write(JSON.stringify(["127.0.0.1","::1","[::1]","localhost","a.localhost","","10.0.0.1","example.com"].map(isLoopback)));`,
      "block",
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([true, true, true, true, true, true, false, false]);
  });
});
