// Tells the operator (RELAYER_ALERT_ADDRESS, through the notify queue: Telegram / Web Push) when
// the relayer's ETH runs low. It pays every stamp, reveal, root, feed push, pool alignment and
// swap setup, so running dry stops them all quietly. Alerts again at most every 6 hours.
import { formatEther, parseEther } from "viem";
import { chainConfig } from "@proviso/chain";
import type { Clients } from "./chain";

const TICK_MS = 10 * 60_000;
const REPEAT_MS = 6 * 3_600_000;

/** Every 10 minutes, alerts the operator when the relayer's ETH is below `minEth` (default 0.003), at most once per 6 hours until it is topped up. */
export function balanceWatch(
  c: Clients,
  o: { alertAddress: string; minEth?: string; notify: (m: { address: string; title: string; body: string; url?: string }) => Promise<unknown>; log?: (m: string) => void; now?: () => number },
) {
  const min = parseEther(o.minEth ?? "0.003");
  const now = o.now ?? Date.now;
  let lastAlert = -Infinity;

  async function tick() {
    const wei = await c.public.getBalance({ address: c.account.address });
    if (wei >= min) return void (lastAlert = -Infinity); // topped up: the next drop alerts at once
    if (now() - lastAlert < REPEAT_MS) return;
    lastAlert = now();
    const eth = formatEther(wei);
    o.log?.(`ops: relayer ${c.account.address} has ${eth} ETH (< ${formatEther(min)}), alerting`);
    await o.notify({
      address: o.alertAddress.toLowerCase(),
      title: "Relayer low on ETH",
      body: `The Proviso relayer ${c.account.address} has ${Number(eth).toFixed(5)} ETH on ${chainConfig().label}. Top it up: stamps, reveals, feed pushes and swap setups stop when it runs out.`,
    });
  }

  async function run(signal: AbortSignal) {
    o.log?.(`ops: relayer balance watch on (alert below ${formatEther(min)} ETH)`);
    while (!signal.aborted) {
      await tick().catch((e) => o.log?.(`ops: balance watch failed: ${e instanceof Error ? e.message : e}`));
      await new Promise<void>((r) => {
        const t = setTimeout(r, TICK_MS);
        signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
      });
    }
  }
  return { tick, run };
}
