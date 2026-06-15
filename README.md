# Position Sizer

Long-call position sizing tool. Key in a ticker; it pulls the live stock price,
ATR, and the 0.70-0.85 delta call, then sizes the trade against a fixed
percent-of-capital risk budget.

Live: https://alexreed122287.github.io/position-sizer/

## What it shows, per ticker
- Stock price at entry (live) and ATR(14)
- The 0.5 ATR and 1 ATR levels above and below entry (stop / target ladder)
- Risk budget = a chosen % (default 5%) of total capital
- **Long calls** to buy at a 0.5 ATR and 1 ATR stop, sized so the loss at that
  stop equals the risk budget (delta-adjusted): `contracts = budget / (delta x stop x 100)`
- **Shares** that carry the *same* dollar risk: `shares = budget / stop`
- Premium outlay, risk-at-stop, and a premium-capped alternative

## Risk model
Sizing assumes you exit at the ATR stop. The delta-based option-loss estimate
ignores gamma, theta, and IV changes; the true max loss on a long call is the
premium paid. Treat the numbers as planning estimates.

## Data
Reads market data through the shared `tradier-proxy` worker (read-only,
`X-Live-Token`). On devices where the scanner already works, the token is
shared automatically (same GitHub Pages origin). No keys are stored in the repo.

## Dev
- `app.js` - all logic (pure math is exported for Node)
- `index.html` - shell + styling
- `node test.js` - unit tests for the sizing math
