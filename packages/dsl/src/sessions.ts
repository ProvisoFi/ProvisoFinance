/**
 * Session calendar for HIP-3 markets (trade.xyz, "xyz:NVDA"). Hyperliquid exposes no session state,
 * so this follows trade.xyz's published Specification Index and Holiday Closures (2026 lists).
 *
 * Outside a market's external session its oracle is trade.xyz's internal EMA of its own book: weekend
 * and overnight prices are mostly noise and a lone thin print can move it. Session guards treat those
 * readings as unknown, plus a short reopen guard while the oracle snaps back to the external price.
 *
 * ponytail: holiday lists are per year. Past `through` a market reads "unknown" (guarded) until the
 * next year's list is added here, so a stale calendar stops fires instead of letting noise through.
 */

/** open: external price live · reopen: first minutes after an internal stretch · closed/holiday: internal pricing · unknown: no calendar · preipo: internal-only market · 24/7: crypto. */
export type SessionState = "open" | "reopen" | "closed" | "holiday" | "unknown" | "preipo" | "24/7";

/** Readings and reference-price exits are trusted only in these states. */
export const sessionTradable = (s: SessionState) => s === "open" || s === "24/7" || s === "preipo";

export const REOPEN_GUARD_MIN = 5;

type Win = readonly [start: number, end: number]; // minutes from the session date's local midnight; may run past either end
type Calendar = {
  tz: string;
  windows: readonly Win[];
  /** Session dates (YYYY-MM-DD, Mon–Fri) with no session, and ones with shortened windows. */
  closed?: readonly string[];
  short?: Readonly<Record<string, readonly Win[]>>;
  /** Last date the holiday list covers; later sessions are "unknown". */
  through?: string;
};

const h = (hh: number, mm = 0) => hh * 60 + mm;
const days = (year: number, list: string) => list.split(" ").map((d) => `${year}-${d}`);

// US stocks and ETFs: 24/5, Sunday 20:05 to Friday 20:00 ET. Session D runs D-1 20:05 → D 20:00.
const US_EQUITY: Calendar = {
  tz: "America/New_York",
  windows: [[h(20, 5) - 1440, h(20)]],
  closed: [
    ...days(2026, "01-01 01-19 02-16 04-03 05-25 06-19 07-03 09-07 11-26 12-25"),
    ...days(2027, "01-01 01-18 02-15 03-26 05-31 06-18 07-05 09-06 11-25 12-24"),
  ],
  // Early closes: 04:00–13:00 ET, no overnight session before them.
  short: Object.fromEntries(["2026-11-27", "2026-12-24", "2027-11-26"].map((d) => [d, [[h(4), h(13)]]])),
  through: "2027-12-31",
};

// Commodities, US index and JP225 futures: Sunday 18:00 to Friday 17:00 ET, daily 17:00–18:00 gap.
// Holidays: the earliest close across trade.xyz's futures, energy and base-metal lists.
const FUTURES: Calendar = {
  tz: "America/New_York",
  windows: [[h(18) - 1440, h(17)]],
  closed: days(2026, "01-01 04-03 12-25"),
  short: {
    ...Object.fromEntries(days(2026, "01-19 02-16 05-25 06-19 07-03 09-07 11-26").map((d) => [d, [[h(18) - 1440, h(13)]]])),
    "2026-11-27": [[h(18) - 1440, h(13, 15)]],
    "2026-12-24": [[h(18) - 1440, h(13, 15)]],
  },
  through: "2026-12-31",
};

// FX: Sunday 17:00 to Friday 17:00 ET; trades through most US holidays.
const FX: Calendar = { tz: "America/New_York", windows: [[h(17) - 1440, h(17)]] };

const KR_CLOSED = days(2026, "01-01 02-16 02-17 02-18 03-02 05-01 05-05 05-25 08-17 09-24 09-25 10-05 10-09 12-25 12-31");
// Korean stocks: 09:01–15:20 and 16:05–20:00 KST (no pre-market since the SK Hynix incident).
const KR_EQUITY: Calendar = { tz: "Asia/Seoul", windows: [[h(9, 1), h(15, 20)], [h(16, 5), h(20)]], closed: KR_CLOSED, through: "2026-12-31" };
// KR200: KRX futures day 08:45–15:35 and night 18:00–05:50 (next day) KST.
const KR_INDEX: Calendar = { tz: "Asia/Seoul", windows: [[h(8, 45), h(15, 35)], [h(18), 1440 + h(5, 50)]], closed: KR_CLOSED, through: "2026-12-31" };

const JP_EQUITY: Calendar = {
  tz: "Asia/Tokyo",
  windows: [[h(8, 20), h(16, 30)], [h(17), h(23, 59)]],
  closed: days(2026, "01-01 01-02 01-12 02-11 02-23 03-20 04-29 05-04 05-05 05-06 07-20 08-11 09-21 09-22 09-23 10-12 11-03 11-23 12-31"),
  through: "2026-12-31",
};

const HK_EQUITY: Calendar = {
  tz: "Asia/Hong_Kong",
  windows: [[h(9, 30), h(12)], [h(13), h(16)]],
  closed: days(2026, "01-01 02-17 02-18 02-19 04-03 04-06 04-07 05-01 05-25 06-19 07-01 10-01 10-19 12-25"),
  short: Object.fromEntries(days(2026, "02-16 12-24 12-31").map((d) => [d, [[h(9, 30), h(12)]]])),
  through: "2026-12-31",
};

