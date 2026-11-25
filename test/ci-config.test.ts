import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error plain .mjs script without types
import { fillConfig } from "../scripts/ci-config.mjs";

// A committed copy of the config as it is in the repository: the working-tree wrangler.jsonc is edited by
// whoever deploys from their own computer (real database id, optional bindings on), so tests must not read it.
const base = readFileSync("test/fixtures/wrangler.base.jsonc", "utf8");

describe("CI deploy config", () => {
  it("fills the database id and push key, and turns on optional bindings", () => {
    const out: string = fillConfig(base, { D1_DATABASE_ID: "abc-123", VAPID_PUBLIC_KEY: "BPub", ENABLE_VECTORIZE: "true", ENABLE_BACKUPS: "true" });
    expect(out).toContain('"database_id": "abc-123"');
    expect(out).toContain('"VAPID_PUBLIC_KEY": "BPub"');
    expect(out).toMatch(/^\s*"vectorize":/m);
    expect(out).toMatch(/^\s*"r2_buckets":/m);
  });
  it("overwrites values that are already filled in, and leaves enabled bindings alone", () => {
    const local = fillConfig(base, { D1_DATABASE_ID: "old-id", VAPID_PUBLIC_KEY: "OldPub", ENABLE_VECTORIZE: "true", ENABLE_BACKUPS: "true" });
    const out: string = fillConfig(local, { D1_DATABASE_ID: "new-id", VAPID_PUBLIC_KEY: "NewPub", ENABLE_VECTORIZE: "true", ENABLE_BACKUPS: "true" });
    expect(out).toContain('"database_id": "new-id"');
    expect(out).toContain('"VAPID_PUBLIC_KEY": "NewPub"');
    expect(out).not.toContain("old-id");
    expect(out.match(/"vectorize":/g)).toHaveLength(1);
    expect(out).not.toMatch(/\/\/\s*"r2_buckets":/);
  });
  it("the fixture still matches the shape of the real config", () => {
    const real = readFileSync("wrangler.jsonc", "utf8");
    for (const key of ['"database_id":', '"VAPID_PUBLIC_KEY":', '"VAPID_SUBJECT":', '"vectorize":', '"r2_buckets":']) {
      expect(base).toContain(key);
      expect(real).toContain(key);
    }
  });
  it("refuses a config with nothing to fill", () => {
    expect(() => fillConfig("{}", { D1_DATABASE_ID: "a", VAPID_PUBLIC_KEY: "b" })).toThrow(/database_id/);
  });
  it("refuses to deploy without the push key (it would switch push off)", () => {
    expect(() => fillConfig(base, { D1_DATABASE_ID: "abc" })).toThrow(/VAPID_PUBLIC_KEY/);
    expect(() => fillConfig(base, { D1_DATABASE_ID: 'a"b', VAPID_PUBLIC_KEY: "x" })).toThrow();
  });
});
