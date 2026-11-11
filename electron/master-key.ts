/**
 * Ana anahtar dosyasının yüklenmesi ve çözülemediğinde kurtarma akışı (C5-b).
 *
 * Bu modül Electron'u İÇE AKTARMAZ: dosya sistemi, işletim sistemi anahtarlığı (safeStorage) ve iletişim kutuları
 * dışarıdan verilir (`MasterKeyPorts`), böylece karar mantığı birim testlerle sınanabilir.
 *
 * Eskiden anahtar çözülemezse sessizce YENİ anahtar üretiliyordu: gizli depodaki API anahtarları, OAuth istemci sırrı,
 * yenileme belirteçleri ve abonelikten çıkış özel anahtarları kullanılamaz hale geliyordu. Artık:
 *  - kullanıcıya engelleyici bir iletişim kutusu gösterilir (Kapat / Tekrar dene / Veri klasörünü göster / Sıfırla…),
 *  - varsayılan ve Esc seçimi KAPAT'tır; hiçbir dosyaya dokunulmaz,
 *  - sıfırlama yalnızca İKİNCİ bir onaydan sonra yapılır; eski anahtar dosyası ve secrets.json SİLİNMEZ, yanlarına
 *    zaman damgalı yedek adla taşınır (anahtarlık erişimi geri gelirse elle geri yüklenebilir).
 */

export const MASTER_KEY_FILENAME = "master.key.enc";
export const SECRETS_FILENAME = "secrets.json";

/** Kurtarma döngüsünün üst sınırı: beklenmedik bir yanıt döngüsünde uygulama KAPANIR (güvenli yön). */
export const MAX_RECOVERY_ROUNDS = 25;

export function isValidMasterKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

export type DecryptAttempt = { ok: true; key: string } | { ok: false; error: string };

