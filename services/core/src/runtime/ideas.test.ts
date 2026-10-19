import { describe, expect, test } from "bun:test";
import { activity, theses } from "@proviso/db";
import { eq } from "drizzle-orm";
import { config } from "../evaluator/conditions.ts";
import { Evaluator } from "../evaluator/engine.ts";
import { priceAbove, spec } from "../evaluator/testkit.ts";
import { insertThesis, setup } from "./fixture.ts";
import { IdeaRegistry } from "./ideas.ts";

const state = async (db: Awaited<ReturnType<typeof setup>>["db"], id: bigint) =>
  (await db.select().from(theses).where(eq(theses.id, id)))[0];

describe("IdeaRegistry", () => {
  test("a valid sealed thesis registers with stamp and expiry from the row; plaintext is never logged", async () => {
    const { db, priv, pub } = await setup();
    const sealed = await insertThesis(db, pub, 1n);
    const logs: string[] = [];
    const ev = new Evaluator(() => {});
    const reg = new IdeaRegistry({ db, evaluator: ev, specKey: priv, config: config({ minHlVolumeUsd: 1000 }), log: (m, e) => logs.push(m + String(e ?? "")) });
    expect(await reg.sync()).toEqual({ added: ["1"], removed: [], invalid: [] });
    const m = ev.get("1")!;
    expect(m.stampedAt).toBe(Date.parse("2026-10-19T00:00:00Z"));
    expect(m.expiresAt).toBe(Date.parse("2026-10-26T00:00:00Z"));
    expect(m.cfg.minHlVolumeUsd).toBe(1000);
    expect(reg.get(1n)?.saltX).toBe(sealed.saltX);
    expect(reg.hlCoins()).toEqual(["BTC"]);
    expect(await reg.sync()).toEqual({ added: [], removed: [], invalid: [] }); // idempotent
    expect(logs.join()).not.toContain(sealed.saltE.slice(2));
    expect(logs.join()).not.toContain(sealed.saltX.slice(2));
  });

  test("a tampered commitment is flagged invalid_commitment, stopped, recorded, and never registered", async () => {
    const { db, priv, pub } = await setup();
    const sealed = await insertThesis(db, pub, 2n, { tamper: true });
    const logs: string[] = [];
    const ev = new Evaluator(() => {});
    const reg = new IdeaRegistry({ db, evaluator: ev, specKey: priv, log: (m, e) => logs.push(m + String(e ?? "")) });
    expect(await reg.sync()).toEqual({ added: [], removed: [], invalid: ["2"] });
    expect(ev.size).toBe(0);
    const row = await state(db, 2n);
    expect(row.state).toBe("stopped");
    expect(row.flags).toEqual(["invalid_commitment"]);
    const acts = await db.select().from(activity);
    expect(acts).toMatchObject([{ kind: "idea_invalid", payload: { thesisId: "2", reason: "invalid_commitment" } }]);
    expect(logs.join()).not.toContain(sealed.saltE.slice(2));
    expect(await reg.sync()).toEqual({ added: [], removed: [], invalid: [] }); // stopped rows are not reloaded
  });

  test("an undecryptable box or a box sealed to another key is invalid", async () => {
    const { db, priv, pub } = await setup();
    await insertThesis(db, pub, 3n, { garbage: true });
    const other = await setup();
    await insertThesis(db, other.pub, 4n);
    const reg = new IdeaRegistry({ db, evaluator: new Evaluator(() => {}), specKey: priv, log: () => {} });
    expect((await reg.sync()).invalid).toEqual(["3", "4"]);
    expect((await state(db, 3n)).state).toBe("stopped");
    expect((await state(db, 4n)).state).toBe("stopped");
  });

  test("state changes: stopped/retired are removed; fired stays in memory but is not evaluated", async () => {
    const { db, priv, pub } = await setup();
    await insertThesis(db, pub, 5n);
    await insertThesis(db, pub, 6n, { spec: spec(priceAbove("ETH", 1)) });
    await insertThesis(db, pub, 7n, { state: "fired" });
    const ev = new Evaluator(() => {});
    const reg = new IdeaRegistry({ db, evaluator: ev, specKey: priv });
    expect((await reg.sync()).added).toEqual(["5", "6", "7"]);
    expect(ev.size).toBe(2);
    expect(reg.get(7n)).toBeDefined();
    await db.update(theses).set({ state: "stopped" }).where(eq(theses.id, 5n));
    await db.update(theses).set({ state: "retired" }).where(eq(theses.id, 6n));
    expect((await reg.sync()).removed).toEqual(["5", "6"]);
    expect(ev.size).toBe(0);
    expect(reg.size).toBe(1);
  });
});
