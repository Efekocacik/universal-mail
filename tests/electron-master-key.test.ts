import { describe, expect, it } from "vitest";
import {
  backupPath,
  CONFIRM_BUTTONS,
  EXPLAIN_BUTTONS,
  isValidMasterKey,
  loadOrRecoverMasterKey,
  MAX_RECOVERY_ROUNDS,
  MasterKeyQuit,
  nextRecoveryStep,
  planSecretsReset,
  recoveryDialog,
  tryDecryptMasterKey,
  type MasterKeyPorts,
  type RecoveryDialogSpec,
} from "../electron/master-key";

/**
 * Ana anahtar kurtarma akışı (C5-b). Electron yok: dosya sistemi, anahtarlık ve iletişim kutuları bellek içi sahte
 * nesnelerle verilir. Asıl güvence: çözülemeyen anahtar SESSİZCE yenilenmez, dosyalar silinmez.
 */

const KEY_FILE = "/u/master.key.enc";
const SECRETS = "/u/data/secrets.json";
const OLD_KEY = "ab".repeat(32);
const NEW_KEY = "cd".repeat(32);
const NOW = 1_700_000_000_000;

/** Basit "anahtarlık": `enc:` önekiyle şifreler; `broken` iken çözme hata verir. */
function harness(opts: {
  files?: Record<string, string>;
  responses?: number[];
  smoke?: boolean;
  broken?: boolean | (() => boolean);
}) {
  const files = new Map<string, Buffer>(
    Object.entries(opts.files ?? {}).map(([k, v]) => [k, Buffer.from(v)]),
  );
  const responses = [...(opts.responses ?? [])];
  const dialogs: RecoveryDialogSpec[] = [];
  const revealed: string[] = [];
  const logs: string[] = [];
  const renames: [string, string][] = [];
  const isBroken = () =>
    typeof opts.broken === "function" ? opts.broken() : (opts.broken ?? false);
  const ports: MasterKeyPorts = {
    keyFile: KEY_FILE,
    secretsFile: SECRETS,
    smoke: opts.smoke ?? false,
    exists: (p) => files.has(p),
    readFile: (p) => {
      const f = files.get(p);
      if (!f) throw new Error("ENOENT");
      return f;
    },
    writeKeyFile: (p, data) => void files.set(p, data),
    rename: (from, to) => {
      const f = files.get(from);
      if (!f) throw new Error("ENOENT");
      files.delete(from);
      files.set(to, f);
      renames.push([from, to]);
    },
    decrypt: (data) => {
      if (isBroken()) throw new Error("Error while decrypting the ciphertext");
      const s = data.toString();
      if (!s.startsWith("enc:")) throw new Error("bozuk");
      return s.slice(4);
    },
    encrypt: (plain) => Buffer.from(`enc:${plain}`),
    randomKey: () => NEW_KEY,
    showDialog: (spec) => {
      dialogs.push(spec);
      const r = responses.shift();
      if (r === undefined) throw new Error("beklenmeyen iletişim kutusu");
      return r;
    },
    reveal: (p) => void revealed.push(p),
    log: (m) => void logs.push(m),
    now: () => NOW,
  };
  const snapshot = () =>
    JSON.stringify([...files.entries()].map(([k, v]) => [k, v.toString()]).sort());
  return { ports, files, dialogs, revealed, logs, renames, snapshot };
}

const existing = { [KEY_FILE]: `enc:${OLD_KEY}`, [SECRETS]: '{"items":{}}' };

describe("ana anahtar: normal yollar", () => {
  it("dosya yoksa (ilk açılış) yeni anahtar üretilir ve şifreli yazılır; iletişim kutusu yok", () => {
    const h = harness({});
    expect(loadOrRecoverMasterKey(h.ports)).toEqual({
      kind: "key",
      key: NEW_KEY,
      created: true,
      backups: [],
    });
    expect(h.files.get(KEY_FILE)!.toString()).toBe(`enc:${NEW_KEY}`);
    expect(h.dialogs).toHaveLength(0);
  });

  it("dosya çözülürse mevcut anahtar döner; hiçbir dosya değişmez", () => {
    const h = harness({ files: existing });
    const before = h.snapshot();
    expect(loadOrRecoverMasterKey(h.ports)).toEqual({
      kind: "key",
      key: OLD_KEY,
      created: false,
      backups: [],
    });
    expect(h.snapshot()).toBe(before);
    expect(h.dialogs).toHaveLength(0);
  });
});

