import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteSecret,
  getSecret,
  maskSecret,
  resolveMasterKey,
  secretStatus,
  setSecret,
} from "@/lib/secrets/store";

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-sec-"));
  process.env.UM_DATA_DIR = dir;
  delete process.env.UM_MASTER_KEY;
  delete process.env.UM_REQUIRE_MASTER_KEY;
  delete process.env.GOOGLE_PLACES_API_KEY;
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("gizli bilgi deposu", () => {
  it("kaydedilen anahtar şifreli saklanır ve geri okunur", async () => {
    await setSecret("google.placesKey", "AIzaSyTESTKEY1234567890");
    const raw = fs.readFileSync(path.join(dir, "secrets.json"), "utf8");
    expect(raw).not.toContain("AIzaSyTESTKEY");
    expect(await getSecret("google.placesKey")).toBe("AIzaSyTESTKEY1234567890");
    const st = await secretStatus("google.placesKey");
    expect(st).toMatchObject({ set: true, source: "store" });
    expect(st.masked).toBe("AIza••••7890");
  });

  it("silme ve ortam değişkeni yedeği", async () => {
    await setSecret("google.placesKey", "stored-key-value");
    await deleteSecret("google.placesKey");
    expect(await getSecret("google.placesKey")).toBeUndefined();
    process.env.GOOGLE_PLACES_API_KEY = "env-key-value-1234";
    expect(await getSecret("google.placesKey")).toBe("env-key-value-1234");
    expect(await secretStatus("google.placesKey")).toMatchObject({ set: true, source: "env" });
  });

  it("bozuk secrets.json yazmada ÜZERİNE YAZILMAZ: yedeklenir ve hata verilir; okuma boş döner", async () => {
    process.env.UM_MASTER_KEY = "a".repeat(64);
    await setSecret("google.placesKey", "first-key-value-123");
    const file = path.join(dir, "secrets.json");
    const truncated = fs.readFileSync(file, "utf8").slice(0, 20);
    fs.writeFileSync(file, truncated);
    expect(await getSecret("google.placesKey")).toBeUndefined();
    await expect(setSecret("hunter.apiKey", "hunter-value-12345")).rejects.toThrow(
      /okunamadı; dosya yedeklendi/,
    );
    await expect(deleteSecret("google.placesKey")).rejects.toThrow(/yedeklendi/);
    expect(fs.readFileSync(file, "utf8")).toBe(truncated);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith("secrets.json.corrupt-"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(path.join(dir, backups[0]!), "utf8")).toBe(truncated);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("dosya yoksa yazma boş depodan başlar; bayat kilit dosyası yazmayı engellemez", async () => {
    const lock = path.join(dir, "secrets.json.lock");
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    await setSecret("google.placesKey", "fresh-key-value-1");
    expect(await getSecret("google.placesKey")).toBe("fresh-key-value-1");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("UM_MASTER_KEY ile çalışır; yanlış ana anahtarla okunamaz", async () => {
    process.env.UM_MASTER_KEY = "a".repeat(64);
    await setSecret("google.mapsKey", "maps-key-abcdefgh");
    expect(await getSecret("google.mapsKey")).toBe("maps-key-abcdefgh");
    process.env.UM_MASTER_KEY = "b".repeat(64);
    expect(await getSecret("google.mapsKey")).toBeUndefined();
  });

  it("üretimde ana anahtar zorunludur ve biçimi doğrulanır", () => {
    process.env.UM_REQUIRE_MASTER_KEY = "1";
    expect(() => resolveMasterKey()).toThrow(/Ana anahtar/);
    process.env.UM_MASTER_KEY = "kısa";
    expect(() => resolveMasterKey()).toThrow(/64/);
  });

  it("geliştirme anahtarı dosyası yalnızca sahibine yazılır", () => {
    resolveMasterKey();
    const mode = fs.statSync(path.join(dir, "master.key")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("boş değer reddedilir, kısa değer maskelenir", async () => {
    await expect(setSecret("google.placesKey", "   ")).rejects.toThrow();
    expect(maskSecret("abc")).toBe("••••");
  });
});
