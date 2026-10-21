import { z } from "zod";
import { BRAND_PACK_SOURCES } from "./brand.generated.js";

/**
 * Brand packs make one platform release run as different products. A pack is
 * data only: code reads these values and never branches on the pack ID.
 *
 * Sources live in `packages/brands/<id>/` and are embedded by
 * `scripts/generate-brand-assets.mjs` into `brand.generated.ts`, so servers
 * need no extra files at runtime. Each process validates its selected pack at
 * boot through `loadBrandPack`.
 */

export const DEFAULT_BRAND_PACK_ID = "opencloud";

export type BrandPackId = keyof typeof BRAND_PACK_SOURCES;

export const brandPackIds = Object.freeze(
  Object.keys(BRAND_PACK_SOURCES).sort() as BrandPackId[],
);

export const brandPackIdSchema = z.enum(
  brandPackIds as unknown as [BrandPackId, ...BrandPackId[]],
);

/** Names appear in HTML, attributes, scripts and email headers unescaped. */
const displayName = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 .-]{0,39}$/,
    "Use letters, digits, spaces, dots or hyphens (at most 40 characters)",
  );
const plainText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !/[<>\n\r]/.test(value), "Use plain single-line text");
const hexColor = z
  .string()
  .regex(/^#[0-9a-f]{6}$/, "Use a six-digit lowercase hex colour");
const emailAddress = z.string().max(320).pipe(z.email());
const packFile = (folder: string, extensions: readonly string[]) =>
  z
    .string()
    .regex(
      new RegExp(`^${folder}/[a-z0-9][a-z0-9.-]*\\.(?:${extensions.join("|")})$`),
      `Use a ${extensions.join(" or ")} file inside ${folder}/`,
    );
const imagePath = packFile("assets", ["png", "svg"]);
const pngPath = packFile("assets", ["png"]);
const svgPath = packFile("assets", ["svg"]);
const markdownPath = packFile("content", ["md"]);
const jsonPath = packFile("content", ["json"]);

/** The colour roles shared by server-rendered pages, emails and the UI theme. */
export const brandColorRoles = [
  "canvas",
  "surface",
  "surfaceMuted",
  "text",
  "textMuted",
  "border",
  "primary",
  "onPrimary",
  "primaryHover",
  "primarySoft",
  "accent",
  "onAccent",
  "focus",
] as const;

export type BrandColorRole = (typeof brandColorRoles)[number];

const brandColorSetSchema = z
  .object({
    canvas: hexColor,
    surface: hexColor,
    surfaceMuted: hexColor,
    text: hexColor,
    textMuted: hexColor,
    border: hexColor,
    primary: hexColor,
    onPrimary: hexColor,
    primaryHover: hexColor,
    primarySoft: hexColor,
    accent: hexColor,
    onAccent: hexColor,
    focus: hexColor,
  })
  .strict();

const hue = z.number().min(0).max(360);

/**
 * Server-rendered pages and emails carry hand-written CSS with literal
 * colours. A pack restyles them with a deterministic palette mapping instead
 * of forking every view: exact replacements first, then OKLCH hue shifts for
 * the remaining tints and shades. An empty mapping leaves output unchanged.
 */
export const brandPagePaletteSchema = z
  .object({
    exact: z.record(hexColor, hexColor),
    hueShifts: z
      .array(
        z
          .object({
            from: z.tuple([hue, hue]),
            to: hue,
            chroma: z.number().min(0).max(2),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export type BrandPagePalette = z.infer<typeof brandPagePaletteSchema>;

export const brandManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    /** `draft` packs still contain placeholders (legal details, assets). */
    status: z.enum(["draft", "final"]),
    productName: displayName,
    shortName: displayName,
    tagline: plainText(160),
    description: plainText(320),
    /** Optional "Built on …" footer link. */
    poweredBy: z
      .object({ label: plainText(80), url: z.url() })
      .strict()
      .nullable(),
    legal: z
      .object({
        operatorName: plainText(120),
        companyNumber: plainText(80).nullable(),
        registeredOffice: plainText(240).nullable(),
        vatNumber: plainText(80).nullable(),
        copyrightHolder: plainText(120),
        /** Show the operator, company number and office in page footers. */
        footerNotice: z.boolean(),
      })
      .strict(),
    contacts: z
      .object({
        support: emailAddress,
        privacy: emailAddress,
        abuse: emailAddress,
      })
      .strict(),
    email: z
      .object({
        senderName: plainText(120),
        /** Plain-text footer appended to platform emails; `null` adds none. */
        footer: plainText(500).nullable(),
        copy: jsonPath,
      })
      .strict(),
    theme: z
      .object({
        /** Value of `data-oc-theme`; the token set lives in packages/ui. */
        id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
        colors: z
          .object({ light: brandColorSetSchema, dark: brandColorSetSchema })
          .strict(),
        pagePalette: brandPagePaletteSchema,
        /** The app dashboard's colour scheme until a person picks one. */
        dashboardColorScheme: z.enum(["dark", "light"]),
        /**
         * Colour scheme of platform emails and server-rendered pages (sign-in,
         * email links, permissions, errors, content). `light` renders them
         * from `colors.light` exactly.
         */
        pageColorScheme: z.enum(["dark", "light"]),
      })
      .strict(),
    assets: z
      .object({
        /** Wordmark for designers and documentation; not served yet. */
        logo: svgPath.nullable(),
        /** Square mark rendered beside the product name. */
        mark: imagePath,
        favicon: pngPath,
        /** Square web app and home-screen icon (512 × 512). */
        appIcon: pngPath,
        notificationIcon: pngPath,
        /** Link-preview image (1200 × 630) for the consumer homepage. */
        openGraphImage: pngPath.nullable(),
      })
      .strict(),
    agent: z
      .object({
        /** How the hosted Agent is labelled in its interface. */
        name: displayName,
        /** Extra system guidance naming the product; `null` adds none. */
        promptFragment: z.string().trim().min(1).max(2_000).nullable(),
      })
      .strict(),
    cli: z
      .object({ command: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/) })
      .strict(),
    mcp: z
      .object({
        serverName: displayName,
        toolNameSegment: z.string().regex(/^[a-z][a-z0-9]{1,30}$/),
        skillResourceName: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/),
      })
      .strict(),
    domainChallengeLabel: z.string().regex(/^_[a-z0-9][a-z0-9-]{0,61}$/),
    homepage: z
      .object({
        /** `platform` is the built-in OpenCloud page; `consumer` renders the content.home copy. */
        layout: z.enum(["platform", "consumer"]),
        /** Serve the application gallery and stories pages. */
        showcase: z.boolean(),
      })
      .strict(),
    content: z
      .object({
        /** The consumer homepage's copy, validated by `brandHomeCopySchema`. */
        home: jsonPath.nullable(),
        support: markdownPath,
        privacy: markdownPath,
        terms: markdownPath,
        reportAbuse: markdownPath.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.homepage.layout === "consumer" && !manifest.content.home) {
      context.addIssue({
        code: "custom",
        path: ["content", "home"],
        message: "The consumer homepage layout needs content.home",
      });
    }
  });

export type BrandManifest = z.infer<typeof brandManifestSchema>;

/** Placeholders the mailer fills; any other `{name}` is a pack error. */
export const brandEmailPlaceholders = [
  "projectName",
  "organisationName",
  "expiresAt",
  "amount",
  "cadence",
  "claimDeadline",
  "benefitEnd",
] as const;

const copy = (maximum = 400) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => !/[<>\n\r]/.test(value), "Use plain single-line text")
    .refine(
      (value) =>
        [...value.matchAll(/\{([^{}]*)\}/g)].every((match) =>
          (brandEmailPlaceholders as readonly string[]).includes(match[1] ?? ""),
        ),
      `Use only these placeholders: ${brandEmailPlaceholders.map((name) => `{${name}}`).join(", ")}`,
    );

/** Wording for platform emails. `{name}` placeholders are filled by the mailer. */
export const brandEmailCopySchema = z
  .object({
    projectConfirmation: z
      .object({
        subjectNewUser: copy(160),
        subjectExistingUser: copy(160),
        eyebrow: copy(80),
        heading: copy(120),
        introNewUser: copy(),
        introExistingUser: copy(),
        consequenceNewUser: copy(),
        consequenceExistingUser: copy(),
        action: copy(80),
        textAction: copy(120),
        footnote: copy(),
        projectLabel: copy(40),
        accessLabel: copy(40),
        addressLabel: copy(40),
        textAddressLabel: copy(40),
        privateLabel: copy(40),
        publicLabel: copy(40),
      })
      .strict(),
    organisationInvitation: z
      .object({
        subject: copy(160),
        eyebrow: copy(80),
        heading: copy(120),
        intro: copy(),
        organisationLabel: copy(40),
        roleLabel: copy(40),
        adminRole: copy(40),
        memberRole: copy(40),
        recipientLabel: copy(40),
        instruction: copy(),
        action: copy(80),
        linkHint: copy(120),
        footnote: copy(),
        textInstruction: copy(),
        textFootnote: copy(),
      })
      .strict(),
    signIn: z
      .object({
        eyebrow: copy(80),
        headingConfirm: copy(120),
        headingContinue: copy(120),
        explanationConfirmOriginalWindow: copy(),
        explanationOriginalWindow: copy(),
        explanationConfirm: copy(),
        explanation: copy(),
        completionOriginalWindow: copy(),
        completion: copy(),
        /** For a link that lasts until the account's confirmation deadline. */
        completionUntil: copy(),
        action: copy(80),
        textAction: copy(120),
        /** For a link that lasts until the account's confirmation deadline. */
        textActionUntil: copy(120),
      })
      .strict(),
    emailChange: z
      .object({
        subject: copy(160),
        eyebrow: copy(80),
        heading: copy(120),
        explanation: copy(),
        action: copy(80),
        footnote: copy(),
        textAction: copy(120),
      })
      .strict(),
    promotionCredit: z
      .object({
        subject: copy(160),
        eyebrow: copy(80),
        offer: copy(),
        instruction: copy(),
        action: copy(80),
        footnote: copy(),
        textSummary: copy(),
        textAction: copy(120),
        textFootnote: copy(),
      })
      .strict(),
  })
  .strict();

export type BrandEmailCopy = z.infer<typeof brandEmailCopySchema>;

/** Plain single-line homepage text; `{name}` is allowed only for the listed placeholders. */
const homeText = (maximum = 400, placeholders: readonly string[] = []) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !/[<>\n\r]/.test(value), "Use plain single-line text")
    .refine(
      (value) =>
        [...value.matchAll(/\{([^{}]*)\}/g)].every((match) =>
          placeholders.includes(match[1] ?? ""),
        ),
      placeholders.length
        ? `Use only these placeholders: ${placeholders.map((name) => `{${name}}`).join(", ")}`
        : "Placeholders are not allowed here",
    );

/** A plain part of a sentence; its leading and trailing spaces join it to the next part. */
const homeWordPart = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => value.trim().length > 0, "Use words, not only spaces")
  .refine((value) => !/[<>\n\r{}]/.test(value), "Use plain single-line text without braces");

