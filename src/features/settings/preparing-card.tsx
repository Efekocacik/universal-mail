import { Hourglass } from "lucide-react";
import { EmptyState } from "@/components/ui/page";
import { t } from "@/lib/i18n";
import { Section } from "./shared";

/**
 * Faz 5 P0 yer tutucusu: paketi henüz teslim edilmemiş bir ayar kartı. Başlık ve açıklama paketin kendi sözlük
 * parçasından gelir; gövde ortak "hazırlanıyor" metnidir. Paket kendi kartını yazınca bunu kullanmayı bırakır.
 */
export function PreparingCard({ title, description }: { title: string; description: string }) {
  return (
    <Section title={title} description={description}>
      <EmptyState
        compact
        icon={Hourglass}
        title={t("faz5.preparing.title")}
        body={t("faz5.preparing.body")}
      />
    </Section>
  );
}
