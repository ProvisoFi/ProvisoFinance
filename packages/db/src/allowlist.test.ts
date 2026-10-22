import { expect, test } from "bun:test";
import { allowEntries } from "./allowlist";

test("allowEntries reads the API's object form, the entry array, and refuses junk", () => {
  expect(allowEntries({ coins: ["BTC"], sides: ["long"], maxUsd: 10, maxLev: 3 })).toEqual([{ coin: "BTC", side: "long", maxUsd: 10, maxLev: 3 }]);
  expect(allowEntries({ coins: ["BTC"], sides: ["short", "long"], maxUsd: 10, maxLev: 3 })).toEqual([{ coin: "BTC", side: "both", maxUsd: 10, maxLev: 3 }]);
  expect(allowEntries([{ coin: "TSLA", side: "both", maxUsd: 5, maxLev: 1 }])).toEqual([{ coin: "TSLA", side: "both", maxUsd: 5, maxLev: 1 }]);
  for (const junk of [null, undefined, "x", [], {}, { coins: [], sides: ["long"], maxUsd: 1, maxLev: 1 }, [{ coin: "BTC", side: "up", maxUsd: 1, maxLev: 1 }], { coins: ["BTC"], sides: ["long"], maxUsd: -1, maxLev: 1 }])
    expect(allowEntries(junk)).toBeNull();
});
