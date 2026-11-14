import type { IntroContext, IntroGenerator, IntroResult } from "./types";

/**
 * Demo kişisel giriş üreticisi (P0 taslağı; sahibi: paket A). Ağsız, ücretsiz, belirlenimci; model `demo`. P0 sürümü
 * tek kalıp cümle üretir; paket A dil başına kalıpları, doğrulayıcıyı ve canlı Claude istemcisini ekler.
 */
export function createDemoIntroGenerator(): IntroGenerator {
  return {
    model: "demo",
    isDemo: true,
    async generate(ctx: IntroContext): Promise<IntroResult> {
      const where = ctx.city ? ` in ${ctx.city}` : "";
      const what = ctx.categoryLabel ?? "business";
      return {
        text: `We came across your ${what}${where} and wanted to introduce ourselves.`,
        model: "demo",
        inputTokens: 0,
        outputTokens: 0,
        estCostUsd: 0,
        sourceDomain: null,
      };
    },
  };
}
