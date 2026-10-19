// Sanity check for the generated eval set: every expected rule must parse.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Spec } from "@proviso/dsl";

const xs = JSON.parse(readFileSync(join(import.meta.dir, "ideas.json"), "utf8"));
const bad = xs.filter((x: { ambiguous: boolean; expected: unknown }) => !x.ambiguous && !Spec.safeParse(x.expected).success);
console.log(`${xs.length} ideas, ${bad.length} invalid expected rules`);
process.exit(bad.length ? 1 : 0);
