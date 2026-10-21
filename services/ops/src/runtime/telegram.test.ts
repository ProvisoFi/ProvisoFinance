import { beforeEach, describe, expect, mock, test } from "bun:test";
import { follows, telegramCodes, telegramLinks, theses, users, type Db } from "@proviso/db";
import { createTestDb } from "@proviso/db/testing";
import { notifyHandler } from "./notify";
import { confirmData, confirmKeyboard, parseConfirmData, telegramHandlers, type BotCtx, type ConfirmMsg } from "./telegram";

const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";
const NOW = new Date("2026-10-20T10:00:00Z");
const FIRE = "0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";

let db: Db;
let confirms: ConfirmMsg[];
let h: ReturnType<typeof telegramHandlers>;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(users).values([{ address: ALICE }, { address: BOB }]);
  confirms = [];
  h = telegramHandlers(db, { sendConfirm: async (m) => void confirms.push(m), now: () => NOW });
});

function ctx(chatId: number, extra: Partial<BotCtx> = {}) {
  const replies: string[] = [];
  const answers: (string | undefined)[] = [];
  const c: BotCtx = {
    chat: { id: chatId, type: "private" },
    from: { id: chatId },
    reply: async (t) => void replies.push(t),
    answerCallbackQuery: async (t) => void answers.push(t),
    ...extra,
  };
  return { c, replies, answers };
}
const links = () => db.select().from(telegramLinks);

describe("/start", () => {
  test("a valid code links the chat once and is consumed", async () => {
    await db.insert(telegramCodes).values({ code: "abc123", address: ALICE, expiresAt: new Date(NOW.getTime() + 600_000) });
    const { c, replies } = ctx(42, { match: " abc123 " });
    await h.start(c);
    expect(replies).toEqual(["Linked"]);
    expect((await links()).map((l) => [l.address, l.chatId])).toEqual([[ALICE, 42n]]);
    expect(await db.select().from(telegramCodes)).toHaveLength(0);

    const again = ctx(43, { match: "abc123" });
    await h.start(again.c);
    expect(again.replies[0]).toContain("invalid or expired");
    expect(await links()).toHaveLength(1);
  });

  test("an expired code doesn't link; no code gets instructions", async () => {
    await db.insert(telegramCodes).values({ code: "old", address: ALICE, expiresAt: new Date(NOW.getTime() - 1) });
    const { c, replies } = ctx(42, { match: "old" });
    await h.start(c);
    expect(replies[0]).toContain("invalid or expired");
    expect(await links()).toHaveLength(0);

    const bare = ctx(42, { match: "" });
    await h.start(bare.c);
    expect(bare.replies[0]).toContain("Proviso settings");
  });

  test("relinking moves the address to the new chat, and a chat to the new address", async () => {
    const exp = new Date(NOW.getTime() + 600_000);
    await db.insert(telegramCodes).values([
      { code: "c1", address: ALICE, expiresAt: exp },
      { code: "c2", address: ALICE, expiresAt: exp },
      { code: "c3", address: BOB, expiresAt: exp },
    ]);
    await h.start(ctx(1, { match: "c1" }).c);
    await h.start(ctx(2, { match: "c2" }).c); // Alice moves to chat 2
    await h.start(ctx(2, { match: "c3" }).c); // chat 2 now belongs to Bob
    expect((await links()).map((l) => [l.address, l.chatId])).toEqual([[BOB, 2n]]);
  });
});

describe("/stop and /status", () => {
  beforeEach(async () => {
    await db.insert(telegramLinks).values({ address: ALICE, chatId: 42n });
    const base = { owner: ALICE, encSpec: new Uint8Array([1, 2, 3]), entryHash: "0xSECRETENTRY", exitHash: "0xSECRETEXIT", mode: "live", signedAt: NOW, stampedAt: NOW, sealTx: "0x1", expiresAt: NOW };
    await db.insert(theses).values([
      { ...base, id: 7n, state: "live" },
      { ...base, id: 3n, state: "alert" },
      { ...base, id: 9n, state: "closed" },
      { ...base, id: 11n, owner: BOB, state: "live" },
    ]);
  });

  test("status lists only the linked address's live ideas: ids and states", async () => {
    const { c, replies } = ctx(42);
    await h.status(c);
    expect(replies).toEqual(["Live ideas:\n#3 alert\n#7 live"]);
    expect(replies[0]).not.toContain("SECRET");

    const stranger = ctx(99);
    await h.status(stranger.c);
    expect(stranger.replies[0]).toContain("isn't linked");
  });

  test("stop unlinks", async () => {
    const { c, replies } = ctx(42);
    await h.stop(c);
    expect(replies[0]).toContain("Unlinked");
    expect(await links()).toHaveLength(0);
    const again = ctx(42);
    await h.stop(again.c);
    expect(again.replies[0]).toContain("isn't linked");
  });
});

