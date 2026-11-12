import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { previewSteps, stepLabel } from "@/features/campaigns/preflight-model";
import {
  isReviewHold,
  reevaluateView,
  shouldCountExcluded,
} from "@/features/campaigns/queue-model";
import {
  clearDraft,
  clearDraftPart,
  DRAFT_MAX_AGE_MS,
  draftKey,
  readDraft,
  writeDraftPart,
  type DraftStore,
} from "@/features/campaigns/wizard-draft";
import {
  GUARD_BACK_STEPS,
  guardState,
  HISTORY_GUARD,
  isGuardState,
  mailboxCapHint,
  prefillFollowups,
  type BasicsValues,
} from "@/features/campaigns/wizard-dirty";
import { EMPTY_DRAFT, subjectHintKey, toDraft } from "@/features/templates/model";
import type { PreflightPreview } from "@/lib/client/campaigns";
import { en } from "@/lib/i18n/en";
import { tr } from "@/lib/i18n/tr";

/**
 * Faz 4 / E — arayüzün saf mantığı (DOM'suz): sihirbaz yerel taslağı, geri tuşu koruması, posta kutusu tavanı
 * ipucu, takip şablonu ön seçimi, kuyruk "yeniden denetle" görünümü, başlatma özeti adımları ve şablon konu ipucu.
 */

function memoryStore(): DraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const BASICS: BasicsValues = {
  name: "Londra kafeleri",
  mailboxId: 1,
  dailyCap: 20,
  minGapS: 90,
  maxGapS: 300,
  sendWindow: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
};
const STEPS = [{ stepIndex: 0, language: "en", templateId: 3, delayDays: 0 }];
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);

describe("sihirbaz yerel taslağı", () => {
  it("bölümler ayrı yazılır, aynı sürümde birleşir ve geri okunur", () => {
    const s = memoryStore();
    const key = draftKey(7);
    expect(key).toBe("um.wizardDraft.7");
    expect(draftKey(undefined)).toBe("um.wizardDraft.new");
    expect(writeDraftPart(s, key, "basics", BASICS, 100, NOW)).toBe(true);
    expect(writeDraftPart(s, key, "steps", STEPS, 100, NOW + 1)).toBe(true);
    expect(readDraft(s, key, 100, NOW + 2)).toMatchObject({
      against: 100,
      savedAt: NOW + 1,
      basics: BASICS,
      steps: STEPS,
    });
  });

  it("kampanya değiştiyse, süresi geçtiyse veya bozuksa önerilmez ve silinir", () => {
    const s = memoryStore();
    const key = draftKey(7);
    writeDraftPart(s, key, "basics", BASICS, 100, NOW);
    expect(readDraft(s, key, 101, NOW)).toBeNull();
    expect(s.map.has(key)).toBe(false);

    writeDraftPart(s, key, "basics", BASICS, 100, NOW);
    expect(readDraft(s, key, 100, NOW + DRAFT_MAX_AGE_MS + 1)).toBeNull();

    s.setItem(key, "{bozuk");
    expect(readDraft(s, key, 100, NOW)).toBeNull();
    s.setItem(key, JSON.stringify({ v: 1, against: 100, savedAt: NOW, basics: { name: 5 } }));
    expect(readDraft(s, key, 100, NOW)).toBeNull();
    s.setItem(key, JSON.stringify({ v: 1, against: 100, savedAt: NOW }));
    expect(readDraft(s, key, 100, NOW)).toBeNull();
    expect(readDraft(s, "um.wizardDraft.yok", 100, NOW)).toBeNull();
  });

  it("farklı sürüme yazılan bölüm eski taslağı devralmaz", () => {
    const s = memoryStore();
    const key = draftKey(undefined);
    writeDraftPart(s, key, "basics", BASICS, null, NOW);
    writeDraftPart(s, key, "steps", STEPS, 5, NOW + 1);
    const d = readDraft(s, key, 5, NOW + 2)!;
    expect(d.basics).toBeUndefined();
    expect(d.steps).toEqual(STEPS);
  });

  it("bölüm temizlenince boş taslak silinir; depo yoksa veya hata verirse sessiz kalır", () => {
    const s = memoryStore();
    const key = draftKey(1);
    writeDraftPart(s, key, "basics", BASICS, 1, NOW);
    writeDraftPart(s, key, "steps", STEPS, 1, NOW);
    clearDraftPart(s, key, "basics");
    expect(readDraft(s, key, 1, NOW)!.basics).toBeUndefined();
    clearDraftPart(s, key, "steps");
    expect(s.map.has(key)).toBe(false);
    writeDraftPart(s, key, "steps", STEPS, 1, NOW);
    clearDraft(s, key);
    expect(s.map.size).toBe(0);

    expect(writeDraftPart(null, key, "steps", STEPS, 1, NOW)).toBe(false);
    expect(readDraft(null, key, 1, NOW)).toBeNull();
    const broken: DraftStore = {
      getItem: () => {
        throw new Error("kapalı");
      },
      setItem: () => {
        throw new Error("kapalı");
      },
      removeItem: () => {
        throw new Error("kapalı");
      },
    };
    expect(readDraft(broken, key, 1, NOW)).toBeNull();
    expect(writeDraftPart(broken, key, "steps", STEPS, 1, NOW)).toBe(false);
    expect(() => clearDraftPart(broken, key, "steps")).not.toThrow();
    expect(() => clearDraft(broken, key)).not.toThrow();
    clearDraftPart(null, key, "steps");
    clearDraft(null, key);
  });
});