describe("ana anahtar çözülemedi: SESSİZCE yenilenmez", () => {
  it("varsayılan seçim KAPAT: hiçbir dosya değişmez, yeni anahtar üretilmez", () => {
    const h = harness({ files: existing, broken: true, responses: [EXPLAIN_BUTTONS.quit] });
    const before = h.snapshot();
    expect(loadOrRecoverMasterKey(h.ports)).toEqual({ kind: "quit" });
    expect(h.snapshot()).toBe(before);
    expect(h.renames).toHaveLength(0);
    expect(h.dialogs).toHaveLength(1);
    expect(h.dialogs[0]!.defaultId).toBe(EXPLAIN_BUTTONS.quit);
    expect(h.dialogs[0]!.cancelId).toBe(EXPLAIN_BUTTONS.quit);
  });

  it("biçimi bozuk anahtar da (çözülse bile) kurtarma kutusunu açar", () => {
    const h = harness({
      files: { [KEY_FILE]: "enc:kisa" },
      responses: [EXPLAIN_BUTTONS.quit],
    });
    expect(loadOrRecoverMasterKey(h.ports)).toEqual({ kind: "quit" });
    expect(h.dialogs[0]!.detail).toContain("beklenmeyen biçim");
  });

  it("tekrar dene: anahtarlık erişimi geri gelirse eski anahtar kullanılır, dosyalar değişmez", () => {
    let broken = true;
    const h = harness({
      files: existing,
      broken: () => broken,
      responses: [EXPLAIN_BUTTONS.retry],
    });
    const before = h.snapshot();
    h.ports.showDialog = ((orig) => (spec: RecoveryDialogSpec) => {
      broken = false; // kullanıcı anahtarlık isteğine izin verdi
      return orig(spec);
    })(h.ports.showDialog);
    expect(loadOrRecoverMasterKey(h.ports)).toMatchObject({ kind: "key", key: OLD_KEY });
    expect(h.snapshot()).toBe(before);
  });

  it("veri klasörünü göster: dosya gösterilir ve aynı kutuya dönülür", () => {
    const h = harness({
      files: existing,
      broken: true,
      responses: [EXPLAIN_BUTTONS.reveal, EXPLAIN_BUTTONS.quit],
    });
    expect(loadOrRecoverMasterKey(h.ports)).toEqual({ kind: "quit" });
    expect(h.revealed).toEqual([KEY_FILE]);
    expect(h.dialogs.map((d) => d.title)).toEqual([
      "Ana anahtar açılamadı",
      "Ana anahtar açılamadı",
    ]);
  });

  it("sıfırla seçilip ikinci onayda VAZGEÇ: ilk kutuya dönülür; kapatılırsa hiçbir dosya değişmez", () => {
    const h = harness({
      files: existing,
      broken: true,
      responses: [EXPLAIN_BUTTONS.reset, CONFIRM_BUTTONS.back, EXPLAIN_BUTTONS.quit],
    });
    const before = h.snapshot();
    expect(loadOrRecoverMasterKey(h.ports)).toEqual({ kind: "quit" });
    expect(h.snapshot()).toBe(before);
    expect(h.dialogs.map((d) => d.title)).toEqual([
      "Ana anahtar açılamadı",
      "Gizli bilgiler sıfırlansın mı?",
      "Ana anahtar açılamadı",
    ]);
  });

  it("iki aşamalı onayla sıfırlama: eski anahtar ve secrets.json SİLİNMEZ, yedek adla saklanır; yeni anahtar yazılır", () => {
    const h = harness({
      files: existing,
      broken: true,
      responses: [EXPLAIN_BUTTONS.reset, CONFIRM_BUTTONS.reset],
    });
    const r = loadOrRecoverMasterKey(h.ports);
    expect(r).toEqual({
      kind: "key",
      key: NEW_KEY,
      created: true,
      backups: [
        { from: SECRETS, to: `${SECRETS}.bak-${NOW}` },
        { from: KEY_FILE, to: `${KEY_FILE}.bak-${NOW}` },
      ],
    });
    expect(h.files.get(`${KEY_FILE}.bak-${NOW}`)!.toString()).toBe(`enc:${OLD_KEY}`);
    expect(h.files.get(`${SECRETS}.bak-${NOW}`)!.toString()).toBe('{"items":{}}');
    expect(h.files.get(KEY_FILE)!.toString()).toBe(`enc:${NEW_KEY}`);
    expect(h.files.has(SECRETS)).toBe(false);
    expect(h.logs.join("\n")).toContain(`${KEY_FILE}.bak-${NOW}`);
  });

  it("onay kutusunda Esc/kapatma (iptal dizini) sıfırlamaz", () => {
    const spec = recoveryDialog("confirm_reset", { keyFile: "k", secretsFile: "s", error: "e" });
    expect(spec.defaultId).toBe(CONFIRM_BUTTONS.back);
    expect(spec.cancelId).toBe(CONFIRM_BUTTONS.back);
    expect(nextRecoveryStep("confirm_reset", spec.cancelId)).toEqual({
      kind: "dialog",
      stage: "explain",
    });
  });

  it("duman testi: iletişim kutusu yok, dosyalara dokunulmaz, geçici anahtar", () => {
    const h = harness({ files: existing, broken: true, smoke: true });
    const before = h.snapshot();
    expect(loadOrRecoverMasterKey(h.ports)).toEqual({ kind: "ephemeral", key: NEW_KEY });
    expect(h.snapshot()).toBe(before);
    expect(h.dialogs).toHaveLength(0);
  });

  it("sonsuz döngü yok: sürekli 'göster' veya 'tekrar dene' sınırda KAPAT'a gider, dosyalar değişmez", () => {
    const reveal = harness({
      files: existing,
      broken: true,
      responses: Array(MAX_RECOVERY_ROUNDS).fill(EXPLAIN_BUTTONS.reveal),
    });
    expect(loadOrRecoverMasterKey(reveal.ports)).toEqual({ kind: "quit" });
    expect(reveal.renames).toHaveLength(0);

    const retry = harness({
      files: existing,
      broken: true,
      responses: Array(MAX_RECOVERY_ROUNDS).fill(EXPLAIN_BUTTONS.retry),
    });
    expect(loadOrRecoverMasterKey(retry.ports)).toEqual({ kind: "quit" });
    expect(retry.renames).toHaveLength(0);
  });
});

