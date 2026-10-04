// Browser wallets only. Wallets announce themselves through EIP-6963; a lone window.ethereum is the fallback.
import { useCallback, useEffect, useState } from "react";
import { createWalletClient, custom, getAddress, type Address, type WalletClient } from "viem";
import { chain } from "./chain";

export interface Eip1193 {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, fn: (...args: any[]) => void) => void;
  removeListener?: (event: string, fn: (...args: any[]) => void) => void;
}
export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}
export interface DiscoveredWallet {
  info: WalletInfo;
  provider: Eip1193;
}
export interface Wallet {
  address: Address;
  chainId: number;
  info: WalletInfo;
  provider: Eip1193;
  client: WalletClient;
}

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<DiscoveredWallet>;
  }
}

const LAST = "hapax.wallet";
const remember = (rdns: string | null) => {
  try {
    if (rdns) localStorage.setItem(LAST, rdns);
    else localStorage.removeItem(LAST);
  } catch {
    /* storage unavailable */
  }
};
const remembered = () => {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
};

/** Wallets installed in this browser, updated as they announce themselves. */
export function useDiscoveredWallets() {
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  useEffect(() => {
    const seen = new Map<string, DiscoveredWallet>();
    const onAnnounce = (e: CustomEvent<DiscoveredWallet>) => {
      seen.set(e.detail.info.rdns || e.detail.info.uuid, e.detail);
      setWallets([...seen.values()]);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    // Older wallets that don't speak EIP-6963.
    const t = setTimeout(() => {
      if (!seen.size && window.ethereum) {
        seen.set("injected", {
          info: { uuid: "injected", name: "Browser wallet", icon: "", rdns: "injected" },
          provider: window.ethereum,
        });
        setWallets([...seen.values()]);
      }
    }, 400);
    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      clearTimeout(t);
    };
  }, []);
  return wallets;
}

function build(w: DiscoveredWallet, address: string, chainId: number): Wallet {
  const addr = getAddress(address);
  return {
    address: addr,
    chainId,
    info: w.info,
    provider: w.provider,
    client: createWalletClient({ account: addr, chain, transport: custom(w.provider) }),
  };
}

const chainOf = async (p: Eip1193) => Number(await p.request({ method: "eth_chainId" }));

export async function switchToAppChain(p: Eip1193) {
  const hex = `0x${chain.id.toString(16)}`;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 4902 && code !== -32603) throw err;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
        },
      ],
    });
  }
}

/**
 * The connected wallet. Reconnects silently to the last wallet used (no prompt), and follows the wallet's
 * account and network changes.
 */
export function useWallet(discovered: DiscoveredWallet[]) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [restoring, setRestoring] = useState(true);

  // Silent restore: eth_accounts never prompts.
  useEffect(() => {
    if (wallet) return;
    const rdns = remembered();
    if (!rdns) {
      const t = setTimeout(() => setRestoring(false), 500);
      return () => clearTimeout(t);
    }
    const w = discovered.find((x) => x.info.rdns === rdns);
    if (!w) {
      const t = setTimeout(() => setRestoring(false), 800);
      return () => clearTimeout(t);
    }
    let alive = true;
    (async () => {
      try {
        const [acct] = (await w.provider.request({ method: "eth_accounts" })) as string[];
        if (alive && acct) setWallet(build(w, acct, await chainOf(w.provider)));
      } catch {
        /* wallet locked or unavailable */
      } finally {
        if (alive) setRestoring(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [discovered, wallet]);

  // Follow account and network changes in the wallet.
  useEffect(() => {
    if (!wallet) return;
    const p = wallet.provider;
    const onAccounts = (accts: string[]) => {
      if (!accts.length) {
        remember(null);
        setWallet(null);
      } else setWallet((w) => (w ? build({ info: w.info, provider: w.provider }, accts[0], w.chainId) : w));
    };
    const onChain = (id: string) => setWallet((w) => (w ? { ...w, chainId: Number(id) } : w));
    p.on?.("accountsChanged", onAccounts);
    p.on?.("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [wallet?.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = useCallback(async (w: DiscoveredWallet) => {
    const [acct] = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
    if (!acct) throw new Error("No account selected");
    let id = await chainOf(w.provider);
    if (id !== chain.id) {
      try {
        await switchToAppChain(w.provider);
        id = await chainOf(w.provider);
      } catch {
        /* user declined; the app shows a switch-network prompt */
      }
    }
    remember(w.info.rdns);
    setWallet(build(w, acct, id));
  }, []);

  const disconnect = useCallback(async () => {
    const p = wallet?.provider;
    remember(null);
    setWallet(null);
    // Wallets that support it forget the site's permission too; others just stay unlinked from the app.
    await p?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
  }, [wallet]);

  const switchNetwork = useCallback(async () => {
    if (!wallet) return;
    await switchToAppChain(wallet.provider);
    const id = await chainOf(wallet.provider);
    setWallet((w) => (w ? { ...w, chainId: id } : w));
  }, [wallet]);

  return { wallet, restoring, connect, disconnect, switchNetwork };
}
