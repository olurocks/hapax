# Deployments

## Robinhood Chain testnet (chain id 46630)

- RPC: `https://rpc.testnet.chain.robinhood.com`
- Explorer: `https://explorer.testnet.chain.robinhood.com`
- Deployed: 2026-10-04 (redeployed with `repayFrom`, `cashOut` and the P&L counters). All 17 contracts verified on Blockscout.
- Admin / demo operator: `0xef004915965f882F739C17ac68fb3A0F031074Ca`
- Broker signer: `0x35Ba6B4224Bd7fdA5117e9e12Cf9dB2b9b1F4D19`

### Tokens — mock (see note)

This deployment uses **mock ERC-20 tokens**, not Robinhood's real testnet faucet tokens. The real stock tokens and USDG are not mintable by us, and the faucet caps at ~5 shares per asset — far below the liquidity the demo needs (a ~$1M pool and venue inventory). The mock tokens carry the same symbols, decimals (USDG 6, stocks 18) and oracle wiring, so the contract behaviour is identical; only the token issuer differs.

For reference, the real Robinhood Chain testnet token addresses (usable with `USE_MOCKS=false` once funded):

| Token | Real testnet address |
|---|---|
| USDG | `0x7E955252E15c84f5768B83c41a71F9eba181802F` |
| TSLA | `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E` |
| AMZN | `0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02` |
| NFLX | `0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93` |

| Token | Address |
|---|---|
| USDG (mock, 6 dec) | `0x515299bDa81aEFf9112d9d3116a77B377D69E372` |
| TSLA (mock, 18 dec) | `0xC9985BF3005F53Fd4b51419eE16d97A4f4A52aB0` |
| AMZN (mock, 18 dec) | `0x61dd7b1c4B3CF33c50990fa632e875A0E31e6Fd0` |
| NFLX (mock, 18 dec) | `0xd7F300b64e1c046e4839D2d250431695D9721Ca7` |

### Core contracts

| Contract | Address |
|---|---|
| MarketOracle | `0xCbbD916cf7946Ed3681616367bDCC8c3A840E714` |
| CollateralRegistry | `0x73A873673e23d5d5a185B63a6F0216a61480b538` |
| LiquidityPool | `0x927299E3eFfef156430e469849ef33FC00D46395` |
| RiskManager | `0x4056a6BDc2F84aF5FF97f0c5F524345aBea9B2C0` |
| FacilityFactory | `0xb390a4e241Ac11ED2C553943e978673374a8d316` |
| CreditFacility (clone implementation) | `0xc7ac304a555ae5859F2D681de3Db347B8ECC34cc` |
| DemoVenue | `0x9c00a617f3F0D38b74A16a7af30CBaB61c1cB43D` |

### Demo price feeds (operator-controlled `DemoFeed`, 8 decimals)

| Asset | Reference feed | Live feed |
|---|---|---|
| TSLA | `0x67b08E682803FaA624d863cB926f2Ec342602f8E` | `0x8468716BB84842aEE73Ab3D0cFe781127ADca74e` |
| AMZN | `0xcf5789484b0ECC5c4B4BA005aAa61F86F9197A52` | `0x06fC3CF29072dF5F5F76D5eBf53B1Ad56E186315` |
| NFLX | `0xD533B6e268a55e8925705D54319bDf38D1c41a56` | `0x35Fa63b47584e596470905Ed0B953A11a245F68b` |

### Initial liquidity (seeded at deploy)

- LiquidityPool: 1,000,000 USDG supplied.
- DemoVenue: 1,000,000 USDG + 10,000 of each stock token.

The machine-readable addresses used by the app and services live in `contracts/deployments/46630.json`.

## Local Anvil (chain id 31337)

Deployed per-run by `pnpm deploy:local`; addresses in `contracts/deployments/31337.json` (gitignored). Uses mock tokens with the same seeding.
