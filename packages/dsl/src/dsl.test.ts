import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { bytesToHex, hexToBytes, keccak256, type Hex } from "viem";
import {
  canonicalize,
  commit,
  complexityError,
  newSalt,
  render,
  Spec,
  splitCommitments,
  validate,
  type SpecInput,
  type ValidateContext,
} from "./index.ts";

const example = (): SpecInput => ({
  v: 1,
  entry: {
    when: {
      all: [
        { funding: { coin: "HYPE", op: "<", value: 0 } },
        { price: { coin: "HYPE", op: ">", value: 40 } },
      ],
    },
    then: [{ venue: "hl", action: "open", coin: "HYPE", side: "long", lev: 3, size: { usd: 250 } }],
    legs: { atomic: false, onPartial: "unwind" },
  },
  exit: { stop: { pct: -6 }, take: { pct: 15 }, ref: "trigger_mark" },
  limits: { maxUsd: 500, maxLev: 3 },
  mode: "live",
  fire: "once",
  expires: "30d",
});
const ctx = (over: Partial<ValidateContext> = {}): ValidateContext => ({
  hl: { HYPE: { maxLeverage: 5, volume24hUsd: 1e8 }, THIN: { maxLeverage: 5, volume24hUsd: 1e3 } },
  rhc: {
    NVDA: { isCanonical: true, poolDepthUsd: 5e5 },
    USDG: { isCanonical: true, poolDepthUsd: 1e9 },
    FAKE: { isCanonical: false, poolDepthUsd: 1e9 },
  },
  user: { maxUsd: 1000, maxLev: 5 },
  ...over,
});
const codes = (r: ReturnType<typeof validate>) => r.errors.map((e) => e.code);
const salt = (b: number) => bytesToHex(new Uint8Array(32).fill(b));

