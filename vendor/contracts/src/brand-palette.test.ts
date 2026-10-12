import { describe, expect, it } from "vitest";
import { createColorMapper, createPagePaletteMapper } from "./brand-palette.js";

const palette = {
  exact: { "#071019": "#0f1512", "#83bfff": "#6cc774" },
  hueShifts: [{ from: [195, 300] as [number, number], to: 148, chroma: 0.9 }],
};

describe("brand page palettes", () => {
  it("returns the input untouched for an empty palette", () => {
    const html = '<style>a{color:#83bfff}</style><p style="color:#071019">x</p>';
    expect(createPagePaletteMapper({ exact: {}, hueShifts: [] })(html)).toBe(html);
  });

  it("maps exact colours in every CSS context and keeps alpha", () => {
    const map = createPagePaletteMapper(palette);
    expect(
      map(
        '<meta name="theme-color" content="#071019"><style>a{color:#83BFFF;background:rgba(131, 191, 255, .35);border-color:#071019cc}</style>' +
          '<p style="color:rgb(7,16,25)">#83bfff stays in text</p><svg><stop stop-color="#83bfff"/></svg>',
      ),
    ).toBe(
      '<meta name="theme-color" content="#0f1512"><style>a{color:#6cc774;background:rgba(108, 199, 116, .35);border-color:#0f1512cc}</style>' +
        '<p style="color:rgb(15,21,18)">#83bfff stays in text</p><svg><stop stop-color="#6cc774"/></svg>',
    );
  });

  it("shifts remaining hues while keeping neutrals, warm colours and scripts", () => {
    const map = createPagePaletteMapper(palette);
    const html =
      '<style>.a{color:#5153d9}.b{color:#fff}.c{color:#b42318}.d{color:#000}</style><script>const c="#5153d9";</script>';
    const mapped = map(html);
    expect(mapped).toContain('<script>const c="#5153d9";</script>');
    expect(mapped).toContain(".b{color:#fff}");
    expect(mapped).toContain(".c{color:#b42318}");
    expect(mapped).toContain(".d{color:#000}");
    expect(mapped).not.toContain(".a{color:#5153d9}");
    const [red, green, blue] = createColorMapper(palette)([81, 83, 217]);
    expect(green).toBeGreaterThan(red);
    expect(green).toBeGreaterThan(blue);
  });

  it("copies scripts verbatim even when they build styled markup", () => {
    const script =
      '<script nonce="n">const html = \'<style>a{color:#83bfff}</style><p style="color:#83bfff">x</p><stop stop-color="#83bfff"/>\';</script>';
    const mapped = createPagePaletteMapper(palette)(
      `<style>a{color:#83bfff}</style>${script}<p style="color:#83bfff">y</p>`,
    );
    expect(mapped).toBe(
      `<style>a{color:#6cc774}</style>${script}<p style="color:#6cc774">y</p>`,
    );
  });

  it("is deterministic", () => {
    const html = "<style>.a{color:#4e9fff;background:rgba(78,159,255,.1)}</style>";
    expect(createPagePaletteMapper(palette)(html)).toBe(
      createPagePaletteMapper(palette)(html),
    );
  });
});
