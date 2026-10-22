"use client";
// Robinhood Chain swaps (R4). Swaps run from the account's swap wallet (its Privy embedded wallet;
// MetaMask can't 7702-delegate to arbitrary contracts): it delegates to ZeroDev Kernel v3.3,
// installs SwapKeyPolicy and signs the swap-key and adapter policies. One Proviso account: a
// MetaMask login gets an embedded swap wallet of its own; an email login swaps from its wallet.
// The session key is made and sealed in the enclave; the relayer submits everything and pays gas,
// or, when the user picks it (or the relayer won't sponsor), the swap wallet sends the same txs itself.
import { useExportWallet, useSign7702Authorization, useSignMessage, useSignTypedData } from "@privy-io/react-auth";
import {
  chainConfig, checkRevokeOps, checkSwapSetup, deployment, legacySwapKeyPolicies, ENTRY_POINT_V07, network, provisoSwapAdapterAbi, SESSION_GAS, swapConfig, swapKeyPolicyAbi,
  swapSetupProgress, swapSetupTypedData, swapWalletProofMessage, toJsonSafe, type SwapSetup,
} from "@proviso/chain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createPublicClient, createWalletClient, custom, getAddress, http, hashMessage, isAddressEqual, parseEther, publicActions, recoverAddress, recoverMessageAddress, recoverTypedDataAddress, type Address, type Hex, type TypedDataDefinition, type WalletClient } from "viem";
import { entryPoint07Abi, toPackedUserOperation } from "viem/account-abstraction";
import { useAccount } from "@/lib/backend/account";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { Icon } from "@/views/proviso/shared";
import { Note, Tag } from "./ui";

type Step = "preparing" | "signing" | "paying" | "relaying" | "done";
/** What a self-paid setup needs in the swap wallet: the session key's gas plus a margin for the txs. */
const SELF_PAY = parseEther("0.0004");

/**
 * Swap-setup signatures skip Privy's confirm window per call: Proviso has already checked every
 * payload (checkSwapSetup / checkRevokeUserOp) and shows what is being signed. Each signature is
 * recovered before use; if a silent one doesn't verify, the normal window path (viem over the
 * wallet's provider) signs it instead. Everything else keeps Privy's window.
 */
function useSwapSigner() {
  const { signMessage } = useSignMessage();
  const { signTypedData } = useSignTypedData();
  const silent = { uiOptions: { showWalletUIs: false } };
  return (wallet: WalletClient, address: Address) => ({
    raw: async (hash: Hex, what: string) => {
      const ok = async (sig: string) => isAddressEqual(await recoverAddress({ hash: hashMessage({ raw: hash }), signature: sig as Hex }), address);
      const quiet = await inTime(signMessage({ message: hash }, { ...silent, address }), what).catch(() => null);
      if (quiet && (await ok(quiet.signature))) return quiet.signature as Hex;
      return inTime(wallet.signMessage({ account: address, message: { raw: hash } }), what);
    },
    text: async (message: string, what: string) => {
      const quiet = await inTime(signMessage({ message }, { ...silent, address }), what).catch(() => null);
      if (quiet && isAddressEqual(await recoverMessageAddress({ message, signature: quiet.signature as Hex }), address)) return quiet.signature as Hex;
      return inTime(wallet.signMessage({ account: address, message }), what);
    },
    typed: async (td: TypedDataDefinition, what: string) => {
      const quiet = await inTime(signTypedData(toJsonSafe(td) as never, { ...silent, address }), what).catch(() => null);
      if (quiet && isAddressEqual(await recoverTypedDataAddress({ ...td, signature: quiet.signature as Hex } as never), address)) return quiet.signature as Hex;
      return inTime(wallet.signTypedData({ account: address, ...td }), what);
    },
  });
}

/** A wallet that never answers becomes an error instead of a frozen page. */
function inTime<T>(p: Promise<T>, what: string, ms = 60_000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error(`The wallet didn't sign the ${what} within ${ms / 1000} s. Reload and try again.`)), ms))]);
}
const stepText: Record<Step, string> = {
  preparing: "The enclave is generating your swap-only session key…",
  signing: "Signing the account upgrade and the swap policies with your swap wallet (checked first: Kernel, the two pools, caps, 30-day expiry)…",
  paying: `Sending the setup from your swap wallet on ${chainConfig().label} (you pay the gas; confirm each transaction)…`,
  relaying: `Proviso is submitting them on ${chainConfig().label} (no gas needed from you)…`,
  done: "Robinhood Chain swaps are ready.",
};

