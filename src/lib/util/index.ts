import { createHash, randomUUID } from "node:crypto";

export const nowMs = (): number => Date.now();

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

export function uuid(): string {
  return randomUUID();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

/** "2026-10" biçiminde UTC ay anahtarı. */
export function monthKey(ms: number = nowMs()): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** "2026-10-18" biçiminde UTC gün anahtarı. */
export function dayKey(ms: number = nowMs()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Anahtar sırasından bağımsız, kararlı JSON (karma/imza üretimi için). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
