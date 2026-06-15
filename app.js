/* Position Sizer - long-call ATR-based position sizing
 * Single-purpose tool: key in a ticker, it pulls live price + ATR + the
 * 0.70-0.85 delta call from Tradier, then sizes long calls and the
 * risk-equivalent share count against a fixed percent-of-capital risk budget.
 *
 * Data path reuses Alex's existing tradier-proxy worker (read-only, X-Live-Token).
 * All pure math is exported for Node so it can be unit-tested.
 */
(function () {
  'use strict';

  var APP_VERSION = 'v1.0.0';

  // ---- Tradier data path (shared with the scanner / Option Panda) ----
  var PROXY_FALLBACK = 'https://tradier-proxy.alexander-s-reed.workers.dev';
  var DIRECT_HOST = 'https://api.tradier.com';
  var LIVE_TOKEN_KEY = 'rrjcar_tradier_proxy_live_token'; // shared with scanner
  var PROXY_KEY = 'rrjcar_tradier_proxy';
  var RAW_KEY = 'rrjcar_tradier';

  var SKEY = 'posSizer_v1';

  // ============================================================
  // Credentials / fetch
  // ============================================================
  function ls() { return (typeof localStorage !== 'undefined') ? localStorage : null; }
  function lsGet(k) { var s = ls(); try { return s ? (s.getItem(k) || '').trim() : ''; } catch (_) { return ''; } }
  function lsSet(k, v) { var s = ls(); try { if (s) s.setItem(k, v); } catch (_) {} }

  function resolveCreds() {
    var liveToken = lsGet(LIVE_TOKEN_KEY);
    var proxyBase = lsGet(PROXY_KEY) || PROXY_FALLBACK;
    var rawKey = lsGet(RAW_KEY);
    if (liveToken) return { mode: 'proxy', host: proxyBase, liveToken: liveToken };
    if (rawKey) return { mode: 'direct', host: DIRECT_HOST, rawKey: rawKey };
    return { mode: 'none', host: proxyBase, liveToken: '' };
  }

  function tFetch(path) {
    var c = resolveCreds();
    var url, headers = { Accept: 'application/json' };
    if (c.mode === 'direct') {
      url = c.host + path;
      headers['Authorization'] = 'Bearer ' + c.rawKey;
    } else {
      url = c.host + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'mode=live';
      if (c.liveToken) headers['X-Live-Token'] = c.liveToken;
    }
    return fetch(url, { headers: headers }).then(function (res) {
      if (!res.ok) {
        var msg = 'HTTP ' + res.status;
        if (res.status === 403) msg = 'Live data blocked (403). Open Data settings and paste your Tradier live token.';
        else if (res.status === 401) msg = 'Tradier auth failed (401).';
        else if (res.status === 404) msg = 'Not found (404) - check the ticker symbol.';
        else if (res.status === 429) msg = 'Rate limited (429) - wait a moment and retry.';
        throw new Error(msg);
      }
      return res.json();
    });
  }

  // ============================================================
  // API helpers (browser only)
  // ============================================================
  function apiQuote(sym) {
    return tFetch('/v1/markets/quotes?symbols=' + encodeURIComponent(sym)).then(function (d) {
      var q = d && d.quotes && d.quotes.quote;
      if (Array.isArray(q)) q = q[0];
      if (!q) throw new Error('No quote for ' + sym);
      var last = parseFloat(q.last);
      if (!isFinite(last) || last <= 0) last = parseFloat(q.close) || parseFloat(q.prevclose) || 0;
      return {
        symbol: q.symbol || sym,
        desc: q.description || '',
        last: last,
        change: parseFloat(q.change) || 0,
        changePct: parseFloat(q.change_percentage) || 0
      };
    });
  }

  function apiHistory(sym, start, end) {
    return tFetch('/v1/markets/history?symbol=' + encodeURIComponent(sym) +
      '&interval=daily&start=' + start + '&end=' + end).then(function (d) {
      var days = d && d.history && d.history.day;
      if (!days) return [];
      if (!Array.isArray(days)) days = [days];
      return days.map(function (b) {
        return { date: b.date, open: +b.open, high: +b.high, low: +b.low, close: +b.close };
      }).filter(function (b) {
        return isFinite(b.high) && isFinite(b.low) && isFinite(b.close);
      }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    });
  }

  function apiExpirations(sym) {
    return tFetch('/v1/markets/options/expirations?symbol=' + encodeURIComponent(sym)).then(function (d) {
      var dates = d && d.expirations && d.expirations.date;
      if (!dates) return [];
      if (!Array.isArray(dates)) dates = [dates];
      return dates.slice();
    });
  }

  function apiChainCalls(sym, exp) {
    return tFetch('/v1/markets/options/chains?symbol=' + encodeURIComponent(sym) +
      '&expiration=' + encodeURIComponent(exp) + '&greeks=true').then(function (d) {
      var opts = d && d.options && d.options.option;
      if (!opts) return [];
      if (!Array.isArray(opts)) opts = [opts];
      return opts.filter(function (o) { return o && o.option_type === 'call'; }).map(function (o) {
        var g = o.greeks || {};
        return {
          strike: +o.strike,
          bid: +o.bid || 0,
          ask: +o.ask || 0,
          last: +o.last || 0,
          oi: +o.open_interest || 0,
          delta: (g.delta != null) ? parseFloat(g.delta) : NaN,
          iv: (g.mid_iv != null) ? parseFloat(g.mid_iv) : NaN,
          symbol: o.symbol
        };
      });
    });
  }

  // ============================================================
  // Pure math (unit-tested in Node)
  // ============================================================

  // Wilder's ATR (matches the default TradingView / charting ATR).
  function computeATR(bars, period) {
    period = period || 14;
    if (!bars || bars.length < period + 1) return null;
    var trs = [];
    for (var i = 1; i < bars.length; i++) {
      var h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    if (trs.length < period) return null;
    var atr = 0, j;
    for (j = 0; j < period; j++) atr += trs[j];
    atr = atr / period; // seed = SMA of first `period` true ranges
    for (var k = period; k < trs.length; k++) {
      atr = (atr * (period - 1) + trs[k]) / period; // Wilder smoothing
    }
    return atr;
  }

  function fmtDateYMD(d) {
    var y = d.getFullYear(),
      m = ('0' + (d.getMonth() + 1)).slice(-2),
      da = ('0' + d.getDate()).slice(-2);
    return y + '-' + m + '-' + da;
  }
  function parseYMD(s) {
    var p = String(s).split('-');
    return new Date(+p[0], (+p[1]) - 1, +p[2], 12, 0, 0, 0);
  }
  function daysToExp(expStr, today) {
    today = today || new Date();
    var t = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0, 0);
    return Math.round((parseYMD(expStr) - t) / 86400000);
  }

  // Pick the expiration whose DTE is closest to target (and >= minDTE).
  function pickExpiration(expirations, targetDTE, minDTE, today) {
    targetDTE = targetDTE || 45;
    minDTE = (minDTE == null ? 7 : minDTE);
    var map = expirations.map(function (x) { return { exp: x, dte: daysToExp(x, today) }; });
    var cands = map.filter(function (o) { return o.dte >= minDTE; });
    if (!cands.length) cands = map.filter(function (o) { return o.dte > 0; });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return Math.abs(a.dte - targetDTE) - Math.abs(b.dte - targetDTE); });
    return cands[0];
  }

  // Pick the call inside the [deltaMin, deltaMax] band closest to targetDelta.
  function pickCall(calls, opts) {
    opts = opts || {};
    var tDelta = opts.targetDelta != null ? opts.targetDelta : 0.80;
    var dMin = opts.deltaMin != null ? opts.deltaMin : 0.70;
    var dMax = opts.deltaMax != null ? opts.deltaMax : 0.85;
    var valid = calls.filter(function (c) { return isFinite(c.delta) && c.delta > 0 && isFinite(c.strike); });
    if (!valid.length) return null;
    var band = valid.filter(function (c) { return c.delta >= dMin && c.delta <= dMax; });
    var chosen, outOfBand = false;
    if (band.length) {
      band.sort(function (a, b) {
        var da = Math.abs(a.delta - tDelta), db = Math.abs(b.delta - tDelta);
        if (da !== db) return da - db;
        return b.delta - a.delta; // tie -> prefer the more ITM (higher delta) call
      });
      chosen = band[0];
    } else {
      outOfBand = true;
      valid.sort(function (a, b) {
        function dist(d) { return d < dMin ? (dMin - d) : (d > dMax ? (d - dMax) : 0); }
        return dist(a.delta) - dist(b.delta);
      });
      chosen = valid[0];
    }
    var mid = (chosen.bid > 0 && chosen.ask > 0) ? (chosen.bid + chosen.ask) / 2
      : (chosen.last > 0 ? chosen.last : (chosen.ask > 0 ? chosen.ask : chosen.bid));
    return {
      strike: chosen.strike, delta: chosen.delta, bid: chosen.bid, ask: chosen.ask,
      last: chosen.last, mid: mid, oi: chosen.oi, iv: chosen.iv, symbol: chosen.symbol,
      outOfBand: outOfBand
    };
  }

  // Core sizing. Risk budget = capital * riskPct%. Stop = multiple of ATR.
  //   Shares (risk-equivalent) = riskBudget / stopDistance
  //   Contracts (delta-adjusted) = riskBudget / (delta * stopDistance * 100)
  // so a stop hit loses ~= the same dollars either way.
  function computeSizing(p) {
    var capital = +p.capital || 0, riskPct = +p.riskPct || 0,
      P = +p.price || 0, A = +p.atr || 0, D = +p.delta || 0, prem = +p.premium || 0;
    var riskBudget = capital * riskPct / 100;
    function leg(mult) {
      var dist = mult * A;
      var out = { mult: mult, dist: dist, shares: 0, contracts: 0, premiumOutlay: 0,
        optRiskAtStop: 0, sharesNotional: 0, sharesRiskAtStop: 0 };
      if (dist > 0) {
        out.shares = Math.floor(riskBudget / dist);
        out.sharesNotional = out.shares * P;
        out.sharesRiskAtStop = out.shares * dist;
        if (D > 0) {
          out.contracts = Math.floor(riskBudget / (D * dist * 100));
          out.optRiskAtStop = out.contracts * D * dist * 100;
          out.premiumOutlay = out.contracts * prem * 100;
        }
      }
      return out;
    }
    return {
      riskBudget: riskBudget,
      levels: { plusOne: P + A, plusHalf: P + 0.5 * A, entry: P, minusHalf: P - 0.5 * A, minusOne: P - A },
      half: leg(0.5),
      one: leg(1.0),
      premiumCapContracts: (prem > 0) ? Math.floor(riskBudget / (prem * 100)) : 0
    };
  }

  // ============================================================
  // App state + rendering (browser only)
  // ============================================================
  var STATE = {
    settings: { capital: 100000, riskPct: 5, atrPeriod: 14, targetDTE: 45, targetDelta: 0.80, deltaMin: 0.70, deltaMax: 0.85 },
    tickers: [] // {sym, status, error, quote, atr, expirations, exp, dte, call, sizing}
  };

  function save() {
    var t = STATE.tickers.map(function (x) { return { sym: x.sym, exp: x.exp || null }; });
    lsSet(SKEY, JSON.stringify({ settings: STATE.settings, tickers: t }));
  }
  function load() {
    try {
      var raw = lsGet(SKEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o.settings) for (var k in o.settings) if (o.settings[k] != null) STATE.settings[k] = o.settings[k];
      if (Array.isArray(o.tickers)) STATE.tickers = o.tickers.map(function (x) {
        return { sym: x.sym, exp: x.exp || null, status: 'idle' };
      });
    } catch (_) {}
  }

  // ---- formatters ----
  function money(n) { return (n == null || !isFinite(n)) ? '-' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function money0(n) { return (n == null || !isFinite(n)) ? '-' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
  function intc(n) { return (n == null || !isFinite(n)) ? '-' : Number(n).toLocaleString('en-US'); }
  function num(n, d) { d = d == null ? 2 : d; return isFinite(n) ? Number(n).toFixed(d) : '-'; }
  function fmtMDY(ymd) { var p = String(ymd).split('-'); return p.length === 3 ? (p[1] + '-' + p[2] + '-' + p[0]) : ymd; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function el(id) { return document.getElementById(id); }

  // ---- shell ----
  function renderShell() {
    var s = STATE.settings;
    el('app').innerHTML =
      '<header class="hdr"><div class="title">Position Sizer</div>' +
        '<div class="sub">Long calls 0.70-0.85 delta - ATR risk sizing</div></header>' +

      '<section class="card cfg">' +
        '<div class="row2">' +
          '<label>Total capital<input id="cap" type="number" inputmode="decimal" value="' + s.capital + '"></label>' +
          '<label>Risk per trade (%)<input id="rsk" type="number" inputmode="decimal" step="0.5" value="' + s.riskPct + '"></label>' +
        '</div>' +
        '<div id="budgetLine" class="budget"></div>' +
        '<details class="adv"><summary>Advanced</summary>' +
          '<div class="row3">' +
            '<label>ATR period<input id="atrp" type="number" inputmode="numeric" value="' + s.atrPeriod + '"></label>' +
            '<label>Target DTE<input id="dte" type="number" inputmode="numeric" value="' + s.targetDTE + '"></label>' +
            '<label>Target delta<input id="tdelta" type="number" inputmode="decimal" step="0.01" value="' + s.targetDelta + '"></label>' +
          '</div>' +
          '<div class="hint">Delta band fixed at 0.70-0.85. Target delta is the preferred strike within that band.</div>' +
        '</details>' +
      '</section>' +

      '<section class="card add">' +
        '<div class="addrow">' +
          '<input id="addSym" type="text" placeholder="Add ticker (e.g. AAPL)" autocapitalize="characters" autocomplete="off" spellcheck="false">' +
          '<button id="addBtn" class="btn primary">Add</button>' +
        '</div>' +
        '<div class="addrow2"><button id="refreshAll" class="btn">Refresh all</button>' +
          '<span id="dataStatus" class="status"></span></div>' +
        '<details class="adv"><summary>Data settings</summary>' +
          '<div class="hint">Reads market data through your tradier-proxy worker. On devices where your scanner already works, the live token is shared automatically - nothing to do here.</div>' +
          '<label class="full">Tradier live token<input id="liveTok" type="password" placeholder="X-Live-Token" autocomplete="off"></label>' +
          '<label class="full">Proxy URL (optional override)<input id="proxyUrl" type="text" placeholder="' + PROXY_FALLBACK + '" autocomplete="off"></label>' +
          '<button id="saveData" class="btn">Save data settings</button>' +
        '</details>' +
      '</section>' +

      '<div id="results"></div>' +
      '<footer class="foot">Estimates only. The true max loss on a long call is the premium paid. ' +
        'Delta-based stop loss ignores gamma, theta and IV moves. ' + APP_VERSION + '</footer>';

    // hydrate data-settings fields
    var lt = lsGet(LIVE_TOKEN_KEY); if (lt) el('liveTok').value = lt;
    var pu = lsGet(PROXY_KEY); if (pu) el('proxyUrl').value = pu;

    wire();
    updateBudgetLine();
    updateDataStatus();
  }

  function updateBudgetLine() {
    var s = STATE.settings;
    var rb = (+s.capital || 0) * (+s.riskPct || 0) / 100;
    el('budgetLine').textContent = 'Risk budget per trade: ' + money(rb) +
      '  (' + num(s.riskPct, 2) + '% of ' + money0(s.capital) + ')';
  }

  function updateDataStatus() {
    var c = resolveCreds();
    var node = el('dataStatus');
    if (!node) return;
    if (c.mode === 'proxy') { node.textContent = 'Live data: proxy + token'; node.className = 'status ok'; }
    else if (c.mode === 'direct') { node.textContent = 'Live data: direct key'; node.className = 'status ok'; }
    else { node.textContent = 'Live data: no token - open Data settings'; node.className = 'status warn'; }
  }

  // ---- events ----
  function wire() {
    el('cap').addEventListener('input', onSettingChange);
    el('rsk').addEventListener('input', onSettingChange);
    el('atrp').addEventListener('input', onSettingChange);
    el('dte').addEventListener('input', onSettingChange);
    el('tdelta').addEventListener('input', onSettingChange);

    el('addBtn').addEventListener('click', onAdd);
    el('addSym').addEventListener('keydown', function (e) { if (e.key === 'Enter') onAdd(); });
    el('refreshAll').addEventListener('click', function () { STATE.tickers.forEach(function (t) { fetchTicker(t); }); });
    el('saveData').addEventListener('click', onSaveData);

    var res = el('results');
    res.addEventListener('click', function (e) {
      var card = e.target.closest('.tk'); if (!card) return;
      var idx = +card.getAttribute('data-idx');
      var t = STATE.tickers[idx]; if (!t) return;
      if (e.target.matches('[data-act="remove"]')) { STATE.tickers.splice(idx, 1); save(); renderResults(); }
      else if (e.target.matches('[data-act="refresh"]')) { fetchTicker(t); }
      else if (e.target.matches('[data-act="retry"]')) { fetchTicker(t); }
    });
    res.addEventListener('change', function (e) {
      if (e.target.matches('select[data-act="exp"]')) {
        var card = e.target.closest('.tk'); var idx = +card.getAttribute('data-idx');
        var t = STATE.tickers[idx]; if (!t) return;
        t.exp = e.target.value; save(); fetchChainAndSize(t);
      }
    });
  }

  function onSettingChange() {
    var s = STATE.settings;
    s.capital = parseFloat(el('cap').value) || 0;
    s.riskPct = parseFloat(el('rsk').value) || 0;
    s.atrPeriod = Math.max(2, parseInt(el('atrp').value, 10) || 14);
    s.targetDTE = Math.max(1, parseInt(el('dte').value, 10) || 45);
    s.targetDelta = parseFloat(el('tdelta').value) || 0.80;
    save();
    updateBudgetLine();
    // recompute sizing locally; only ATR period / delta target need a refetch
    STATE.tickers.forEach(function (t) {
      if (t.quote && t.atr != null && t.call) {
        t.sizing = computeSizing({ capital: s.capital, riskPct: s.riskPct, price: t.quote.last, atr: t.atr, delta: t.call.delta, premium: t.call.mid });
      }
    });
    renderResults();
  }

  function onAdd() {
    var v = (el('addSym').value || '').trim().toUpperCase();
    if (!v) return;
    if (STATE.tickers.some(function (t) { return t.sym === v; })) { el('addSym').value = ''; return; }
    var t = { sym: v, exp: null, status: 'idle' };
    STATE.tickers.push(t);
    el('addSym').value = '';
    save();
    renderResults();
    fetchTicker(t);
  }

  function onSaveData() {
    var tok = (el('liveTok').value || '').trim();
    var pxy = (el('proxyUrl').value || '').trim();
    if (tok) lsSet(LIVE_TOKEN_KEY, tok);
    if (pxy) lsSet(PROXY_KEY, pxy);
    updateDataStatus();
    STATE.tickers.forEach(function (t) { fetchTicker(t); });
  }

  // ---- fetching ----
  function fetchTicker(t) {
    var s = STATE.settings;
    t.status = 'loading'; t.error = null; renderResults();
    var today = new Date();
    var end = fmtDateYMD(today);
    var start = fmtDateYMD(new Date(today.getTime() - 220 * 86400000));
    Promise.all([apiQuote(t.sym), apiHistory(t.sym, start, end), apiExpirations(t.sym)])
      .then(function (r) {
        t.quote = r[0];
        t.atr = computeATR(r[1], s.atrPeriod);
        t.expirations = r[2] || [];
        if (t.atr == null) throw new Error('Not enough history to compute ATR.');
        // choose expiration (respect a saved override if still valid)
        if (!t.exp || t.expirations.indexOf(t.exp) < 0) {
          var pe = pickExpiration(t.expirations, s.targetDTE, 7, today);
          t.exp = pe ? pe.exp : (t.expirations[0] || null);
        }
        return fetchChainAndSize(t);
      })
      .catch(function (err) { t.status = 'error'; t.error = err.message || String(err); renderResults(); });
  }

  function fetchChainAndSize(t) {
    var s = STATE.settings;
    if (!t.exp) { t.status = 'error'; t.error = 'No options expirations available.'; renderResults(); return Promise.resolve(); }
    t.status = 'loading'; renderResults();
    return apiChainCalls(t.sym, t.exp).then(function (calls) {
      t.call = pickCall(calls, { targetDelta: s.targetDelta, deltaMin: s.deltaMin, deltaMax: s.deltaMax });
      if (!t.call) throw new Error('No call with greeks for ' + fmtMDY(t.exp) + '.');
      t.dte = daysToExp(t.exp);
      t.sizing = computeSizing({ capital: s.capital, riskPct: s.riskPct, price: t.quote.last, atr: t.atr, delta: t.call.delta, premium: t.call.mid });
      t.status = 'ready';
      renderResults();
    }).catch(function (err) { t.status = 'error'; t.error = err.message || String(err); renderResults(); });
  }

  // ---- result rendering ----
  function renderResults() {
    var wrap = el('results');
    if (!STATE.tickers.length) { wrap.innerHTML = '<div class="empty">Add a ticker to size a position.</div>'; return; }
    wrap.innerHTML = STATE.tickers.map(renderCard).join('');
  }

  function renderCard(t, idx) {
    var head = '<div class="tkhead"><div class="tksym">' + esc(t.sym) + '</div>' +
      '<div class="tkbtns"><button class="mini" data-act="refresh">Refresh</button>' +
      '<button class="mini" data-act="remove">Remove</button></div></div>';

    var body;
    if (t.status === 'loading') body = '<div class="loading">Loading market data...</div>';
    else if (t.status === 'error') body = '<div class="err">' + esc(t.error || 'Error') + ' <button class="mini" data-act="retry">Retry</button></div>';
    else if (t.status === 'ready' && t.sizing) body = renderReady(t);
    else body = '<div class="loading">...</div>';

    return '<section class="tk card" data-idx="' + idx + '">' + head + body + '</section>';
  }

  function renderReady(t) {
    var q = t.quote, z = t.sizing, c = t.call, s = STATE.settings;
    var chgCls = q.changePct >= 0 ? 'up' : 'down';
    var chgStr = (q.changePct >= 0 ? '+' : '') + num(q.change, 2) + ' (' + (q.changePct >= 0 ? '+' : '') + num(q.changePct, 2) + '%)';
    var atrPct = q.last > 0 ? (t.atr / q.last * 100) : 0;

    var priceLine = '<div class="price">Entry price <b>' + money(q.last) + '</b> ' +
      '<span class="chg ' + chgCls + '">' + chgStr + '</span></div>' +
      '<div class="atr">ATR(' + s.atrPeriod + '): <b>' + money(t.atr) + '</b> (' + num(atrPct, 1) + '% of price)</div>';

    var L = z.levels;
    var ladder = '<div class="ladder">' +
      lrow('+1 ATR', L.plusOne, 'pos') +
      lrow('+0.5 ATR', L.plusHalf, 'pos') +
      lrow('Entry', L.entry, 'mid') +
      lrow('-0.5 ATR', L.minusHalf, 'neg') +
      lrow('-1 ATR', L.minusOne, 'neg') +
      '</div>';

    var expSel = '<select data-act="exp">' + (t.expirations || []).map(function (x) {
      return '<option value="' + x + '"' + (x === t.exp ? ' selected' : '') + '>' + fmtMDY(x) + ' (' + daysToExp(x) + 'd)</option>';
    }).join('') + '</select>';

    var oob = c.outOfBand ? '<span class="badge warn">delta ' + num(c.delta, 2) + ' outside 0.70-0.85 band</span>' : '';
    var callLine = '<div class="call"><div class="callrow"><span>Call</span>' + expSel + '</div>' +
      '<div class="callmeta"><b>' + num(c.strike, c.strike % 1 ? 1 : 0) + 'C</b>' +
      ' &middot; delta ' + num(c.delta, 2) +
      ' &middot; mid ' + money(c.mid) +
      ' &middot; ' + t.dte + ' DTE' + (isFinite(c.iv) ? ' &middot; IV ' + num(c.iv * 100, 0) + '%' : '') + '</div>' + oob + '</div>';

    var h = z.half, o = z.one;
    var table =
      '<table class="sz"><thead><tr><th></th><th>Stop 0.5 ATR</th><th>Stop 1 ATR</th></tr></thead><tbody>' +
        '<tr><td class="lbl">Stop price</td><td>' + money(L.minusHalf) + '</td><td>' + money(L.minusOne) + '</td></tr>' +
        '<tr><td class="lbl">Stop distance</td><td>' + money(h.dist) + '</td><td>' + money(o.dist) + '</td></tr>' +
        '<tr class="hl"><td class="lbl">Long calls</td><td><b>' + intc(h.contracts) + '</b></td><td><b>' + intc(o.contracts) + '</b></td></tr>' +
        '<tr><td class="lbl sub">premium outlay</td><td>' + money0(h.premiumOutlay) + '</td><td>' + money0(o.premiumOutlay) + '</td></tr>' +
        '<tr><td class="lbl sub">risk at stop</td><td>' + money0(h.optRiskAtStop) + '</td><td>' + money0(o.optRiskAtStop) + '</td></tr>' +
        '<tr class="hl"><td class="lbl">Shares (=risk)</td><td><b>' + intc(h.shares) + '</b></td><td><b>' + intc(o.shares) + '</b></td></tr>' +
        '<tr><td class="lbl sub">notional</td><td>' + money0(h.sharesNotional) + '</td><td>' + money0(o.sharesNotional) + '</td></tr>' +
      '</tbody></table>';

    var note = '<details class="adv"><summary>How these are sized</summary>' +
      '<div class="hint">Risk budget = ' + money(z.riskBudget) + ' (' + num(s.riskPct, 2) + '% of capital).<br>' +
      'Shares = risk budget / stop distance.<br>' +
      'Long calls = risk budget / (delta x stop distance x 100), so a stop hit loses about the same dollars either way.<br>' +
      'Premium outlay is total cash deployed - it can exceed the risk budget; if the underlying gaps through your stop the most you can lose is the premium.<br>' +
      'Premium-capped alt: ' + intc(z.premiumCapContracts) + ' contracts keeps total premium within the risk budget.</div></details>';

    return priceLine + ladder + callLine + table + note;
  }

  function lrow(label, val, cls) {
    return '<div class="lr ' + cls + '"><span>' + label + '</span><span>' + money(val) + '</span></div>';
  }

  // ---- demo hook (for offline UI verification; harmless in production) ----
  function posSizerDemo(mock) {
    var s = STATE.settings;
    mock = mock || {
      sym: 'AAPL', price: 230.12, atr: 4.25, exp: '2026-07-17',
      expirations: ['2026-06-19', '2026-06-26', '2026-07-17', '2026-08-21'],
      call: { strike: 210, delta: 0.78, bid: 24.2, ask: 24.8, last: 24.5, mid: 24.5, oi: 5400, iv: 0.27, outOfBand: false }
    };
    var t = {
      sym: mock.sym, status: 'ready', exp: mock.exp, expirations: mock.expirations,
      quote: { symbol: mock.sym, last: mock.price, change: 1.34, changePct: 0.58, desc: '' },
      atr: mock.atr, call: mock.call, dte: daysToExp(mock.exp)
    };
    t.sizing = computeSizing({ capital: s.capital, riskPct: s.riskPct, price: mock.price, atr: mock.atr, delta: mock.call.delta, premium: mock.call.mid });
    STATE.tickers = [t];
    renderResults();
  }

  function init() {
    load();
    renderShell();
    renderResults();
    STATE.tickers.forEach(function (t) { fetchTicker(t); });
  }

  if (typeof document !== 'undefined') {
    if (typeof window !== 'undefined') window.posSizerDemo = posSizerDemo;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      computeATR: computeATR, computeSizing: computeSizing, pickCall: pickCall,
      pickExpiration: pickExpiration, fmtDateYMD: fmtDateYMD, parseYMD: parseYMD, daysToExp: daysToExp
    };
  }
})();