export function tryDecryptMasterKey(
  read: () => Buffer,
  decrypt: (data: Buffer) => string,
): DecryptAttempt {
  try {
    const key = decrypt(read());
    if (isValidMasterKey(key)) return { ok: true, key };
    return { ok: false, error: "beklenmeyen biçim" };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

/* --------------------------------- iletişim kutuları --------------------------------- */

export type RecoveryStage = "explain" | "confirm_reset";

/** Electron `MessageBoxSyncOptions` ile uyumlu, Electron'dan bağımsız alt küme. */
export interface RecoveryDialogSpec {
  type: "warning" | "error" | "question";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: true;
}

export const EXPLAIN_BUTTONS = {
  quit: 0,
  retry: 1,
  reveal: 2,
  reset: 3,
} as const;

export const CONFIRM_BUTTONS = {
  back: 0,
  reset: 1,
} as const;

export function recoveryDialog(
  stage: RecoveryStage,
  ctx: { keyFile: string; secretsFile: string; error: string },
): RecoveryDialogSpec {
  if (stage === "explain") {
    return {
      type: "warning",
      title: "Ana anahtar açılamadı",
      message: "Gizli bilgilerinizi koruyan ana anahtar açılamadı.",
      detail: [
        `İşletim sisteminin anahtar deposu (Anahtarlık / Kimlik Bilgisi Yöneticisi) anahtarı çözemedi (${ctx.error}).`,
        "Bu genellikle anahtarlık erişim isteği reddedildiğinde, uygulama farklı imzayla yeniden kurulduğunda veya veri klasörü başka bir bilgisayardan taşındığında olur.",
        "",
        'Hiçbir dosya değiştirilmedi. Anahtarlık erişim isteğini reddettiyseniz "Tekrar dene"yi seçip izin verin.',
        "",
        "Sıfırlarsanız kayıtlı API anahtarları, Gmail bağlantısı ve abonelikten çıkış imza/kanal anahtarları kullanılamaz; yeniden kurmanız gerekir. Eski dosyalar silinmez, yedek olarak saklanır.",
        "",
        `Anahtar dosyası: ${ctx.keyFile}`,
      ].join("\n"),
      buttons: [
        "Uygulamayı kapat",
        "Tekrar dene",
        "Veri klasörünü göster",
        "Gizli bilgileri sıfırla…",
      ],
      defaultId: EXPLAIN_BUTTONS.quit,
      cancelId: EXPLAIN_BUTTONS.quit,
      noLink: true,
    };
  }
  return {
    type: "warning",
    title: "Gizli bilgiler sıfırlansın mı?",
    message: "Yeni bir ana anahtar üretilecek ve kayıtlı gizli bilgiler kullanılamayacak.",
    detail: [
      'API anahtarlarını ve Gmail bağlantısını yeniden kurmanız gerekecek. Abonelikten çıkış altyapısında imza ve kanal anahtarı için "Yeni anahtara geç"i seçip anahtar dosyasını sunucuya yeniden yüklemeniz ve doğrulamanız gerekecek.',
      "Eski anahtar dosyası ve gizli depo silinmez; aynı klasörde yedek adla saklanır.",
      "",
      `Gizli depo: ${ctx.secretsFile}`,
    ].join("\n"),
    buttons: ["Vazgeç", "Sıfırla ve devam et"],
    defaultId: CONFIRM_BUTTONS.back,
    cancelId: CONFIRM_BUTTONS.back,
    noLink: true,
  };
}

export type RecoveryStep =
  | { kind: "dialog"; stage: RecoveryStage }
  | { kind: "reveal"; then: RecoveryStage }
  | { kind: "retry" }
  | { kind: "quit" }
  | { kind: "reset" };

/**
 * Bir iletişim kutusu yanıtından sonraki adım. Bilinmeyen yanıt (ör. pencere kapatıldı) her zaman KAPAT'a gider;
 * sıfırlama YALNIZCA ikinci onay kutusunda açıkça "Sıfırla" seçilirse yapılır.
 */
export function nextRecoveryStep(stage: RecoveryStage, response: number): RecoveryStep {
  if (stage === "explain") {
    switch (response) {
      case EXPLAIN_BUTTONS.retry:
        return { kind: "retry" };
      case EXPLAIN_BUTTONS.reveal:
        return { kind: "reveal", then: "explain" };
      case EXPLAIN_BUTTONS.reset:
        return { kind: "dialog", stage: "confirm_reset" };
      default:
        return { kind: "quit" };
    }
  }
  if (response === CONFIRM_BUTTONS.reset) return { kind: "reset" };
  // Vazgeç (veya Esc): hiçbir şey değişmeden ilk kutuya dönülür.
  return { kind: "dialog", stage: "explain" };
}

/* ---------------------------------------- yedekleme ---------------------------------------- */

/** Var olan bir dosyanın üzerine YAZMAYAN zaman damgalı yedek adı. */
export function backupPath(file: string, now: number, exists: (p: string) => boolean): string {
  const base = `${file}.bak-${now}`;
  if (!exists(base)) return base;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error("Yedek dosya adı bulunamadı.");
}

export interface Rename {
  from: string;
  to: string;
}

/** Sıfırlamada taşınacak dosyalar: önce gizli depo, sonra anahtar dosyası (yalnızca var olanlar). */
export function planSecretsReset(
  files: { keyFile: string; secretsFile: string },
  now: number,
  exists: (p: string) => boolean,
): Rename[] {
  const renames: Rename[] = [];
  const taken = new Set<string>();
  const occupied = (p: string) => taken.has(p) || exists(p);
  for (const from of [files.secretsFile, files.keyFile]) {
    if (!exists(from)) continue;
    const to = backupPath(from, now, occupied);
    taken.add(to);
    renames.push({ from, to });
  }
  return renames;
}

/* ------------------------------------------ akış ------------------------------------------ */

export interface MasterKeyPorts {
  keyFile: string;
  secretsFile: string;
  /** Duman testi (CI): iletişim kutusu GÖSTERİLMEZ, dosyalara dokunulmaz, geçici anahtar kullanılır. */
  smoke: boolean;
  exists(p: string): boolean;
  readFile(p: string): Buffer;
  /** Anahtar dosyasını 0600 izniyle yazar. */
  writeKeyFile(p: string, data: Buffer): void;
  rename(from: string, to: string): void;
  decrypt(data: Buffer): string;
  encrypt(plain: string): Buffer;
  randomKey(): string;
  /** Engelleyici iletişim kutusu; seçilen düğmenin dizinini döndürür. */
  showDialog(spec: RecoveryDialogSpec): number;
  /** Dosyayı Finder/Gezgin'de gösterir. */
  reveal(p: string): void;
  log(message: string): void;
  now(): number;
}

export type MasterKeyResult =
  | { kind: "key"; key: string; created: boolean; backups: Rename[] }
  | { kind: "ephemeral"; key: string }
  | { kind: "quit" };

function createKey(ports: MasterKeyPorts): string {
  const key = ports.randomKey();
  if (!isValidMasterKey(key)) throw new Error("Üretilen ana anahtar geçersiz.");
  ports.writeKeyFile(ports.keyFile, ports.encrypt(key));
  return key;
}

/**
 * Ana anahtarı yükler. Dosya yoksa (ilk açılış) yeni anahtar üretir. Dosya var ama çözülemiyorsa ASLA sessizce yeni
 * anahtar üretmez: kullanıcı kapatmayı, yeniden denemeyi veya iki aşamalı onayla sıfırlamayı seçer.
 */
export function loadOrRecoverMasterKey(ports: MasterKeyPorts): MasterKeyResult {
  if (!ports.exists(ports.keyFile)) {
    return { kind: "key", key: createKey(ports), created: true, backups: [] };
  }

  for (let round = 0; round < MAX_RECOVERY_ROUNDS; round++) {
    const attempt = tryDecryptMasterKey(
      () => ports.readFile(ports.keyFile),
      (d) => ports.decrypt(d),
    );
    if (attempt.ok) return { kind: "key", key: attempt.key, created: false, backups: [] };

    ports.log(`Ana anahtar çözülemedi (${attempt.error}).`);
    if (ports.smoke) {
      // Duman testi: kalıcı dosyalara dokunmadan geçici anahtar.
      ports.log("UYARI: duman testi için geçici anahtar kullanılıyor; dosyalar değiştirilmedi.");
      return { kind: "ephemeral", key: ports.randomKey() };
    }

    const ctx = { keyFile: ports.keyFile, secretsFile: ports.secretsFile, error: attempt.error };
    let stage: RecoveryStage = "explain";
    let decided: "retry" | "quit" | "reset" | null = null;
    for (let i = 0; i < MAX_RECOVERY_ROUNDS && decided === null; i++) {
      const step = nextRecoveryStep(stage, ports.showDialog(recoveryDialog(stage, ctx)));
      if (step.kind === "dialog") stage = step.stage;
      else if (step.kind === "reveal") {
        ports.reveal(ports.keyFile);
        stage = step.then;
      } else decided = step.kind;
    }

    if (decided === "retry") {
      ports.log("Kullanıcı ana anahtarı yeniden denemeyi seçti.");
      continue;
    }
    if (decided === "reset") {
      const backups = planSecretsReset(
        { keyFile: ports.keyFile, secretsFile: ports.secretsFile },
        ports.now(),
        (p) => ports.exists(p),
      );
      for (const r of backups) ports.rename(r.from, r.to);
      const key = createKey(ports);
      ports.log(
        `Kullanıcı onayıyla gizli bilgiler sıfırlandı; yedekler: ${backups.map((b) => b.to).join(", ") || "yok"}.`,
      );
      return { kind: "key", key, created: true, backups };
    }
    ports.log("Kullanıcı uygulamayı kapatmayı seçti; hiçbir dosya değiştirilmedi.");
    return { kind: "quit" };
  }
  ports.log("Ana anahtar kurtarma döngüsü sınırı aşıldı; uygulama kapatılıyor.");
  return { kind: "quit" };
}

/** Kullanıcı kapatmayı seçtiğinde başlatmayı hata iletişim kutusu GÖSTERMEDEN durdurmak için. */
export class MasterKeyQuit extends Error {
  constructor() {
    super("Ana anahtar açılamadı; kullanıcı uygulamayı kapatmayı seçti.");
    this.name = "MasterKeyQuit";
  }
}
