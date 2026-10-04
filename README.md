# Hapax

**Give your AI agent buying power, not your keys.** Your Robinhood stocks back a USDG credit line on Robinhood Chain that an AI agent can trade 24/7, under a mandate the contract enforces.

- **Your stocks stay put.** The broker signs an attestation of your holdings (shares, not dollars). That sets an onchain credit limit. Nothing is moved or sold.
- **The agent gets a mandate, not keys.** Which stocks it may buy, a per-position cap, an expiry, and a kill switch. It can never borrow, withdraw, or send funds anywhere but allowlisted venues. Anything outside the mandate reverts onchain.
- **About 4x the buying power of cash-out credit.** Borrowed USDG never leaves the facility, so your collateral only backs what the positions could lose. The same $400k account goes from $175k to $700k of buying power.
- **Risk management that doesn't stop on Friday.** Chainlink stock feeds update 24/5; Robinhood stock tokens trade 24/7. A session-aware risk engine revalues everything from the live onchain market on weekends, deleverages automatically, and freezes in the same block if the broker revokes.

Built for Arbitrum Open House Singapore (Robinhood Chain). Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Real vs simulated

| Real | Simulated (labelled in the UI) |
|---|---|
| EIP-712 holdings attestations, expiry, nonces, revocation | The broker (our signing service) |
| Facility smart account and per-action policy | Legal enforceability of the pledge |
| Session-aware oracle (reference vs live, OPEN vs CLOSED) | Price feeds on testnet (Robinhood's testnet stock feeds are mocks; ours are operator-driven demo feeds) |
| Agent mandate (token list, position cap, expiry, kill switch), enforced onchain | |
| AI agent trading through the mandate (Claude, with a rules fallback) | |
| Two-signal risk engine, state machine, permissionless deleverage | Broker-side sale of shares on default |
| Robinhood testnet stock tokens (TSLA, AMZN, NFLX) and USDG | Venue liquidity (demo venue priced off the live feed) |

## Layout

```
contracts/   Foundry: MarketOracle, CollateralRegistry, LiquidityPool, FacilityFactory, CreditFacility, RiskManager, demo feed/venue
shared/      Chain config, generated ABIs, EIP-712 types
broker/      Broker simulator: signs attestations, operator API (revoke, encumber, silence, settle)
keeper/      Evaluates facilities, pokes state changes, deleverages
market/      Demo market operator: open/close the session, move live prices
agent/       AI agent: Claude turns plain-English instructions into trades through the agent key
web/         Dashboard: buying power, risk, agent mandate, activity feed with onchain refusals, demo console
docs/        Architecture
```

## Run locally

Requires Foundry, Node 20+, pnpm.

```bash
pnpm install
cp .env.example .env          # fill in keys; for Anvil use its default dev keys
pnpm contracts:test           # 31 scenario tests, one per demo scene and guardrail

anvil                          # terminal 1
pnpm deploy:local              # writes contracts/deployments/31337.json
pnpm abis                      # regenerate shared/src/abis.ts after contract changes
pnpm market                    # terminal 2, :8788
pnpm broker                    # terminal 3, :8787
pnpm keeper                    # terminal 4
pnpm agent                     # terminal 5, :8789 (set ANTHROPIC_API_KEY for Claude; otherwise rules mode;
                               #   AGENT_INTERVAL_MS=0 turns off autorun so the demo console drives every decision)
pnpm web                       # terminal 6, dashboard at http://localhost:5173
```

The dashboard reads the chain directly and drives the demo services from its demo console. Owner actions use a browser wallet, or `VITE_DEV_OWNER_PK` on local Anvil.

Drive the demo:

```bash
# borrower opens a facility (factory.openFacility()), then the broker attests their account
curl -X POST localhost:8787/accounts -d '{"facility":"0x...","holdings":{"TSLA":1000,"AMZN":500},"cashUsd":50000}'
# borrow USDG (facility.borrow), then appoint the agent (facility.setAgent(agent, expiry, maxPositionUsd, [TSLA, NFLX]))
curl -X POST localhost:8789/facility -d '{"facility":"0x..."}'
curl -X POST localhost:8789/tick                                  # agent decides and trades
curl -X POST localhost:8789/try -d '{"action":"buy","symbol":"AMZN","usd":10000}'  # refused onchain: OutsideMandate
curl -X POST localhost:8788/session -d '{"open":false}'          # Friday 4pm: buying power 700k -> 364k
curl -X POST localhost:8788/shock -d '{"symbol":"TSLA","pct":-16}' # Saturday crash: keeper deleverages, facility -> CURE
curl -X POST localhost:8787/revoke -d '{"facility":"0x..."}'      # broker revokes: facility FROZEN in the same block
```

## Robinhood Chain testnet

Chain id 46630, RPC `https://rpc.testnet.chain.robinhood.com`, explorer `https://explorer.testnet.chain.robinhood.com`. Set `CHAIN_ID=46630`, `RPC_URL`, `USE_MOCKS=false`, then `pnpm deploy:testnet`. Defaults use the testnet faucet stock tokens and USDG (addresses in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#11-robinhood-chain-notes)).
