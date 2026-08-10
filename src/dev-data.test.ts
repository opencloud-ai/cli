import { describe, expect, it } from "vitest";
import { devDataRequest } from "./dev-data.js";

describe("development fixture data", () => {
  it.each([
    [
      "create",
      { values: '{"title":"One"}' },
      { path: "/rest/v1/items", method: "POST", body: { title: "One" } },
    ],
    [
      "createMany",
      { values: '[{"title":"One"},{"title":"Two"}]' },
      {
        path: "/rest/v1/items",
        method: "POST",
        body: [{ title: "One" }, { title: "Two" }],
      },
    ],
    [
      "updateById",
      { id: "row/1", values: '{"title":"Changed"}' },
      {
        path: "/rest/v1/items?id=eq.row%2F1",
        method: "PATCH",
        body: { title: "Changed" },
      },
    ],
    [
      "deleteById",
      { id: "row-1" },
      { path: "/rest/v1/items?id=eq.row-1", method: "DELETE" },
    ],
  ] as const)("maps %s without exposing REST", (action, options, expected) => {
    expect(devDataRequest("items", action, options)).toEqual(expected);
  });

  it("rejects incomplete, malformed, and extraneous inputs", () => {
    expect(() => devDataRequest("Items", "create", { values: "{}" })).toThrow(
      /lowercase SQL identifier/,
    );
    expect(() => devDataRequest("items", "create", {})).toThrow();
    expect(() =>
      devDataRequest("items", "createMany", { values: "{}" }),
    ).toThrow();
    expect(() =>
      devDataRequest("items", "deleteById", { id: "row-1", values: "{}" }),
    ).toThrow();
    expect(() =>
      devDataRequest("items", "updateById", {
        id: "row-1",
        values: "not-json",
      }),
    ).toThrow("--values must be valid JSON");
  });
});