export function RobinhoodConnect({ fallback }: { fallback: () => void }) {
  const account = useAccount();
  if (account.status !== "signed-in")
    return (
      <button className="w-button secondary" onClick={fallback}>
        Set up swaps <Icon name="diagonal" size={16} />
      </button>
    );
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const sw = account.swapWallet;
  return (
    <>
      <Note>
        Account {short(account.address!)}
        {sw && sw.address !== account.address ? <> · swap wallet {short(sw.address)}</> : sw ? " (also its swap wallet)" : ""}
        {sw && <> · <ExportKey address={sw.address} /></>}
      </Note>
      {sw ? <EmbeddedSetup /> : <CreateSwapWallet />}
    </>
  );
}

/** MetaMask accounts: one click makes the account's embedded swap wallet (Privy, no seed phrase). */
function CreateSwapWallet() {
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div aria-live="polite">
      <button
        className="w-button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await account.createSwapWallet();
          } catch (e) {
            setError(e instanceof Error ? e.message : "The swap wallet was not created.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Create swap wallet <Icon name="diagonal" size={16} />
      </button>
      <Note>
        Swaps run from a separate embedded wallet that belongs to this account (MetaMask can&apos;t upgrade to the smart
        account swaps use). Your ideas, Telegram and Hyperliquid stay on {account.address?.slice(0, 6)}….
      </Note>
      {error && <Note>Not done: {error}</Note>}
    </div>
  );
}

/** Privy's own export window shows the key inside its iframe: Proviso never sees it. */
function ExportKey({ address }: { address: string }) {
  const { exportWallet } = useExportWallet();
  return (
    <button className="w-text-link" onClick={() => exportWallet({ address }).catch(() => {})}>
      Export wallet key
    </button>
  );
}

/**
 * Sends the checked setup from the swap wallet itself, skipping what is already on-chain: the
 * type-4 handleOps (7702 delegation + install), the adapter and swap-key setPolicy calls, and the
 * session key's gas. A MetaMask account first tops the swap wallet up from the sign-in wallet.
 */
async function sendSetupSelf(o: {
  setup: SwapSetup;
  wallet: WalletClient;
  address: Address;
  contracts: { swapAdapter: Address; swapKeyPolicy: Address };
  sigs: { userOp?: Hex; adapter: Hex[]; policy: Hex };
  signAuthorization: (nonce: number) => Promise<{ address: Address; chainId: number; nonce: number; r: Hex; s: Hex; yParity: number }>;
  topUp?: (wei: bigint) => Promise<void>;
}) {
  const { setup, address, contracts } = o;
  const w = o.wallet.extend(publicActions);
  const send = async (hash: Promise<Hex>, what: string) => {
    const r = await w.waitForTransactionReceipt({ hash: await inTime(hash, what, 180_000) });
    if (r.status !== "success") throw new Error(`The ${what} transaction reverted.`);
  };
  const call = { account: address, chain: chainConfig().chain } as const;
  const bal = await w.getBalance({ address });
  if (bal < SELF_PAY && o.topUp) await o.topUp(SELF_PAY - bal);
  else if (bal < SELF_PAY) throw new Error(`Your swap wallet needs about 0.0004 ETH on ${chainConfig().label} to pay the setup.`);
  const p = await swapSetupProgress(w as never, setup, { account: address, ...contracts });
  if (setup.install && !p.installed) {
    // Sent by the account itself, so its delegation is signed at the nonce after this tx's own.
    const a = setup.install.authorization;
    const authorizationList = a ? [await o.signAuthorization((await w.getTransactionCount({ address, blockTag: "pending" })) + 1)] : undefined;
    const op = toPackedUserOperation({ ...setup.install.userOp, signature: o.sigs.userOp! });
    await send(w.writeContract({ ...call, address: ENTRY_POINT_V07, abi: entryPoint07Abi, functionName: "handleOps", args: [[op], address], authorizationList } as never), "account upgrade");
  }
  for (const [i, ap] of setup.adapterPolicies.entries())
    if (!p.adapterSet[i]) await send(w.writeContract({ ...call, address: contracts.swapAdapter, abi: provisoSwapAdapterAbi, functionName: "setPolicy", args: [ap, o.sigs.adapter[i]!] } as never), `pool policy ${i + 1}`);
  if (!p.policyActive) await send(w.writeContract({ ...call, address: contracts.swapKeyPolicy, abi: swapKeyPolicyAbi, functionName: "setPolicy", args: [setup.policy, o.sigs.policy] } as never), "swap-key policy");
  if (!p.gasFunded) await send(w.sendTransaction({ ...call, to: setup.policy.sessionKey, value: SESSION_GAS }), "session-key gas");
}

