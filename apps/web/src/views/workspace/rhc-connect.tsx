"use client";
// Robinhood Chain swaps (R4). Swaps run from the account's swap wallet (its Privy embedded wallet;
// MetaMask can't 7702-delegate to arbitrary contracts): it delegates to ZeroDev Kernel v3.3,
// installs SwapKeyPolicy and signs the swap-key and adapter policies. One Proviso account: a
// MetaMask login gets an embedded swap wallet of its own; an email login swaps from its wallet.
// The session key is made and sealed in the enclave; the relayer submits everything and pays gas.
import { useExportWallet, useSign7702Authorization } from "@privy-io/react-auth";
import { checkRevokeUserOp, checkSwapSetup, robinhoodTestnet, swapSetupTypedData, TESTNET_DEPLOYMENT, TESTNET_SWAP } from "@proviso/chain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createWalletClient, custom, getAddress, type TypedDataDefinition } from "viem";
import { useAccount } from "@/lib/backend/account";
import { useTRPC, useTRPCClient } from "@/lib/backend/api";
import { Icon } from "@/views/proviso/shared";
import { Note, Tag } from "./ui";

type Step = "preparing" | "signing" | "relaying" | "done";
const stepText: Record<Step, string> = {
  preparing: "The enclave is generating your swap-only session key…",
  signing: "Approve the account upgrade and the swap policies in your wallet…",
  relaying: "Proviso is submitting them on Robinhood Chain testnet (no gas needed from you)…",
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

function EmbeddedSetup() {
  const account = useAccount();
  const trpc = useTRPC();
  const api = useTRPCClient();
  const qc = useQueryClient();
  const { signAuthorization } = useSign7702Authorization();
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const status = useQuery({
    ...trpc.swapKey.status.queryOptions(),
    refetchInterval: (q) => (q.state.data?.state === "relaying" ? 3000 : false),
  });
  const state = status.data?.state;

  const run = async () => {
    setError(null);
    try {
      setStep("preparing");
      // Short requests only: the server answers "pending" until the enclave has made the key.
      const sw = account.swapWallet;
      if (!sw) throw new Error("Create the swap wallet first.");
      let prep = await api.swapKey.prepare.mutate({ account: sw.address });
      for (let i = 0; prep.pending && i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        prep = await api.swapKey.prepare.mutate({ account: sw.address });
      }
      if (prep.pending) throw new Error("The enclave didn't answer; try again in a minute.");
      const { setup } = prep;
      const provider = await sw.provider(); // the swap wallet signs everything here
      const address = getAddress(sw.address);
      // Never sign what the server built without checking it: Kernel target, install-only UserOp,
      // known adapter, pools, oracles and caps. The typed data is rebuilt here from the checked setup.
      const contracts = { swapAdapter: TESTNET_DEPLOYMENT.swapAdapter!, swapKeyPolicy: TESTNET_DEPLOYMENT.swapKeyPolicy! };
      checkSwapSetup(setup, { account: address, chainId: robinhoodTestnet.id, ...contracts, markets: TESTNET_SWAP.markets, caps: TESTNET_SWAP.caps, maxDays: TESTNET_SWAP.policyDays });
      const typedData = swapSetupTypedData(setup, contracts);
      const wallet = createWalletClient({ account: address, chain: robinhoodTestnet, transport: custom(provider) });
      await wallet.switchChain({ id: robinhoodTestnet.id }).catch(() => {});

      setStep("signing");
      let authorization;
      if (setup.install?.authorization) {
        const a = setup.install.authorization;
        const s = await signAuthorization({ contractAddress: a.address, chainId: a.chainId, nonce: a.nonce }, { address });
        authorization = { address: s.address, chainId: s.chainId, nonce: s.nonce, r: s.r, s: s.s, yParity: s.yParity };
      }
      const userOp = setup.install ? await wallet.signMessage({ account: address, message: { raw: setup.install.userOpHash } }) : undefined;
      const sign = (td: unknown) => wallet.signTypedData({ account: address, ...(td as TypedDataDefinition) });
      const adapter = [];
      for (const td of typedData.adapter) adapter.push(await sign(td));
      const policy = await sign(typedData.policy);

      setStep("relaying");
      await api.swapKey.register.mutate({ authorization, userOp, adapter, policy });
      await qc.invalidateQueries({ queryKey: trpc.swapKey.status.queryKey() });
    } catch (e) {
      setStep(null);
      setError(e instanceof Error ? e.message : "Swaps were not set up.");
    }
  };

  // Revoke: one signature; the key stops at once, the on-chain uninstall is relayed (no gas from you).
  const revoke = async () => {
    setError(null);
    try {
      setStep("signing");
      const r = await api.swapKey.prepareRevoke.mutate();
      const sw = account.swapWallet;
      if (!sw) throw new Error("The swap wallet isn't available in this browser.");
      const provider = await sw.provider();
      const address = getAddress(sw.address);
      checkRevokeUserOp(r.userOp, r.userOpHash, { account: address, chainId: robinhoodTestnet.id, swapKeyPolicy: TESTNET_DEPLOYMENT.swapKeyPolicy! });
      const wallet = createWalletClient({ account: address, chain: robinhoodTestnet, transport: custom(provider) });
      const signature = await wallet.signMessage({ account: address, message: { raw: r.userOpHash } });
      await api.swapKey.revoke.mutate({ signature });
      setStep(null);
      setRevoked(true);
      await qc.invalidateQueries({ queryKey: trpc.swapKey.status.queryKey() });
    } catch (e) {
      setStep(null);
      setError(e instanceof Error ? e.message : "The swap key was not revoked.");
    }
  };

  const busy = step === "preparing" || step === "signing";
  return (
    <div aria-live="polite">
      {state === "ready" ? (
        <>
          <Tag solid>Swaps ready · session key until {new Date(status.data!.expiresAt!).toLocaleDateString()} · testnet</Tag>
          <button className="w-button secondary" disabled={busy} onClick={revoke}>
            Revoke swap key <Icon name="close" size={16} />
          </button>
        </>
      ) : state === "relaying" ? (
        <Note>{stepText.relaying}</Note>
      ) : (
        <button className="w-button" disabled={busy} onClick={run}>
          Set up Robinhood Chain swaps <Icon name="diagonal" size={16} />
        </button>
      )}
      {busy && !error && <Note>{stepText[step!]}</Note>}
      {status.isError && <Note>Can&apos;t reach Proviso right now, so this status may be out of date: reload the page.</Note>}
      {revoked && state !== "ready" && (
        <Note>Swap key revoked: it can no longer swap. Tokens it bought stay in your wallet; set swaps up again any time.</Note>
      )}
      {error && <Note>Not done: {error}</Note>}
    </div>
  );
}
