// Sends every structured-output schema the Worker uses to the Anthropic API with a one-word prompt, so a schema the
// API refuses (e.g. 400 "The compiled grammar is too large", whose limit is not published) fails here, before
// `wrangler deploy`, instead of breaking every capture in production. Costs a fraction of a cent.
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run check:ai
//
// Runs before `npm run deploy` (predeploy). SKIP_AI_CHECK=1 skips it, for a deploy without network or key.
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.env.SKIP_AI_CHECK === "1") {
  console.warn("check:ai skipped (SKIP_AI_CHECK=1)");
  process.exit(0);
}
const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error(
    "check:ai needs ANTHROPIC_API_KEY in this shell (the same key as the Worker secret) to test the AI schemas against the API before deploying.\n" +
      "Set it, or run with SKIP_AI_CHECK=1 to deploy without the check.",
  );
  process.exit(1);
}

// Model names come from wrangler.jsonc, so the check uses what production uses.
const vars = readFileSync("wrangler.jsonc", "utf8");
const modelVar = (name) => vars.match(new RegExp(`"${name}":\\s*"([^"]+)"`))?.[1];
const parseModel = modelVar("PARSE_MODEL");
const adviceModel = modelVar("ADVICE_MODEL");
if (!parseModel || !adviceModel) throw new Error("PARSE_MODEL / ADVICE_MODEL not found in wrangler.jsonc");

// Bundle the TypeScript schemas once into a temporary module.
const dir = mkdtempSync(join(tmpdir(), "muninn-check-ai-"));
const out = join(dir, "schemas.mjs");
await build({
  stdin: {
    contents: `
      export { PARSE_SCHEMAS } from "./worker/core/wire";
      export { AnswerSchema, AdviceSchema, TipWordingSchema } from "./worker/core/schema";
      export { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
      export { default as Anthropic } from "@anthropic-ai/sdk";`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  logLevel: "error",
});
const m = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const client = new m.Anthropic({ apiKey: key, maxRetries: 1, timeout: 60_000 });
// Each request mirrors the Worker's: model, thinking and effort settings, strict JSON output with that schema.
const checks = [
  ["parse (capture)", parseModel, m.PARSE_SCHEMAS.parse_capture],
  ["parse (recall)", parseModel, m.PARSE_SCHEMAS.parse_recall],
  ["answer", parseModel, m.AnswerSchema],
  ["tips", parseModel, m.TipWordingSchema],
  ["advice", adviceModel, m.AdviceSchema],
];
let failed = 0;
for (const [name, model, schema] of checks) {
  try {
    await client.messages.create({
      model,
      max_tokens: model === adviceModel ? 1200 : 16,
      ...(model === parseModel ? { thinking: { type: "disabled" } } : {}),
      output_config: { effort: "low", format: m.zodOutputFormat(schema) },
      messages: [{ role: "user", content: "ok" }],
    });
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}: ${e?.status ?? ""} ${e?.message ?? e}`);
  }
}
if (failed) {
  console.error(`\n${failed} schema(s) refused by the API. Not deploying: every AI call using them would fail.`);
  process.exit(1);
}
console.log("All AI schemas accepted by the API.");
