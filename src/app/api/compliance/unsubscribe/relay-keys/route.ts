import { database, HttpError, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { getSetting } from "@/lib/settings";
import { channelPrivateKeyMissing, exportChannelPublicKeys } from "@/lib/unsubscribe/channel";
import { exportRelayKeySet, signingPrivateKeyMissing } from "@/lib/unsubscribe/keys";
import { withUnsubscribeLock } from "../shared";

export const dynamic = "force-dynamic";

/**
 * Aktarıcı anahtar dosyası (`relay-keys.json`): YALNIZCA GENEL anahtarlar (imza + kanal) ve temel adresin kökü.
 * Özel anahtar veya gizli bilgi içermez; yine de yalnızca SSH (scp) ile sunucuya kopyalanmalıdır: kanal anahtarlarını
 * değiştirebilen biri olayları çekip onaylayabilir (silebilir). Etkin imza anahtarı, etkin kanal anahtarı veya temel
 * adres yoksa 409; etkin anahtarlardan birinin özel anahtarı okunamıyorsa 409 `KEY_UNREADABLE`.
 */
export const GET = domainRoute(async () => {
  const db = await database();
  return withUnsubscribeLock(async () => {
    const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
    const signing = await getSetting(db, "mail.unsubscribeKeys");
    const channel = await getSetting(db, "mail.unsubscribeChannel");
    const hasSigning = signing.keys.some((k) => k.kid === signing.current && k.revokedAt === null);
    const hasChannel = channel.keys.some((k) => k.kid === channel.current && k.revokedAt === null);
    if (!cfg.baseUrl || !hasSigning || !hasChannel) {
      throw new HttpError(
        409,
        "Anahtar dosyası için önce imza anahtarı, kanal anahtarı ve çıkış adresi tanımlanmalıdır.",
        { code: "NOT_CONFIGURED" },
      );
    }
    // Özel anahtarı okunamayan (gizli bilgiler sıfırlanmış) bir anahtarın dosyası işe yaramaz: önce yeni anahtara geçilir.
    if ((await signingPrivateKeyMissing(db)) || (await channelPrivateKeyMissing(db))) {
      throw new HttpError(
        409,
        "Etkin imza veya kanal anahtarının özel anahtarı okunamıyor (gizli bilgiler sıfırlanmış olabilir). İlgili anahtarda “Yeni anahtara geç”i seçin, sonra dosyayı indirin.",
        { code: "KEY_UNREADABLE" },
      );
    }
    const file = {
      v: 1 as const,
      origin: new URL(cfg.baseUrl).origin,
      tokenKeys: (await exportRelayKeySet(db)).keys,
      channelKeys: await exportChannelPublicKeys(db),
      generatedAt: Date.now(),
    };
    return json(file, {
      headers: { "Content-Disposition": 'attachment; filename="relay-keys.json"' },
    });
  });
});
