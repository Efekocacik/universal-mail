import { describe, expect, it } from "vitest";
import {
  categoryTemplatesFor,
  preservedFollowupVariants,
  pruneVariantSelection,
  selectionFromSteps,
  variantOptions,
} from "@/features/campaigns/category-variants";
import { stepsDirty } from "@/features/campaigns/wizard-dirty";
import type { StepInput, TemplateItem } from "@/lib/client/campaigns";

/**
 * Sihirbazın kategori varyantı mantığı (saf, DOM'suz): kaydedilemeyecek seçimlerin ayıklanması ve API ile takip
 * adımlarına yazılmış varyantların kayıtta korunması.
 */

let nextId = 1;
function tpl(p: Partial<TemplateItem> & Pick<TemplateItem, "language" | "kind">): TemplateItem {
  return {
    id: nextId++,
    name: `T${nextId}`,
    categoryKey: null,
    builtIn: false,
    version: 1,
    subject: "s",
    followupReuseSubject: true,
    subjectB: null,
    infoOnly: false,
    archived: false,
    updatedAt: 0,
    lockedBy: 0,
    ...p,
  } as TemplateItem;
}

describe("pruneVariantSelection", () => {
  it("arşivlenen tek varyant şablonu satırla birlikte kaybolur: gönderilmez, kaldırılacak diye listelenir", () => {
    const cafe = tpl({ language: "en", kind: "initial", categoryKey: "cafe", archived: true });
    const pub = tpl({ language: "en", kind: "initial", categoryKey: "pub" });
    const options = variantOptions([cafe, pub], ["en"]);
    expect(options.map((o) => o.categoryKey)).toEqual(["pub"]);

    const sel = { "en|cafe": cafe.id, "en|pub": pub.id, "fr|cafe": 999 };
    const { kept, stale } = pruneVariantSelection(sel, options, ["en"]);
    expect(categoryTemplatesFor("en", kept)).toEqual([{ categoryKey: "pub", templateId: pub.id }]);
    expect(stale).toEqual([
      { stepIndex: 0, language: "en", categoryKey: "cafe", templateId: cafe.id },
    ]);
    // Seçili olmayan dilin seçimi gönderilmez ama "kaldırılacak" diye de gösterilmez.
    expect(kept["fr|cafe"]).toBe(999);
  });

  it("satır duruyor ama seçili şablon artık o satırda değil (arşiv veya dil değişikliği): ayıklanır", () => {
    const a = tpl({ language: "en", kind: "initial", categoryKey: "cafe" });
    const b = tpl({ language: "en", kind: "initial", categoryKey: "cafe", archived: true });
    const { kept, stale } = pruneVariantSelection(
      { "en|cafe": b.id },
      variantOptions([a, b], ["en"]),
      ["en"],
    );
    expect(kept).toEqual({});
    expect(stale).toHaveLength(1);
  });

  it("işareti kaldırılmış (0) seçim yok sayılır", () => {
    const { kept, stale } = pruneVariantSelection({ "en|cafe": 0 }, [], ["en"]);
    expect(kept).toEqual({});
    expect(stale).toEqual([]);
  });
});

describe("preservedFollowupVariants", () => {
  const general = tpl({ language: "en", kind: "initial" });
  const fu = tpl({ language: "en", kind: "followup" });
  const fuCafe = tpl({ language: "en", kind: "followup", categoryKey: "cafe" });
  const fuPubArchived = tpl({
    language: "en",
    kind: "followup",
    categoryKey: "pub",
    archived: true,
  });
  const saved: StepInput[] = [
    { stepIndex: 0, language: "en", templateId: general.id, delayDays: 0 },
    {
      stepIndex: 1,
      language: "en",
      templateId: fu.id,
      delayDays: 5,
      categoryTemplates: [
        { categoryKey: "cafe", templateId: fuCafe.id },
        { categoryKey: "pub", templateId: fuPubArchived.id },
      ],
    },
  ];

  it("API ile yazılmış takip varyantı korunur; uygun olmayanı ayrılır", () => {
    const { byStep, stale } = preservedFollowupVariants(saved, [
      general,
      fu,
      fuCafe,
      fuPubArchived,
    ]);
    expect(byStep).toEqual({ "en|1": [{ categoryKey: "cafe", templateId: fuCafe.id }] });
    expect(stale).toEqual([
      { stepIndex: 1, language: "en", categoryKey: "pub", templateId: fuPubArchived.id },
    ]);
    // Adım 0 seçimi takip varyantlarını içermez (sihirbaz onları seçtirmez).
    expect(selectionFromSteps(saved)).toEqual({});
  });

  it("korunan varyantla yeniden kurulan adımlar kayıtlıyla aynı sayılır (sessiz silme yok)", () => {
    const savedOk: StepInput[] = [
      saved[0]!,
      { ...saved[1]!, categoryTemplates: [{ categoryKey: "cafe", templateId: fuCafe.id }] },
    ];
    const { byStep } = preservedFollowupVariants(savedOk, [general, fu, fuCafe]);
    const rebuilt: StepInput[] = [
      saved[0]!,
      {
        stepIndex: 1,
        language: "en",
        templateId: fu.id,
        delayDays: 5,
        categoryTemplates: byStep["en|1"],
      },
    ];
    expect(stepsDirty(savedOk, rebuilt)).toBe(false);
    // Önceki davranış: takip varyantı düşürülürdü ve fark oluşurdu.
    expect(stepsDirty(savedOk, [saved[0]!, { ...rebuilt[1]!, categoryTemplates: undefined }])).toBe(
      true,
    );
  });
});