describe("geri tuşu koruması", () => {
  it("nöbetçi durum mevcut geçmiş alanlarını korur", () => {
    const st = guardState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: 1 });
    expect(st).toMatchObject({ __NA: true, [HISTORY_GUARD]: true });
    expect(isGuardState(st)).toBe(true);
    expect(isGuardState(guardState(null))).toBe(true);
    expect(isGuardState({ __NA: true })).toBe(false);
    expect(isGuardState(null)).toBe(false);
    expect(GUARD_BACK_STEPS).toBe(-2);
  });
});

describe("posta kutusu tavanı ipucu", () => {
  it("profil üst sınırı, bugünkü ısınma tavanı veya hiçbiri", () => {
    const gmail = { limits: { todayCap: 10, profileMaxDaily: 50 } };
    expect(mailboxCapHint(60, gmail)).toEqual({ kind: "max", n: 50 });
    expect(mailboxCapHint(20, gmail)).toEqual({ kind: "today", n: 10 });
    expect(mailboxCapHint(10, gmail)).toBeNull();
    expect(mailboxCapHint(20, undefined)).toBeNull();
    expect(mailboxCapHint(Number.NaN, gmail)).toBeNull();
    expect(mailboxCapHint(30, { limits: { todayCap: 20 } })).toEqual({ kind: "today", n: 20 });
  });
});

describe("takip şablonu ön seçimi", () => {
  const templates = [
    { id: 30, language: "en", name: "My own", builtIn: false },
    { id: 12, language: "en", name: "Follow-up 2 – final note (EN)", builtIn: true },
    { id: 11, language: "en", name: "Follow-up 1 – short reminder (EN)", builtIn: true },
    { id: 21, language: "tr", name: "Takip 1 – kısa hatırlatma (TR)", builtIn: true },
  ];

  it("yerleşikler sırayla önerilir; kullanıcı seçimi korunur; şablon yoksa dil atlanır", () => {
    expect(prefillFollowups({}, templates, ["en", "tr", "de"], 2)).toEqual({
      en: [11, 12],
      tr: [21, 21],
    });
    expect(prefillFollowups({ en: [30] }, templates, ["en"], 2)).toEqual({ en: [30, 12] });
    const current = { en: [11] };
    prefillFollowups(current, templates, ["en"], 2);
    expect(current).toEqual({ en: [11] });
  });
});