describe("group chats", () => {
  test("link, stop, status and confirm are refused outside a private chat or from another sender", async () => {
    await db.insert(telegramCodes).values({ code: "g1", address: ALICE, expiresAt: new Date(NOW.getTime() + 600_000) });
    const group = (extra: Partial<BotCtx> = {}) => ctx(-100, { chat: { id: -100, type: "group" }, from: { id: 7 }, ...extra });
    const g = group({ match: "g1" });
    await h.start(g.c);
    expect(g.replies[0]).toContain("private chat");
    expect(await links()).toHaveLength(0);
    expect(await db.select().from(telegramCodes)).toHaveLength(1); // code not consumed

    // a group already linked (before this check) can't be driven either
    await db.insert(telegramLinks).values({ address: ALICE, chatId: -100n });
    const [f] = await db.insert(follows).values({ follower: ALICE, caller: BOB, sizeRule: {}, limits: {} }).returning();
    for (const fn of [h.status, h.stop] as const) {
      const r = group();
      await fn(r.c);
      expect(r.replies[0]).toContain("private chat");
    }
    expect(await links()).toHaveLength(1);
    const cb = group({ callbackQuery: { data: confirmData(f!.id, FIRE) } });
    await h.callback(cb.c);
    expect(cb.answers[0]).not.toBe("Confirmed");

    // a private-looking chat whose sender isn't the chat's user (e.g. a forwarded/anonymous update)
    await db.insert(telegramLinks).values({ address: BOB, chatId: 43n });
    const spoof = ctx(43, { from: { id: 999 }, callbackQuery: { data: confirmData(f!.id, FIRE) } });
    await h.callback(spoof.c);
    await h.status(spoof.c);
    expect(spoof.answers[0]).not.toBe("Confirmed");
    expect(spoof.replies[0]).toContain("private chat");
    expect(confirms).toHaveLength(0);
  });
});

describe("confirm button", () => {
  let followId: string;
  beforeEach(async () => {
    await db.insert(telegramLinks).values([
      { address: ALICE, chatId: 42n },
      { address: BOB, chatId: 43n },
    ]);
    const [f] = await db.insert(follows).values({ follower: ALICE, caller: BOB, sizeRule: {}, limits: {} }).returning();
    followId = f!.id;
  });

  test("callback data fits Telegram's 64 bytes and round-trips", () => {
    const d = confirmData(followId, FIRE);
    expect(d.length).toBeLessThanOrEqual(64);
    expect(parseConfirmData(d)).toEqual({ followId, fireId: FIRE });
    expect(parseConfirmData("x:whatever")).toBeNull();
    expect(() => confirmData("not-a-uuid", FIRE)).toThrow();
  });

  test("pressing it sends {followId, fireId, address, at} to the confirm queue", async () => {
    const data = confirmKeyboard({ followId, thesisId: 5, fireId: FIRE }).inline_keyboard[0]![0]!.callback_data;
    const { c, answers } = ctx(42, { callbackQuery: { data } });
    await h.callback(c);
    expect(confirms).toEqual([{ followId, fireId: FIRE, address: ALICE, at: NOW.toISOString() }]);
    expect(answers).toEqual(["Confirmed"]);
  });

  test("another account's chat, an unlinked chat or junk data sends nothing", async () => {
    const data = confirmData(followId, FIRE);
    for (const [chat, d] of [[43, data], [99, data], [42, "c:junk"]] as const) {
      const { c, answers } = ctx(chat, { callbackQuery: { data: d } });
      await h.callback(c);
      expect(answers[0]).not.toBe("Confirmed");
    }
    expect(confirms).toHaveLength(0);
  });

  test("a notify message with confirm passes it to the Telegram sender", async () => {
    const telegram = mock(async (_chat: bigint, _text: string, _confirm?: unknown) => {});
    const confirm = { followId, thesisId: "5", fireId: FIRE };
    await notifyHandler(db, { telegram })({ address: ALICE, title: "Copy idea #5?", body: "Tap to confirm", confirm });
    expect(telegram.mock.calls[0]).toEqual([42n, "Copy idea #5?\nTap to confirm", confirm]);
  });
});