function EmbeddedSetup() {
  const account = useAccount();
  const trpc = useTRPC();
  const api = useTRPCClient();
  const qc = useQueryClient();
  const { signAuthorization } = useSign7702Authorization();
  const swapSigner = useSwapSigner();
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const status = useQuery({
    ...trpc.swapKey.status.queryOptions(),
    refetchInterval: (q) => (q.state.data?.state === "relaying" ? 3000 : false),
  });
  const state = status.data?.state;

  const run = async (selfPay = false) => {
    setError(null);
    try {
      setStep("preparing");
      // Short requests only: the server answers "pending" until the enclave has made the key.
      const sw = account.swapWallet;
      if (!sw) throw new Error("Create the swap wallet first.");
      // A separate swap wallet first proves it belongs to this account (one signature).
      let proof: `0x${string}` | undefined;
      if (sw.address !== account.address) {
        const swc = createWalletClient({ account: getAddress(sw.address), chain: chainConfig().chain, transport: custom(await sw.provider()) });
        proof = await swapSigner(swc, getAddress(sw.address)).text(swapWalletProofMessage(sw.address, account.address!), "swap wallet proof");
      }
      let prep = await api.swapKey.prepare.mutate({ account: sw.address, proof });
      for (let i = 0; prep.pending && i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        prep = await api.swapKey.prepare.mutate({ account: sw.address, proof });
      }
      if (prep.pending) throw new Error("The enclave didn't answer; try again in a minute.");
      const { setup } = prep;
      const provider = await sw.provider(); // the swap wallet signs everything here
      const address = getAddress(sw.address);
      // Never sign what the server built without checking it: Kernel target, install-only UserOp,
      // known adapter, pools, oracles and caps. The typed data is rebuilt here from the checked setup.
      const d = deployment();
      const contracts = { swapAdapter: d.swapAdapter!, swapKeyPolicy: d.swapKeyPolicy! };
      const swap = swapConfig();
      checkSwapSetup(setup, { account: address, chainId: chainConfig().chain.id, ...contracts, markets: swap.markets, caps: swap.caps, maxDays: swap.policyDays });
      const typedData = swapSetupTypedData(setup, contracts);
      const wallet = createWalletClient({ account: address, chain: chainConfig().chain, transport: custom(provider) });
      await wallet.switchChain({ id: chainConfig().chain.id }).catch(async () => {
        await wallet.addChain({ chain: chainConfig().chain }).catch(() => {}); // embedded wallets already know it
        await wallet.switchChain({ id: chainConfig().chain.id }).catch(() => {});
      });

      setStep("signing");
      let authorization;
      const signAuth = async (nonce: number) => {
        const a = setup.install!.authorization!;
        const s = await inTime(signAuthorization({ contractAddress: a.address, chainId: a.chainId, nonce }, { address }), "account upgrade");
        return { address: s.address as Address, chainId: s.chainId, nonce: s.nonce, r: s.r as Hex, s: s.s as Hex, yParity: s.yParity ?? 0 };
      };
      if (setup.install?.authorization && !selfPay) authorization = await signAuth(setup.install.authorization.nonce); // the relayer sends it
      const signer = swapSigner(wallet, address);
      const userOp = setup.install ? await signer.raw(setup.install.userOpHash, "setup message") : undefined;
      const sign = (td: unknown, what: string) => signer.typed(td as TypedDataDefinition, what);
      const adapter: Hex[] = [];
      for (const [i, td] of typedData.adapter.entries()) adapter.push(await sign(td, `pool policy ${i + 1}`));
      const policy = await sign(typedData.policy, "swap-key policy");

      if (selfPay) {
        setStep("paying");
        const login = account.address && !isAddressEqual(getAddress(account.address), address) ? await account.provider() : null;
        const topUp = login
          ? async (wei: bigint) => {
              const from = getAddress(account.address!);
              const lw = createWalletClient({ account: from, chain: chainConfig().chain, transport: custom(login) }).extend(publicActions);
              // MetaMask may not know Robinhood Chain yet: add it, then switch (same as seal and retire).
              const chain = chainConfig().chain;
              await lw.switchChain({ id: chain.id }).catch(async () => {
                await lw.addChain({ chain });
                await lw.switchChain({ id: chain.id });
              });
              const hash = await inTime(lw.sendTransaction({ account: from, chain, to: address, value: wei }), "swap wallet top-up", 180_000);
              await createPublicClient({ chain, transport: http() }).waitForTransactionReceipt({ hash });
            }
          : undefined;
        await sendSetupSelf({ setup, wallet, address, contracts, sigs: { userOp, adapter, policy }, signAuthorization: signAuth, topUp });
        // The server's RPC can trail the wallet's by a block or two.
        for (let i = 0; ; i++) {
          try {
            await api.swapKey.register.mutate({ userOp, adapter, policy, selfPaid: true });
            break;
          } catch (e) {
            if (i >= 2 || !(e instanceof Error && e.message.includes("isn't fully on-chain yet"))) throw e;
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
        setStep(null);
        await qc.invalidateQueries({ queryKey: trpc.swapKey.status.queryKey() });
        return;
      }
      setStep("relaying");
      await api.swapKey.register.mutate({ authorization, userOp, adapter, policy });
      await qc.invalidateQueries({ queryKey: trpc.swapKey.status.queryKey() });
    } catch (e) {
      setStep(null);
      setError(e instanceof Error ? e.message : "Swaps were not set up.");
    }
  };

  // Revoke: one signature per policy module on the wallet (the current one, plus an older one left from an
  // earlier setup); the key stops at once, the on-chain uninstall is relayed (no gas from you).
  // `legacyOnly`: remove only the older permission and keep swaps working.
  const revoke = async (legacyOnly = false) => {
    setError(null);
    try {
      setStep("signing");
      const r = await api.swapKey.prepareRevoke.mutate({ legacyOnly });
      const sw = account.swapWallet;
      if (!sw) throw new Error("The swap wallet isn't available in this browser.");
      const provider = await sw.provider();
      const address = getAddress(sw.address);
      const allowed = [...(legacyOnly ? [] : [deployment().swapKeyPolicy!]), ...legacySwapKeyPolicies()];
      checkRevokeOps(r.ops, { account: address, chainId: chainConfig().chain.id, allowed });
      const wallet = createWalletClient({ account: address, chain: chainConfig().chain, transport: custom(provider) });
      const signatures: Hex[] = [];
      for (const o of r.ops) signatures.push(await swapSigner(wallet, address).raw(o.userOpHash, "revoke"));
      await api.swapKey.revoke.mutate({ signatures });
      setStep(null);
      if (!legacyOnly) setRevoked(true);
      await qc.invalidateQueries({ queryKey: trpc.swapKey.status.queryKey() });
    } catch (e) {
      setStep(null);
      setError(e instanceof Error ? e.message : "The swap key was not revoked.");
    }
  };

  const busy = step === "preparing" || step === "signing" || step === "paying";
  const failed = status.data?.state === "failed" ? status.data.reason : null;
  return (
    <div aria-live="polite">
      {state === "ready" ? (
        <>
          <Tag solid>Swaps ready · session key until {new Date(status.data!.expiresAt!).toLocaleDateString()} · {network()}</Tag>
          <button className="w-button secondary" disabled={busy} onClick={() => revoke()}>
            Revoke swap key <Icon name="close" size={16} />
          </button>
        </>
      ) : state === "relaying" ? (
        <Note>{stepText.relaying}</Note>
      ) : (
        <>
          {failed && !busy && (
            <Note>Not sponsored: {failed === "relayer_budget" ? "sponsored setups are used up for today." : failed} You can pay the gas from your wallet instead.</Note>
          )}
          <button className="w-button" disabled={busy} onClick={() => run()}>
            Set up Robinhood Chain swaps <Icon name="diagonal" size={16} />
          </button>
          <button className="w-button secondary" disabled={busy} onClick={() => run(true)}>
            Pay the setup gas from my wallet (about 0.0004 ETH) <Icon name="diagonal" size={16} />
          </button>
        </>
      )}
      {busy && !error && <Note>{stepText[step!]}</Note>}
      {status.isError && <Note>Can&apos;t reach Proviso right now, so this status may be out of date: reload the page.</Note>}
      {revoked && state !== "ready" && (
        <Note>Swap key revoked: it can no longer swap. Tokens it bought stay in your wallet; set swaps up again any time.</Note>
      )}
      {status.data?.legacy && !busy && (
        <>
          <Note>This wallet still has an older swap permission from an earlier setup. Proviso no longer uses it; remove it with one signature (no gas from you).</Note>
          <button className="w-button secondary" onClick={() => revoke(true)}>
            Remove the old swap permission <Icon name="close" size={16} />
          </button>
        </>
      )}
      {error && <Note>Not done: {error}</Note>}
    </div>
  );
}
