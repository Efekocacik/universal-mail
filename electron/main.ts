import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { fork, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { SESSION_CACHE_FILENAME } from "../src/lib/config/paths";
import { wipeSessionCacheFiles } from "../src/lib/config/session-cache";

/**
 * Universal Mail masaüstü kabuğu.
 *
 * Sorumluluklar:
 *  - Kullanıcı veri klasörünü ve ana anahtarı (işletim sistemi anahtarlığıyla korunan) hazırlamak,
 *  - şema geçişlerini çalıştırmak, ardından yerel web sunucusunu (127.0.0.1) ve arka plan işçisini başlatmak,
 *  - arayüzü güvenli bir pencerede göstermek ve kapanışta işçiyi güvenle durdurmak.
 * Hiçbir veri geliştiriciye gönderilmez; dış ağ trafiği yalnızca uygulamanın kendi API çağrılarıdır.
 */

const SMOKE = process.env.UM_SMOKE_TEST === "1";
const DEV_URL = process.env.UM_DEV_URL; // geliştirme: `npm run dev` sunucusuna bağlan
const children = new Map<string, ChildProcess>();
let quitting = false;
let origin = "";
let mainWindow: BrowserWindow | null = null;

app.setName("Universal Mail");
if (process.env.UM_USER_DATA_DIR) app.setPath("userData", process.env.UM_USER_DATA_DIR);

/* ------------------------------ günlük kaydı ------------------------------ */

let logDir = "";
function log(scope: string, message: string): void {
  const line = `${new Date().toISOString()} [${scope}] ${message.replace(/\s+$/, "")}`;
  console.log(line);
  try {
    if (logDir) fs.appendFileSync(path.join(logDir, "app.log"), `${line}\n`);
  } catch {
    /* günlük yazılamıyorsa uygulama etkilenmesin */
  }
}

function rotateLogs(): void {
  for (const f of ["app.log"]) {
    const p = path.join(logDir, f);
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 5_000_000) fs.renameSync(p, `${p}.1`);
    } catch {
      /* yoksay */
    }
  }
}

/* --------------------------------- yollar --------------------------------- */

function serverDir(): string {
  if (process.env.UM_SERVER_DIR) return process.env.UM_SERVER_DIR;
  return app.isPackaged
    ? path.join(process.resourcesPath, "server")
    : path.join(app.getAppPath(), ".next", "standalone");
}

function dataDir(): string {
  const dir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ------------------------------- ana anahtar ------------------------------- */

/**
 * Gizli depo (API anahtarları) için ana anahtar. Rastgele üretilir, işletim sistemi anahtarlığıyla
 * (macOS Keychain / Windows DPAPI) şifrelenip diske yazılır. Anahtar çözülemezse eski gizli depo kullanılamaz
 * hale gelir; yeni anahtar üretilir ve kullanıcıdan API anahtarlarını yeniden girmesi beklenir.
 */
function loadMasterKey(): string {
  try {
    return loadMasterKeyUnsafe();
  } catch (e) {
    if (!SMOKE) throw e;
    // Duman testi (CI): anahtarlık erişilemezse geçici, kalıcı olmayan anahtarla devam et.
    log(
      "main",
      `UYARI: güvenli depolama hatası (${(e as Error).message}); geçici anahtar kullanılıyor.`,
    );
    return crypto.randomBytes(32).toString("hex");
  }
}

function loadMasterKeyUnsafe(): string {
  if (!safeStorage.isEncryptionAvailable()) {
    if (SMOKE) {
      log("main", "UYARI: güvenli depolama yok; duman testi için geçici anahtar kullanılıyor.");
      return crypto.randomBytes(32).toString("hex");
    }
    dialog.showErrorBox(
      "Güvenli depolama kullanılamıyor",
      "İşletim sisteminin anahtar deposu (Anahtarlık / Kimlik Bilgisi Yöneticisi) bu oturumda kullanılamıyor. API anahtarlarınız güvenli saklanamayacağı için uygulama kapatılıyor.",
    );
    app.exit(1);
    return "";
  }
  const file = path.join(app.getPath("userData"), "master.key.enc");
  if (fs.existsSync(file)) {
    try {
      const key = safeStorage.decryptString(fs.readFileSync(file));
      if (/^[0-9a-f]{64}$/i.test(key)) return key;
      throw new Error("beklenmeyen biçim");
    } catch (e) {
      log(
        "main",
        `Ana anahtar çözülemedi (${(e as Error).message}); yenisi üretiliyor, eski gizli depo yedeğe alınıyor.`,
      );
      fs.renameSync(file, `${file}.bak-${Date.now()}`);
      const secrets = path.join(dataDir(), "secrets.json");
      if (fs.existsSync(secrets)) fs.renameSync(secrets, `${secrets}.bak-${Date.now()}`);
    }
  }
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 });
  return key;
}

