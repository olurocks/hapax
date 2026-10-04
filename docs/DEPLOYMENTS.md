# Deployments

## Robinhood Chain testnet (chain id 46630)

- RPC: `https://rpc.testnet.chain.robinhood.com`
- Explorer: `https://explorer.testnet.chain.robinhood.com`
- Deployed: 2026-10-04. All contracts verified on Blockscout (source links below).
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
| USDG (mock, 6 dec) | `0xcC4fC05Ef9DBFC4f9E8D02a24fC68d4Cbc9139d0` |
| TSLA (mock, 18 dec) | `0x616d62330f103d1E58Bf2eb96D85f113ac642A50` |
| AMZN (mock, 18 dec) | `0x29dc522bEC2D58DEA4CF90D19c6275d9172E68df` |
| NFLX (mock, 18 dec) | `0x53d9955B4090447161230ce4B02bB85Cb629bDD1` |

### Core contracts

| Contract | Address |
|---|---|
| MarketOracle | `0x0406dd751333b36ee285D47a76234c115D21846E` |
| CollateralRegistry | `0x8174653734eE0823A07675fc9F2be2d0F0BE385A` |
| LiquidityPool | `0x44e5a9D97C2a7552d7758a427F4eA46a43339347` |
| RiskManager | `0x8d4EDBe23414829F6C3DF5b3d48ED38DEB159A70` |
| FacilityFactory | `0x337910Ec28C517eDF350Ec87E34D987f30A7bB90` |
| CreditFacility (clone implementation) | `0xA70B0729A852aCFA6133dD37dE50c0d8C0f1f385` |
| DemoVenue | `0x34cA6C2Ce7f5e2542F8C3F602f36E2A0b68fE1e3` |

### Demo price feeds (operator-controlled `DemoFeed`, 8 decimals)

| Asset | Reference feed | Live feed |
|---|---|---|
| TSLA | `0x7ED7b2FEB6f12e39168b40F64AE44458add619Bc` | `0x0D803bCEA5C909fe92bf44433a3452bff3D21511` |
| AMZN | `0x5698147fA121903E7a2f74b9d58A7D01d1D07dDc` | `0x5D06De3669F2E4dF7C1e8253a3cA3055952A1436` |
| NFLX | `0x3A1DeC020052B5aB309AFd45AAc2D20D5A7fC2e8` | `0xb7FdaFBcE612D303EB29C79925f759bcBED94b5D` |

### Initial liquidity (seeded at deploy)

- LiquidityPool: 1,000,000 USDG supplied.
- DemoVenue: 1,000,000 USDG + 10,000 of each stock token.

The machine-readable addresses used by the app and services live in `contracts/deployments/46630.json`.

## Local Anvil (chain id 31337)

Deployed per-run by `pnpm deploy:local`; addresses in `contracts/deployments/31337.json` (gitignored). Uses mock tokens with the same seeding.
