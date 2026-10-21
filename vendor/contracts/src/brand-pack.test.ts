import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  brandEmailCopySchema,
  brandHomeCopySchema,
  brandManifestSchema,
  brandPackIds,
  DEFAULT_BRAND_PACK_ID,
  loadBrandPack,
  parseBrandDocument,
} from "./brand-pack.js";
import {
  BRAND_PACK_SOURCES,
  OPEN_CLOUD_FAVICON_DATA_URI,
  OPEN_CLOUD_LOGO_DATA_URI,
} from "./brand.generated.js";

const brandsDirectory = new URL("../../brands/", import.meta.url);

function pngDimensions(dataUri: string): [number, number] {
  const image = Buffer.from(dataUri.split(",", 2)[1] ?? "", "base64");
  expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [image.readUInt32BE(16), image.readUInt32BE(20)];
}

describe("brand packs", () => {
  it("ships the default OpenCloud pack and Sprout", () => {
    expect(DEFAULT_BRAND_PACK_ID).toBe("opencloud");
    expect(brandPackIds).toEqual(["opencloud", "sprout"]);
    expect(loadBrandPack("opencloud").assets.openGraphImage).toBeNull();
    expect(loadBrandPack("sprout").assets.openGraphImage?.path).toBe("assets/og.png");
  });

  it.each(brandPackIds)("validates and resolves the %s pack", (id) => {
    const pack = loadBrandPack(id);
    expect(pack.id).toBe(id);
    expect(pack.assets.favicon.contentType).toBe("image/png");
    expect(pngDimensions(pack.assets.favicon.dataUri)).toEqual([32, 32]);
    const [width, height] = pngDimensions(pack.assets.notificationIcon.dataUri);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(96);
    expect(pngDimensions(pack.assets.appIcon.dataUri)).toEqual([512, 512]);
    if (pack.assets.openGraphImage) {
      expect(pngDimensions(pack.assets.openGraphImage.dataUri)).toEqual([1200, 630]);
    }
    expect(pack.content.support.meta.title).toBeTruthy();
    expect(pack.content.privacy.meta.updated).toBeTruthy();
    expect(pack.emailCopy.signIn.action).toBeTruthy();
  });

  it("keeps the generated module in step with packages/brands", () => {
    for (const id of brandPackIds) {
      const source = BRAND_PACK_SOURCES[id] as {
        manifest: unknown;
        files: Record<string, string>;
      };
      const directory = new URL(`${id}/`, brandsDirectory);
      expect(source.manifest).toEqual(
        JSON.parse(readFileSync(new URL("brand.json", directory), "utf8")),
      );
      for (const [path, value] of Object.entries(source.files)) {
        const bytes = readFileSync(new URL(path, directory));
        expect(value, `${id}/${path}`).toBe(
          /\.(?:png|svg)$/.test(path)
            ? `data:${path.endsWith(".svg") ? "image/svg+xml" : "image/png"};base64,${bytes.toString("base64")}`
            : bytes.toString("utf8"),
        );
      }
    }
  });

  it("keeps the legacy OpenCloud constants on the default pack", () => {
    const pack = loadBrandPack(DEFAULT_BRAND_PACK_ID);
    expect(OPEN_CLOUD_LOGO_DATA_URI).toBe(pack.assets.mark.dataUri);
    expect(OPEN_CLOUD_FAVICON_DATA_URI).toBe(pack.assets.favicon.dataUri);
    expect(pack.assets.notificationIcon.dataUri).toBe(OPEN_CLOUD_LOGO_DATA_URI);
  });

  it("names the operator and the brand contact on Sprout", () => {
    const sprout = loadBrandPack("sprout");
    expect(sprout.productName).toBe("Sprout");
    expect(sprout.legal.operatorName).toBe("Open Cloud Solutions Limited");
    expect(sprout.legal.footerNotice).toBe(true);
    expect(Object.values(sprout.contacts)).toEqual([
      "support@sprout.is",
      "support@sprout.is",
      "support@sprout.is",
    ]);
    expect(sprout.homepage.layout).toBe("consumer");
    expect(sprout.content.reportAbuse).not.toBeNull();
    expect(sprout.cli.command).toBe("sprout");
    expect(sprout.mcp.toolNameSegment).toBe("sprout");
    expect(sprout.domainChallengeLabel).toBe("_sprout-challenge");
    expect(sprout.poweredBy).toBeNull();
  });

  it("rejects invalid manifests", () => {
    const manifest = structuredClone(
      BRAND_PACK_SOURCES.sprout.manifest,
    ) as Record<string, unknown>;
    expect(brandManifestSchema.safeParse(manifest).success).toBe(true);
    for (const change of [
      { productName: "<Sprout>" },
      { theme: { ...(manifest.theme as object), id: "Sprout Theme" } },
      { content: { ...(manifest.content as object), home: null } },
      { assets: { ...(manifest.assets as object), favicon: "assets/favicon.svg" } },
      { unexpected: true },
    ]) {
      expect(
        brandManifestSchema.safeParse({ ...manifest, ...change }).success,
        JSON.stringify(Object.keys(change)),
      ).toBe(false);
    }
    expect(() => loadBrandPack("unknown")).toThrow();
  });

  it("accepts only the placeholders the mailer fills in email copy", () => {
    const copy = loadBrandPack("sprout").emailCopy;
    expect(brandEmailCopySchema.safeParse(copy).success).toBe(true);
    for (const subject of ["Hello {name}", "Line\nbreak", "<b>Bold</b>"]) {
      expect(
        brandEmailCopySchema.safeParse({
          ...copy,
          emailChange: { ...copy.emailChange, subject },
        }).success,
        subject,
      ).toBe(false);
    }
  });

  it("links example apps only to https demos", () => {
    const copy = loadBrandPack("sprout").homeCopy;
    expect(copy).not.toBeNull();
    if (!copy) return;
    expect(brandHomeCopySchema.safeParse(copy).success).toBe(true);
    const [first, ...rest] = copy.gallery.apps;
    if (!first) throw new Error("Sprout has no example apps");
    for (const change of [
      { demo: "http://chores.example" },
      { demo: "javascript:alert(1)" },
      { demo: "chores.example" },
    ]) {
      expect(
        brandHomeCopySchema.safeParse({
          ...copy,
          gallery: { ...copy.gallery, apps: [{ ...first, ...change }, ...rest] },
        }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
  });

  it("parses content front matter", () => {
    expect(
      parseBrandDocument("content/x.md", "---\ntitle: A: b\nupdated: Today\n---\n\nBody\n"),
    ).toEqual({
      path: "content/x.md",
      meta: { title: "A: b", updated: "Today" },
      body: "\nBody\n",
    });
    expect(() => parseBrandDocument("content/x.md", "Body")).toThrow(
      /front matter/,
    );
    expect(() =>
      parseBrandDocument("content/x.md", "---\ntitle: A\ntitle: B\n---\n"),
    ).toThrow(/repeats/);
  });
});