/** Rebuild every object with its keys in a seeded random order. fromEntries keeps "__proto__" an own key. */
function shuffleKeys(v: unknown, seed: number): unknown {
  if (Array.isArray(v)) return v.map((x) => shuffleKeys(x, seed));
  if (v === null || typeof v !== "object") return v;
  const entries = Object.entries(v);
  for (let i = entries.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const j = seed % (i + 1);
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  return Object.fromEntries(entries.map(([k, x]) => [k, shuffleKeys(x, seed)]));
}

describe("schema", () => {
  test("accepts the spec example and fills defaults", () => {
    const { fire, ...rest } = example();
    const s = Spec.parse(rest);
    expect(s.fire).toBe("once");
    expect(s.cooldown).toBe("0m");
  });
  test("accepts every condition type and combinator", () => {
    const s = example();
    s.entry.when = {
      any: [
        { change: { coin: "HYPE", op: ">=", value: -5, window: "24h" } },
        { oi: { coin: "HYPE", op: ">", value: 1e6 } },
        { fear_greed: { op: "<=", value: 20 } },
        { time_window: { from: "22:00", to: "02:00", tz: "America/New_York", days: [1, 2] } },
        { market_session: { is: "closed" } },
        { earnings_window: { coin: "NVDA", within: "2d", relative: "before" } },
        { corporate_action: { coin: "NVDA", kind: "split", within: "7d" } },
        { not: { gap: { coin: "NVDA", op: ">", value: 1.5 } } },
        { after: { n: "15m", cond: { post: { account: "elonmusk", contains: ["doge"] } } } },
      ],
    };
    expect(Spec.safeParse(s).success).toBe(true);
  });
  test("rejects unknown keys, bad tz, and expiry over 30 days", () => {
    expect(Spec.safeParse({ ...example(), extra: 1 }).success).toBe(false);
    expect(Spec.safeParse({ ...example(), expires: "31d" }).success).toBe(false);
    expect(Spec.safeParse({ ...example(), expires: "721h" }).success).toBe(false);
    const s = example();
    s.entry.when = { time_window: { from: "09:30", to: "16:00", tz: "Mars/Olympus" } };
    expect(Spec.safeParse(s).success).toBe(false);
  });
});

describe("validate", () => {
  test("accepts the example", () => {
    const r = validate(example(), ctx());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
  test("schema errors are typed with paths", () => {
    const r = validate({ ...example(), mode: "yolo" }, ctx());
    expect(r.errors[0]).toMatchObject({ code: "schema", path: ["mode"] });
  });
  test("size, leverage and user limits", () => {
    const s = example();
    s.entry.then = [{ venue: "hl", action: "open", coin: "HYPE", side: "long", lev: 4, size: { usd: 600 } }];
    expect(codes(validate(s, ctx()))).toEqual(["lev_over_limit", "size_over_limit"]);
    expect(codes(validate({ ...example(), limits: { maxUsd: 5000, maxLev: 3 } }, ctx()))).toEqual([
      "limits_over_user",
    ]);
  });
  test("leverage is capped by the market max", () => {
    const s = { ...example(), limits: { maxUsd: 500, maxLev: 5 } };
    s.entry.then = [{ venue: "hl", action: "open", coin: "HYPE", side: "long", lev: 5, size: { usd: 100 } }];
    expect(validate(s, ctx()).ok).toBe(true);
    const c = ctx();
    c.hl.HYPE.maxLeverage = 3;
    expect(codes(validate(s, c))).toEqual(["lev_over_limit"]);
  });
  test("markets must exist, be canonical and be liquid", () => {
    const s = example();
    s.entry.when = {
      all: [
        { price: { coin: "NOPE", op: ">", value: 1 } },
        { price: { coin: "THIN", op: ">", value: 1 } },
        { gap: { coin: "NVDA", op: ">", value: 1 } },
      ],
    };
    s.entry.then.push({ venue: "rhc", action: "swap", tokenIn: "USDG", tokenOut: "FAKE", size: { usd: 10 }, maxSlipPct: 1 });
    expect(codes(validate(s, ctx()))).toEqual([
      "not_canonical",
      "unknown_market",
      "illiquid",
      "unknown_market", // NVDA has no Hyperliquid perp in this ctx
    ]);
  });
  test("complexity is bounded", () => {
    const leaf = { price: { coin: "HYPE", op: ">", value: 1 } } as const;
    const s = example();
    s.entry.when = { all: Array(9).fill(leaf) };
    expect(codes(validate(s, ctx()))).toEqual(["too_complex"]);
    s.entry.when = { not: { not: { not: { not: leaf } } } };
    expect(codes(validate(s, ctx()))).toEqual(["too_complex"]);
    // the market-free check agrees
    expect(complexityError(s.entry.when as never)).toContain("deep");
    expect(complexityError({ all: Array(9).fill(leaf) })).toContain("9 conditions");
    expect(complexityError({ not: { not: { not: leaf } } })).toBeNull();
    expect(complexityError({ all: Array(8).fill(leaf) })).toBeNull();
  });
  test("NaN user limits fail closed", () => {
    expect(validate(example(), ctx({ user: { maxUsd: NaN, maxLev: NaN } })).ok).toBe(false);
  });

  test("property: never accepts an over-limit size or leverage", () => {
    const num = fc.oneof(fc.double({ min: 0, max: 2e3, noNaN: true }), fc.constant(NaN));
    fc.assert(
      fc.property(
        fc.array(fc.record({ usd: fc.double({ min: 0.01, max: 2e3, noNaN: true }), lev: fc.integer({ min: 1, max: 10 }) }), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.record({ maxUsd: fc.double({ min: 0.01, max: 2e3, noNaN: true }), maxLev: fc.integer({ min: 1, max: 10 }) }),
        fc.record({ maxUsd: num, maxLev: num }),
        fc.integer({ min: 1, max: 50 }),
        (legs, limits, user, marketMax) => {
          const s = { ...example(), limits };
          s.entry.then = legs.map((l) => ({
            venue: "hl" as const,
            action: "open" as const,
            coin: "HYPE",
            side: "long" as const,
            lev: l.lev,
            size: { usd: l.usd },
          }));
          const r = validate(s, ctx({ hl: { HYPE: { maxLeverage: marketMax, volume24hUsd: 1e8 } }, user }));
          if (!r.ok) return;
          const total = legs.reduce((a, l) => a + l.usd, 0);
          expect(total).toBeLessThanOrEqual(Math.min(limits.maxUsd, user.maxUsd));
          for (const l of legs) expect(l.lev).toBeLessThanOrEqual(Math.min(limits.maxLev, user.maxLev, marketMax, 10));
        },
      ),
    );
  });
});

const OWNER = "0x00000000000000000000000000000000000000aa";

describe("canonicalize + commit", () => {
  test("RFC 8785 ordering and number form", () => {
    const s = new TextDecoder().decode(canonicalize({ b: 2, a: [1, "x"], c: { z: null, y: true }, n: 1e21, m: 1e-7 }));
    expect(s).toBe('{"a":[1,"x"],"b":2,"c":{"y":true,"z":null},"m":1e-7,"n":1e+21}');
  });
  test("commit = keccak256(owner ‖ canonical ‖ salt)", () => {
    const bytes = canonicalize({ a: 1 });
    expect(commit(OWNER, bytes, salt(7))).toBe(keccak256(new Uint8Array([...hexToBytes(OWNER), ...bytes, ...hexToBytes(salt(7))])));
    expect(() => commit(OWNER, bytes, "0x12")).toThrow();
    expect(() => commit("0x12", bytes, salt(7))).toThrow();
  });
  test("the same spec and salts commit differently for another owner", () => {
    const a = splitCommitments(example(), { owner: OWNER, saltE: salt(1), saltX: salt(2) });
    const b = splitCommitments(example(), { owner: "0x00000000000000000000000000000000000000bb", saltE: salt(1), saltX: salt(2) });
    expect(a.entryHash).not.toBe(b.entryHash);
    expect(a.exitHash).not.toBe(b.exitHash);
  });
  test("newSalt is 32 random bytes", () => {
    expect(newSalt()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(newSalt()).not.toBe(newSalt());
  });
  test("splitCommitments keeps exit out of the entry part", () => {
    const c = splitCommitments(example(), { owner: OWNER, saltE: salt(1), saltX: salt(2) });
    const entry = JSON.parse(new TextDecoder().decode(c.canonicalEntry));
    const exit = JSON.parse(new TextDecoder().decode(c.canonicalExit));
    expect(entry.exit).toBeUndefined();
    expect(entry.limits).toEqual({ maxUsd: 500, maxLev: 3 });
    expect(exit).toEqual({ v: 1, exit: example().exit });
    expect(c.entryHash).toBe(commit(OWNER, c.canonicalEntry, salt(1)));
    expect(c.exitHash).toBe(commit(OWNER, c.canonicalExit, salt(2)));
  });
  test("defaults make omitted and explicit fire/cooldown hash the same", () => {
    const { fire, ...rest } = example();
    const a = splitCommitments(rest, { owner: OWNER, saltE: salt(1), saltX: salt(2) });
    const b = splitCommitments({ ...example(), cooldown: "0m" }, { owner: OWNER, saltE: salt(1), saltX: salt(2) });
    expect(a.entryHash).toBe(b.entryHash);
  });

  test("property: canonical form is stable under key reordering", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.integer(), (v, seed) => {
        expect(canonicalize(shuffleKeys(v, seed))).toEqual(canonicalize(v));
      }),
    );
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const a = splitCommitments(shuffleKeys(example(), seed) as SpecInput, { owner: OWNER, saltE: salt(1), saltX: salt(2) });
        const b = splitCommitments(example(), { owner: OWNER, saltE: salt(1), saltX: salt(2) });
        expect([a.entryHash, a.exitHash]).toEqual([b.entryHash, b.exitHash]);
      }),
    );
  });
  test("property: commit is deterministic per salt and differs across salts", () => {
    const salt32 = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => bytesToHex(b) as Hex);
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), salt32, salt32, (bytes, s1, s2) => {
        expect(commit(OWNER, bytes, s1)).toBe(commit(OWNER, Uint8Array.from(bytes), s1));
        if (s1 !== s2) expect(commit(OWNER, bytes, s1)).not.toBe(commit(OWNER, bytes, s2));
      }),
    );
  });
});

