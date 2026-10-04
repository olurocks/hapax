# Demo walkthrough

A step-by-step script for showing every Hapax feature end to end on Robinhood Chain testnet. Follow it top to bottom.

You will use two windows:

| Window | What it is | Who it is |
|---|---|---|
| **Browser** at `http://localhost:5173` | The Hapax app | You, the user. Every action is approved in your wallet. |
| **Terminal** | `pnpm demo …` commands | The "world": the brokerage, the stock market, test money. Keep it off-camera. |

In each step:
- 🖥️ **Terminal**: type this command and press Enter.
- 🌐 **App**: click this in the browser.
- 👀 **You should see**: what confirms the step worked.

Testnet is slower than your laptop: each transaction takes a few seconds, and your wallet pops up for every one. Wait for the bottom-right panel to say it's done before the next step.

---

## Part 0: One-time setup

### 0.1 Start everything
Open a terminal in the project folder and start each of these in its own terminal tab, leaving them running:

```bash
pnpm market
pnpm broker
pnpm keeper
pnpm agent
pnpm control
pnpm sim
pnpm web
```

👀 Each prints a `listening on http://localhost:…` line (the keeper prints `watching …`). Open `http://localhost:5173` in the browser that has your wallet.

### 0.2 Create two brokerage customers
These are the people "at Harbor Securities" you'll sign in as. Run A uses Alex, Run B uses Bea.

🖥️
```bash
pnpm demo seed alex 2468 TSLA=1000 AMZN=500 cash=50000 holder="Alex Rivera"
pnpm demo seed bea 1357 TSLA=1000 AMZN=500 cash=50000 holder="Bea Okafor"
```
👀 Each prints the customer with an account number.

### 0.3 Give your wallet test money
Copy your wallet address (MetaMask: click the account name). You need testnet ETH for fees and USDG to repay from your wallet.

🖥️
```bash
pnpm demo faucet 0xYOUR_WALLET_ADDRESS usdg=200000 eth=0
```
👀 `"usdg": 200000` in the balances. Use `eth=0.005` instead of `eth=0` if your wallet has no testnet ETH yet.

### 0.4 Start from known prices
🖥️
```bash
pnpm demo open
pnpm demo price TSLA 250
pnpm demo price AMZN 200
pnpm demo price NFLX 100
```

---

## Run A: the everyday user journey

### A1. Connect your wallet
🌐 Click **Connect wallet** → choose your wallet → approve in the wallet popup. If it asks to switch to *Robinhood Chain Testnet*, approve that too.
👀 The welcome card: *Open your credit account*.

### A2. Open a credit account
🌐 **Open credit account** → confirm in the wallet.
👀 The dashboard with tabs (Overview, Agent, Collateral, Activity) and a **Get started** checklist.
> Say: "A credit account is a smart account only my wallet controls. Borrowed money can't leave it."

### A3. Connect the brokerage
🌐 In the checklist, click **Continue** next to *Connect your brokerage* (or open the **Collateral** tab) → **Connect Harbor Securities**.
👀 You're sent to the Harbor Securities sign-in page.

🌐 Username `alex`, passcode `2468` → **Sign in**.
👀 A consent page listing 1,000 TSLA, 500 AMZN and $50,000 cash, and what Hapax may do.

🌐 **Allow**.
👀 Back in the app: *"Brokerage connected."* **Collateral** shows **Verified** and a **$250,000** credit limit. **Overview** shows **$700,000 available to borrow**.
> Say: "The broker signs what I hold, shares not dollars. Nothing moved. That sets my credit limit onchain."

### A4. Borrow
🌐 **Overview** → *Move money* → **Borrow** tab → type `300000` → **Borrow** → confirm.
👀 Borrowed **$300,000**, Account value about **$0** (the cash is in, the debt is equal), Credit used near **0%**.

