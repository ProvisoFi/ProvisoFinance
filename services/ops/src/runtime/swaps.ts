// swap_setup queue: relays a user's signed Robinhood Chain swap setup (R4). In order, each step
// skipped when already done on-chain: one type-4 handleOps tx that 7702-delegates the embedded
// wallet to Kernel v3.3 and installs SwapKeyPolicy (the UserOp pays no gas), the adapter policies,
// the swap-key policy, gas for the session key, and on testnet a tUSDG drip.
import {
  adapterPolicyFromJson,
  ENTRY_POINT_V07,
  KERNEL_V33_IMPLEMENTATION,
  kernelAbi,
  kernelDelegationCode,
  MODULE_TYPE_EXECUTOR,
  provisoSwapAdapterAbi,
  swapKeyPolicyAbi,
  swapKeyPolicyFromJson,
  swapKeyPolicyHash,
  userOpFromJson,
} from "@proviso/chain";
import { activity, swapKeys, type Db } from "@proviso/db";
import { eq } from "drizzle-orm";
import { verifyAuthorization } from "viem/utils";
import { erc20Abi, getAddress, isAddressEqual, parseAbi, parseEther, type Abi, type Address, type Hex, type SignedAuthorization } from "viem";
import { entryPoint07Abi, toPackedUserOperation } from "viem/account-abstraction";
import type { QueueMessage } from "../queue";
import { revertName, send, type Clients } from "./chain";

export type SwapSetupMsg = { address: string };
/** What swapKey.register adds to swap_keys.setup. */
export type SetupSignatures = {
  authorization?: SignedAuthorization;
  userOp?: Hex;
  adapter: Hex[];
  policy: Hex;
};

const SESSION_GAS = parseEther("0.0003");
const MAX_ATTEMPTS = 3;
const mintAbi = parseAbi(["function mint(address to, uint256 value)"]);

export const swapSetupHandler =
  (db: Db, c: Clients, d: { swapAdapter: Address; swapKeyPolicy: Address; testnetUsdg?: Address }, log = console.error) =>
  async (m: SwapSetupMsg, meta?: QueueMessage<SwapSetupMsg>) => {
    const owner = m.address.toLowerCase();
    const [row] = await db.select().from(swapKeys).where(eq(swapKeys.address, owner));
    const setup = row?.setup as (Record<string, any> & { signatures?: SetupSignatures }) | null | undefined;
    if (!row || row.revokedAt || row.registeredAt || !setup?.signatures) return; // nothing (left) to do
    const sig = setup.signatures;
    const account = getAddress(owner);
    const read = (address: Address, abi: Abi, functionName: string, args: unknown[]) =>
      c.public.readContract({ address, abi, functionName, args } as never) as Promise<any>;
    try {
      if (setup.install) {
        const delegated = (await c.public.getCode({ address: account }))?.toLowerCase() === kernelDelegationCode;
        const installed = delegated && (await read(account, kernelAbi, "isModuleInstalled", [MODULE_TYPE_EXECUTOR, d.swapKeyPolicy, "0x"]));
        if (!installed) {
          if (!sig.userOp || (!delegated && !sig.authorization)) throw new Error("missing_install_signature");
          // Re-check at relay time: the relayer only ever sponsors a delegation to Kernel v3.3 here.
          const a = sig.authorization;
          if (!delegated && !(isAddressEqual(a!.address, KERNEL_V33_IMPLEMENTATION) && a!.chainId === c.public.chain?.id && (await verifyAuthorization({ address: account, authorization: a! }))))
            throw new Error("bad_authorization");
          const op = { ...userOpFromJson(setup.install.userOp), signature: sig.userOp };
          const hash = await c.wallet.writeContract({
            address: ENTRY_POINT_V07,
            abi: entryPoint07Abi,
            functionName: "handleOps",
            args: [[toPackedUserOperation(op)], c.account.address],
            authorizationList: delegated ? undefined : [sig.authorization!],
            account: c.account,
            chain: c.public.chain,
          } as never);
          const r = await c.public.waitForTransactionReceipt({ hash });
          if (r.status !== "success") throw new Error(`handleOps ${hash} reverted`);
          if (!(await read(account, kernelAbi, "isModuleInstalled", [MODULE_TYPE_EXECUTOR, d.swapKeyPolicy, "0x"])))
            throw new Error("install_failed"); // the UserOp ran but installModule reverted inside it
        }
      }
      for (const [i, j] of (setup.adapterPolicies as Record<string, unknown>[]).entries()) {
        const ap = adapterPolicyFromJson(j);
        const last = (await read(d.swapAdapter, provisoSwapAdapterAbi as Abi, "lastPolicyNonce", [account])) as bigint;
        if (last < ap.nonce) await send(c, { address: d.swapAdapter, abi: provisoSwapAdapterAbi as Abi, functionName: "setPolicy", args: [ap, sig.adapter[i]] });
      }
      const policy = swapKeyPolicyFromJson(setup.policy);
      if ((await read(d.swapKeyPolicy, swapKeyPolicyAbi as Abi, "activePolicy", [account])) !== swapKeyPolicyHash(policy))
        await send(c, { address: d.swapKeyPolicy, abi: swapKeyPolicyAbi as Abi, functionName: "setPolicy", args: [policy, sig.policy] });

      if ((await c.public.getBalance({ address: policy.sessionKey })) < SESSION_GAS / 3n)
        await c.public.waitForTransactionReceipt({
          hash: await c.wallet.sendTransaction({ to: policy.sessionKey, value: SESSION_GAS, account: c.account, chain: c.public.chain }),
        });
      if (d.testnetUsdg && ((await read(d.testnetUsdg, erc20Abi, "balanceOf", [account])) as bigint) < 10n * 10n ** 6n)
        await send(c, { address: d.testnetUsdg, abi: mintAbi, functionName: "mint", args: [account, 100n * 10n ** 6n] });

      await db.transaction(async (tx) => {
        await tx.update(swapKeys).set({ registeredAt: new Date(), signedPolicy: setup.policy, policySig: sig.policy }).where(eq(swapKeys.address, owner));
        await tx.insert(activity).values({ address: owner, kind: "swaps_ready", payload: { sessionKey: policy.sessionKey } });
      });
    } catch (e) {
      // Bad signatures and inner reverts won't heal on retry; RPC hiccups might. Give up after a few.
      if ((meta?.readCt ?? MAX_ATTEMPTS) < MAX_ATTEMPTS) throw e;
      // Users see a closed code only; logs get the message without URLs (RPC endpoints can carry keys).
      const known = ["missing_install_signature", "bad_authorization", "install_failed"];
      const msg = e instanceof Error ? e.message : String(e);
      const reason = revertName(e) ?? (known.includes(msg) ? msg : "relay_error");
      log(`ops: swap setup for ${owner} failed (${reason}): ${msg.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300)}`);
      await db.insert(activity).values({ address: owner, kind: "swap_setup_failed", payload: { reason } });
    }
  };