/* ------------------------------ alt süreçler ------------------------------ */

function childEnv(port: number, masterKey: string): NodeJS.ProcessEnv {
  const dir = serverDir();
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    UM_DATA_DIR: dataDir(),
    UM_MASTER_KEY: masterKey,
    UM_REQUIRE_MASTER_KEY: "1",
    UM_MIGRATIONS_DIR: path.join(dir, "drizzle"),
    UM_STATIC_DATA_DIR: path.join(dir, "data"),
  };
}

function spawnChild(name: string, script: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = fork(path.join(serverDir(), script), [], {
    cwd: serverDir(),
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.on("data", (d: Buffer) => log(name, d.toString()));
  child.stderr?.on("data", (d: Buffer) => log(`${name}:err`, d.toString()));
  children.set(name, child);
  child.on("exit", (code, signal) => {
    log("main", `${name} çıktı (kod=${code}, sinyal=${signal})`);
    children.delete(name);
  });
  return child;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
    if (!children.has("server")) throw new Error("Web sunucusu beklenmedik şekilde kapandı.");
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Web sunucusu zamanında hazır olmadı (${lastError}).`);
}

let workerRestarts = 0;
function startWorker(env: NodeJS.ProcessEnv): void {
  const w = spawnChild("worker", "worker.cjs", env);
  w.on("exit", (code) => {
    if (quitting) return;
    if (workerRestarts >= 5) {
      log("main", "İşçi çok kez çöktü; yeniden başlatılmıyor.");
      return;
    }
    workerRestarts++;
    const delay = 1500 * workerRestarts;
    log("main", `İşçi ${delay} ms sonra yeniden başlatılacak (kod=${code}).`);
    setTimeout(() => !quitting && startWorker(env), delay);
  });
}

async function startBackend(): Promise<string> {
  if (DEV_URL) return DEV_URL;
  const masterKey = loadMasterKey();
  const port = await freePort();
  const env = childEnv(port, masterKey);

  // 1) şema geçişi (öncesinde otomatik yedek alınır)
  // Önceki oturumdan kalan Google önbelleği (çökme/zorla kapanma olasılığına karşı) açılışta da silinir.
  const migrate = spawnChild("migrate", "migrate.cjs", { ...env, UM_WIPE_SESSION: "1" });
  const code = await waitForExit(migrate, 120_000);
  if (code !== 0)
    throw new Error(`Veritabanı hazırlanamadı (kod=${code}). Ayrıntı için günlük dosyasına bakın.`);

  // 2) web sunucusu
  spawnChild("server", "server.js", env);
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url);

  // 3) arka plan işçisi
  startWorker(env);
  return url;
}

/* --------------------------------- pencere --------------------------------- */

function isLocal(url: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    show: !SMOKE,
    title: "Universal Mail",
    backgroundColor: "#f6f6f3",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target) && !isLocal(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, target) => {
    if (!isLocal(target)) {
      e.preventDefault();
      if (/^https?:/i.test(target)) void shell.openExternal(target);
    }
  });
  void win.loadURL(url);

  // Süren bir tarama varken kapatma: kullanıcıya bilgi ver.
  win.on("close", (e) => {
    if (quitting || SMOKE) return;
    e.preventDefault();
    void confirmQuit(win);
  });
  return win;
}

async function confirmQuit(win: BrowserWindow): Promise<void> {
  let running = false;
  try {
    const res = await fetch(`${origin}/api/status`);
    const status = (await res.json()) as { scans?: { status: string }[] };
    running = !!status.scans?.some((s) => s.status === "running" || s.status === "queued");
  } catch {
    /* durum alınamazsa sormadan kapat */
  }
  if (running) {
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Kapat ve duraklat", "Vazgeç"],
      defaultId: 1,
      cancelId: 1,
      title: "Tarama sürüyor",
      message: "Bir tarama sürüyor.",
      detail:
        "Uygulamayı kapatırsanız tarama duraklatılır. Uygulamayı açtığınızda kaldığı yerden devam ettirebilirsiniz; ücretli çağrılar siz onaylamadan sürmez.",
    });
    if (response !== 0) return;
  }
  app.quit();
}

function buildMenu(): void {
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    { role: "editMenu" },
    {
      label: "Görünüm",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...((!app.isPackaged ? [{ role: "toggleDevTools" }] : []) as MenuItemConstructorOptions[]),
      ],
    },
    { role: "windowMenu" },
    {
      label: "Yardım",
      submenu: [
        { label: "Veri klasörünü aç", click: () => void shell.openPath(dataDir()) },
        { label: "Günlük klasörünü aç", click: () => void shell.openPath(logDir) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------ duman testi ------------------------------ */

async function smokeTest(): Promise<void> {
  const result: Record<string, unknown> = { ok: false };
  try {
    const get = async (p: string, init?: RequestInit) => {
      const res = await fetch(`${origin}${p}`, { redirect: "manual", ...init });
      const text = await res.text();
      return {
        status: res.status,
        location: res.headers.get("location"),
        body: text.slice(0, 400),
      };
    };
    const health = await get("/api/health");
    const status = await get("/api/status");
    const categories = await get("/api/categories");
    const cities = await get("/api/cities?q=Londra&limit=1");
    const home = await get("/");
    // fetch (undici) Host başlığını değiştirmeye izin vermez; ham http isteğiyle yabancı Host denenir.
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const url = new URL(origin);
      const r = http.request(
        {
          host: url.hostname,
          port: url.port,
          path: "/api/health",
          headers: { Host: "evil.example.com" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      r.on("error", reject);
      r.end();
    });
    const catCount = (
      JSON.parse(categories.body.length < 400 ? categories.body : "{}") as {
        categories?: unknown[];
      }
    ).categories?.length;
    const workerAlive =
      children.get("worker")?.exitCode === null && children.get("worker")?.connected === true;
    // İşçinin veritabanına bağlandığını doğrulamak için kısa bekle
    await new Promise((r) => setTimeout(r, 1500));
    Object.assign(result, {
      health: health.status,
      status: status.status,
      categoriesStatus: categories.status,
      citiesStatus: cities.status,
      citiesBody: cities.body.slice(0, 80),
      homeStatus: home.status,
      homeRedirect: home.location,
      foreignHost,
      workerAlive: workerAlive && children.get("worker")?.exitCode === null,
      serverAlive: children.get("server")?.exitCode === null,
      catCount,
    });
    result.ok =
      health.status === 200 &&
      status.status === 200 &&
      categories.status === 200 &&
      cities.status === 200 &&
      home.status === 307 &&
      home.location?.endsWith("/setup") === true &&
      foreignHost === 403 &&
      result.workerAlive === true;
  } catch (e) {
    result.error = (e as Error).message;
  }
  console.log(`UM_SMOKE_RESULT ${JSON.stringify(result)}`);
  await shutdown();
  app.exit(result.ok ? 0 : 1);
}

/* ------------------------------- yaşam döngüsü ------------------------------- */

async function shutdown(): Promise<void> {
  quitting = true;
  const worker = children.get("worker");
  if (worker && worker.connected) worker.send("shutdown");
  if (worker) {
    const code = await waitForExit(worker, 25_000);
    if (code === null) worker.kill("SIGKILL");
  }
  children.get("server")?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  for (const c of children.values()) c.kill("SIGKILL");
  // Google verisi kalıcı saklanmaz: süreçler durduktan sonra oturum önbelleği silinir (Windows'ta dosya kilidi için bir kez daha denenir).
  if (!DEV_URL) {
    const cacheFile = path.join(dataDir(), SESSION_CACHE_FILENAME);
    wipeSessionCacheFiles(cacheFile);
    await new Promise((r) => setTimeout(r, 300));
    wipeSessionCacheFiles(cacheFile);
  }
}

if (!app.requestSingleInstanceLock() && !SMOKE) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    rotateLogs();
    log(
      "main",
      `Universal Mail ${app.getVersion()} başlıyor (${process.platform}/${process.arch}, paketli=${app.isPackaged})`,
    );

    session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    ipcMain.handle("um:open-data-folder", () => shell.openPath(dataDir()));
    buildMenu();

    try {
      origin = new URL(await startBackend()).origin;
    } catch (e) {
      log("main", `Başlatma hatası: ${(e as Error).message}`);
      if (SMOKE) {
        console.log(
          `UM_SMOKE_RESULT ${JSON.stringify({ ok: false, error: (e as Error).message })}`,
        );
        await shutdown();
        app.exit(1);
        return;
      }
      dialog.showErrorBox(
        "Universal Mail başlatılamadı",
        `${(e as Error).message}\n\nGünlük klasörü: ${logDir}`,
      );
      await shutdown();
      app.exit(1);
      return;
    }

    mainWindow = createWindow(origin);
    if (SMOKE) void smokeTest();
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    void shutdown().then(() => app.exit(0));
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && origin) mainWindow = createWindow(origin);
  });
}