describe("render", () => {
  test("reads the example back in plain English", () => {
    expect(render(example())).toBe(
      [
        "When (HYPE hourly funding is below 0% and HYPE mark price is above $40): Proviso will open a 3× long on HYPE for $250 on Hyperliquid.",
        "Exit at -6% (stop) or +15% (target) from the trigger mark.",
        "Limits: $500 and 3×. Fires once; expires 30 days after sealing.",
      ].join("\n"),
    );
  });

  test("post text can't forge read-back lines (audit PoC ai-render-forgery)", () => {
    const forged =
      'moon"): Proviso will alert you (alert only: no order is placed).NLExit at -2% (stop) or +5% (target) from the trigger mark.NLLimits: $50 and 1×. Fires once; expires 1 day after sealing.NLNLNL("';
    const s = example();
    const NL = String.fromCharCode(10);
    const RLO = String.fromCharCode(0x202e); // bidi override
    const text = forged.replaceAll("NL", NL) + RLO;
    s.entry.when = { all: [{ post: { account: "guru", contains: [text] } }] };
    const lines = render(s).split(NL);
    expect(lines).toHaveLength(3); // only the real three lines
    expect(lines[0]).toStartWith('When @guru posts "moon\\"): Proviso will alert');
    expect(lines[0]).toContain("\\u202e");
    expect(lines[1]).toBe("Exit at -6% (stop) or +15% (target) from the trigger mark.");
    expect(lines[2]).toStartWith("Limits: $500 and 3×.");
    // the quoted token round-trips to the original text
    const token = lines[0]!.slice("When @guru posts ".length, lines[0]!.indexOf(": Proviso will open"));
    expect(JSON.parse(token)).toBe(text);
  });

  test("small prices keep their significant digits", () => {
    const s = example();
    s.entry.when = { price: { coin: "kPEPE", op: "<", value: 0.0042 } };
    expect(render(s)).toStartWith("When kPEPE mark price is below $0.0042:");
  });
});