describe("kuyruk görünümü", () => {
  it("yeniden denetleme: taslak/hazırda düğme, çalışırken/duraklatılmışta açıklama", () => {
    expect(reevaluateView("draft", 2)).toBe("button");
    expect(reevaluateView("ready", 1)).toBe("button");
    expect(reevaluateView("running", 3)).toBe("closed");
    expect(reevaluateView("paused", 3)).toBe("closed");
    expect(reevaluateView("completed", 3)).toBeNull();
    expect(reevaluateView("running", 0)).toBeNull();
    expect(reevaluateView(undefined, 4)).toBeNull();
    expect(shouldCountExcluded("paused")).toBe(true);
    expect(shouldCountExcluded("cancelled")).toBe(false);
    expect(shouldCountExcluded(undefined)).toBe(false);
  });

  it("incelemede bekleyen yanıt nedeni tanınır", () => {
    expect(isReviewHold("inbound_review_pending")).toBe(true);
    expect(isReviewHold("followup_too_soon,inbound_review_pending")).toBe(true);
    expect(isReviewHold("followup_too_soon")).toBe(false);
    expect(isReviewHold(null)).toBe(false);
  });
});

describe("başlatma özeti adımları", () => {
  const base: PreflightPreview = {
    leadId: 1,
    name: "Kafe",
    language: "en",
    sendable: true,
    subject: "Hello",
    html: "<p>x</p>",
    text: "x",
    missing: [],
    warnings: [],
    reasons: [],
  } as unknown as PreflightPreview;

  it("adımlar yoksa ilk adım üst düzey alanlardan kurulur; varsa sıralanır", () => {
    expect(previewSteps(base)).toEqual([
      {
        stepIndex: 0,
        delayDays: 0,
        subject: "Hello",
        text: "x",
        html: "<p>x</p>",
        missing: [],
        warnings: [],
        errors: [],
      },
    ]);
    const s = (i: number) => ({ ...previewSteps(base)[0]!, stepIndex: i, delayDays: i * 5 });
    expect(previewSteps({ ...base, steps: [s(1), s(0)] }).map((x) => x.stepIndex)).toEqual([0, 1]);
  });

  it("adım etiketleri", () => {
    expect(stepLabel({ stepIndex: 0, delayDays: 0 })).toBe(tr["preflight.step.initial"]);
    expect(stepLabel({ stepIndex: 2, delayDays: 7 })).toBe("3. adım · +7 gün");
  });
});

describe("şablon düzenleyici: konu devamı", () => {
  it("varsayılan açık; yalnızca takip şablonunda ipucu gösterilir", () => {
    expect(EMPTY_DRAFT.followupReuseSubject).toBe(true);
    expect(subjectHintKey({ kind: "followup", followupReuseSubject: true })).toBe(
      "tplEditor.subject.reuseHint",
    );
    expect(subjectHintKey({ kind: "followup", followupReuseSubject: false })).toBeNull();
    expect(subjectHintKey({ kind: "initial", followupReuseSubject: true })).toBeNull();
    expect(
      toDraft({ name: "a", language: "en", kind: "followup", subject: "s", bodyHtml: "<p>b</p>" })
        .followupReuseSubject,
    ).toBe(true);
  });
});

describe("i18n: E paketinin anahtarları iki dilde de var", () => {
  it("TR ve EN outreach parçalarında eklenen anahtarlar boş değildir", () => {
    const keys = [
      "mbx.limits.title",
      "mbx.limits.preview",
      "wizard.draft.offer",
      "wizard.capAboveMailbox",
      "queue.reevaluate.closed",
      "reason.inbound_review_pending",
      "tplEditor.reuseSubject",
      "preflight.check.followups",
      "preflight.advisory.followup_compose_error",
    ] as const;
    for (const k of keys) {
      expect((tr as Record<string, string>)[k], k).toBeTruthy();
      expect((en as Record<string, string>)[k], k).toBeTruthy();
    }
  });

  it("limits.ts istemciye güvenle aktarılabilir (yalnızca saf içe aktarımlar)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "src/lib/mail/consumer-gmail.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from "node:/);
  });
});
