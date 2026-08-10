import { describe, expect, it } from "vitest";
import { validateMigrationIdConvention } from "./sql-conventions.js";

describe("migration id convention", () => {
  it.each([
    "create table notes (id uuid primary key, body text not null)",
    "create table notes (id uuid not null, body text, primary key (id))",
    'create table "notes" ("id" bigint, constraint notes_pk primary key ("id"))',
  ])("accepts one canonical id primary key: %s", (sql) => {
    expect(() => validateMigrationIdConvention(sql)).not.toThrow();
  });

  it.each([
    "create table notes (note_id uuid primary key, body text)",
    "create table notes (id uuid, body text)",
    'create table notes ("ID" uuid primary key, body text)',
    "create table memberships (user_id uuid, team_id uuid, primary key (user_id, team_id))",
  ])("rejects an app table without the canonical id primary key: %s", (sql) => {
    expect(() => validateMigrationIdConvention(sql)).toThrow(
      /Table notes|Table memberships/,
    );
  });

  it("ignores create-table examples in comments and strings", () => {
    expect(() =>
      validateMigrationIdConvention(
        "-- create table bad (key uuid primary key)\nselect 'create table nope (key uuid)';",
      ),
    ).not.toThrow();
  });
});
