import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error plain .mjs script without types
import { compareBindings, configBindings, liveBindings, stripJsonc } from "../scripts/check-live-config.mjs";
// @ts-expect-error plain .mjs script without types
import { fillConfig } from "../scripts/ci-config.mjs";

const base = readFileSync("test/fixtures/wrangler.base.jsonc", "utf8");
const env = { D1_DATABASE_ID: "db-1", VAPID_PUBLIC_KEY: "BPub", VAPID_SUBJECT: "mailto:me@example.com", ENABLE_BACKUPS: "true" };
const next = (e: Record<string, string> = env) => configBindings(JSON.parse(stripJsonc(fillConfig(base, e))));

// What the Cloudflare settings API returns for the Worker as it is deployed today.
const liveApi = [
  { type: "d1", name: "DB", id: "db-1" },
  { type: "r2_bucket", name: "BACKUPS", bucket_name: "muninn-backups" },
  { type: "ai", name: "AI" },
  { type: "assets", name: "ASSETS" },
  { type: "plain_text", name: "PARSE_MODEL", text: "claude-haiku-5-5" },
  { type: "plain_text", name: "VAPID_PUBLIC_KEY", text: "BPub" },
  { type: "plain_text", name: "VAPID_SUBJECT", text: "mailto:me@example.com" },
  { type: "secret_text", name: "DATA_KEY" },
  { type: "secret_text", name: "GOOGLE_CLIENT_SECRET" },
];

describe("stripJsonc", () => {
  it("parses the real config shape: comments, URLs in strings, trailing commas", () => {
    const cfg = JSON.parse(stripJsonc(base));
    expect(cfg.name).toBe("muninn");
    expect(cfg.d1_databases[0].binding).toBe("DB");
    expect(cfg.r2_buckets).toBeUndefined(); // commented out in the repository copy
    expect(JSON.parse(stripJsonc('{ "u": "https://x//y", /* c */ "a": [1, 2,], }'))).toEqual({ u: "https://x//y", a: [1, 2] });
    expect(JSON.parse(stripJsonc('{ "q": "say \\"hi\\" // not a comment" }'))).toEqual({ q: 'say "hi" // not a comment' });
  });
});

describe("live config check", () => {
  it("passes when the new config matches the live Worker, ignoring secrets", () => {
    const { stops } = compareBindings(liveBindings(liveApi), next());
    expect(stops).toEqual([]);
  });
  it("stops when ENABLE_BACKUPS is forgotten, which would unbind the R2 bucket", () => {
    const { stops } = compareBindings(liveBindings(liveApi), next({ ...env, ENABLE_BACKUPS: "" }));
    expect(stops).toHaveLength(1);
    expect(stops[0]).toContain("BACKUPS");
  });
  it("stops when the push key or subject would change, or the database id differs", () => {
    const { stops } = compareBindings(liveBindings(liveApi), next({ ...env, VAPID_PUBLIC_KEY: "Other", VAPID_SUBJECT: "", D1_DATABASE_ID: "db-2" }));
    expect(stops.join("\n")).toMatch(/VAPID_PUBLIC_KEY/);
    expect(stops.join("\n")).toMatch(/VAPID_SUBJECT/);
    expect(stops.join("\n")).toMatch(/DB \(d1\)/);
    expect(stops.join("\n")).not.toContain("Other"); // names only, never values
  });
  it("only notes a changed model or a new binding", () => {
    const live = liveBindings(liveApi.map((b) => (b.name === "PARSE_MODEL" ? { ...b, text: "old-model" } : b)).filter((b) => b.name !== "AI"));
    const { stops, notes } = compareBindings(live, next());
    expect(stops).toEqual([]);
    expect(notes.join("\n")).toMatch(/PARSE_MODEL changes value/);
    expect(notes.join("\n")).toMatch(/AI \(ai\) is new/);
  });
  it("stops when a binding changes type", () => {
    const live = liveBindings([{ type: "kv_namespace", name: "BACKUPS", namespace_id: "x" }]);
    expect(compareBindings(live, next()).stops[0]).toMatch(/change type/);
  });
});
