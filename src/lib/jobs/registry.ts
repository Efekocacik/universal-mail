import type { Db } from "@/lib/db/client";
import type { JobRow } from "./queue";

/**
 * İş işleyicisi kayıt defteri. Yeni bir arka plan işi (ör. Faz 2 `enrich.website`, Faz 3 `mail.send`)
 * yalnızca bir işleyici kaydederek eklenir; işçi döngüsü değiştirilmez.
 */
export interface JobContext<P = unknown> {
  job: JobRow;
  payload: P;
  db: Db;
  /** İşçi kapanırken `true` olur; uzun işler sık sık kontrol edip güvenle durmalıdır. */
  shouldStop: () => boolean;
  log: (message: string) => void;
}

export type JobHandler<P = unknown> = (ctx: JobContext<P>) => Promise<void>;

const handlers = new Map<string, JobHandler<never>>();

export function registerJobHandler<P>(type: string, handler: JobHandler<P>): void {
  handlers.set(type, handler as JobHandler<never>);
}

export function getJobHandler(type: string): JobHandler<unknown> | undefined {
  return handlers.get(type) as JobHandler<unknown> | undefined;
}

export function clearJobHandlers(): void {
  handlers.clear();
}

export class NonRetryableJobError extends Error {}
