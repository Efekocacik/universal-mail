import { randomBytes } from "node:crypto";
import {
  isNativeConfirmResponse,
  NATIVE_CONFIRM_CANCEL,
  NATIVE_CONFIRM_MAX_TTL_MS,
  NATIVE_CONFIRM_REQUEST,
  summaryHash,
  type CountryActivationSummary,
  type NativeConfirmKind,
} from "./native-confirm-protocol";

/**
 * Sunucu tarafı: Electron ana sürecinden YEREL ONAY ister (özel IPC kanalı; protokol `native-confirm-protocol.ts`).
 *
 * - Kanal yoksa (tarayıcıda geliştirme, betik, test) `NativeConfirmUnavailableError` fırlatır: onay gerektiren işlem
 *   REDDEDİLİR. Paketli uygulamada metin tabanlı yedek yoktur.
 * - Aynı anda tek bekleyen istek olabilir (ikincisi reddedilir).
 * - Onay yalnızca: yanıt kimliği ve özet özeti isteğimizle birebir aynıysa VE `approved === true` ise kabul edilir;
 *   yanıt tek kullanımlıktır (ilkinden sonra dinleyici kaldırılır, sonraki yanıtlar yok sayılır).
 * - Süre dolarsa ana sürece iptal gönderilir ve `timeout` döner.
 */

export class NativeConfirmUnavailableError extends Error {
  constructor(readonly why: "no_channel" | "busy") {
    super(
      why === "busy"
        ? "Başka bir yerel onay bekleniyor."
        : "Yerel onay kanalı yok (yalnızca paketli masaüstü uygulamasında kullanılabilir).",
    );
    this.name = "NativeConfirmUnavailableError";
  }
}

export type NativeConfirmOutcome = "approved" | "declined" | "timeout";

/** `process` (veya test için sahte) kanal arayüzü. */
export interface IpcChannel {
  connected?: boolean;
  send?: (message: unknown) => unknown;
  on(event: "message" | "disconnect", listener: (...args: never[]) => void): unknown;
  removeListener(event: "message" | "disconnect", listener: (...args: never[]) => void): unknown;
}

let pendingId: string | null = null;

export async function requestNativeConfirm(
  input: { kind: NativeConfirmKind; summary: CountryActivationSummary },
  opts: { ttlMs?: number; channel?: IpcChannel; newId?: () => string } = {},
): Promise<NativeConfirmOutcome> {
  const channel = opts.channel ?? (process as unknown as IpcChannel);
  if (typeof channel.send !== "function" || channel.connected === false) {
    throw new NativeConfirmUnavailableError("no_channel");
  }
  if (pendingId !== null) throw new NativeConfirmUnavailableError("busy");
  const id = (opts.newId ?? (() => randomBytes(16).toString("hex")))();
  const ttlMs = Math.max(
    1000,
    Math.min(opts.ttlMs ?? NATIVE_CONFIRM_MAX_TTL_MS, NATIVE_CONFIRM_MAX_TTL_MS),
  );
  const hash = summaryHash(input.summary);
  pendingId = id;

  return new Promise<NativeConfirmOutcome>((resolve) => {
    let done = false;
    const finish = (r: NativeConfirmOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel.removeListener("message", onMessage);
      channel.removeListener("disconnect", onDisconnect);
      pendingId = null;
      resolve(r);
    };
    const onMessage = (m: unknown) => {
      if (!isNativeConfirmResponse(m) || m.id !== id) return; // başka isteğe ait veya geçersiz: yok sayılır
      finish(m.approved === true && m.summaryHash === hash ? "approved" : "declined");
    };
    const onDisconnect = () => finish("declined");
    // Ana süreç kendi süresini (ttl) uygular; yanıtını almak için kısa bir pay bırakılır.
    const timer = setTimeout(() => {
      try {
        channel.send?.({ type: NATIVE_CONFIRM_CANCEL, id });
      } catch {
        /* kanal kapanmış olabilir */
      }
      finish("timeout");
    }, ttlMs + 5000);
    channel.on("message", onMessage as (...args: never[]) => void);
    channel.on("disconnect", onDisconnect as (...args: never[]) => void);
    try {
      channel.send?.({
        type: NATIVE_CONFIRM_REQUEST,
        id,
        kind: input.kind,
        summary: input.summary,
        summaryHash: hash,
        ttlMs,
      });
    } catch {
      finish("declined");
    }
  });
}

/** Testler için: bekleyen istek kaydını sıfırlar. */
export function resetNativeConfirmForTests(): void {
  pendingId = null;
}
