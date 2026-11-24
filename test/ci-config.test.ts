import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error plain .mjs script without types
import { fillConfig } from "../scripts/ci-config.mjs";

const base = readFileSync("wrangler.jsonc", "utf8");

describe("CI deploy config", () => {
  it("fills the database id and push key, and turns on optional bindings", () => {
    const out: string = fillConfig(base, { D1_DATABASE_ID: "abc-123", VAPID_PUBLIC_KEY: "BPub", ENABLE_VECTORIZE: "true", ENABLE_BACKUPS: "true" });
    expect(out).toContain('"database_id": "abc-123"');
    expect(out).toContain('"VAPID_PUBLIC_KEY": "BPub"');
    expect(out).toMatch(/^\s*"vectorize":/m);
    expect(out).toMatch(/^\s*"r2_buckets":/m);
  });
  it("refuses to deploy without the push key (it would switch push off)", () => {
    expect(() => fillConfig(base, { D1_DATABASE_ID: "abc" })).toThrow(/VAPID_PUBLIC_KEY/);
    expect(() => fillConfig(base, { D1_DATABASE_ID: 'a"b', VAPID_PUBLIC_KEY: "x" })).toThrow();
  });
});
