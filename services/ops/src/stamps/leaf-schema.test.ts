import { expect, test } from "bun:test";
import { fillModelFor, sessionOf } from "./leaf";

test("sessionOf: Hyperliquid crypto perps are 24/7; HIP-3 carries its session-guard state; no market, no session", () => {
  const at = new Date("2026-10-24T03:00:00Z"); // Friday 23:00 New York
  expect(sessionOf("hl:BTC", at)).toBe("24/7");
  expect(sessionOf("hl:xyz:TSLA", at)).toBe("closed");
  expect(sessionOf("hl:xyz:TSLA", new Date("2026-10-21T14:00:00Z"))).toBe("open");
  expect(sessionOf("hl:xyz:SKHX", new Date("2026-10-09T02:00:00Z"))).toBe("holiday");
  expect(sessionOf("hl:xyz:CORN", at)).toBe("unknown");
  expect(sessionOf(null, at)).toBeNull();
  expect(sessionOf("cex:BTC", at)).toBeNull();
});

test("sessionOf: Robinhood Chain Stock Tokens follow the US equity clock in New York time, across daylight saving", () => {
  const s = (iso: string) => sessionOf("rhc:TSLA", new Date(iso));
  // Wednesday 2026-10-21 (EDT, UTC-4)
  expect(s("2026-10-21T07:59:00Z")).toBe("closed"); // 03:59
  expect(s("2026-10-21T08:00:00Z")).toBe("pre"); // 04:00
  expect(s("2026-10-21T13:29:00Z")).toBe("pre"); // 09:29
  expect(s("2026-10-21T13:30:00Z")).toBe("regular"); // 09:30
  expect(s("2026-10-21T19:59:00Z")).toBe("regular"); // 15:59
  expect(s("2026-10-21T20:00:00Z")).toBe("post"); // 16:00
  expect(s("2026-10-22T00:00:00Z")).toBe("closed"); // 20:00
  // Saturday and Sunday are closed all day
  expect(s("2026-10-24T15:00:00Z")).toBe("closed");
  expect(s("2026-10-25T15:00:00Z")).toBe("closed");
  // Wednesday 2026-12-02 (EST, UTC-5): 09:30 New York is 14:30 UTC
  expect(s("2026-12-02T14:29:00Z")).toBe("pre");
  expect(s("2026-12-02T14:30:00Z")).toBe("regular");
});

test("fillModelFor: live fills come from the venue, alerts place none, paper uses the published model", () => {
  expect(fillModelFor("live")).toBe("venue");
  expect(fillModelFor("alert")).toBe("none");
  expect(fillModelFor("paper")).toBe("paper-v1");
  expect(fillModelFor(null)).toBeNull();
});
