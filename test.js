/* Unit tests for the pure sizing math. Run: node test.js */
var A = require('./app.js');

var fails = 0;
function approx(a, b, t) { t = t || 1e-9; return Math.abs(a - b) <= t; }
function check(name, cond) { if (!cond) { console.log('FAIL ' + name); fails++; } else { console.log('ok   ' + name); } }

// ---- ATR (Wilder) ----
check('atr trivial = 2.0', approx(A.computeATR([
  { high: 10, low: 8, close: 9 }, { high: 11, low: 9, close: 10 },
  { high: 12, low: 10, close: 11 }, { high: 11, low: 9, close: 10 }
], 2), 2.0));

// TRs = [2,4,4]; seed=(2+4)/2=3; then (3*1+4)/2=3.5
check('atr smoothing = 3.5', approx(A.computeATR([
  { high: 101, low: 99, close: 100 }, { high: 102, low: 100, close: 101 },
  { high: 105, low: 101, close: 104 }, { high: 104, low: 100, close: 101 }
], 2), 3.5));

check('atr null when too few bars', A.computeATR([{ high: 1, low: 0, close: 0.5 }], 14) === null);

// ---- sizing ----
var s = A.computeSizing({ capital: 100000, riskPct: 5, price: 200, atr: 4, delta: 0.78, premium: 15 });
check('riskBudget = 5000', s.riskBudget === 5000);
check('level +1 ATR = 204', s.levels.plusOne === 204);
check('level +0.5 ATR = 202', s.levels.plusHalf === 202);
check('level -0.5 ATR = 198', s.levels.minusHalf === 198);
check('level -1 ATR = 196', s.levels.minusOne === 196);
check('half shares = 2500', s.half.shares === 2500);
check('half contracts = 32', s.half.contracts === 32);
check('half premium outlay = 48000', s.half.premiumOutlay === 48000);
check('one shares = 1250', s.one.shares === 1250);
check('one contracts = 16', s.one.contracts === 16);
check('one premium outlay = 24000', s.one.premiumOutlay === 24000);
check('premium-cap contracts = 3', s.premiumCapContracts === 3); // floor(5000/(15*100)) = floor(3.33) = 3
// risk-equivalence sanity: contracts ~= shares / (delta*100)
check('equiv half', s.half.contracts === Math.floor(s.half.shares / (0.78 * 100)));
check('equiv one', s.one.contracts === Math.floor(s.one.shares / (0.78 * 100)));

// guard: zero atr -> zero sizes, no NaN
var z0 = A.computeSizing({ capital: 100000, riskPct: 5, price: 200, atr: 0, delta: 0.78, premium: 15 });
check('zero atr safe', z0.half.shares === 0 && z0.half.contracts === 0);

// ---- pickCall ----
var calls = [
  { strike: 170, delta: 0.95, bid: 30, ask: 31, last: 30.5 },
  { strike: 190, delta: 0.82, bid: 15, ask: 15.4, last: 15.2 },
  { strike: 200, delta: 0.78, bid: 11, ask: 11.4, last: 11.2 },
  { strike: 210, delta: 0.72, bid: 8, ask: 8.4, last: 8.2 },
  { strike: 220, delta: 0.60, bid: 5, ask: 5.4, last: 5.2 }
];
var pc = A.pickCall(calls, { targetDelta: 0.80 });
check('pickCall in band strike 190', pc.strike === 190 && approx(pc.delta, 0.82));
check('pickCall mid = 15.2', approx(pc.mid, 15.2));
check('pickCall not flagged', pc.outOfBand === false);

var pc2 = A.pickCall([
  { strike: 100, delta: 0.95, bid: 1, ask: 2, last: 1.5 },
  { strike: 120, delta: 0.92, bid: 1, ask: 2, last: 1.5 }
], { targetDelta: 0.80 });
check('pickCall out of band picks 0.92', pc2.outOfBand === true && pc2.delta === 0.92);

check('pickCall null on empty greeks', A.pickCall([{ strike: 100, delta: NaN }], {}) === null);

// ---- expiration / DTE ----
var today = new Date(2026, 5, 14, 12, 0, 0); // 2026-06-14
check('dte 2026-07-17 = 33', A.daysToExp('2026-07-17', today) === 33);
var pe = A.pickExpiration(['2026-06-19', '2026-07-17', '2026-08-21'], 45, 7, today);
check('pickExpiration = 2026-07-17', pe.exp === '2026-07-17' && pe.dte === 33);
var pe2 = A.pickExpiration(['2026-06-16', '2026-06-19'], 45, 7, today); // both < minDTE -> fallback picks longest-dated (closest to target)
check('pickExpiration fallback = 2026-06-19', pe2 && pe2.exp === '2026-06-19');

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
