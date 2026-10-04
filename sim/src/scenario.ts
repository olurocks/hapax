// Weekend-gap simulation: broker-only margin vs Hapax, on the same weekend crash.
//
// The thesis Hapax rests on: a stock-backed loan marked with the reference feed alone is marked at
// Friday's close all weekend, so the lender cannot react until Monday's open and liquidates into the
// full gap. Hapax reads the 24/7 onchain market, so its risk engine deleverages the moment the live
// mark first breaches a threshold, at a higher price, and the exposure-based collateral backstop
// absorbs the residual. This module quantifies the difference in lender loss.
//
// Everything here is a pure, deterministic function of the inputs (no chain access), so the numbers
// are reproducible. Defaults mirror contracts/script/DemoConfig.sol and the demo account.

export interface Lot {
  symbol: string;
  shares: number;
  price: number; // USD at Friday's close
}

export interface SimParams {
  /** Brokerage collateral the broker attests. Shares stay at the broker; nothing moves onchain. */
  holdings: Lot[];
  cashUsd: number;
  /** The facility's leveraged state at Friday's close. */
  debtUsd: number;
  facilityIdleUsd: number; // borrowed USDG not yet spent, held in the facility
  facilityPosition: Lot[]; // stock the agent bought with borrowed USDG, priced at Friday's close
  /**
   * Live price path per symbol over the weekend, Friday's close -> Monday's open.
   * Index 0 is Friday's close; the last entry is Monday's open. Symbols absent here hold flat.
   */
  weekendPath: Record<string, number[]>;
  /** Risk parameters (bps). Defaults mirror DemoConfig.sol. */
  haircutOpenBps: number;
  haircutWeekendBps: number;
  maxLtvBps: number;
  maxBorrowUtilBps: number;
  hDelevBps: number; // position health (A/D) deleverage threshold, 8500 = 0.85
  uDelevBps: number; // utilization (E/limit) deleverage threshold, 10000 = 1.00
  maxSlippageBps: number; // Hapax forced-reduction slippage bound
  brokerSlippageBps: number; // broker liquidation market impact at Monday's open
  /** Hours the reference feed is dark: Friday 4pm -> Monday 9:30am ≈ 65.5h. */
  weekendHours: number;
}

export function defaultParams(): SimParams {
  // The demo account (docs/DEPLOYMENTS.md, README): 1,000 TSLA @ $250 + 500 AMZN @ $200 + $50k = $400k.
  // The agent has drawn $300k USDG and bought $250k of TSLA, leaving $50k idle (H ≈ 1.0 at Friday's close).
  return {
    holdings: [
      { symbol: "TSLA", shares: 1000, price: 250 },
      { symbol: "AMZN", shares: 500, price: 200 },
    ],
    cashUsd: 50_000,
    debtUsd: 300_000,
    facilityIdleUsd: 50_000,
    facilityPosition: [{ symbol: "TSLA", shares: 1000, price: 250 }],
    // TSLA gaps down hard on Saturday and keeps sliding into Monday's open (Fri -> Mon, ~-28%).
    // Hapax sees the Saturday break on the live feed; the broker is blind until Monday.
    weekendPath: { TSLA: [250, 212, 202, 192, 184, 180] },
    haircutOpenBps: 2_500,
    haircutWeekendBps: 4_000,
    maxLtvBps: 8_000,
    maxBorrowUtilBps: 7_000,
    hDelevBps: 8_500,
    uDelevBps: 10_000,
    maxSlippageBps: 100,
    brokerSlippageBps: 100,
    weekendHours: 65.5,
  };
}

const frac = (bps: number) => bps / 10_000;
const round = (x: number) => Math.round(x * 100) / 100;

/** Live price of a symbol at a weekend step, clamped to the path, flat if the symbol has no path. */
function priceAt(symbol: string, step: number, p: SimParams, fridayPrice: number): number {
  const path = p.weekendPath[symbol];
  if (!path || path.length === 0) return fridayPrice;
  return path[Math.min(step, path.length - 1)];
}

function stepCount(p: SimParams): number {
  return Math.max(1, ...Object.values(p.weekendPath).map((a) => a.length));
}

