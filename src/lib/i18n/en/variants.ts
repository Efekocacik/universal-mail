import type { variants as TrVariants } from "../tr/variants";
import type { EnFragment } from "../types";

/** Package T (Faz 5): info-only badge, A/B subject, category variants, campaign stats, open tracking. */
export const variants = {
  "tracking.settings.title": "Open tracking",
  "tracking.settings.desc":
    "Shows roughly whether messages in demo campaigns were opened. Off by default.",
  "tracking.toggle": "Use open tracking",
  "tracking.toggle.hint":
    "An invisible tracking image is added to demo campaign messages and opens are counted approximately.",
  "tracking.state.on": "On · confirmed on {at}",
  "tracking.state.off": "Off",
  "tracking.legal":
    "Legal note: open tracking may count as reading information from the recipient's device. In the EU and many other countries it may require explicit consent. Make your own legal assessment before using it.",
  "tracking.demoOnly":
    "In this version it only works in demo campaigns. No tracking image is added to real messages; that needs public relay support later.",
  "tracking.confirm.title": "Turn on open tracking?",
  "tracking.confirm.body":
    "Open data is not exact (image blocking, automatic prefetching). It is used only in demo campaigns, and you can turn it off at any time.",
  "tracking.confirm.ok": "I understand, turn on",

  "tpl.infoOnly": "For information only, sending blocked",
  "tpl.infoOnly.hint":
    "German templates are kept as examples: cold email to Germany, Austria and Switzerland is blocked by the country rules.",
  "tpl.abBadge": "A/B subject",
  "tpl.categoryBadge": "Category: {name}",
  "tplField.subjectB": "Subject B",
  "tplEditor.subjectB": "Subject B (A/B test, optional)",
  "tplEditor.subjectB.hint":
    "If you fill this in, half of the campaign's recipients get this subject. The campaign details show which subject gets more replies.",
  "tplEditor.infoOnly":
    "Templates in this language are for information only and cannot be used in campaigns (country rules block sending).",
  "tplEditor.category":
    "Category variant: in a campaign, {name} businesses get this template and everyone else gets the general one.",
  "tplPreview.variant": "Subject shown",
  "tplPreview.variant.a": "Subject A",
  "tplPreview.variant.b": "Subject B",
  "composeError.template_info_only": "The template is for information only and cannot be sent",

  "wizard.steps.infoOnly": "{lang}: for information only, sending blocked",
  "wizard.steps.noUsable":
    "{lang}: there is no usable general first-email template (it may be archived). Add one on the Templates page.",
  "wizard.steps.ab":
    "{lang}: A/B subject test is on. Recipients alternate between the two subjects.",
  "wizard.variants.title": "Category variants (first email)",
  "wizard.variants.help":
    "Businesses in a ticked category get that category's template; everyone else gets the template above. Matching variants are suggested; untick the ones you don't want.",
  "wizard.variants.none": "There are no category templates in the selected languages.",
  "wizard.variants.use": "{lang} · separate template for {category} businesses",
  "wizard.variants.template": "{lang} {category} variant template",
  "wizard.variants.stale":
    "{step} · {lang} · {category}: the variant template is archived or no longer suitable. It will be removed when you save.",
  "wizard.variants.followupKept":
    "Category variants set for follow-up steps are kept. You can see all of them in the campaign details.",
  "campaign.stepVariant": "{category} → {template}",
  "campaign.stepVariants": "Category variants",

  "campaignStats.title": "Subject test and opens",
  "campaignStats.ab.title": "A/B subject test (first email)",
  "campaignStats.ab.none":
    "This campaign has no A/B subject test. To run one, add a subject B to the first email template.",
  "campaignStats.col.variant": "Subject",
  "campaignStats.col.sent": "Sent",
  "campaignStats.col.replied": "Replies",
  "campaignStats.col.replyRate": "Reply rate",
  "campaignStats.col.opened": "Opens",
  "campaignStats.variant.a": "Subject A",
  "campaignStats.variant.b": "Subject B",
  "campaignStats.opens.title": "Opens",
  "campaignStats.opens.off":
    "Open tracking is off. You can turn it on in Settings → Open tracking.",
  "campaignStats.opens.value": "{opened} of {sent} messages opened",
  "campaignStats.opens.disclaimer":
    "Open data is not exact (image blocking, automatic prefetching).",
  "campaignStats.opens.demoOnly":
    "In this version, opens are simulated in demo campaigns only; no tracking is added to real messages.",
  "campaignStats.openSettings": "Go to settings",

  "apiError.TEMPLATE_INFO_ONLY":
    "This template is for information only and cannot be used for sending. Choose another template.",
  "apiError.TEMPLATE_NO_VARIANT_B":
    "This template has no subject B. Add a subject B to the template first.",
  "apiError.CATEGORY_TEMPLATE_MISMATCH":
    "The category template's language or type does not match the step. Choose a template with the same language and type.",
} as const satisfies EnFragment<typeof TrVariants>;