describe("saf yardımcılar", () => {
  it("bilinmeyen yanıt her zaman KAPAT; sıfırlama yalnızca ikinci kutuda açık seçimle", () => {
    expect(nextRecoveryStep("explain", -1)).toEqual({ kind: "quit" });
    expect(nextRecoveryStep("explain", 99)).toEqual({ kind: "quit" });
    expect(nextRecoveryStep("explain", EXPLAIN_BUTTONS.reset)).toEqual({
      kind: "dialog",
      stage: "confirm_reset",
    });
    expect(nextRecoveryStep("explain", EXPLAIN_BUTTONS.retry)).toEqual({ kind: "retry" });
    expect(nextRecoveryStep("confirm_reset", CONFIRM_BUTTONS.reset)).toEqual({ kind: "reset" });
    expect(nextRecoveryStep("confirm_reset", 7)).toEqual({ kind: "dialog", stage: "explain" });
  });

  it("iletişim kutusu düğmeleri dizinlerle uyumlu ve dosya yollarını gösterir", () => {
    const ctx = { keyFile: KEY_FILE, secretsFile: SECRETS, error: "x" };
    const e = recoveryDialog("explain", ctx);
    expect(e.buttons).toHaveLength(4);
    expect(e.buttons[EXPLAIN_BUTTONS.quit]).toBe("Uygulamayı kapat");
    expect(e.buttons[EXPLAIN_BUTTONS.reset]).toMatch(/sıfırla/i);
    expect(e.detail).toContain(KEY_FILE);
    const c = recoveryDialog("confirm_reset", ctx);
    expect(c.buttons[CONFIRM_BUTTONS.reset]).toMatch(/Sıfırla/);
    expect(c.detail).toContain(SECRETS);
  });

  it("yedek adı var olan dosyanın üzerine yazmaz", () => {
    const taken = new Set([`/a.bak-${NOW}`, `/a.bak-${NOW}-1`]);
    expect(backupPath("/a", NOW, (p) => taken.has(p))).toBe(`/a.bak-${NOW}-2`);
    expect(backupPath("/b", NOW, () => false)).toBe(`/b.bak-${NOW}`);
  });

  it("sıfırlama planı yalnızca var olan dosyaları taşır (secrets.json yoksa yalnızca anahtar)", () => {
    expect(
      planSecretsReset({ keyFile: KEY_FILE, secretsFile: SECRETS }, NOW, (p) => p === KEY_FILE),
    ).toEqual([{ from: KEY_FILE, to: `${KEY_FILE}.bak-${NOW}` }]);
  });

  it("anahtar biçimi ve çözme denemesi", () => {
    expect(isValidMasterKey(OLD_KEY)).toBe(true);
    expect(isValidMasterKey("xyz")).toBe(false);
    expect(isValidMasterKey(undefined)).toBe(false);
    expect(
      tryDecryptMasterKey(
        () => Buffer.from(""),
        () => {
          throw new Error("izin yok");
        },
      ),
    ).toEqual({ ok: false, error: "izin yok" });
    expect(
      tryDecryptMasterKey(
        () => Buffer.from(""),
        () => OLD_KEY,
      ),
    ).toEqual({ ok: true, key: OLD_KEY });
  });

  it("kapatma seçimi ayrı hata türüyle bildirilir (başlatma hata kutusu gösterilmesin)", () => {
    const e = new MasterKeyQuit();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("MasterKeyQuit");
  });
});