interface MarkState {
  step: number;
  hours: number;
  prices: Record<string, number>;
  assets: number; // A: idle + position at live mark, no haircut
  stressedAssets: number; // A_s: idle + position at live mark, weekend haircut
  collateral: number; // brokerage collateral at live mark, weekend haircut, + cash
  creditLimit: number;
  exposure: number; // E = max(0, D - A_s)
  health: number; // H = A / D
  utilization: number; // U = E / limit
}

/** Evaluate the facility and collateral at one weekend step, marking everything to the live price. */
function evalStep(step: number, p: SimParams): MarkState {
  const prices: Record<string, number> = {};
  const priceOf = (lot: Lot) => {
    const px = priceAt(lot.symbol, step, p, lot.price);
    prices[lot.symbol] = px;
    return px;
  };

  const positionValue = p.facilityPosition.reduce((s, l) => s + l.shares * priceOf(l), 0);
  const positionStressed = p.facilityPosition.reduce(
    (s, l) => s + l.shares * priceAt(l.symbol, step, p, l.price) * (1 - frac(p.haircutWeekendBps)),
    0,
  );
  const assets = p.facilityIdleUsd + positionValue;
  const stressedAssets = p.facilityIdleUsd + positionStressed;

  const eligible =
    p.holdings.reduce(
      (s, l) => s + l.shares * priceOf(l) * (1 - frac(p.haircutWeekendBps)),
      0,
    ) + p.cashUsd;
  const creditLimit = eligible * frac(p.maxLtvBps);

  const exposure = Math.max(0, p.debtUsd - stressedAssets);
  return {
    step,
    hours: round((step / Math.max(1, stepCount(p) - 1)) * p.weekendHours),
    prices,
    assets: round(assets),
    stressedAssets: round(stressedAssets),
    collateral: round(eligible),
    creditLimit: round(creditLimit),
    exposure: round(exposure),
    health: p.debtUsd > 0 ? round(assets / p.debtUsd) : Infinity,
    utilization: creditLimit > 0 ? round(exposure / creditLimit) : Infinity,
  };
}

/** Proceeds from flattening the facility: idle USDG + position sold at `prices` net of slippage. */
function flatten(prices: Record<string, number>, slippageBps: number, p: SimParams): number {
  const stock = p.facilityPosition.reduce(
    (s, l) => s + l.shares * (prices[l.symbol] ?? l.price) * (1 - frac(slippageBps)),
    0,
  );
  return round(p.facilityIdleUsd + stock);
}

/** What the broker can recover by selling the attested shares at `prices`, net of slippage, + cash. */
function collateralLiquidation(prices: Record<string, number>, slippageBps: number, p: SimParams): number {
  const stock = p.holdings.reduce(
    (s, l) => s + l.shares * (prices[l.symbol] ?? l.price) * (1 - frac(slippageBps)),
    0,
  );
  return round(stock + p.cashUsd);
}

export interface SimResult {
  params: SimParams;
  fridayClose: {
    collateralOpen: number;
    creditLimitOpen: number;
    debt: number;
    health: number;
    buyingPower: { cashOutCredit: number; hapax: number };
  };
  timeline: MarkState[];
  hapax: Resolution;
  brokerOnly: Resolution;
  verdict: {
    hoursEarlier: number;
    lenderLossAvoidedGross: number;
    lenderLossAvoidedNet: number;
    summary: string;
  };
}

export interface Resolution {
  policy: string;
  actsAtHours: number;
  actedStep: number;
  prices: Record<string, number>;
  positionProceeds: number;
  debtRepaid: number;
  residual: number; // debt the facility sale could not cover
  collateralBackstop: number; // broker-side recovery available at the action price
  lenderLossGross: number; // residual before the brokerage backstop
  lenderLossNet: number; // residual after selling the attested collateral
  note: string;
}

function resolve(policy: string, state: MarkState, backstopSlippageBps: number, p: SimParams, note: string): Resolution {
  const positionProceeds = flatten(state.prices, p.maxSlippageBps, p);
  const residual = Math.max(0, round(p.debtUsd - positionProceeds));
  const collateralBackstop = collateralLiquidation(state.prices, backstopSlippageBps, p);
  return {
    policy,
    actsAtHours: state.hours,
    actedStep: state.step,
    prices: state.prices,
    positionProceeds,
    debtRepaid: Math.min(p.debtUsd, positionProceeds),
    residual,
    collateralBackstop,
    lenderLossGross: residual,
    lenderLossNet: Math.max(0, round(residual - collateralBackstop)),
    note,
  };
}