### A5. Hire an agent
🌐 **Agent** tab → **Hire Dip Buyer** (or **Hire Claude Discretionary** if you've set an API key).
In the form: tick **TSLA** and **NFLX** only, *Max per position* `250000`, *Mandate lasts* **24 hours** → **Appoint**.
Confirm the transaction, then approve the **signature** request (it moves no money).
👀 The agent card shows **Active**, the allowed stocks, the cap, the expiry, and *Can / Cannot*.
> Say: "The agent gets buying power, not keys. It can trade, never withdraw. These limits live in the contract."

### A6. The leash: the contract refuses out-of-bounds trades
🖥️
```bash
pnpm demo try buy AMZN 10000
```
👀 **Activity** tab: a red **Refused** row, `OutsideMandate(AMZN)`. AMZN isn't on the list.

🖥️
```bash
pnpm demo try buy TSLA 300000
```
👀 **Refused**, `PositionTooLarge(TSLA, …)`. That's over the $250,000 cap.
> Say: "Those are reverted transactions onchain, not a backend saying no."

### A7. The agent trades by itself
🖥️
```bash
pnpm demo shock TSLA -4
pnpm demo tick
```
👀 **Agent** tab: *Buying dips…* and a **Filled** buy of TSLA. **Overview → Holdings** now lists TSLA.
(`tick` just makes the agent decide now; it also decides by itself every minute.)

### A8. Change the agent's instructions and limits
🌐 **Agent** → **Edit instructions** → type something new → **Sign and save** → approve the signature.
👀 The new instructions are shown.

🌐 **Change limits** → set *Max per position* to `200000` → **Update mandate** → confirm.
👀 *Max per position* shows **$200,000**.

### A9. Profit, then withdraw it
🖥️
```bash
pnpm demo price TSLA 265
pnpm demo tick
```
👀 The agent sells part of its TSLA. **Overview** → *Profit and loss* turns green.

🌐 *Move money* → **Withdraw** → **Max** → **Withdraw** → confirm.
👀 The wallet menu (top right, click your address) shows more USDG. The debt is unchanged: only profit leaves, never the borrowed money.

### A10. Sell a position yourself
🌐 **Overview → Holdings** → **Sell** next to TSLA → **50%** → **Sell 50%** → confirm.
👀 Fewer TSLA shares, more USDG cash.

### A11. Repay from your wallet
🌐 *Move money* → **Repay** → **From my wallet** → type `20000` → **Repay** → approve USDG, then confirm the repay.
👀 *Borrowed* drops by $20,000.

### A12. Stop the agent (kill switch)
🌐 **Agent** → **Stop agent** → confirm.
👀 The agent is gone; the catalog shows again. Activity: *Agent … stopped. It has no rights left.*

### A13. Close out
🌐 **Overview → Holdings** → **Close out account** → read the summary → **Close out** → confirm.
👀 One transaction sells everything, repays all debt and sends the rest to your wallet. *Borrowed* is **$0**, Holdings are empty.

### A14. Disconnect the brokerage
🌐 **Collateral** → **Disconnect brokerage** → approve the signature.
👀 The Collateral tab is back to *Connect your brokerage account*.
> Say: "I'm out: debt repaid, profit in my wallet, brokerage released."

---

## Part B: the risk engine (on a second account)

### B1. Open a second account and connect Bea
🌐 Header → the account dropdown → **+ Open another account** → confirm.
🌐 **Collateral** → **Connect Harbor Securities** → sign in as `bea` / `1357` → **Allow**.
👀 Verified, **$250,000** credit limit.

### B2. Borrow and hire
🌐 **Borrow** `300000`. Then **Agent** → **Hire Dip Buyer** → TSLA + NFLX, `250000`, **24 hours** → **Appoint**, confirm, sign.

### B3. Load up a position
🖥️
```bash
pnpm demo try buy TSLA 200000
```
👀 A **Filled** buy. Overview → Holdings shows TSLA.

### B4. Friday 4pm: the stock market closes
🖥️
```bash
pnpm demo close
```
👀 Banner: *The stock market is closed…*, a **Market closed** chip, and a lower credit limit. No transaction happened.
> Say: "The broker is blind until Monday. Hapax isn't: it prices from the 24/7 onchain market."

### B5. Saturday crash
🖥️
```bash
pnpm demo shock TSLA -9
```
👀 Risk badge **Warning** (amber).

🖥️
```bash
pnpm demo shock TSLA -16
pnpm demo try buy NFLX 5000
```
👀 **Margin call** (red), and the agent's buy is **Refused** with `StateNotAllowed`. The agent can't add risk now.

🖥️
```bash
pnpm demo shock TSLA -25
```
👀 Within a few seconds: **Deleveraging**, then **Cure period**. The keeper sold every position and repaid most of the debt; the banner says how much is left (tens of thousands).

The thresholds depend on your position. If a level doesn't trigger, shock further; the dashed lines on the TSLA chart show where each level sits. The agent also decides once a minute, and outside **Active** it sells and repays to cut risk by itself. If you see that in Activity, it's the agent doing its job. Run the shocks back to back to reach the keeper's sell-off.

### B6. Cure: repay from your wallet. You have 2 minutes.
🌐 *Move money* → **Repay** → **From my wallet** → **Max** → **Repay** → approve, then confirm.
👀 *Borrowed* **$0**, status back to **Active**.
(If you miss the 2 minutes, go to B8 instead.)

### B7. The broker revokes
🖥️
```bash
pnpm demo revoke
```
👀 Status **Frozen** immediately. **Collateral** says the broker stopped vouching.

🖥️
```bash
pnpm demo reinstate
```
👀 Back to **Active**.

### B8 (optional, instead of B6 and B7). Default and settlement
After B5, don't repay. Wait about 2 minutes.
👀 Status **Default**: *your broker has been asked to sell pledged shares*.

🖥️
```bash
pnpm demo settle
```
👀 Status **Closed**. Activity: *Broker settled … from pledged shares.* The lender is made whole.

### B9. Reopen the market
🖥️
```bash
pnpm demo open
```

---

## Closer: the weekend-gap number
Open `http://localhost:8790/sim` in the browser.
👀 A comparison: a broker acting at Monday's open vs Hapax acting on Saturday, and how much earlier Hapax de-risks.

---

## Before a second take
- Use fresh customers (`pnpm demo seed carl 1111 …`) or the same ones after they've been disconnected; each brokerage customer backs one account at a time.
- Reset prices with Part 0.4.
- `pnpm demo status` shows every account, its state, brokerage and agent, plus the pool's free cash. If borrowing fails with `InsufficientLiquidity`, run `pnpm demo liquidity 1000000`.

## If something goes wrong
| Problem | Fix |
|---|---|
| App says the agent service or brokerage is unavailable | That terminal (`pnpm agent` / `pnpm broker`) stopped; start it again |
| `pnpm demo …` says the control service isn't reachable | Start `pnpm control` |
| The app is stuck loading | Refresh. If it says it couldn't load, check the terminals are running |
| Agent shows **Your agent isn't running** | Click **Start …** and approve the signature |
| A crash level doesn't trigger | Shock further (e.g. `-30`); the dashed chart lines show each trigger price |
| Wallet says "nonce too low" or a transaction hangs | In MetaMask: Settings → Advanced → Clear activity tab data, then retry |

`pnpm smoke` tests the whole flow automatically (local Anvil only).

## Appendix: running on local Anvil instead
Faster and free, same steps. Put Anvil's default dev keys in `.env` (`DEPLOYER_PK`, `BROKER_PK`/`BROKER_ADDRESS`, `KEEPER_PK`, `AGENT_PK`, each a different account) and set `CHAIN_ID=31337`, `RPC_URL=http://127.0.0.1:8545`, `USE_MOCKS=true`, `VITE_CHAIN_ID=31337`. Run `anvil`, then `pnpm deploy:local`, then start the services as in 0.1. Use `eth=1` in the faucet. On Anvil you can skip the 2-minute wait in B8 with `pnpm demo advance 130`.
