/* Position Sizer + Journal
 * Tab 1 "Sizer": pre-trade long-call sizing. Live price + ATR + 0.70-0.85 delta
 *   call via the shared tradier-proxy (greeks; no key needed). Unchanged math.
 * Tab 2 "Journal": spreadsheet of long calls you already bought. Key in ticker +
 *   purchase date/time (CST); pulls the stock price at that moment and the ATR as
 *   of that date (FMP /stable, your key), then shows the ATR levels around entry.
 *
 * All pure math is exported for Node so it can be unit-tested.
 */
(function () {
  'use strict';

  var APP_VERSION = 'v1.1.1';

  // ---- Tradier data path (Sizer tab) ----
  var PROXY_FALLBACK = 'https://tradier-proxy.alexander-s-reed.workers.dev';
  var DIRECT_HOST = 'https://api.tradier.com';
  var LIVE_TOKEN_KEY = 'rrjcar_tradier_proxy_live_token';
  var PROXY_KEY = 'rrjcar_tradier_proxy';
  var RAW_KEY = 'rrjcar_tradier';

  // ---- FMP data path (Journal tab) ----
  var FMP_BASE = 'https://financialmodelingprep.com/stable';
  var FMP_KEY1 = 'rrjcar_fmp';   // shared with the scanner
  var FMP_KEY2 = 'posSizer_fmp'; // local fallback

  var SKEY = 'posSizer_v1';

  // ============================================================
  // localStorage helpers
  // ============================================================
  function ls() { return (typeof localStorage !== 'undefined') ? localStorage : null; }
  function lsGet(k) { var s = ls(); try { return s ? (s.getItem(k) || '').trim() : ''; } catch (_) { return ''; } }
  function lsSet(k, v) { var s = ls(); try { if (s) s.setItem(k, v); } catch (_) {} }

  // ============================================================
  // Tradier credentials / fetch (Sizer)
  // ============================================================
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

  function apiQuote(sym) {
    return tFetch('/v1/markets/quotes?symbols=' + encodeURIComponent(sym)).then(function (d) {
      var q = d && d.quotes && d.quotes.quote;
      if (Array.isArray(q)) q = q[0];
      if (!q) throw new Error('No quote for ' + sym);
      var last = parseFloat(q.last);
      if (!isFinite(last) || last <= 0) last = parseFloat(q.close) || parseFloat(q.prevclose) || 0;
      return { symbol: q.symbol || sym, desc: q.description || '', last: last,
        change: parseFloat(q.change) || 0, changePct: parseFloat(q.change_percentage) || 0 };
    });
  }
  function apiHistory(sym, start, end) {
    return tFetch('/v1/markets/history?symbol=' + encodeURIComponent(sym) +
      '&interval=daily&start=' + start + '&end=' + end).then(function (d) {
      var days = d && d.history && d.history.day;
      if (!days) return [];
      if (!Array.isArray(days)) days = [days];
      return days.map(function (b) { return { date: b.date, open: +b.open, high: +b.high, low: +b.low, close: +b.close }; })
        .filter(function (b) { return isFinite(b.high) && isFinite(b.low) && isFinite(b.close); })
        .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
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
        return { strike: +o.strike, bid: +o.bid || 0, ask: +o.ask || 0, last: +o.last || 0,
          oi: +o.open_interest || 0, delta: (g.delta != null) ? parseFloat(g.delta) : NaN,
          iv: (g.mid_iv != null) ? parseFloat(g.mid_iv) : NaN, symbol: o.symbol };
      });
    });
  }

  // ============================================================
  // FMP credentials / fetch (Journal) - /stable endpoints
  // ============================================================
  function fmpKey() { return lsGet(FMP_KEY1) || lsGet(FMP_KEY2) || ''; }

  function fmpFetch(path) {
    var key = fmpKey();
    if (!key) return Promise.reject(new Error('Add your FMP API key in Journal > Data settings.'));
    var url = FMP_BASE + '/' + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'apikey=' + encodeURIComponent(key);
    return fetch(url).then(function (r) {
      return r.text().then(function (txt) {
        if (/Restricted Endpoint/i.test(txt)) throw new Error('FMP plan does not allow this endpoint.');
        if (/Legacy Endpoint/i.test(txt)) throw new Error('FMP legacy endpoint - app needs the /stable API.');
        if (r.status === 401 || r.status === 403) throw new Error('FMP key rejected (' + r.status + ').');
        if (r.status === 429) throw new Error('FMP rate limit (429) - wait and retry.');
        var d;
        try { d = JSON.parse(txt); } catch (e) { throw new Error('FMP bad response: ' + txt.slice(0, 90)); }
        if (d && d['Error Message']) throw new Error('FMP: ' + d['Error Message']);
        if (!r.ok) throw new Error('FMP HTTP ' + r.status);
        return d;
      });
    });
  }

  function fmpQuote(sym) {
    return fmpFetch('quote?symbol=' + encodeURIComponent(sym)).then(function (a) {
      var q = Array.isArray(a) ? a[0] : a;
      if (!q || q.price == null) throw new Error('No quote for ' + sym);
      return { last: +q.price, change: +q.change || 0, changePct: +q.changePercentage || 0, name: q.name || '' };
    });
  }
  function fmpDaily(sym, from, to) {
    return fmpFetch('historical-price-eod/full?symbol=' + encodeURIComponent(sym) + '&from=' + from + '&to=' + to).then(function (a) {
      a = Array.isArray(a) ? a : [];
      return a.map(function (b) { return { date: b.date, open: +b.open, high: +b.high, low: +b.low, close: +b.close }; })
        .filter(function (b) { return isFinite(b.high) && isFinite(b.low) && isFinite(b.close); })
        .sort(function (x, y) { return x.date < y.date ? -1 : 1; });
    });
  }
  function fmpIntraday5(sym, from, to) {
    return fmpFetch('historical-chart/5min?symbol=' + encodeURIComponent(sym) + '&from=' + from + '&to=' + to).then(function (a) {
      a = Array.isArray(a) ? a : [];
      return a.map(function (b) { return { dt: b.date, open: +b.open, high: +b.high, low: +b.low, close: +b.close }; });
    });
  }

  // ============================================================
  // Pure math (unit-tested)
  // ============================================================
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
    atr = atr / period;
    for (var k = period; k < trs.length; k++) atr = (atr * (period - 1) + trs[k]) / period;
    return atr;
  }

  function computeLevels(price, atr) {
    return { plusOne: price + atr, plusHalf: price + 0.5 * atr, entry: price,
      minusHalf: price - 0.5 * atr, minusOne: price - atr };
  }

  // Where current price sits vs entry, in ATR multiples. zone drives the color.
  function atrStatus(now, entry, atr) {
    if (now == null || entry == null || !isFinite(atr) || atr <= 0) return null;
    var mult = (now - entry) / atr, zone;
    if (mult >= 1) zone = 'p2';
    else if (mult >= 0.5) zone = 'p1';
    else if (mult >= 0) zone = 'p0';
    else if (mult > -0.5) zone = 'n0';
    else if (mult > -1) zone = 'n1';
    else zone = 'n2';
    return { mult: mult, zone: zone, label: (mult >= 0 ? '+' : '') + mult.toFixed(2) + ' ATR' };
  }

  function fmtDateYMD(d) {
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function parseYMD(s) { var p = String(s).split('-'); return new Date(+p[0], (+p[1]) - 1, +p[2], 12, 0, 0, 0); }
  function daysToExp(expStr, today) {
    today = today || new Date();
    var t = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0, 0);
    return Math.round((parseYMD(expStr) - t) / 86400000);
  }

  // Central time -> Eastern time (market data is ET). Chicago is always 1h behind NY.
  function ctToEt(dateStr, timeStr) {
    var p = String(dateStr).split('-'), t = String(timeStr || '09:30').split(':');
    var d = new Date(+p[0], (+p[1]) - 1, +p[2], +t[0] || 0, +t[1] || 0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d;
  }
  // Nearest intraday bar to a target Date (both parsed in the same local TZ -> diff is consistent).
  function pickIntradayBar(bars, targetDate) {
    var tt = targetDate.getTime(), best = null, bestDiff = Infinity;
    for (var i = 0; i < bars.length; i++) {
      var bt = new Date(String(bars[i].dt).replace(' ', 'T')).getTime();
      if (!isFinite(bt)) continue;
      var diff = Math.abs(bt - tt);
      if (diff < bestDiff) { bestDiff = diff; best = bars[i]; }
    }
    return best;
  }

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
        return b.delta - a.delta;
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
    return { strike: chosen.strike, delta: chosen.delta, bid: chosen.bid, ask: chosen.ask, last: chosen.last,
      mid: mid, oi: chosen.oi, iv: chosen.iv, symbol: chosen.symbol, outOfBand: outOfBand };
  }

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
    return { riskBudget: riskBudget, levels: computeLevels(P, A), half: leg(0.5), one: leg(1.0),
      premiumCapContracts: (prem > 0) ? Math.floor(riskBudget / (prem * 100)) : 0 };
  }

  // ============================================================
  // State
  // ============================================================
  var STATE = {
    tab: 'sizer',
    settings: { capital: 100000, riskPct: 5, atrPeriod: 14, targetDTE: 45, targetDelta: 0.80, deltaMin: 0.70, deltaMax: 0.85 },
    tickers: [], // sizer
    journal: []  // {id, ticker, date, time, entry, manual, atr, now, barTime, status, err}
  };
  var nextId = 1;

  function save() {
    var t = STATE.tickers.map(function (x) { return { sym: x.sym, exp: x.exp || null }; });
    var j = STATE.journal.map(function (r) {
      return { ticker: r.ticker, date: r.date, time: r.time, entry: r.entry, manual: !!r.manual, atr: r.atr, now: r.now, barTime: r.barTime || null };
    });
    lsSet(SKEY, JSON.stringify({ settings: STATE.settings, tickers: t, journal: j, tab: STATE.tab }));
  }
  function load() {
    try {
      var o = JSON.parse(lsGet(SKEY) || '{}');
      if (o.settings) for (var k in o.settings) if (o.settings[k] != null) STATE.settings[k] = o.settings[k];
      if (o.tab) STATE.tab = o.tab;
      if (Array.isArray(o.tickers)) STATE.tickers = o.tickers.map(function (x) { return { sym: x.sym, exp: x.exp || null, status: 'idle' }; });
      if (Array.isArray(o.journal)) STATE.journal = o.journal.map(function (r) {
        return { id: nextId++, ticker: r.ticker, date: r.date, time: r.time, entry: r.entry, manual: !!r.manual,
          atr: r.atr, now: r.now, barTime: r.barTime || null, status: (r.entry != null && r.atr != null) ? 'ready' : 'idle', err: null };
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

  // ============================================================
  // App scaffold + tabs
  // ============================================================
  function renderApp() {
    el('app').innerHTML =
      '<header class="hdr"><div class="title">Position Sizer</div>' +
        '<div class="sub">Long calls 0.70-0.85 delta - ATR risk sizing</div></header>' +
      '<div class="tabs">' +
        '<button class="tab" data-tab="sizer">Sizer</button>' +
        '<button class="tab" data-tab="journal">Journal</button>' +
      '</div>' +
      '<div id="view-sizer" class="view"></div>' +
      '<div id="view-journal" class="view"></div>' +
      '<footer class="foot">Estimates only. The true max loss on a long call is the premium paid. ' +
        'Delta-based stop loss ignores gamma, theta and IV moves. ' + APP_VERSION + '</footer>';
    renderSizerShell();
    renderJournalShell();
    el('app').addEventListener('click', function (e) {
      if (e.target.matches('.tab')) setTab(e.target.getAttribute('data-tab'));
    });
    setTab(STATE.tab);
  }
  function setTab(name) {
    STATE.tab = name; save();
    var tabs = el('app').querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === name);
    el('view-sizer').classList.toggle('hidden', name !== 'sizer');
    el('view-journal').classList.toggle('hidden', name !== 'journal');
  }

  // ============================================================
  // SIZER tab
  // ============================================================
  function renderSizerShell() {
    var s = STATE.settings;
    el('view-sizer').innerHTML =
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
          '<div class="hint">The Sizer reads live data (incl. option deltas) through your tradier-proxy worker. On devices where your scanner works, the token is shared automatically.</div>' +
          '<label class="full">Tradier live token<input id="liveTok" type="password" placeholder="X-Live-Token" autocomplete="off"></label>' +
          '<label class="full">Proxy URL (optional override)<input id="proxyUrl" type="text" placeholder="' + PROXY_FALLBACK + '" autocomplete="off"></label>' +
          '<button id="saveData" class="btn">Save data settings</button>' +
        '</details>' +
      '</section>' +
      '<div id="results"></div>';

    var lt = lsGet(LIVE_TOKEN_KEY); if (lt) el('liveTok').value = lt;
    var pu = lsGet(PROXY_KEY); if (pu) el('proxyUrl').value = pu;
    wireSizer();
    updateBudgetLine();
    updateDataStatus();
    renderResults();
  }

  function updateBudgetLine() {
    var s = STATE.settings;
    el('budgetLine').textContent = 'Risk budget per trade: ' + money((+s.capital || 0) * (+s.riskPct || 0) / 100) +
      '  (' + num(s.riskPct, 2) + '% of ' + money0(s.capital) + ')';
  }
  function updateDataStatus() {
    var c = resolveCreds(), node = el('dataStatus'); if (!node) return;
    if (c.mode === 'proxy') { node.textContent = 'Live data: proxy + token'; node.className = 'status ok'; }
    else if (c.mode === 'direct') { node.textContent = 'Live data: direct key'; node.className = 'status ok'; }
    else { node.textContent = 'Live data: no token - open Data settings'; node.className = 'status warn'; }
  }

  function wireSizer() {
    ['cap', 'rsk', 'atrp', 'dte', 'tdelta'].forEach(function (id) { el(id).addEventListener('input', onSettingChange); });
    el('addBtn').addEventListener('click', onAddSizer);
    el('addSym').addEventListener('keydown', function (e) { if (e.key === 'Enter') onAddSizer(); });
    el('refreshAll').addEventListener('click', function () { STATE.tickers.forEach(function (t) { fetchTicker(t); }); });
    el('saveData').addEventListener('click', function () {
      var tok = (el('liveTok').value || '').trim(), pxy = (el('proxyUrl').value || '').trim();
      if (tok) lsSet(LIVE_TOKEN_KEY, tok);
      if (pxy) lsSet(PROXY_KEY, pxy);
      updateDataStatus();
      STATE.tickers.forEach(function (t) { fetchTicker(t); });
    });
    var res = el('results');
    res.addEventListener('click', function (e) {
      var card = e.target.closest('.tk'); if (!card) return;
      var idx = +card.getAttribute('data-idx'), t = STATE.tickers[idx]; if (!t) return;
      if (e.target.matches('[data-act="remove"]')) { STATE.tickers.splice(idx, 1); save(); renderResults(); }
      else if (e.target.matches('[data-act="refresh"]') || e.target.matches('[data-act="retry"]')) fetchTicker(t);
    });
    res.addEventListener('change', function (e) {
      if (e.target.matches('select[data-act="exp"]')) {
        var t = STATE.tickers[+e.target.closest('.tk').getAttribute('data-idx')]; if (!t) return;
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
    STATE.tickers.forEach(function (t) {
      if (t.quote && t.atr != null && t.call)
        t.sizing = computeSizing({ capital: s.capital, riskPct: s.riskPct, price: t.quote.last, atr: t.atr, delta: t.call.delta, premium: t.call.mid });
    });
    renderResults();
  }
  function onAddSizer() {
    var v = (el('addSym').value || '').trim().toUpperCase();
    if (!v || STATE.tickers.some(function (t) { return t.sym === v; })) { el('addSym').value = ''; return; }
    var t = { sym: v, exp: null, status: 'idle' };
    STATE.tickers.push(t); el('addSym').value = ''; save(); renderResults(); fetchTicker(t);
  }

  function fetchTicker(t) {
    var s = STATE.settings;
    t.status = 'loading'; t.error = null; renderResults();
    var today = new Date();
    var end = fmtDateYMD(today), start = fmtDateYMD(new Date(today.getTime() - 220 * 86400000));
    Promise.all([apiQuote(t.sym), apiHistory(t.sym, start, end), apiExpirations(t.sym)])
      .then(function (r) {
        t.quote = r[0]; t.atr = computeATR(r[1], s.atrPeriod); t.expirations = r[2] || [];
        if (t.atr == null) throw new Error('Not enough history to compute ATR.');
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
      t.status = 'ready'; renderResults();
    }).catch(function (err) { t.status = 'error'; t.error = err.message || String(err); renderResults(); });
  }

  function renderResults() {
    var wrap = el('results'); if (!wrap) return;
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
    var priceLine = '<div class="price">Entry price <b>' + money(q.last) + '</b> <span class="chg ' + chgCls + '">' + chgStr + '</span></div>' +
      '<div class="atr">ATR(' + s.atrPeriod + '): <b>' + money(t.atr) + '</b> (' + num(atrPct, 1) + '% of price)</div>';
    var L = z.levels;
    var ladder = '<div class="ladder">' + lrow('+1 ATR', L.plusOne, 'pos') + lrow('+0.5 ATR', L.plusHalf, 'pos') +
      lrow('Entry', L.entry, 'mid') + lrow('-0.5 ATR', L.minusHalf, 'neg') + lrow('-1 ATR', L.minusOne, 'neg') + '</div>';
    var expSel = '<select data-act="exp">' + (t.expirations || []).map(function (x) {
      return '<option value="' + x + '"' + (x === t.exp ? ' selected' : '') + '>' + fmtMDY(x) + ' (' + daysToExp(x) + 'd)</option>';
    }).join('') + '</select>';
    var oob = c.outOfBand ? '<span class="badge warn">delta ' + num(c.delta, 2) + ' outside 0.70-0.85 band</span>' : '';
    var callLine = '<div class="call"><div class="callrow"><span>Call</span>' + expSel + '</div>' +
      '<div class="callmeta"><b>' + num(c.strike, c.strike % 1 ? 1 : 0) + 'C</b> &middot; delta ' + num(c.delta, 2) +
      ' &middot; mid ' + money(c.mid) + ' &middot; ' + t.dte + ' DTE' + (isFinite(c.iv) ? ' &middot; IV ' + num(c.iv * 100, 0) + '%' : '') + '</div>' + oob + '</div>';
    var h = z.half, o = z.one;
    var table = '<table class="sz"><thead><tr><th></th><th>Stop 0.5 ATR</th><th>Stop 1 ATR</th></tr></thead><tbody>' +
      '<tr><td class="lbl">Stop price</td><td>' + money(L.minusHalf) + '</td><td>' + money(L.minusOne) + '</td></tr>' +
      '<tr><td class="lbl">Stop distance</td><td>' + money(h.dist) + '</td><td>' + money(o.dist) + '</td></tr>' +
      '<tr class="hl"><td class="lbl">Long calls</td><td><b>' + intc(h.contracts) + '</b></td><td><b>' + intc(o.contracts) + '</b></td></tr>' +
      '<tr><td class="lbl sub">premium outlay</td><td>' + money0(h.premiumOutlay) + '</td><td>' + money0(o.premiumOutlay) + '</td></tr>' +
      '<tr><td class="lbl sub">risk at stop</td><td>' + money0(h.optRiskAtStop) + '</td><td>' + money0(o.optRiskAtStop) + '</td></tr>' +
      '<tr class="hl"><td class="lbl">Shares (=risk)</td><td><b>' + intc(h.shares) + '</b></td><td><b>' + intc(o.shares) + '</b></td></tr>' +
      '<tr><td class="lbl sub">notional</td><td>' + money0(h.sharesNotional) + '</td><td>' + money0(o.sharesNotional) + '</td></tr>' +
      '</tbody></table>';
    var note = '<details class="adv"><summary>How these are sized</summary><div class="hint">Risk budget = ' + money(z.riskBudget) +
      ' (' + num(s.riskPct, 2) + '% of capital).<br>Shares = risk budget / stop distance.<br>' +
      'Long calls = risk budget / (delta x stop distance x 100), so a stop hit loses about the same dollars either way.<br>' +
      'Premium outlay is total cash deployed - it can exceed the risk budget; if the underlying gaps through your stop the most you can lose is the premium.<br>' +
      'Premium-capped alt: ' + intc(z.premiumCapContracts) + ' contracts keeps total premium within the risk budget.</div></details>';
    return priceLine + ladder + callLine + table + note;
  }
  function lrow(label, val, cls) { return '<div class="lr ' + cls + '"><span>' + label + '</span><span>' + money(val) + '</span></div>'; }

  // ============================================================
  // JOURNAL tab
  // ============================================================
  function renderJournalShell() {
    el('view-journal').innerHTML =
      '<section class="card">' +
        '<div class="jadd">' +
          '<input id="jSym" type="text" placeholder="Ticker" autocapitalize="characters" autocomplete="off" spellcheck="false">' +
          '<input id="jDate" type="date">' +
          '<input id="jTime" type="time">' +
          '<button id="jAdd" class="btn primary">Add</button>' +
        '</div>' +
        '<div class="addrow2"><button id="jRefresh" class="btn">Refresh all</button>' +
          '<button id="jCsv" class="btn">Export CSV</button>' +
          '<span id="fmpStatus" class="status"></span></div>' +
        '<div class="hint">Enter the time you bought (Central time). It pulls the stock price at that 5-min bar and the ATR(' + STATE.settings.atrPeriod + ') as of that date, then shows the levels around your entry. The Entry cell is editable - type your real fill to override.</div>' +
        '<details class="adv"><summary>Data settings</summary>' +
          '<div class="hint">The Journal uses FMP (/stable API). Paste your FMP key; it is stored only in this browser. Your tier supports 5-min intraday and daily history.</div>' +
          '<label class="full">FMP API key<input id="fmpKeyIn" type="password" placeholder="FMP apikey" autocomplete="off"></label>' +
          '<button id="jSaveKey" class="btn">Save FMP key</button>' +
        '</details>' +
      '</section>' +
      '<div id="journalTable"></div>';
    var fk = lsGet(FMP_KEY2); if (fk) el('fmpKeyIn').value = fk;
    wireJournal();
    updateFmpStatus();
    renderJournalRows();
  }

  function updateFmpStatus() {
    var node = el('fmpStatus'); if (!node) return;
    if (fmpKey()) { node.textContent = 'FMP: key set'; node.className = 'status ok'; }
    else { node.textContent = 'FMP: no key - open Data settings'; node.className = 'status warn'; }
  }

  function wireJournal() {
    el('jAdd').addEventListener('click', onAddJournal);
    el('jSym').addEventListener('keydown', function (e) { if (e.key === 'Enter') onAddJournal(); });
    el('jRefresh').addEventListener('click', function () { STATE.journal.forEach(fetchJournalRow); });
    el('jCsv').addEventListener('click', exportCsv);
    el('jSaveKey').addEventListener('click', function () {
      var k = (el('fmpKeyIn').value || '').trim();
      if (k) { lsSet(FMP_KEY2, k); updateFmpStatus(); STATE.journal.forEach(fetchJournalRow); }
    });
    var tbl = el('journalTable');
    tbl.addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-id]'); if (!tr) return;
      var row = rowById(+tr.getAttribute('data-id')); if (!row) return;
      if (e.target.matches('[data-act="jremove"]')) { STATE.journal = STATE.journal.filter(function (r) { return r.id !== row.id; }); save(); renderJournalRows(); }
      else if (e.target.matches('[data-act="jrefresh"]')) fetchJournalRow(row);
    });
    tbl.addEventListener('change', function (e) {
      if (e.target.matches('input[data-act="jentry"]')) {
        var row = rowById(+e.target.closest('tr[data-id]').getAttribute('data-id')); if (!row) return;
        var v = parseFloat(e.target.value);
        if (isFinite(v) && v > 0) { row.entry = v; row.manual = true; save(); renderJournalRows(); }
      }
    });
  }
  function rowById(id) { for (var i = 0; i < STATE.journal.length; i++) if (STATE.journal[i].id === id) return STATE.journal[i]; return null; }

  function onAddJournal() {
    var sym = (el('jSym').value || '').trim().toUpperCase();
    var date = el('jDate').value, time = el('jTime').value;
    if (!sym) return;
    if (!date) { el('jDate').focus(); return; }
    if (!time) time = '09:30';
    var row = { id: nextId++, ticker: sym, date: date, time: time, entry: null, manual: false, atr: null, now: null, barTime: null, status: 'loading', err: null };
    STATE.journal.push(row);
    el('jSym').value = '';
    save(); renderJournalRows(); fetchJournalRow(row);
  }

  function fetchJournalRow(row) {
    if (!fmpKey()) { row.status = 'error'; row.err = 'No FMP key'; renderJournalRows(); return; }
    row.status = 'loading'; row.err = null; renderJournalRows();
    var period = STATE.settings.atrPeriod;
    var fromD = new Date(row.date + 'T12:00:00'); fromD.setDate(fromD.getDate() - 320);
    var dailyFrom = fmtDateYMD(fromD);
    var jobs = [
      fmpDaily(row.ticker, dailyFrom, row.date),
      fmpQuote(row.ticker),
      row.manual ? Promise.resolve(null) : fmpIntraday5(row.ticker, row.date, row.date)
    ];
    Promise.all(jobs).then(function (r) {
      var daily = r[0] || [], quote = r[1], intraday = r[2];
      var upto = daily.filter(function (b) { return b.date <= row.date; });
      row.atr = computeATR(upto, period);
      row.now = quote ? quote.last : null;
      if (!row.manual) {
        if (intraday && intraday.length) {
          var bar = pickIntradayBar(intraday, ctToEt(row.date, row.time));
          if (bar) { row.entry = bar.close; row.barTime = bar.dt; }
        }
        if (row.entry == null) {
          // fallback to that day's daily close
          var dayBar = upto[upto.length - 1];
          if (dayBar && dayBar.date === row.date) { row.entry = dayBar.close; row.barTime = 'daily close'; }
        }
      }
      if (row.atr == null) { row.status = 'error'; row.err = 'No ATR (history?)'; }
      else if (row.entry == null) { row.status = 'error'; row.err = 'No price at that time - type entry'; }
      else row.status = 'ready';
      save(); renderJournalRows();
    }).catch(function (err) { row.status = 'error'; row.err = err.message || String(err); save(); renderJournalRows(); });
  }

  function renderJournalRows() {
    var wrap = el('journalTable'); if (!wrap) return;
    if (!STATE.journal.length) { wrap.innerHTML = '<div class="empty">Add a long call you bought: ticker, purchase date, and CST time.</div>'; return; }
    var head = '<table class="jt"><thead><tr>' +
      '<th class="stick">Ticker</th><th>Bought (CST)</th><th>Entry</th><th>ATR</th>' +
      '<th>-1 ATR</th><th>-0.5 ATR</th><th>+0.5 ATR</th><th>+1 ATR</th><th>Now</th><th>vs entry</th><th></th>' +
      '</tr></thead><tbody>' + STATE.journal.map(renderJournalRow).join('') + '</tbody></table>';
    wrap.innerHTML = '<div class="jwrap">' + head + '</div>';
  }
  function renderJournalRow(row) {
    var when = fmtMDY(row.date) + ' ' + (row.time || '');
    var entryCell = '<input class="cell" data-act="jentry" type="number" inputmode="decimal" step="0.01" value="' + (row.entry != null ? row.entry : '') + '"' + (row.manual ? ' title="manual override"' : '') + '>';
    var tickTd = '<td class="stick tick">' + esc(row.ticker) + '</td>';
    var whenTd = '<td class="when">' + esc(when) + (row.barTime === 'daily close' ? ' <span class="tag">eod</span>' : '') + '</td>';
    var actTd = '<td class="jact"><button class="mini" data-act="jrefresh" title="Refresh">R</button><button class="mini" data-act="jremove" title="Remove">X</button></td>';
    var mid;
    if (row.status === 'loading') mid = '<td class="entry">' + entryCell + '</td><td colspan="7" class="jmsg">loading...</td>';
    else if (row.status === 'error') mid = '<td class="entry">' + entryCell + '</td><td colspan="7" class="jmsg err">' + esc(row.err || 'error') + '</td>';
    else {
      var lv = computeLevels(row.entry, row.atr);
      var st = atrStatus(row.now, row.entry, row.atr);
      var stCell = st ? '<span class="st ' + st.zone + '">' + st.label + '</span>' : '-';
      mid = '<td class="entry">' + entryCell + '</td>' +
        '<td>' + money(row.atr) + '</td>' +
        '<td class="neg">' + money(lv.minusOne) + '</td>' +
        '<td class="neg">' + money(lv.minusHalf) + '</td>' +
        '<td class="pos">' + money(lv.plusHalf) + '</td>' +
        '<td class="pos">' + money(lv.plusOne) + '</td>' +
        '<td>' + (row.now != null ? money(row.now) : '-') + '</td>' +
        '<td class="stcol">' + stCell + '</td>';
    }
    return '<tr data-id="' + row.id + '">' + tickTd + whenTd + mid + actTd + '</tr>';
  }

  function exportCsv() {
    var rows = [['Ticker', 'BuyDate_CST', 'BuyTime_CST', 'Entry', 'ATR', '-1ATR', '-0.5ATR', '+0.5ATR', '+1ATR', 'Now', 'ATRfromEntry']];
    STATE.journal.forEach(function (r) {
      var lv = (r.entry != null && r.atr != null) ? computeLevels(r.entry, r.atr) : { minusOne: '', minusHalf: '', plusHalf: '', plusOne: '' };
      var st = atrStatus(r.now, r.entry, r.atr);
      rows.push([r.ticker, r.date, r.time, r.entry != null ? r.entry : '', r.atr != null ? r.atr.toFixed(4) : '',
        n(lv.minusOne), n(lv.minusHalf), n(lv.plusHalf), n(lv.plusOne), r.now != null ? r.now : '', st ? st.mult.toFixed(2) : '']);
    });
    function n(x) { return (typeof x === 'number' && isFinite(x)) ? x.toFixed(2) : ''; }
    var csv = rows.map(function (r) { return r.join(','); }).join('\n');
    try {
      var blob = new Blob([csv], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'position-journal.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } catch (_) {}
  }

  // ---- demo hooks (offline UI verification; harmless in production) ----
  function posSizerDemo(mock) {
    var s = STATE.settings;
    mock = mock || { sym: 'AAPL', price: 230.12, atr: 4.25, exp: '2026-07-17',
      expirations: ['2026-06-19', '2026-06-26', '2026-07-17', '2026-08-21'],
      call: { strike: 210, delta: 0.78, bid: 24.2, ask: 24.8, last: 24.5, mid: 24.5, oi: 5400, iv: 0.27, outOfBand: false } };
    var t = { sym: mock.sym, status: 'ready', exp: mock.exp, expirations: mock.expirations,
      quote: { symbol: mock.sym, last: mock.price, change: 1.34, changePct: 0.58, desc: '' },
      atr: mock.atr, call: mock.call, dte: daysToExp(mock.exp) };
    t.sizing = computeSizing({ capital: s.capital, riskPct: s.riskPct, price: mock.price, atr: mock.atr, delta: mock.call.delta, premium: mock.call.mid });
    STATE.tickers = [t]; setTab('sizer'); renderResults();
  }
  function posSizerJournalDemo(rows) {
    rows = rows || [
      { ticker: 'AAPL', date: '2026-06-12', time: '09:42', entry: 291.36, atr: 5.18, now: 291.13, barTime: '2026-06-12 10:40:00' },
      { ticker: 'NVDA', date: '2026-06-10', time: '13:15', entry: 142.55, atr: 4.02, now: 145.10, barTime: '2026-06-10 14:15:00' }
    ];
    STATE.journal = rows.map(function (r) { return { id: nextId++, ticker: r.ticker, date: r.date, time: r.time, entry: r.entry, manual: false, atr: r.atr, now: r.now, barTime: r.barTime, status: 'ready', err: null }; });
    setTab('journal'); renderJournalRows();
  }

  function init() {
    load();
    renderApp();
    STATE.tickers.forEach(function (t) { fetchTicker(t); });
  }

  if (typeof document !== 'undefined') {
    if (typeof window !== 'undefined') { window.posSizerDemo = posSizerDemo; window.posSizerJournalDemo = posSizerJournalDemo; }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeATR: computeATR, computeSizing: computeSizing, computeLevels: computeLevels,
      atrStatus: atrStatus, pickCall: pickCall, pickExpiration: pickExpiration, fmtDateYMD: fmtDateYMD,
      parseYMD: parseYMD, daysToExp: daysToExp, ctToEt: ctToEt, pickIntradayBar: pickIntradayBar };
  }
})();
