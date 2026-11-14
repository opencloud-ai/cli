import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// The docs build's dependency-free copy must render exactly like this one.
import * as docsCopy from "../../../docs/site/.vitepress/installation-sections.mjs";
import {
  CANONICAL_INSTALLATION_FEATURES,
  renderInstallationSections,
  type InstallationTextFeatures,
} from "./installation-sections.js";

const personal: InstallationTextFeatures = {
  organisations: false,
  clientPlugin: false,
};

const source = [
  "Shared start.",
  "<!-- installation: organisations -->",
  "Create or join an organisation.",
  "<!-- /installation -->",
  "   <!-- installation: personal -->",
  "   Build in your own account.",
  "   <!-- /installation -->",
  "<!-- installation: client-plugin -->",
  "Install the plugin.",
  "<!-- /installation -->",
  "<!-- installation: no-client-plugin -->",
  "Add the hosted connector.",
  "<!-- /installation -->",
  "Shared end.",
  "",
].join("\n");

describe("renderInstallationSections", () => {
  it("keeps the canonical organisation and plugin blocks without markers", () => {
    expect(
      renderInstallationSections(source, CANONICAL_INSTALLATION_FEATURES),
    ).toBe(
      "Shared start.\nCreate or join an organisation.\nInstall the plugin.\nShared end.\n",
    );
  });

  it("keeps the personal and connector blocks for a personal brand", () => {
    expect(renderInstallationSections(source, personal)).toBe(
      "Shared start.\n   Build in your own account.\nAdd the hosted connector.\nShared end.\n",
    );
  });

  it("leaves text without markers unchanged, including CRLF line endings", () => {
    const text = "One\r\nTwo\r\n<!-- a comment -->\r\n";
    expect(renderInstallationSections(text, personal)).toBe(text);
    expect(
      renderInstallationSections(
        "A\r\n<!-- installation: personal -->\r\nB\r\n<!-- /installation -->\r\nC",
        CANONICAL_INSTALLATION_FEATURES,
      ),
    ).toBe("A\r\nC");
  });

  it.each([
    ["<!-- installation: everyone -->\nx\n<!-- /installation -->", /Unknown installation section "everyone" on line 1/],
    ["<!-- installation: constructor -->\nx\n<!-- /installation -->", /Unknown installation section/],
    ["<!-- installation: personal -->\n<!-- installation: organisations -->\n<!-- /installation -->", /opens inside the section from line 1/],
    ["x\n<!-- /installation -->", /line 2 has no opening marker/],
    ["<!-- installation: personal -->\nx", /"personal" from line 1 is never closed/],
  ])("rejects malformed markers: %s", (text, error) => {
    expect(() => renderInstallationSections(text, personal)).toThrow(error);
    expect(() => docsCopy.renderInstallationSections(text, personal)).toThrow(error);
  });

  it("matches the docs build copy on every repository source", () => {
    expect(docsCopy.CANONICAL_INSTALLATION_FEATURES).toEqual(
      CANONICAL_INSTALLATION_FEATURES,
    );
    const skill = readFileSync(
      new URL("../../../SKILL.md", import.meta.url),
      "utf8",
    );
    for (const text of [source, skill]) {
      for (const features of [CANONICAL_INSTALLATION_FEATURES, personal]) {
        const rendered = renderInstallationSections(text, features);
        expect(docsCopy.renderInstallationSections(text, features)).toBe(rendered);
        expect(rendered).not.toMatch(/<!-- \/?installation/);
      }
    }
  });
});
