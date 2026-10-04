// Everything the signed-in views read, polled in one place and shared through context.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import type { Assignment, BrokerLink, StockSymbol } from "@hapax/shared";
import {
  LOOKBACK,
  facilitiesFor,
  publicClient,
  readEvents,
  readParams,
  readPoolApr,
  readPrices,
  readSnapshot,
  readWalletBalances,
  revertReason,
  sortPrices,
  type ChainEvent,
  type PricePoint,
  type RiskParams,
  type Snapshot,
  type WalletBalances,
} from "./chain";
import { agents, broker } from "./services";
import type { Wallet } from "./wallet";
import type { Step } from "./tx";

const POLL_MS = Number(import.meta.env.VITE_POLL_MS ?? 2500);

export interface Account {
  wallet: Wallet;
  facilities: readonly Address[];
  facilitiesLoaded: boolean;
  facility: Address | null;
  selectFacility: (f: Address) => void;
  snap: Snapshot | null;
  params: RiskParams | null;
  aprBps: number | null;
  balances: WalletBalances | null;
  /** undefined while loading; null when the brokerage connection is unreachable */
  link: BrokerLink | null | undefined;
  brokerName: string;
  /** undefined while loading; null when no agent was ever hired for this facility */
  assignment: Assignment | null | undefined;
  agentServiceUp: boolean;
  /** Set when the account can't be read; cleared on the next successful refresh. */
  loadError: string | null;
  events: ChainEvent[];
  prices: PricePoint[];
  symbol: StockSymbol;
  setSymbol: (s: StockSymbol) => void;
  refresh: () => Promise<void>;
  run: (title: string, steps: Step[], done?: string) => Promise<boolean>;
  busy: boolean;
}

const Ctx = createContext<Account | null>(null);
export const AccountProvider = Ctx.Provider;
export function useAccount() {
  const a = useContext(Ctx);
  if (!a) throw new Error("useAccount outside AccountProvider");
  return a;
}

const storeKey = (owner: Address) => `hapax.facility.${owner.toLowerCase()}`;
const readStored = (owner: Address) => {
  try {
    return localStorage.getItem(storeKey(owner)) as Address | null;
  } catch {
    return null;
  }
};
const writeStored = (owner: Address, f: Address) => {
  try {
    localStorage.setItem(storeKey(owner), f);
  } catch {
    /* storage unavailable */
  }
};

export function useAccountData(wallet: Wallet, preferred: Address | null) {
  const owner = wallet.address;
  const [facilities, setFacilities] = useState<readonly Address[]>([]);
  const [facilitiesLoaded, setFacilitiesLoaded] = useState(false);
  const [facility, setFacility] = useState<Address | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [params, setParams] = useState<RiskParams | null>(null);
  const [aprBps, setApr] = useState<number | null>(null);
  const [balances, setBalances] = useState<WalletBalances | null>(null);
  const [link, setLink] = useState<BrokerLink | null | undefined>(undefined);
  const [brokerName, setBrokerName] = useState("your broker");
  const [assignment, setAssignment] = useState<Assignment | null | undefined>(undefined);
  const [agentServiceUp, setAgentUp] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [events, setEvents] = useState<ChainEvent[]>([]);
  const [prices, setPrices] = useState<PricePoint[]>([]);
  const [symbol, setSymbol] = useState<StockSymbol>("TSLA");
  const cursor = useRef<{ events: bigint | null; prices: bigint | null }>({ events: null, prices: null });

  useEffect(() => {
    readParams().then(setParams, () => {});
    readPoolApr().then((x) => setApr(Number(x)), () => {});
    broker.info().then((i) => setBrokerName(i.name), () => {});
  }, []);

  // Reset per-wallet and per-facility state.
  useEffect(() => {
    setFacilities([]);
    setFacilitiesLoaded(false);
    setFacility(null);
  }, [owner]);
  useEffect(() => {
    setSnap(null);
    setEvents([]);
    setLink(undefined);
    setAssignment(undefined);
    cursor.current.events = null;
  }, [facility]);
  useEffect(() => {
    setPrices([]);
    cursor.current.prices = null;
  }, [symbol]);

  const selectFacility = useCallback(
    (f: Address) => {
      writeStored(owner, f);
      setFacility(f);
    },
    [owner],
  );

  const tick = useCallback(async () => {
    const list = await facilitiesFor(owner);
    setFacilities(list);
    setFacilitiesLoaded(true);

    // Only ever show a facility this wallet owns: preferred (e.g. returning from the broker), last used, newest.
    let f = facility;
    const owns = (x: Address | null) => !!x && list.some((y) => y.toLowerCase() === x.toLowerCase());
    if (!owns(f)) {
      f = owns(preferred) ? preferred : owns(readStored(owner)) ? readStored(owner) : list.length ? list[list.length - 1] : null;
      if (f !== facility) {
        setFacility(f);
        setBalances(await readWalletBalances(owner, f));
        return;
      }
    }
    setBalances(await readWalletBalances(owner, f));
    if (!f) return;

    const latest = await publicClient.getBlockNumber();
    const start = latest > LOOKBACK ? latest - LOOKBACK : 0n;
    const [s] = await Promise.all([
      readSnapshot(f),
      broker.link(f).then(setLink, () => setLink(null)),
      agents.assignment(f).then(
        (a) => {
          setAssignment(a);
          setAgentUp(true);
        },
        () => setAgentUp(false),
      ),
    ]);
    setSnap(s);

    const evFrom = cursor.current.events ?? start;
    if (latest >= evFrom) {
      const fresh = await readEvents(f, evFrom, latest);
      cursor.current.events = latest + 1n;
      if (fresh.length) setEvents((prev) => [...new Map([...prev, ...fresh].map((e) => [e.key, e])).values()]);
    }
    const pxFrom = cursor.current.prices ?? start;
    if (latest >= pxFrom) {
      const fresh = await readPrices(symbol, pxFrom, latest);
      cursor.current.prices = latest + 1n;
      if (fresh.length)
        setPrices((prev) => sortPrices([...new Map([...prev, ...fresh].map((p) => [p.key, p])).values()]).slice(-1500));
    }
  }, [owner, facility, preferred, symbol]);

  const running = useRef(false);
  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      await tick();
      setLoadError(null);
    } catch (err) {
      console.warn("refresh failed", err);
      setLoadError(revertReason(err));
    } finally {
      running.current = false;
    }
  }, [tick]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return {
    facilities,
    facilitiesLoaded,
    facility,
    selectFacility,
    snap,
    params,
    aprBps,
    balances,
    link,
    brokerName,
    assignment,
    agentServiceUp,
    loadError,
    events,
    prices,
    symbol,
    setSymbol,
    refresh,
  };
}