/** Words a visitor gives their AI: plain parts, and `{ fill }` parts they make their own. */
const homeWords = z
  .array(z.union([homeWordPart, z.object({ fill: homeText(120) }).strict()]))
  .min(1)
  .max(16);

/** An example app's own address, such as `chores.sprout.is`. */
const homeAddress = z
  .string()
  .max(80)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/);

/** A published demo app that visitors can open, such as `https://chores.sprout.is`. */
const homeDemoUrl = z
  .string()
  .max(200)
  .url()
  .refine((value) => value.startsWith("https://"), "Use an https:// address");

/** The app illustrations the consumer homepage can draw; content picks which and in what order. */
export const brandHomeAppIllustrations = [
  "home",
  "family",
  "kitchen",
  "gifts",
  "trips",
  "admin",
  "reading",
  "dinners",
  "party",
  "mealtrain",
] as const;

/** The care illustrations for the "looked after" cards. */
export const brandHomeCareIllustrations = [
  "backups",
  "address",
  "repairs",
  "private",
] as const;

const homeAppIllustration = z.enum(brandHomeAppIllustrations);

/** Wording for the consumer homepage layout. Plans and prices come from the billing catalog. */
export const brandHomeCopySchema = z
  .object({
    title: homeText(120),
    description: homeText(300),
    nav: z
      .object({
        examples: homeText(40),
        howItWorks: homeText(40),
        pricing: homeText(40),
        menu: homeText(40),
        logIn: homeText(40),
        start: homeText(40),
      })
      .strict(),
    hero: z
      .object({
        /** Set as the headline's first line, such as `sprout.is`. */
        address: homeAddress,
        heading: homeText(160),
        lede: homeText(400),
        primaryAction: homeText(40),
        secondaryAction: homeText(40),
        freeOffer: homeText(160, ["freeApps"]),
        note: homeText(240),
        illustrationLabel: homeText(400),
        apps: z
          .array(
            z
              .object({
                illustration: homeAppIllustration,
                visibility: z.enum(["public", "private"]),
                sharedWith: homeText(60),
              })
              .strict(),
          )
          .length(3),
        factsLabel: homeText(60),
        facts: z.array(homeText(80)).min(1).max(4),
      })
      .strict(),
    gallery: z
      .object({
        title: homeText(120),
        tabsLabel: homeText(60),
        promptLabel: homeText(60),
        promptHint: homeWords,
        copyAction: homeText(40),
        copiedAction: homeText(40),
        copiedAnnouncement: homeText(120),
        growLabel: homeText(40),
        growNote: homeText(200),
        addressLabel: homeText(40),
        /** The button that opens an example's published demo. */
        demoAction: homeText(40),
        demoNote: homeText(120),
        apps: z
          .array(
            z
              .object({
                illustration: homeAppIllustration,
                tab: homeText(30),
                name: homeText(80),
                forWhom: homeText(80),
                blurb: homeText(240),
                address: homeAddress,
                demo: homeDemoUrl.optional(),
                words: homeWords,
                moreLabel: homeText(60),
                more: z.array(homeText(60)).max(6),
              })
              .strict(),
          )
          .min(1)
          .max(brandHomeAppIllustrations.length),
      })
      .strict(),
    howItWorks: z
      .object({
        title: homeText(120),
        steps: z
          .array(z.object({ title: homeText(60), body: homeText(300) }).strict())
          .min(1)
          .max(4),
        demo: z
          .object({
            label: homeText(400),
            assistant: homeText(40),
            connected: homeText(40),
            youLabel: homeText(20),
            assistantLabel: homeText(20),
            request: homeText(200),
            reply: homeText(120),
            progress: z.array(homeText(80)).length(3),
            address: homeAddress,
            visibility: homeText(30),
            composer: homeText(60),
            replay: homeText(40),
            replayAgain: homeText(40),
          })
          .strict(),
      })
      .strict(),
    yourAi: z
      .object({
        title: homeText(120),
        kicker: homeText(60),
        heading: homeText(120),
        body: homeText(400),
        namesLabel: homeText(40),
        names: z.array(homeText(40)).min(1).max(4),
        connectAction: homeText(40),
        otherWays: homeText(60),
        exchange: z.object({ ask: homeText(160), reply: homeText(160) }).strict(),
        noCredits: z
          .object({
            seal: z.array(homeText(20)).min(1).max(2),
            title: homeText(120),
            body: homeText(400),
            note: homeText(240),
          })
          .strict(),
        receipt: z
          .object({
            title: homeText(40),
            rows: z
              .array(z.object({ label: homeText(40), value: homeText(40) }).strict())
              .min(1)
              .max(4),
          })
          .strict(),
      })
      .strict(),
    lookedAfter: z
      .object({
        title: homeText(120),
        question: homeText(160),
        answer: homeText(600),
        items: z
          .array(
            z
              .object({
                illustration: z.enum(brandHomeCareIllustrations),
                title: homeText(60),
                tag: homeText(30).nullable(),
                body: homeText(300),
              })
              .strict(),
          )
          .min(1)
          .max(brandHomeCareIllustrations.length),
      })
      .strict(),
    pricing: z
      .object({
        kicker: homeText(60).nullable(),
        title: homeText(120),
        deck: homeText(400).nullable(),
        /** Catalog key of the plan to mark; `null` marks none. */
        highlightedPlan: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/).nullable(),
        highlightLabel: homeText(30),
        freeCadence: homeText(30),
        monthlyCadence: homeText(30),
        freeAction: homeText(40),
        paidAction: homeText(60, ["plan"]),
        moreDetails: homeText(40),
        labels: z
          .object({
            apps: homeText(40),
            storage: homeText(40),
            customDomains: homeText(40),
            /** Building in the hosted Agent; plans with no hosted-Agent runs leave it out. */
            hostedAgent: homeText(40),
            automaticRepairs: homeText(40),
            builds: homeText(60),
            emails: homeText(60),
            backups: homeText(60),
            prioritySupport: homeText(60),
            included: homeText(30),
            notIncluded: homeText(30),
            unlimited: homeText(30),
          })
          .strict(),
      })
      .strict(),
    faq: z
      .object({
        title: homeText(120),
        deck: homeText(200).nullable(),
        items: z
          .array(z.object({ question: homeText(160), answer: homeText(800, ["freeApps"]) }).strict())
          .min(1)
          .max(12),
      })
      .strict(),
    closing: z
      .object({
        title: homeText(120),
        body: homeText(300),
        action: homeText(40),
        freeOffer: homeText(160, ["freeApps"]),
        notepadTitle: homeText(60),
        notepad: z.array(homeText(60)).min(1).max(6),
      })
      .strict(),
    footer: z
      .object({
        promise: homeText(160),
        pricing: homeText(40),
        myApps: homeText(40),
        support: homeText(40),
        privacy: homeText(40),
        terms: homeText(40),
        reportAbuse: homeText(40),
      })
      .strict(),
  })
  .strict()
  .superRefine((copy, context) => {
    const illustrations = copy.gallery.apps.map((app) => app.illustration);
    if (new Set(illustrations).size !== illustrations.length) {
      context.addIssue({
        code: "custom",
        path: ["gallery", "apps"],
        message: "Each gallery app needs its own illustration",
      });
    }
    const cares = copy.lookedAfter.items.map((item) => item.illustration);
    if (new Set(cares).size !== cares.length) {
      context.addIssue({
        code: "custom",
        path: ["lookedAfter", "items"],
        message: "Each looked-after card needs its own illustration",
      });
    }
    for (const [index, app] of copy.hero.apps.entries()) {
      if (!illustrations.includes(app.illustration)) {
        context.addIssue({
          code: "custom",
          path: ["hero", "apps", index, "illustration"],
          message: "Hero apps must be gallery apps, whose names and addresses they show",
        });
      }
    }
  });

