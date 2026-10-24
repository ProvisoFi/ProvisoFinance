// The rule an AI assistant hands over through MCP prepare_seal (expansion section 6 #4).
import { Spec } from "@proviso/dsl";
/** A rule from an MCP prepare_seal link (`#rule=<base64url JSON>`), or null if absent or not a valid rule. */
export function ruleFromHash(hash: string): Spec | null {
  const m = /(?:^#|&)rule=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  try {
    const b64 = m[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")), (ch) => ch.charCodeAt(0)));
    const r = Spec.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
