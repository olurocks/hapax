# Hapax

**Give your AI agent buying power, not your keys.** Your Robinhood stocks back a USDG credit line on Robinhood Chain that an AI agent can trade 24/7, under a mandate the contract enforces.

- **Your stocks stay put.** The broker signs an attestation of your holdings (shares, not dollars). That sets an onchain credit limit. Nothing is moved or sold.
- **The agent gets a mandate, not keys.** Which stocks it may buy, a per-position cap, an expiry, and a kill switch. It can never borrow, withdraw, or send funds anywhere but allowlisted venues. Anything outside the mandate reverts onchain.
- **About 4x the buying power of cash-out credit.** Borrowed USDG never leaves the facility, so your collateral only backs what the positions could lose. The same $400k account goes from $175k to $700k of buying power.
- **Risk management that doesn't stop on Friday.** Chainlink stock feeds update 24/5; Robinhood stock tokens trade 24/7. A session-aware risk engine revalues everything from the live onchain market on weekends, deleverages automatically, and freezes in the same block if the broker revokes.

Built for Arbitrum Open House Singapore (Robinhood Chain). Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Live testnet addresses: [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).

## Real vs simulated

| Real | Simulated (driven from the demo control plane, never the app) |
|---|---|
| EIP-712 holdings attestations, expiry, nonces, revocation | The broker (our signing service) |
| Facility smart account and per-action policy | Legal enforceability of the pledge |
| Session-aware oracle (reference vs live, OPEN vs CLOSED) | Price feeds on testnet (Robinhood's testnet stock feeds are mocks; ours are operator-driven demo feeds) |
| Agent mandate (token list, position cap, expiry, kill switch), enforced onchain | |
| AI agents trading through the mandate (Claude, or rules strategies), each on its own derived key | Test funds for wallets (faucet) |
| Two-signal risk engine, state machine, permissionless deleverage | Broker-side sale of shares on default |
| USDG as the settlement currency: pool, venue quotes, repayment | Venue liquidity (demo venue priced off the live feed) |
| Contract behaviour is identical on real or mock tokens | The live testnet deploy uses **mock** TSLA/AMZN/NFLX/USDG: the faucet caps at ~5 shares and USDG is not obtainable at scale, so a $1M pool needs mintable tokens. Real token addresses in [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md) |

## Layout

```
contracts/   Foundry: MarketOracle, CollateralRegistry, LiquidityPool, FacilityFactory, CreditFacility, RiskManager, demo feed/venue
shared/      Chain config, generated ABIs, EIP-712 types, owner-signed request format
broker/      Broker simulator: sign-in + consent pages, holdings attestations, admin API (revoke, encumber, silence, settle)
keeper/      Evaluates facilities, pokes state changes, deleverages
market/      Demo market operator: open/close the session, move live prices (admin API)
agent/       Agent catalog (Claude, Dip Buyer, Momentum); one derived key per hired facility; trades through the mandate
control/     Demo control plane: one local HTTP service + the `pnpm demo` CLI for every simulated variable; `pnpm smoke`
sim/         Weekend-gap simulation endpoint: broker-only margin vs Hapax, lender loss for each
web/         The user app
docs/        Architecture write-up, demo walkthrough, live deployment addresses
```

## The app

`http://localhost:5173` is the product, end to end, with no demo controls:

1. **Connect a browser wallet** (MetaMask, Rabby, anything that speaks EIP-6963). Wrong network → one-click switch.
2. **Open a credit account** (your facility; open more from the account switcher).
3. **Connect your brokerage**: the app sends you to the broker's sign-in page, you approve what Hapax may see, and you land back with a signed attestation and a credit limit.
4. **Borrow** USDG into the account.
5. **Hire an agent** from the catalog: choose the stocks it may buy, a per-position cap and how long the mandate lasts, write its instructions. One transaction appoints it onchain, one signature starts it. Edit instructions, change limits, renew or stop it at any time.
6. **Watch it trade**: account value and P&L, risk gauges, live vs exchange prices, an activity feed with every fill and every onchain refusal.
7. **Take profits**: withdraw what the account holds above its debt to your wallet; **repay** from account cash or straight from your wallet; **add funds**; **sell** a position yourself; or **close out** in one transaction (sell everything, repay, stop the agent, send the rest to your wallet).
8. **Disconnect your brokerage** once nothing is owed.

## Demo control plane

Everything Hapax simulates (the brokerage's customers, the price feeds, the broker's decisions, test funds, the clock) is set from `control/`, never from the app. It listens on localhost and calls the other services' `/admin/*` routes with `ADMIN_TOKEN`.

```bash
pnpm demo help
pnpm demo seed alex 2468 TSLA=1000 AMZN=500 cash=50000 holder="Alex Rivera"   # a brokerage customer to sign in as
pnpm demo faucet 0xYOUR_WALLET usdg=100000 eth=1                             # gas + USDG for repaying from the wallet
pnpm demo liquidity 1000000          # the lender supplies more USDG to the pool
pnpm demo close                      # Friday 4pm: reference feeds stop, buying power shrinks
pnpm demo shock TSLA -16             # weekend crash: the keeper deleverages
pnpm demo try buy AMZN 10000         # force an agent trade outside its mandate: reverts OutsideMandate
pnpm demo tick                       # force one agent decision now
pnpm demo revoke                     # broker revokes: the account freezes in the same block
pnpm demo settle                     # broker settles a defaulted account
pnpm demo advance 300                # jump Anvil's clock
pnpm demo status                     # every account, state, brokerage link and agent
```

Commands that take an account default to the newest one; pass a facility address or an owner wallet to pick another. The same actions are plain HTTP on `http://127.0.0.1:8791` (see `control/src/index.ts`).

## Run locally

Requires Foundry, Node 20+, pnpm, and a browser wallet.

```bash
pnpm install
cp .env.example .env          # fill in keys; for Anvil use its default dev keys
pnpm contracts:test           # 40 tests: every demo scene and guardrail, plus the owner's exit paths

anvil                          # terminal 1
pnpm deploy:local              # writes contracts/deployments/31337.json
pnpm abis                      # regenerate shared/src/abis.ts after contract changes
pnpm market                    # terminal 2, :8788
pnpm broker                    # terminal 3, :8787
pnpm keeper                    # terminal 4
pnpm agent                     # terminal 5, :8789 (ANTHROPIC_API_KEY enables the Claude agent)
pnpm control                   # terminal 6, :8791 (demo control plane; drive it with `pnpm demo`)
pnpm web                       # terminal 7, http://localhost:5173
pnpm sim                       # optional, :8790 (GET /sim weekend-gap comparison; no chain needed)

pnpm smoke                     # optional: the whole user journey against the running services
```

In your wallet, add the network (the app offers to), then fund the wallet with `pnpm demo faucet <address>`. See [docs/DEMO.md](docs/DEMO.md) for the full storyline.

## Robinhood Chain testnet

Chain id 46630, RPC `https://rpc.testnet.chain.robinhood.com`, explorer `https://explorer.testnet.chain.robinhood.com`. Set `CHAIN_ID=46630`, `RPC_URL`, `USE_MOCKS=true`, then `pnpm deploy:testnet`. Current addresses: [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).
