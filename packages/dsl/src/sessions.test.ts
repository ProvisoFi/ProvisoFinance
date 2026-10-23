import { describe, expect, test } from "bun:test";
import { hasSessionCalendar, marketSession, sessionTradable } from "./sessions.ts";

const at = (iso: string) => new Date(iso);

describe("session calendar", () => {
  test("crypto is 24/7, unknown xyz markets and other dexes are unknown, pre-IPO is internal-only", () => {
    expect(marketSession("BTC", at("2026-10-24T12:00:00Z"))).toBe("24/7");
    expect(marketSession("xyz:CORN", at("2026-10-21T15:00:00Z"))).toBe("unknown");
    expect(marketSession("flx:NVDA", at("2026-10-21T15:00:00Z"))).toBe("unknown");
    expect(marketSession("xyz:JIO", at("2026-10-24T12:00:00Z"))).toBe("preipo");
    expect(hasSessionCalendar("xyz:NVDA") && hasSessionCalendar("BTC") && hasSessionCalendar("xyz:OURA")).toBe(true);
    expect(hasSessionCalendar("xyz:CORN")).toBe(false);
  });

  test("US stocks: 24/5 from Sunday 20:05 to Friday 20:00 ET, across DST", () => {
    // EDT (UTC-4)
    expect(marketSession("xyz:NVDA", at("2026-10-21T14:00:00Z"))).toBe("open"); // Wed 10:00
    expect(marketSession("xyz:NVDA", at("2026-10-22T05:00:00Z"))).toBe("open"); // Thu 01:00 overnight
    expect(marketSession("xyz:NVDA", at("2026-10-24T00:02:00Z"))).toBe("closed"); // Fri 20:02
    expect(marketSession("xyz:NVDA", at("2026-10-24T16:00:00Z"))).toBe("closed"); // Saturday
    expect(marketSession("xyz:NVDA", at("2026-10-26T00:06:00Z"))).toBe("reopen"); // Sun 20:06
    expect(marketSession("xyz:NVDA", at("2026-10-26T00:11:00Z"))).toBe("open"); // Sun 20:11
    expect(marketSession("xyz:NVDA", at("2026-10-22T00:02:00Z"))).toBe("closed"); // Wed 20:02 daily gap
    expect(marketSession("xyz:NVDA", at("2026-10-22T00:07:00Z"))).toBe("reopen");
    // EST (UTC-5): Mon 9 Nov 20:00 ET = 01:00Z
    expect(marketSession("xyz:NVDA", at("2026-11-10T00:59:00Z"))).toBe("open");
    expect(marketSession("xyz:NVDA", at("2026-11-10T01:02:00Z"))).toBe("closed");
  });

  test("US stock holidays and early closes", () => {
    expect(marketSession("xyz:AAPL", at("2026-11-26T15:00:00Z"))).toBe("holiday"); // Thanksgiving
    expect(marketSession("xyz:AAPL", at("2026-11-26T01:00:00Z"))).toBe("closed"); // Wed 20:00 EST: no overnight into Thanksgiving
    expect(marketSession("xyz:AAPL", at("2026-11-27T08:00:00Z"))).toBe("holiday"); // Fri 03:00, before the 04:00 early open
    expect(marketSession("xyz:AAPL", at("2026-11-27T09:10:00Z"))).toBe("open"); // Fri 04:10
    expect(marketSession("xyz:AAPL", at("2026-11-27T18:30:00Z"))).toBe("holiday"); // after the 13:00 early close
    expect(marketSession("xyz:AAPL", at("2027-01-18T15:00:00Z"))).toBe("holiday"); // MLK 2027
    expect(marketSession("xyz:AAPL", at("2028-01-04T15:00:00Z"))).toBe("unknown"); // past the published lists
  });

  test("futures: daily 17:00–18:00 ET gap with a reopen guard, holiday early closes", () => {
    expect(marketSession("xyz:GOLD", at("2026-10-21T20:30:00Z"))).toBe("open"); // Wed 16:30
    expect(marketSession("xyz:GOLD", at("2026-10-21T21:30:00Z"))).toBe("closed"); // Wed 17:30
    expect(marketSession("xyz:CL", at("2026-10-21T22:02:00Z"))).toBe("reopen"); // Wed 18:02
    expect(marketSession("xyz:CL", at("2026-10-23T21:30:00Z"))).toBe("closed"); // Fri 17:30
    expect(marketSession("xyz:SP500", at("2026-10-25T22:30:00Z"))).toBe("open"); // Sun 18:30
    expect(marketSession("xyz:SP500", at("2026-11-26T18:30:00Z"))).toBe("holiday"); // Thanksgiving 13:30 EST
    expect(marketSession("xyz:SP500", at("2026-11-26T23:30:00Z"))).toBe("open"); // reopens 18:00
    expect(marketSession("xyz:SILVER", at("2026-12-25T15:00:00Z"))).toBe("holiday");
  });

  test("FX runs Sunday 17:00 to Friday 17:00 ET without a daily reopen", () => {
    expect(marketSession("xyz:EUR", at("2026-10-21T21:02:00Z"))).toBe("open"); // Wed 17:02: next day's session, no gap
    expect(marketSession("xyz:EUR", at("2026-10-23T21:30:00Z"))).toBe("closed"); // Fri 17:30
    expect(marketSession("xyz:EUR", at("2026-11-26T15:00:00Z"))).toBe("open"); // trades through Thanksgiving
  });

  test("Korea: no pre-market, 09:01 open, after-hours session, KRX holidays", () => {
    expect(marketSession("xyz:SKHX", at("2026-10-22T23:30:00Z"))).toBe("closed"); // Fri 08:30 KST
    expect(marketSession("xyz:SKHX", at("2026-10-23T00:02:00Z"))).toBe("reopen"); // 09:02
    expect(marketSession("xyz:SKHX", at("2026-10-23T00:10:00Z"))).toBe("open");
    expect(marketSession("xyz:SKHX", at("2026-10-23T06:30:00Z"))).toBe("closed"); // 15:30 break
    expect(marketSession("xyz:SMSN", at("2026-10-23T08:00:00Z"))).toBe("open"); // 17:00 after-hours
    expect(marketSession("xyz:SKHX", at("2026-10-09T02:00:00Z"))).toBe("holiday"); // Hangeul Day
    expect(marketSession("xyz:KR200", at("2026-10-23T19:00:00Z"))).toBe("open"); // Sat 04:00 KST night session
  });

  test("Japan, Hong Kong half days and Shanghai STAR", () => {
    expect(marketSession("xyz:KIOXIA", at("2026-10-23T07:45:00Z"))).toBe("closed"); // 16:45 JST break
    expect(marketSession("xyz:KIOXIA", at("2026-10-23T09:00:00Z"))).toBe("open"); // 18:00 night session
    expect(marketSession("xyz:ZHIPU", at("2026-12-24T03:00:00Z"))).toBe("open"); // 11:00 HKT, half day
    expect(marketSession("xyz:ZHIPU", at("2026-12-24T06:00:00Z"))).toBe("holiday"); // 14:00 HKT, closed after noon
    expect(marketSession("xyz:CXMT", at("2026-10-23T06:58:00Z"))).toBe("closed"); // 14:58 CST
    expect(marketSession("xyz:CXMT", at("2026-10-06T02:00:00Z"))).toBe("holiday"); // Golden Week
  });

  test("only open, 24/7 and pre-IPO readings are trusted", () => {
    expect(["open", "24/7", "preipo"].every((s) => sessionTradable(s as never))).toBe(true);
    expect(["reopen", "closed", "holiday", "unknown"].some((s) => sessionTradable(s as never))).toBe(false);
  });
});
