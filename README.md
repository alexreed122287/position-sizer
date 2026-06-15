# Position Sizer

A shareable, browser-only tool (no backend) with two tabs. Live:
https://alexreed122287.github.io/position-sizer/

Each user keys in their own API keys; keys are stored only in that browser
(localStorage) and never committed.

## Sizer tab (pre-trade)
Key in a ticker; it pulls the live stock price, ATR, and the 0.70-0.85 delta
call, then sizes the trade against a percent-of-capital risk budget.
- Risk budget = a chosen % (default 5%) of total capital
- **Long calls** at a 0.5 ATR and 1 ATR stop, delta-adjusted so the loss at the
  stop equals the budget: `contracts = budget / (delta x stop x 100)`
- **Shares** carrying the same dollar risk: `shares = budget / stop`
- Data: shared `tradier-proxy` worker (read-only, `X-Live-Token`); needs option
  greeks, which is why this tab uses Tradier, not FMP.

## Journal tab (positions you bought)
Spreadsheet of long calls you already own. Per row, key in the **ticker**,
**purchase date**, and **purchase time in CST**:
- Pulls the stock price at that moment (FMP 5-min intraday; CST converted to ET)
- Computes **ATR(14) as of the purchase date**
- Shows the ATR levels around your entry: -1, -0.5, +0.5, +1 ATR, plus current price
- Entry cell is editable - type your real fill to override the fetched price
- Export CSV
- Data: **FMP `/stable` API** with your key (`rrjcar_fmp`). Your tier supports
  5-min intraday + daily history (1-min is gated, so 5-min is used).

## Risk model
Sizing assumes you exit at the ATR stop. The delta-based option-loss estimate
ignores gamma, theta, and IV; the true max loss on a long call is the premium
paid. Treat the numbers as planning estimates.

## Dev
- `app.js` - all logic; pure math exported for Node
- `index.html` - shell + styling
- `node test.js` - unit tests (ATR, sizing, levels, CST->ET, intraday match, call/expiry pick)
