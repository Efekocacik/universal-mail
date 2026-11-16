"use client";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { BackupListCard } from "@/features/backup/backup-list-card";
import { useBackups } from "@/features/backup/data";
import { PendingBanner, ResultBanner } from "@/features/backup/lifecycle-banner";
import { PassphraseCard } from "@/features/backup/passphrase-card";
import { RetentionCard } from "@/features/backup/retention-card";
import { ScheduleCard } from "@/features/backup/schedule-card";
import { WipeCard } from "@/features/backup/wipe-card";
import { FieldError, Section } from "@/features/settings/shared";
import { t } from "@/lib/i18n";

/**
 * Faz 6 (paket Y.8): Ayarlar → "Yedekler" bölümü. `settings-page.tsx` bu bileşeni `#backup` bağlantısının altında
 * gösterir (o dosya dondurulmuştur). Sıra: bekleyen işlem / son sonuç bandı → yedek parolası → otomatik yedek ve klasör
 * → yedek listesi ve geri yükleme → saklama süresi → tüm verilerimi sil.
 */
export function BackupSection() {
  const q = useBackups();
  return (
    <Section title={t("backup.title")} description={t("backup.desc")}>
      {q.isLoading ? (
        <Skeleton className="h-64" />
      ) : !q.data ? (
        <div className="flex flex-wrap items-center gap-3">
          <FieldError>{t("backup.loadError")}</FieldError>
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
            {t("backup.retry")}
          </Button>
        </div>
      ) : (
        <>
          {q.data.pending && <PendingBanner pending={q.data.pending} />}
          {q.data.lastResult && <ResultBanner result={q.data.lastResult} />}
          <PassphraseCard isSet={q.data.passphraseSet} />
          <ScheduleCard data={q.data} />
          <BackupListCard data={q.data} />
          <RetentionCard />
          <WipeCard blocked={q.data.pending !== null} />
        </>
      )}
    </Section>
  );
}