export type BrandHomeCopy = z.infer<typeof brandHomeCopySchema>;

export interface BrandImage {
  readonly path: string;
  readonly contentType: "image/png" | "image/svg+xml";
  readonly dataUri: string;
}

/** A content page: front matter plus Markdown body (rendered by the server). */
export interface BrandDocument {
  readonly path: string;
  readonly meta: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface BrandPack extends Omit<BrandManifest, "assets" | "content"> {
  readonly id: BrandPackId;
  readonly assets: {
    readonly mark: BrandImage;
    readonly favicon: BrandImage;
    readonly appIcon: BrandImage;
    readonly notificationIcon: BrandImage;
    readonly openGraphImage: BrandImage | null;
  };
  readonly assetPaths: BrandManifest["assets"];
  readonly content: {
    readonly support: BrandDocument;
    readonly privacy: BrandDocument;
    readonly terms: BrandDocument;
    readonly reportAbuse: BrandDocument | null;
  };
  readonly emailCopy: BrandEmailCopy;
  /** The consumer homepage's copy; `null` when the pack has none. */
  readonly homeCopy: BrandHomeCopy | null;
}

const contentPageMetaKeys = ["title", "description", "eyebrow", "updated"];

/** Parses `---`-delimited `key: value` front matter followed by a body. */
export function parseBrandDocument(
  path: string,
  source: string,
): BrandDocument {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(normalized);
  if (!match) throw new Error(`${path} must start with front matter`);
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const field = /^([A-Za-z][A-Za-z0-9]*): (.+)$/.exec(line);
    if (!field?.[1] || !field[2]) {
      throw new Error(`${path} has an invalid front matter line: ${line}`);
    }
    if (Object.hasOwn(meta, field[1])) {
      throw new Error(`${path} repeats front matter key ${field[1]}`);
    }
    meta[field[1]] = field[2].trim();
  }
  return Object.freeze({
    path,
    meta: Object.freeze(meta),
    body: normalized.slice(match[0].length),
  });
}

