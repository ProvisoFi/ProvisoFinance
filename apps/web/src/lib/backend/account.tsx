"use client";
import { PrivyProvider, useCreateWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { robinhoodTestnet } from "@proviso/chain";
import type { Session } from "@supabase/supabase-js";
import type { EIP1193Provider } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "./supabase";

// unavailable: backend env not configured · disconnected: no wallet · signing: waiting for the
// sign-in signature · signed-in: Supabase session for the connected wallet.
export type AccountStatus = "unavailable" | "loading" | "disconnected" | "signing" | "signed-in" | "error";
export type Account = {
  status: AccountStatus;
  address: string | null;
  error: string | null;
  connect: () => void;
  signIn: () => void;
  disconnect: () => void;
  /** The connected wallet's EIP-1193 provider, for stamp and backup signatures. */
  provider: () => Promise<EIP1193Provider | null>;
  /**
   * The account's swap wallet: its Privy embedded wallet, the only kind that can 7702-delegate to
   * Kernel. For an email login it is the sign-in wallet too; for a MetaMask login it is a second
   * wallet of the same account (create it with createSwapWallet). Null until one exists.
   */
  swapWallet: { address: string; provider: () => Promise<EIP1193Provider> } | null;
  createSwapWallet: () => Promise<void>;
};

const noop = () => {};
const AccountContext = createContext<Account>({
  status: "unavailable",
  address: null,
  error: null,
  connect: noop,
  signIn: noop,
  disconnect: noop,
  provider: async () => null,
  swapWallet: null,
  createSwapWallet: async () => {},
});
export const useAccount = () => useContext(AccountContext);

const statement = "Sign in to Proviso. This signature proves you own this wallet; it costs nothing and moves no funds.";

function PrivyAccount({ children }: { children: ReactNode }) {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  // One Proviso account per Privy user. Only wallets linked to this user count: an extension that
  // is merely connected in this browser (MetaMask after an email login) must not take over. The
  // account is the linked external wallet (MetaMask login) if any, else the embedded one (email
  // login); the embedded wallet is always the swap wallet.
  const linked = new Set(
    ((user?.linkedAccounts ?? []) as { type: string; address?: string }[])
      .filter((a) => a.type === "wallet" && a.address)
      .map((a) => a.address!.toLowerCase()),
  );
  const mine = wallets.filter((w) => linked.has(w.address.toLowerCase()));
  const embeddedWallet = mine.find((w) => w.walletClientType === "privy");
  const wallet = mine.find((w) => w.walletClientType !== "privy") ?? embeddedWallet ?? wallets[0];
  const address = wallet?.address.toLowerCase() ?? null;
  const [session, setSession] = useState<Session | null>(null);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    const auth = supabase()!.auth;
    auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const signIn = useCallback(async () => {
    if (!wallet) return;
    setSigning(true);
    setError(null);
    try {
      const { error } = await supabase()!.auth.signInWithWeb3({
        chain: "ethereum",
        statement,
        // Same EIP-1193 provider at runtime; Privy and Supabase ship slightly different typings.
        wallet: (await wallet.getEthereumProvider()) as never,
      });
      if (error) setError(error.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in was not completed.");
    } finally {
      setSigning(false);
    }
  }, [wallet]);

  const sessionAddress = JSON.stringify(session?.user.identities ?? []).toLowerCase();
  const signedIn = !!session && !!address && sessionAddress.includes(address);

  // Ask for the sign-in signature once per newly connected wallet; retries go through signIn().
  useEffect(() => {
    if (authenticated && address && !signedIn && attempted.current !== address) {
      attempted.current = address;
      signIn();
    }
  }, [authenticated, address, signedIn, signIn]);

  const disconnect = useCallback(async () => {
    attempted.current = null;
    await supabase()!.auth.signOut();
    await logout();
  }, [logout]);

  const status: AccountStatus = !ready
    ? "loading"
    : !authenticated || !address
      ? "disconnected"
      : signedIn
        ? "signed-in"
        : signing
          ? "signing"
          : error
            ? "error"
            : "signing";

  return (
    <AccountContext.Provider
      value={{
        status,
        address,
        error,
        connect: login,
        signIn,
        disconnect,
        provider: async () => (wallet ? ((await wallet.getEthereumProvider()) as unknown as EIP1193Provider) : null),
        swapWallet: embeddedWallet
          ? { address: embeddedWallet.address.toLowerCase(), provider: async () => (await embeddedWallet.getEthereumProvider()) as unknown as EIP1193Provider }
          : null,
        createSwapWallet: async () => void (await createWallet()),
      }}
    >
      {children}
    </AccountContext.Provider>
  );
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId || !supabase()) return <>{children}</>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["wallet", "email", "telegram"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        // Testnet until mainnet sign-off.
        defaultChain: robinhoodTestnet,
        supportedChains: [robinhoodTestnet, arbitrumSepolia], // Hyperliquid testnet signs on Arbitrum Sepolia
        appearance: { theme: "dark" },
      }}
    >
      <PrivyAccount>{children}</PrivyAccount>
    </PrivyProvider>
  );
}
