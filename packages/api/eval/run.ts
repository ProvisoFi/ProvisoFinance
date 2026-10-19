// Writer eval gate (Backend §12): ≥ 97% exact-rule match on unambiguous ideas and 100% of
// ambiguous ideas flagged. Needs WRITER_MODEL and AI Gateway credentials (AI_GATEWAY_API_KEY,
// or VERCEL_OIDC_TOKEN from `vercel env pull`).
//   bun packages/api/eval/run.ts [--limit N] [--concurrency N]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, Spec } from "@proviso/dsl";
import { draftRule } from "../src/writer";

type Item = { id: string; text: string; ambiguous: boolean; expected?: unknown };
const items: Item[] = JSON.parse(readFileSync(join(import.meta.dir, "ideas.json"), "utf8"));
const arg = (k: string, d: number) => Number(process.argv[process.argv.indexOf(k) + 1] || d);
const limit = process.argv.includes("--limit") ? arg("--limit", items.length) : items.length;
const conc = arg("--concurrency", 8);

const same = (a: unknown, b: unknown) => {
  const dec = new TextDecoder();
  return dec.decode(canonicalize(Spec.parse(a))) === dec.decode(canonicalize(Spec.parse(b)));
};

const results: { id: string; ambiguous: boolean; pass: boolean; why?: string }[] = [];
const queue = items.slice(0, limit);
await Promise.all(
  Array.from({ length: conc }, async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      try {
        const d = await draftRule(it.text);
        const pass = it.ambiguous ? d.ambiguities.length > 0 : d.ambiguities.length === 0 && same(d.spec, it.expected);
        results.push({ id: it.id, ambiguous: it.ambiguous, pass, why: pass ? undefined : JSON.stringify(d) });
      } catch (e) {
        results.push({ id: it.id, ambiguous: it.ambiguous, pass: false, why: String(e) });
      }
    }
  }),
);

const rate = (xs: typeof results) => (xs.length ? xs.filter((r) => r.pass).length / xs.length : 1);
const clear = results.filter((r) => !r.ambiguous);
const vague = results.filter((r) => r.ambiguous);
for (const r of results.filter((r) => !r.pass).slice(0, 20)) console.log(`FAIL ${r.id}: ${r.why?.slice(0, 300)}`);
console.log(`exact match ${(rate(clear) * 100).toFixed(1)}% of ${clear.length} · ambiguity flagged ${(rate(vague) * 100).toFixed(1)}% of ${vague.length}`);
const ok = rate(clear) >= 0.97 && rate(vague) === 1;
console.log(ok ? "GATE PASSED" : "GATE FAILED");
process.exit(ok ? 0 : 1);