export function simulate(p: SimParams): SimResult {
  const steps = stepCount(p);
  const timeline: MarkState[] = [];
  for (let s = 0; s < steps; s++) timeline.push(evalStep(s, p));

  // Friday's close, with the OPEN-session haircut, and the two buying-power regimes.
  const eligibleOpen =
    p.holdings.reduce((s, l) => s + l.shares * l.price * (1 - frac(p.haircutOpenBps)), 0) + p.cashUsd;
  const creditLimitOpen = round(eligibleOpen * frac(p.maxLtvBps));
  const cashOutCredit = round(creditLimitOpen * frac(p.maxBorrowUtilBps)); // money leaves -> backs the full loan
  const hapaxBuyingPower = round(cashOutCredit / frac(p.haircutOpenBps)); // money stays -> backs only the stressed loss

  // Hapax: the 24/7 engine deleverages at the first weekend step that breaches a threshold.
  const trigger = timeline.find((m) => m.step > 0 && (m.health < frac(p.hDelevBps) || m.utilization >= 1));
  const hapax: Resolution = trigger
    ? resolve(
        "Hapax (24/7 risk engine)",
        trigger,
        p.maxSlippageBps,
        p,
        `Live mark breached the deleverage threshold (H<${frac(p.hDelevBps)} or U≥1); flattened in-block.`,
      )
    : {
        policy: "Hapax (24/7 risk engine)",
        actsAtHours: 0,
        actedStep: -1,
        prices: timeline[0].prices,
        positionProceeds: 0,
        debtRepaid: 0,
        residual: 0,
        collateralBackstop: 0,
        lenderLossGross: 0,
        lenderLossNet: 0,
        note: "No threshold was breached over the weekend; no action needed.",
      };

  // Broker-only margin: blind until Monday's open, then liquidates into the realised gap.
  const monday = timeline[timeline.length - 1];
  const brokerOnly = resolve(
    "Broker-only margin",
    monday,
    p.brokerSlippageBps,
    p,
    "Reference feed dark all weekend; first opportunity to act is Monday's open, at the gapped price.",
  );

  const hoursEarlier = round(brokerOnly.actsAtHours - (hapax.actedStep >= 0 ? hapax.actsAtHours : brokerOnly.actsAtHours));
  const lenderLossAvoidedGross = round(brokerOnly.lenderLossGross - hapax.lenderLossGross);
  const lenderLossAvoidedNet = round(brokerOnly.lenderLossNet - hapax.lenderLossNet);
  // Price the crash was flattened at, for the headline (first symbol with a weekend path).
  const crashed = Object.keys(p.weekendPath)[0];
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

  return {
    params: p,
    fridayClose: {
      collateralOpen: round(eligibleOpen),
      creditLimitOpen,
      debt: p.debtUsd,
      health: timeline[0].health,
      buyingPower: { cashOutCredit, hapax: hapaxBuyingPower },
    },
    timeline,
    hapax,
    brokerOnly,
    verdict: {
      hoursEarlier,
      lenderLossAvoidedGross,
      lenderLossAvoidedNet,
      summary:
        hapax.actedStep < 0
          ? `Hapax never breached a threshold; broker-only still liquidated into the Monday gap, a ${money(brokerOnly.residual)} shortfall (net ${money(brokerOnly.lenderLossNet)} after the brokerage backstop).`
          : lenderLossAvoidedNet > 0
            ? `Hapax de-risked ${hoursEarlier}h earlier (at ${money(hapax.prices[crashed])} vs Monday's ${money(brokerOnly.prices[crashed])}) and the gap outran the ${frac(p.haircutWeekendBps) * 100}% haircut: broker-only loses ${money(brokerOnly.lenderLossNet)} of lender capital, Hapax ${money(hapax.lenderLossNet)}.`
            : `Hapax de-risked ${hoursEarlier}h earlier, flattening at ${money(hapax.prices[crashed])} vs the broker's Monday ${money(brokerOnly.prices[crashed])}, which shrinks the shortfall the backstop must absorb by ${money(lenderLossAvoidedGross)} (${money(brokerOnly.residual)} -> ${money(hapax.residual)}). At this leverage the brokerage backstop covers the residual in both cases (net lender loss $0); a deeper or portfolio-wide gap (raise it via POST /sim) pushes broker-only into real lender loss while Hapax stays protected.`,
    },
  };
}