// Shanghai STAR: 09:30–11:30 and 13:00–14:57 CST.
const CN_EQUITY: Calendar = {
  tz: "Asia/Shanghai",
  windows: [[h(9, 30), h(11, 30)], [h(13), h(14, 57)]],
  closed: days(2026, "01-01 01-02 02-16 02-17 02-18 02-19 02-20 02-23 04-06 05-01 05-04 05-05 06-19 09-25 10-01 10-02 10-05 10-06 10-07"),
  through: "2026-12-31",
};

const group = (cal: Calendar, coins: string) => coins.split(" ").map((c) => [c, cal] as const);

/** xyz coins with a published schedule. Coins missing here (grains, VIX, KRW, DXY…) read "unknown". */
const XYZ: ReadonlyMap<string, Calendar> = new Map([
  ...group(
    US_EQUITY,
    "AAOI AAPL AMAT AMD AMZN ARM ASML AVGO BABA BB BE BIRD BMNR BOT BX CBRS COIN COST CRCL CRWD CRWV CVX DELL DKNG DRAM EBAY EWJ EWT EWY EWZ GEV GLW GME GOOGL HIMS HOOD IBM INTC IREN KORU KSTR LITE LLY LRCX LYTE MAGS META MRNA MRVL MSFT MSTR MU NBIS NCLD NET NFLX NOK NOW NVDA ORCL PLTR PURRDAT QCOM QNT RDDT RIVN RKLB SHAZ SKHY SMH SNDK SNXX SOXL SPCX STRC TLT TSLA TSM TWST UMC URNM USAR WDC XBI XLE ZM",
  ),
  ...group(FUTURES, "GOLD SILVER PLATINUM PALLADIUM COPPER ALUMINIUM CL BRENTOIL NATGAS HO SP500 XYZ100 JP225"),
  ...group(FX, "EUR JPY GBP"),
  ...group(KR_EQUITY, "SKHX SMSN HYUNDAI"),
  ...group(KR_INDEX, "KR200"),
  ...group(JP_EQUITY, "KIOXIA SOFTBANK"),
  ...group(HK_EQUITY, "MINIMAX ZHIPU SHEIN"),
  ...group(CN_EQUITY, "CAMBRICON CXMT GIGADEV UNITREE"),
]);
const PRE_IPO = new Set(["JIO", "OURA"]);
/** Pre-IPO markets (xyz:JIO, xyz:OURA): priced only by their own book, so live trading takes a lower leverage cap and carry budget. */
export const isPreIpo = (coin: string) => coin.startsWith("xyz:") && PRE_IPO.has(coin.slice(4));
export const PRE_IPO_MAX_LEV = 2;

const calendarOf = (coin: string): Calendar | undefined => {
  const [dex, name] = coin.split(":");
  return dex === "xyz" && name ? XYZ.get(name) : undefined;
};

/** Whether Proviso knows when `coin` trades: crypto, a scheduled xyz market or a pre-IPO one. */
export const hasSessionCalendar = (coin: string) =>
  !coin.includes(":") || calendarOf(coin) !== undefined || PRE_IPO.has(coin.split(":")[1] ?? "");

const fmt = new Map<string, Intl.DateTimeFormat>();
/** Local wall clock as absolute minutes since 1970-01-01 local midnight. */
function wallMinutes(tz: string, at: number): number {
  let f = fmt.get(tz);
  if (!f) fmt.set(tz, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })));
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!) / 60_000 + +p.hour! * 60 + +p.minute!;
}

const isoDay = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

/** Windows of session date `day` (days since epoch) in absolute wall minutes, or "unknown" past the calendar. */
function sessionWindows(cal: Calendar, day: number): Win[] | "unknown" {
  const wd = new Date(day * 86_400_000).getUTCDay();
  if (wd === 0 || wd === 6) return [];
  const d = isoDay(day);
  if (cal.through && d > cal.through) return "unknown";
  if (cal.closed?.includes(d)) return [];
  return (cal.short?.[d] ?? cal.windows).map(([s, e]) => [day * 1440 + s, day * 1440 + e]);
}

/** The external window containing wall minute `m`, null if none, or "unknown". */
function windowAt(cal: Calendar, m: number): Win | null | "unknown" {
  const day = Math.floor(m / 1440);
  let unknown = false;
  for (const d of [day - 1, day, day + 1]) {
    const ws = sessionWindows(cal, d);
    if (ws === "unknown") { unknown = true; continue; }
    const w = ws.find(([s, e]) => s <= m && m < e);
    if (w) return w;
  }
  return unknown ? "unknown" : null;
}

/** Session state of `coin` ("BTC", "xyz:NVDA") at `at`. */
export function marketSession(coin: string, at: number | Date): SessionState {
  if (!coin.includes(":")) return "24/7";
  if (isPreIpo(coin)) return "preipo";
  const cal = calendarOf(coin);
  if (!cal) return "unknown";
  const m = wallMinutes(cal.tz, +at);
  const w = windowAt(cal, m);
  if (w === "unknown") return "unknown";
  if (w) {
    // Reopen guard: the first minutes after an internal stretch, while the oracle snaps to the external price.
    return m - w[0] < REOPEN_GUARD_MIN && !Array.isArray(windowAt(cal, w[0] - 1)) ? "reopen" : "open";
  }
  const day = Math.floor(m / 1440);
  const wd = new Date(day * 86_400_000).getUTCDay();
  return wd !== 0 && wd !== 6 && (cal.closed?.includes(isoDay(day)) || cal.short?.[isoDay(day)]) ? "holiday" : "closed";
}
