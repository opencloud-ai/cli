import type { BrandPagePalette } from "./brand-pack.js";

/**
 * Restyles hand-written CSS for a brand without forking each view.
 *
 * Server-rendered views, emails and a few app stylesheets keep literal
 * colours. A brand's page palette maps those literals: exact replacements
 * first, then OKLCH hue shifts that keep perceived lightness (so tints, shades
 * and alpha variants follow automatically). Theme token declarations
 * (`--oc-*` custom properties) are never rewritten: brand token sets are
 * already exact. In HTML only CSS contexts are touched: `<style>` blocks,
 * `style` attributes, SVG paint attributes and the `theme-color` meta tag.
 * Scripts are never rewritten, so CSP script hashes stay valid.
 *
 * An empty palette returns the input unchanged, which keeps the default
 * OpenCloud output byte-for-byte identical.
 */
export type PageColorMapper = (html: string) => string;

const identity = (value: string) => value;

const cssColorToken =
  /(--oc-[\w-]+\s*:[^;{}]*)|#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|(rgba?\(\s*)(\d{1,3})(\s*,\s*|\s+)(\d{1,3})(\s*,\s*|\s+)(\d{1,3})/g;
const scriptElement = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const styleBlock = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const styleAttribute = /(\sstyle=")([^"]*)(")/gi;
const paintAttribute =
  /(\s(?:fill|stroke|stop-color|color)=")(#[0-9a-fA-F]{3,8})(")/gi;
const themeColorMeta =
  /(<meta\s+name="theme-color"\s+content=")(#[0-9a-fA-F]{3,8})(")/gi;
const maximumCachedBlocks = 512;

function isIdentity(palette: BrandPagePalette): boolean {
  return (
    Object.keys(palette.exact).length === 0 && palette.hueShifts.length === 0
  );
}

/** Maps colour literals in a stylesheet; identity for an empty palette. */
export function createStylesheetPaletteMapper(
  palette: BrandPagePalette,
): (css: string) => string {
  if (isIdentity(palette)) return identity;
  const mapColor = createColorMapper(palette);
  const cache = new Map<string, string>();
  return (css) => {
    const cached = cache.get(css);
    if (cached !== undefined) return cached;
    const mapped = css.replace(
      cssColorToken,
      (
        literal: string,
        token: string | undefined,
        _hex: string | undefined,
        prefix: string | undefined,
        red: string | undefined,
        firstSeparator: string | undefined,
        green: string | undefined,
        secondSeparator: string | undefined,
        blue: string | undefined,
      ) => {
        if (token !== undefined) return literal;
        if (prefix === undefined) return mapHexLiteral(literal, mapColor);
        const [r, g, b] = mapColor([Number(red), Number(green), Number(blue)]);
        return `${prefix}${r}${firstSeparator}${g}${secondSeparator}${b}`;
      },
    );
    if (cache.size >= maximumCachedBlocks) cache.clear();
    cache.set(css, mapped);
    return mapped;
  };
}

/**
 * Maps colours inside the CSS contexts of an HTML document or email. Script
 * elements are copied verbatim, even when their code builds markup.
 */
export function createPagePaletteMapper(
  palette: BrandPagePalette,
): PageColorMapper {
  if (isIdentity(palette)) return identity;
  const mapColor = createColorMapper(palette);
  const mapCss = createStylesheetPaletteMapper(palette);
  const mapMarkup = (html: string): string =>
    html
      .replace(
        styleBlock,
        (_block, open: string, css: string, close: string) =>
          `${open}${mapCss(css)}${close}`,
      )
      .replace(
        styleAttribute,
        (_attribute, open: string, css: string, close: string) =>
          `${open}${mapCss(css)}${close}`,
      )
      .replace(
        paintAttribute,
        (_attribute, open: string, color: string, close: string) =>
          `${open}${mapHexLiteral(color, mapColor)}${close}`,
      )
      .replace(
        themeColorMeta,
        (_meta, open: string, color: string, close: string) =>
          `${open}${mapHexLiteral(color, mapColor)}${close}`,
      );
  return (html) => {
    let mapped = "";
    let position = 0;
    for (const script of html.matchAll(scriptElement)) {
      const start = script.index;
      mapped += mapMarkup(html.slice(position, start)) + script[0];
      position = start + script[0].length;
    }
    return mapped + mapMarkup(html.slice(position));
  };
}

type Rgb = readonly [number, number, number];

/** Maps one sRGB colour; returns the same tuple when no rule applies. */
export function createColorMapper(
  palette: BrandPagePalette,
): (rgb: Rgb) => Rgb {
  const exact = new Map<string, Rgb>(
    Object.entries(palette.exact).map(([from, to]) => [from, parseHex(to)]),
  );
  const cache = new Map<string, Rgb>();
  return (rgb) => {
    const key = toHex(rgb);
    const cached = cache.get(key);
    if (cached) return cached;
    let result: Rgb = exact.get(key) ?? rgb;
    if (!exact.has(key)) {
      const [lightness, chroma, hue] = rgbToOklch(rgb);
      const shift = palette.hueShifts.find(({ from: [start, end] }) =>
        start <= end ? hue >= start && hue <= end : hue >= start || hue <= end,
      );
      if (shift && chroma > 0.0001) {
        result = oklchToRgbInGamut(lightness, chroma * shift.chroma, shift.to);
      }
    }
    cache.set(key, result);
    return result;
  };
}

function mapHexLiteral(literal: string, mapColor: (rgb: Rgb) => Rgb): string {
  const digits = literal.slice(1);
  const short = digits.length <= 4;
  const colorDigits = short ? digits.slice(0, 3) : digits.slice(0, 6);
  const alphaDigits = short ? digits.slice(3) : digits.slice(6);
  const rgb = parseHex(`#${colorDigits}`);
  const mapped = mapColor(rgb);
  if (mapped === rgb || toHex(mapped) === toHex(rgb)) return literal;
  const alpha = short && alphaDigits ? alphaDigits.repeat(2) : alphaDigits;
  return `${toHex(mapped)}${alpha.toLowerCase()}`;
}

function parseHex(value: string): Rgb {
  const digits = value.slice(1);
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : digits;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const toLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const toGamma = (channel: number) =>
  channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * channel ** (1 / 2.4) - 0.055;

function rgbToOklch(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb.map((channel) => toLinear(channel / 255)) as [
    number,
    number,
    number,
  ];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bAxis = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = ((Math.atan2(bAxis, a) * 180) / Math.PI + 360) % 360;
  return [lightness, Math.hypot(a, bAxis), hue];
}

function oklchToLinearRgb(
  lightness: number,
  chroma: number,
  hue: number,
): [number, number, number] {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Reduces chroma until the colour fits sRGB, keeping lightness and hue. */
function oklchToRgbInGamut(lightness: number, chroma: number, hue: number): Rgb {
  let current = chroma;
  let linear = oklchToLinearRgb(lightness, current, hue);
  while (
    current > 0 &&
    linear.some((channel) => channel < -0.0001 || channel > 1.0001)
  ) {
    current = Math.max(0, current - 0.002);
    linear = oklchToLinearRgb(lightness, current, hue);
  }
  return linear.map((channel) =>
    Math.round(toGamma(Math.min(1, Math.max(0, channel))) * 255),
  ) as unknown as Rgb;
}