const loadedPacks = new Map<BrandPackId, BrandPack>();

/** Validates and resolves an embedded pack. Throws on any invalid value. */
export function loadBrandPack(id: string): BrandPack {
  const packId = brandPackIdSchema.parse(id);
  const cached = loadedPacks.get(packId);
  if (cached) return cached;
  const source = BRAND_PACK_SOURCES[packId] as {
    readonly manifest: unknown;
    readonly files: Readonly<Record<string, string>>;
  };
  const parsed = brandManifestSchema.safeParse(source.manifest);
  if (!parsed.success) {
    throw new Error(
      `Brand pack ${packId} is invalid: ${z.prettifyError(parsed.error)}`,
    );
  }
  const manifest = parsed.data;
  if (manifest.id !== packId) {
    throw new Error(`Brand pack ${packId} declares a different id`);
  }
  const file = (path: string): string => {
    const value = source.files[path];
    if (value === undefined) {
      throw new Error(`Brand pack ${packId} does not embed ${path}`);
    }
    return value;
  };
  const image = (path: string): BrandImage => {
    const dataUri = file(path);
    const contentType = path.endsWith(".svg") ? "image/svg+xml" : "image/png";
    if (!dataUri.startsWith(`data:${contentType};base64,`)) {
      throw new Error(`Brand pack ${packId} asset ${path} is not ${contentType}`);
    }
    return Object.freeze({ path, contentType, dataUri });
  };
  const document = (
    path: string | null,
    requiredKeys: readonly string[],
  ): BrandDocument | null => {
    if (path === null) return null;
    const parsedDocument = parseBrandDocument(path, file(path));
    for (const key of requiredKeys) {
      if (!parsedDocument.meta[key]) {
        throw new Error(`Brand pack ${packId} content ${path} needs ${key}`);
      }
    }
    if (parsedDocument.body.trim().length === 0) {
      throw new Error(`Brand pack ${packId} content ${path} is empty`);
    }
    return parsedDocument;
  };
  const required = (path: string, keys: readonly string[]): BrandDocument =>
    document(path, keys) as BrandDocument;
  let emailCopy: BrandEmailCopy;
  try {
    emailCopy = brandEmailCopySchema.parse(JSON.parse(file(manifest.email.copy)));
  } catch (error) {
    throw new Error(
      `Brand pack ${packId} email copy is invalid: ${
        error instanceof z.ZodError ? z.prettifyError(error) : String(error)
      }`,
    );
  }
  let homeCopy: BrandHomeCopy | null = null;
  if (manifest.content.home !== null) {
    try {
      homeCopy = brandHomeCopySchema.parse(JSON.parse(file(manifest.content.home)));
    } catch (error) {
      throw new Error(
        `Brand pack ${packId} homepage copy is invalid: ${
          error instanceof z.ZodError ? z.prettifyError(error) : String(error)
        }`,
      );
    }
  }
  const { assets, content, ...rest } = manifest;
  const pack: BrandPack = Object.freeze({
    ...rest,
    id: packId,
    assets: Object.freeze({
      mark: image(assets.mark),
      favicon: image(assets.favicon),
      appIcon: image(assets.appIcon),
      notificationIcon: image(assets.notificationIcon),
      openGraphImage: assets.openGraphImage ? image(assets.openGraphImage) : null,
    }),
    assetPaths: assets,
    content: Object.freeze({
      support: required(content.support, contentPageMetaKeys),
      privacy: required(content.privacy, contentPageMetaKeys),
      terms: required(content.terms, contentPageMetaKeys),
      reportAbuse: document(content.reportAbuse, contentPageMetaKeys),
    }),
    emailCopy,
    homeCopy,
  });
  loadedPacks.set(packId, pack);
  return pack;
}
