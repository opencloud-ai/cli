import { describe, expect, it } from "vitest";
import {
  OPEN_CLOUD_FAVICON_DATA_URI,
  OPEN_CLOUD_LOGO_DATA_URI,
} from "./brand.generated.js";

function pngDimensions(dataUri: string): [number, number] {
  expect(dataUri).toMatch(/^data:image\/png;base64,/);
  const image = Buffer.from(dataUri.split(",", 2)[1] ?? "", "base64");
  expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [image.readUInt32BE(16), image.readUInt32BE(20)];
}

describe("OpenCloud brand assets", () => {
  it("exports a two-density interface logo", () => {
    expect(pngDimensions(OPEN_CLOUD_LOGO_DATA_URI)).toEqual([96, 96]);
  });

  it("exports a purpose-sized browser icon", () => {
    expect(pngDimensions(OPEN_CLOUD_FAVICON_DATA_URI)).toEqual([32, 32]);
  });
});
