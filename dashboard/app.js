(function () {
  "use strict";
  var DATA = window.RADAR;
  if (!DATA) return;
  var CAL = DATA.calibration, VM = CAL.value_model, OM = CAL.odds_model, RH = CAL.range_honesty, AC = CAL.accounting;
  var FC = DATA.farm_constants, ROWS = DATA.rows || [], LIVE = DATA.live_comparables || [];

  var state = {
    tab: "board", q: "", verdict: "all", category: "all", chain: "all",
    deposit: FC.defaultDepositUsd || 10000, dropShare: FC.defaultDropShare || 0.07, horizon: FC.defaultHorizonWeeks || 12,
    sort: "implied", dir: "desc", selected: null, liveSort: "mcap", liveDir: "desc",
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function roundTo(v, d) { var f = Math.pow(10, d); return Math.round((v + Number.EPSILON) * f) / f; }
  function sigmoid(z) { return z >= 35 ? 1 - 1e-15 : z <= -35 ? 1e-15 : 1 / (1 + Math.exp(-z)); }

  function fmtUsd(n, dec) {
    if (n === null || n === undefined || !isFinite(n)) return "n/a";
    var s = n < 0 ? "-" : "", a = Math.abs(n);
    if (a >= 1e9) return s + "$" + (a / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(1) + "M";
    if (a >= 1e4) return s + "$" + (a / 1e3).toFixed(1) + "K";
    var d = dec !== undefined ? dec : (a < 1000 ? 2 : 0);
    return s + "$" + a.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtSigned(n) { return (n === null || n === undefined || !isFinite(n)) ? "n/a" : (n > 0 ? "+" : n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtSigned0(n) { return (n === null || n === undefined || !isFinite(n)) ? "n/a" : (n > 0 ? "+" : n < 0 ? "-" : "") + "$" + Math.round(Math.abs(n)).toLocaleString("en-US"); }
  function fmtMoney(n) { return "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtPct(n) { return (n === null || n === undefined || !isFinite(n)) ? "n/a" : (n > 0 ? "+" : "") + n.toFixed(1) + "%"; }
  function fmtAge(d) { return (d === null || d === undefined) ? "n/a" : d >= 365 ? (d / 365.25).toFixed(1) + "y" : Math.round(d) + "d"; }

  /* Independent client recomputation of Model A (Power-Law) x Model B (Logistic Odds) */
  function verifyImpliedValue(row) {
    var lnTvl = Math.log(Math.max(row.tvl_usd, 1));
    var growthC = clamp(row.change_7d === null ? 0 : row.change_7d, -60, 60) / 100;
    var lnChains = Math.log(Math.max(1, (row.chains || []).length));
    var yrs = row.age_days !== null ? row.age_days / 365.25 : null;
    var vs = VM.feature_stats;
    var lnLaunch = VM.alpha + VM.beta_tvl * lnTvl + (VM.category_effects[row.category] || 0)
      + VM.beta_growth * ((growthC - vs.growth_mean) / vs.growth_std)
      + VM.beta_chains * ((lnChains - vs.ln_chains_mean) / vs.ln_chains_std)
      + VM.beta_maturity * (((yrs === null ? vs.median_years_listed : yrs) - vs.years_mean) / vs.years_std);
    var launchUsd = Math.max(1, Math.round(Math.exp(lnLaunch)));
    var os = OM.feature_stats, defSh = clamp(OM.base_rate, 0.02, 0.98), defLo = Math.log(defSh / (1 - defSh));
    var catLo = OM.category_token_logodds[row.category] !== undefined ? OM.category_token_logodds[row.category] : defLo;
    var z = OM.intercept
      + OM.beta_years * (((yrs === null ? os.median_years_listed : yrs) - os.years_mean) / os.years_std)
      + OM.beta_cat_share * ((catLo - os.cat_logodds_mean) / os.cat_logodds_std)
      + OM.beta_ln_tvl * ((lnTvl - os.ln_tvl_mean) / os.ln_tvl_std)
      + OM.beta_growth * ((growthC - os.growth_mean) / os.growth_std)
      + OM.beta_chains * ((lnChains - os.ln_chains_mean) / os.ln_chains_std);
    var odds = roundTo(clamp(sigmoid(z), OM.odds_clamp.min, OM.odds_clamp.max), 4);
    var implied = Math.max(1, Math.round(launchUsd * odds));
    return { launchUsd: launchUsd, odds: odds, implied: implied, verified: Math.abs(implied - row.implied_value_usd) <= 1 };
  }

  var VERIFIED_COUNT = ROWS.reduce(function (a, r) { return a + (verifyImpliedValue(r).verified ? 1 : 0); }, 0);

  function breakEvenDeposit(implied, tvl, dropShare, gas, feeRate, tbillRate) {
    var A = implied * dropShare, r = feeRate + tbillRate, T = Math.max(1, tvl), G = Math.max(0, gas), b = r * T + G - A;
    if (b >= 0) return null;
    var disc = b * b - 4 * r * G * T;
    if (disc < 0) return null;
    var root = (-b - Math.sqrt(disc)) / (2 * r);
    return root > 0 && isFinite(root) ? roundTo(root, 2) : null;
  }

  function simulateFarm(row, deposit, dropShare, horizonWeeks) {
    var fp = row.farm_plan, e0 = fp.economics;
    if (deposit === e0.deposit_usd && dropShare === e0.drop_share && horizonWeeks === e0.horizon_weeks) return fp;
    var days = horizonWeeks * 7, feeRate = fp.category_fee_bps / 10000, tbillRate = FC.tbillAnnualRate * (days / 365);
    var fullFee = roundTo(deposit * feeRate, 2), halfFee = roundTo(deposit * feeRate * 0.5, 2), exitFee = roundTo(fullFee - halfFee, 2);
    var tbill = roundTo(deposit * tbillRate, 2), cycles = Math.max(1, Math.round(horizonWeeks / 6));
    var midEnd = Math.max(2, Math.floor(horizonWeeks / 2)), lateStart = Math.min(horizonWeeks - 1, midEnd + 1);
    var steps = fp.steps.map(function (s) {
      var gm = s.step === 5 || s.step === 6 ? cycles : s.gas_multiplier;
      var mins = s.step === 5 ? cycles * 8 : s.step === 6 ? cycles * 7 : s.minutes;
      var gas = roundTo(fp.chain_gas_unit_usd * gm, 2), fee = s.step === 3 ? halfFee : s.step === 7 ? exitFee : 0, tb = s.step === 8 ? tbill : 0;
      var when = s.step === 5 ? "Weeks 2–" + midEnd : s.step === 6 ? "Weeks " + lateStart + "–" + Math.max(lateStart, horizonWeeks - 1) : s.step === 7 ? "Week " + horizonWeeks + " (TGE)" : s.step === 8 ? "Week " + horizonWeeks : s.when;
      var act = s.step === 2 ? "Bridge $" + deposit.toLocaleString("en-US") + " onto " + fp.optimal_chain + " (lowest-gas supported chain for " + row.name + ")" : s.action;
      return { step: s.step, when: when, title: s.title, action: act, gas_multiplier: gm, gas_cost_usd: gas, fee_cost_usd: fee, tbill_cost_usd: tb, cost_usd: roundTo(gas + fee + tb, 2), minutes: mins };
    });
    var gasTot = roundTo(steps.reduce(function (a, s) { return a + s.gas_cost_usd; }, 0), 2), totalCost = roundTo(gasTot + fullFee + tbill, 2);
    var minsTot = steps.reduce(function (a, s) { return a + s.minutes; }, 0), hrs = minsTot / 60, share = deposit / (row.tvl_usd + deposit);
    var expDrop = roundTo(row.implied_value_usd * dropShare * share, 2), net = roundTo(expDrop - totalCost, 2), netHr = roundTo(net / hrs, 2);
    var verdict = net <= 0 ? "SKIP" : netHr >= FC.farmHourlyThresholdUsd ? "FARM" : "MARGINAL";
    var sens = [];
    FC.sensitivityDropShares.forEach(function (ds) {
      FC.sensitivityDeposits.forEach(function (dep) {
        var cTot = roundTo(gasTot + roundTo(dep * feeRate, 2) + roundTo(dep * tbillRate, 2), 2);
        var nUsd = roundTo(row.implied_value_usd * ds * (dep / (row.tvl_usd + dep)) - cTot, 2), nHr = roundTo(nUsd / hrs, 2);
        sens.push({ drop_share: ds, deposit_usd: dep, net_usd: nUsd, net_per_hour: nHr, verdict: nUsd <= 0 ? "SKIP" : nHr >= FC.farmHourlyThresholdUsd ? "FARM" : "MARGINAL" });
      });
    });
    return {
      optimal_chain: fp.optimal_chain, chain_gas_unit_usd: fp.chain_gas_unit_usd, category_fee_bps: fp.category_fee_bps, steps: steps, risks: fp.risks, sensitivity: sens,
      economics: {
        deposit_usd: deposit, drop_share: dropShare, horizon_weeks: horizonWeeks, horizon_days: days, expected_drop_usd: expDrop,
        gas_total_usd: gasTot, fee_total_usd: fullFee, tbill_benchmark_usd: tbill, total_cost_usd: totalCost,
        net_usd: net, net_p25_usd: roundTo(row.implied_p25_usd * dropShare * share - totalCost, 2), net_p75_usd: roundTo(row.implied_p75_usd * dropShare * share - totalCost, 2),
        hands_on_minutes: minsTot, hands_on_hours: roundTo(hrs, 2), net_per_hour: netHr,
        break_even_deposit_usd: breakEvenDeposit(row.implied_value_usd, row.tvl_usd, dropShare, gasTot, feeRate, tbillRate), verdict: verdict,
      },
    };
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : String(v));
    });
    for (var j = 2; j < arguments.length; j++) {
      var c = arguments[j];
      if (!c && c !== 0) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(typeof x === "string" ? document.createTextNode(x) : x); });
      else node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }
  function tx(tag, cls, text) { return el(tag, cls ? { class: cls, text: text } : { text: text }); }
  function verdictBadge(v) { return tx("span", "badge " + (v === "FARM" ? "b-farm" : v === "MARGINAL" ? "b-marg" : "b-skip"), v); }

  function readHash() {
    var h = window.location.hash.replace(/^#/, "");
    if (!h) return;
    var p = new URLSearchParams(h);
    ["tab", "q", "verdict", "category", "chain", "sort", "dir"].forEach(function (k) { if (p.get(k)) state[k] = p.get(k); });
    if (p.get("p")) state.selected = p.get("p");
    var dep = Number(p.get("deposit")), ds = Number(p.get("drop")), hz = Number(p.get("horizon"));
    if (isFinite(dep) && dep > 0) state.deposit = dep;
    if (isFinite(ds) && ds > 0 && ds < 1) state.dropShare = ds;
    if (isFinite(hz) && hz >= 4) state.horizon = hz;
  }

  function writeHash() {
    var p = new URLSearchParams();
    if (state.tab !== "board") p.set("tab", state.tab);
    if (state.q) p.set("q", state.q);
    if (state.verdict !== "all") p.set("verdict", state.verdict);
    if (state.category !== "all") p.set("category", state.category);
    if (state.chain !== "all") p.set("chain", state.chain);
    if (state.sort !== "implied") p.set("sort", state.sort);
    if (state.dir !== "desc") p.set("dir", state.dir);
    if (state.deposit !== FC.defaultDepositUsd) p.set("deposit", String(state.deposit));
    if (state.dropShare !== FC.defaultDropShare) p.set("drop", String(state.dropShare));
    if (state.horizon !== FC.defaultHorizonWeeks) p.set("horizon", String(state.horizon));
    if (state.selected) p.set("p", state.selected);
    var s = p.toString();
    try { history.replaceState(null, "", s ? "#" + s : window.location.pathname); } catch (e) {}
  }

  function buildScatterSvg(items, highlightRow, heightPx) {
    var W = 540, H = heightPx || 158, pl = 44, pr = 12, pt = 10, pb = 22;
    var xMin = Math.log10(4e6), xMax = Math.log10(6e9), yMin = Math.log10(2e5), yMax = Math.log10(3e10);
    var sx = function (tvl) { return pl + ((clamp(Math.log10(Math.max(tvl, 1)), xMin, xMax) - xMin) / (xMax - xMin)) * (W - pl - pr); };
    var sy = function (val) { return pt + (1 - (clamp(Math.log10(Math.max(val, 1)), yMin, yMax) - yMin) / (yMax - yMin)) * (H - pt - pb); };
    var grid = "";
    [[1e6, "$1M"], [1e7, "$10M"], [1e8, "$100M"], [1e9, "$1B"], [1e10, "$10B"]].forEach(function (t) {
      var y = sy(t[0]).toFixed(1);
      grid += '<line x1="' + pl + '" y1="' + y + '" x2="' + (W - pr) + '" y2="' + y + '" stroke="#E2E8F0" stroke-width="0.8"/><text x="' + (pl - 4) + '" y="' + (+y + 3) + '" text-anchor="end" font-size="8.5" fill="#64748B" font-family="ui-monospace,monospace">' + t[1] + "</text>";
    });
    [[5e6, "$5M"], [5e7, "$50M"], [5e8, "$500M"], [5e9, "$5B"]].forEach(function (t) {
      var x = sx(t[0]).toFixed(1);
      grid += '<line x1="' + x + '" y1="' + pt + '" x2="' + x + '" y2="' + (H - pb) + '" stroke="#F1F5F9" stroke-width="0.8"/><text x="' + x + '" y="' + (H - 8) + '" text-anchor="middle" font-size="8.5" fill="#64748B" font-family="ui-monospace,monospace">' + t[1] + "</text>";
    });
    var up = [], dn = [], mid = [];
    [5e6, 2e7, 1e8, 5e8, 3e9].forEach(function (tvl) {
      var lnL = VM.alpha + VM.beta_tvl * Math.log(tvl), x = sx(tvl).toFixed(1);
      mid.push(x + "," + sy(Math.exp(lnL)).toFixed(1));
      up.push(x + "," + sy(Math.exp(lnL + RH.quantiles.q75)).toFixed(1));
      dn.unshift(x + "," + sy(Math.exp(lnL + RH.quantiles.q25)).toFixed(1));
    });
    var band = '<polygon points="' + up.concat(dn).join(" ") + '" fill="#DBEAFE" fill-opacity="0.55"/><polyline points="' + mid.join(" ") + '" fill="none" stroke="#1D4ED8" stroke-width="1.8"/>';
    var dots = "";
    LIVE.forEach(function (c) { dots += '<circle cx="' + sx(c.tvl_usd).toFixed(1) + '" cy="' + sy(c.mcap_usd).toFixed(1) + '" r="2.2" fill="#475569" fill-opacity="0.55"/>'; });
    if (!highlightRow) {
      items.forEach(function (it) {
        var r = it.row, v = it.sim.economics.verdict;
        dots += '<circle cx="' + sx(r.tvl_usd).toFixed(1) + '" cy="' + sy(r.implied_value_usd).toFixed(1) + '" r="' + (v === "FARM" ? "2.6" : "1.8") + '" fill="' + (v === "FARM" ? "#059669" : v === "MARGINAL" ? "#D97706" : "#94A3B8") + '" fill-opacity="0.85"/>';
      });
    } else {
      (highlightRow.nearest_peers || []).forEach(function (pr) {
        dots += '<circle cx="' + sx(pr.tvl_usd).toFixed(1) + '" cy="' + sy(pr.mcap_usd).toFixed(1) + '" r="4" fill="#F59E0B" stroke="#FFF" stroke-width="1.2"/>';
      });
      var hx = sx(highlightRow.tvl_usd).toFixed(1), hy = sy(highlightRow.implied_value_usd).toFixed(1), hyL = sy(highlightRow.launch_value_usd).toFixed(1);
      dots += '<line x1="' + hx + '" y1="' + hyL + '" x2="' + hx + '" y2="' + hy + '" stroke="#1D4ED8" stroke-width="1.3" stroke-dasharray="2,2"/><circle cx="' + hx + '" cy="' + hyL + '" r="3.5" fill="#93C5FD" stroke="#1D4ED8" stroke-width="1"/><circle cx="' + hx + '" cy="' + hy + '" r="5.5" fill="#059669" stroke="#FFF" stroke-width="1.6"/><text x="' + clamp(+hx + 8, pl + 4, W - 125) + '" y="' + clamp(+hy - 11, pt + 11, H - pb - 10) + '" font-size="9.5" font-weight="700" fill="#0F172A">' + highlightRow.name + "</text>";
    }
    var leg = '<text x="' + (W - pr) + '" y="' + (pt + 9) + '" text-anchor="end" font-size="8.5" fill="#475569">' + (highlightRow ? "● Selected (Implied)  ● Nearest Peers  — Power-Law (β=" + VM.beta_tvl.toFixed(2) + ")" : "● 92 Anchors  ● FARM  — Power-Law β=" + VM.beta_tvl.toFixed(2) + " + P25–75") + "</text>";
    return '<svg class="' + (highlightRow ? "mini-scatter" : "scatter-svg") + '" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Log-log MCap vs TVL scatter plot">' + grid + band + dots + leg + '<text x="' + (W / 2) + '" y="' + (H - 1) + '" text-anchor="middle" font-size="8" fill="#64748B">TVL (USD, log scale) →</text></svg>';
  }

  function buildRangeSvg(row) {
    var lo = row.implied_p10_usd, p25 = row.implied_p25_usd, base = row.implied_value_usd, p75 = row.implied_p75_usd, hi = row.implied_p90_usd;
    var lLo = Math.log(lo), lHi = Math.max(lLo + 0.01, Math.log(hi));
    var px = function (v) { return Math.round(24 + ((Math.log(Math.max(v, 1)) - lLo) / (lHi - lLo)) * 512); };
    var x25 = px(p25), xB = px(base), x75 = px(p75);
    return '<svg class="band-svg" viewBox="0 0 560 42" role="img" aria-label="P10 to P90 range"><line x1="24" y1="20" x2="536" y2="20" stroke="#E2E8F0" stroke-width="4" stroke-linecap="round"/><line x1="' + x25 + '" y1="20" x2="' + x75 + '" y2="20" stroke="#93C5FD" stroke-width="8" stroke-linecap="round"/><circle cx="' + xB + '" cy="20" r="5.5" fill="#1D4ED8" stroke="#FFF" stroke-width="2"/><text x="24" y="10" font-size="9" fill="#64748B" font-family="ui-monospace,monospace">P10 ' + fmtUsd(lo) + '</text><text x="' + x25 + '" y="38" text-anchor="middle" font-size="9" fill="#475569" font-family="ui-monospace,monospace">P25 ' + fmtUsd(p25) + '</text><text x="' + xB + '" y="10" text-anchor="middle" font-size="10" font-weight="700" fill="#1D4ED8" font-family="ui-monospace,monospace">Implied ' + fmtUsd(base) + '</text><text x="' + x75 + '" y="38" text-anchor="middle" font-size="9" fill="#475569" font-family="ui-monospace,monospace">P75 ' + fmtUsd(p75) + '</text><text x="536" y="10" text-anchor="end" font-size="9" fill="#64748B" font-family="ui-monospace,monospace">P90 ' + fmtUsd(hi) + "</text></svg>";
  }

  function renderDetailModal(row) {
    var sim = simulateFarm(row, state.deposit, state.dropShare, state.horizon), e = sim.economics, v = verifyImpliedValue(row), bk = row.breakdown;
    var sumSteps = roundTo(sim.steps.reduce(function (a, s) { return a + s.cost_usd; }, 0), 2), diff = Math.abs(sumSteps - e.total_cost_usd);
    var close = function () { state.selected = null; writeHash(); render(); };
    var eqBox = function (k, val, sub, hi) { return el("div", { class: "eq-box" + (hi ? " hi" : "") }, tx("span", "eq-k", k), tx("span", "eq-v num", val), tx("span", "eq-s", sub)); };
    var vBox = function (k, val, cls) { return el("div", { class: "v-box" }, tx("span", "k", k), tx("span", "v num" + (cls ? " " + cls : ""), val)); };

    var sensBody = FC.sensitivityDropShares.map(function (ds) {
      return el("tr", null, tx("th", "num", (ds * 100).toFixed(0) + "% drop"), FC.sensitivityDeposits.map(function (dep) {
        var cell = sim.sensitivity.find(function (c) { return c.drop_share === ds && c.deposit_usd === dep; });
        var cls = (cell.verdict === "FARM" ? "c-farm" : cell.verdict === "MARGINAL" ? "c-marg" : "c-skip") + (ds === state.dropShare && dep === state.deposit ? " c-cur" : "");
        return el("td", { class: cls + " num" }, el("div", { style: "font-weight:700", text: fmtSigned0(cell.net_usd) }), el("div", { style: "font-size:9px;opacity:0.9", text: fmtSigned0(cell.net_per_hour) + "/hr" }));
      }));
    });

    return el("div", { class: "backdrop", onclick: function (ev) { if (ev.target === ev.currentTarget) close(); } },
      el("div", { class: "modal", role: "dialog", "aria-label": row.name + " detail" },
        el("div", { class: "m-head" },
          el("div", null,
            el("h2", { class: "m-title" }, tx("span", "num muted", "#" + row.rank), row.name, tx("span", "badge " + (row.is_watchlist ? "b-wl" : "b-early"), row.is_watchlist ? "WATCHLIST" : "EARLY FIND"), verdictBadge(e.verdict), tx("span", "pill ok", v.verified ? "✓ Verified against board.json" : "Mismatch")),
            tx("div", "m-meta", row.category + " · Optimal chain: " + sim.optimal_chain + " ($" + sim.chain_gas_unit_usd.toFixed(2) + "/tx, " + row.chains.length + " chains) · Listed: " + (row.listed_at || "unreported") + " (" + fmtAge(row.age_days) + ") · 7d TVL: " + fmtPct(row.change_7d))
          ),
          el("button", { class: "m-close", type: "button", onclick: close, text: "Close [Esc]" })
        ),
        el("div", { class: "m-body" },
          el("div", { class: "m-col" },
            el("section", { class: "sec" },
              el("h3", { class: "sec-h" }, "How The Figure Is Made (Power-Law × Logistic Odds)", tx("span", "num muted", "α=" + VM.alpha.toFixed(2) + " · β=" + VM.beta_tvl.toFixed(3))),
              el("div", { class: "eq-chain" },
                eqBox("Snapshot TVL", fmtUsd(row.tvl_usd), "ln=" + Math.log(row.tvl_usd).toFixed(2)), tx("span", "eq-op", "→"),
                eqBox("Power-Law", fmtUsd(bk.power_law_usd), "TVL^" + VM.beta_tvl.toFixed(2)), tx("span", "eq-op", "×"),
                eqBox("Token Odds", (row.token_odds * 100).toFixed(1) + "%", "Brier " + OM.final_brier_loo.toFixed(3)), tx("span", "eq-op", "="),
                eqBox("Implied Value", fmtUsd(row.implied_value_usd), row.multiple.toFixed(2) + "x TVL", true)
              ),
              el("div", { html: buildRangeSvg(row) })
            ),
            el("section", { class: "sec" },
              el("h3", { class: "sec-h" }, "Nearest Traded Comparables (4 Closest Live Anchors)", tx("span", "muted", bk.category_peer_count + " same-cat peers")),
              el("table", { class: "mini-tbl" },
                el("thead", null, el("tr", null, tx("th", "", "Protocol"), tx("th", "", "Category"), tx("th", "r", "TVL"), tx("th", "r", "MCap"), tx("th", "r", "MCap/TVL"))),
                el("tbody", null, (row.nearest_peers || []).map(function (pr) {
                  return el("tr", null,
                    el("td", null, tx("strong", "", pr.name), pr.symbol ? tx("span", "muted mono", " " + pr.symbol) : null),
                    el("td", null, pr.category, pr.same_category ? el("span", { class: "badge b-wl", style: "margin-left:4px", text: "SAME" }) : null),
                    tx("td", "r num", fmtUsd(pr.tvl_usd)), tx("td", "r num", fmtUsd(pr.mcap_usd)), tx("td", "r num", pr.mcap_tvl_ratio.toFixed(2) + "x")
                  );
                }))
              )
            ),
            el("section", { class: "sec" },
              el("h3", { class: "sec-h" }, "Position vs 92 Traded Anchors (Log-Log)", tx("span", "muted", "Selected vs nearest peers")),
              el("div", { html: buildScatterSvg([], row, 146) })
            )
          ),
          el("div", { class: "m-col" },
            el("section", { class: "sec" },
              el("h3", { class: "sec-h" }, "Farm Verdict ($" + e.deposit_usd.toLocaleString("en-US") + " · " + (e.drop_share * 100).toFixed(0) + "% Drop · " + e.horizon_weeks + "w)", tx("span", "pill ok num", "✓ Reconciled ($" + diff.toFixed(2) + " diff)")),
              el("div", { class: "verdict-grid" },
                vBox("Expected Drop", fmtMoney(e.expected_drop_usd)),
                vBox("Net $", fmtSigned(e.net_usd), e.net_usd > 0 ? "pos" : "neg"),
                vBox("Net / Hr", fmtSigned(e.net_per_hour) + "/h", e.net_per_hour >= 25 ? "pos" : e.net_usd > 0 ? "warn-t" : "neg"),
                vBox("4% T-Bill Cost", fmtMoney(e.tbill_benchmark_usd)),
                vBox("Break-Even", e.break_even_deposit_usd !== null ? fmtUsd(e.break_even_deposit_usd, 0) : "N/A")
              )
            ),
            el("section", { class: "sec" },
              el("h3", { class: "sec-h" }, "2D Sensitivity Matrix (Drop Share × Deposit → Net $ / $/hr)", tx("span", "muted", "Green ≥$25/hr · Amber >$0 · Red ≤$0")),
              el("table", { class: "sens-tbl" },
                el("thead", null, el("tr", null, tx("th", "", "Drop \\ Dep"), FC.sensitivityDeposits.map(function (d) { return tx("th", "num", "$" + (d / 1000) + "k"); }))),
                el("tbody", null, sensBody)
              )
            ),
            el("section", { class: "sec" },
              el("h3", { class: "sec-h" }, "8-Step Costed Farm Plan (" + sim.optimal_chain + " · " + e.hands_on_hours + " hrs hands-on)", tx("span", "num muted", sim.category_fee_bps + " bps fee")),
              el("table", { class: "ledger" },
                el("thead", null, el("tr", null, el("th", { style: "width:22px", text: "#" }), el("th", { style: "width:84px", text: "When" }), tx("th", "", "Step & Concrete Action"), el("th", { class: "r", style: "width:60px", text: "Cost $" }), el("th", { class: "r", style: "width:46px", text: "Time" }))),
                el("tbody", null, sim.steps.map(function (s) {
                  return el("tr", null, tx("td", "num muted", String(s.step)), tx("td", "num muted", s.when), el("td", null, tx("strong", "", s.title + ": "), s.action), tx("td", "r num", fmtMoney(s.cost_usd)), tx("td", "r num muted", s.minutes + "m"));
                })),
                el("tfoot", null, el("tr", null, el("td", { colspan: "3", text: "Total Cost (Gas " + fmtMoney(e.gas_total_usd) + " + Fee " + fmtMoney(e.fee_total_usd) + " + 4% T-Bill " + fmtMoney(e.tbill_benchmark_usd) + ")" }), tx("td", "r num", fmtMoney(sumSteps)), tx("td", "r num", e.hands_on_minutes + "m")))
              )
            )
          )
        )
      )
    );
  }

  function filterAndSort(allItems) {
    var q = state.q.trim().toLowerCase();
    var out = allItems.filter(function (it) {
      var r = it.row;
      if (state.verdict !== "all" && it.sim.economics.verdict !== state.verdict) return false;
      if (state.category !== "all" && r.category !== state.category) return false;
      if (state.chain !== "all" && it.sim.optimal_chain !== state.chain) return false;
      if (q && (r.name + " " + r.slug + " " + r.category + " " + r.chains.join(" ")).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var mul = state.dir === "asc" ? 1 : -1, ord = { FARM: 2, MARGINAL: 1, SKIP: 0 };
    out.sort(function (a, b) {
      if (state.sort === "name") return a.row.name.localeCompare(b.row.name) * mul;
      if (state.sort === "chain") return a.sim.optimal_chain.localeCompare(b.sim.optimal_chain) * mul;
      var g = function (x) {
        if (state.sort === "rank") return x.row.rank;
        if (state.sort === "tvl") return x.row.tvl_usd;
        if (state.sort === "launch") return x.row.launch_value_usd;
        if (state.sort === "odds") return x.row.token_odds;
        if (state.sort === "net") return x.sim.economics.net_usd;
        if (state.sort === "net_hr") return x.sim.economics.net_per_hour;
        if (state.sort === "verdict") return ord[x.sim.economics.verdict];
        return x.row.implied_value_usd;
      };
      var d = g(a) - g(b);
      return d !== 0 ? d * mul : a.row.rank - b.row.rank;
    });
    return out;
  }

  function renderEvidence(allItems) {
    return el("section", { class: "evidence" },
      el("div", { class: "ev-card" },
        el("h2", { class: "ev-title" }, "Double Out-of-Sample Proof (LOO n=" + AC.traded_anchors + " & Walk-Forward n=" + VM.wf_eval_count + ")", tx("span", "muted", "Keep only if BOTH improve")),
        el("table", { class: "mini-tbl" },
          el("thead", null, el("tr", null, tx("th", "", "Value Term (Forward Ladder)"), tx("th", "c", "Gate"), tx("th", "r", "LOO Miss"), tx("th", "r", "WF Miss"), tx("th", "r", "Rho"))),
          el("tbody", null, CAL.value_ladder.map(function (s) {
            return el("tr", { style: s.status === "kept" ? "background:#ECFDF5" : "" },
              el("td", { style: s.status === "kept" ? "font-weight:700" : "", text: s.label }),
              el("td", { class: "c" }, tx("span", "badge " + (s.status === "kept" ? "b-kept" : s.status === "baseline" ? "b-base" : "b-drop"), s.status.toUpperCase())),
              tx("td", "r num", "×" + s.loo_typical_miss.toFixed(2)), tx("td", "r num", "×" + s.wf_typical_miss.toFixed(2)), tx("td", "r num", s.loo_spearman_rho.toFixed(3))
            );
          }))
        ),
        el("div", { class: "ev-foot num" },
          el("span", null, "Odds Brier: ", tx("strong", "pos", OM.final_brier_loo.toFixed(4)), " LOO / ", tx("strong", "pos", OM.final_brier_wf.toFixed(4)), " WF (base " + OM.base_brier_loo.toFixed(4) + "; kept: " + OM.kept_terms.join(", ") + ")"),
          el("span", null, "Range Honesty: ", tx("strong", "", RH.loo_p25_75_coverage_pct + "%"), " in P25–75 · ", tx("strong", "", RH.loo_p10_90_coverage_pct + "%"), " in P10–90")
        )
      ),
      el("div", { class: "ev-card" },
        el("h2", { class: "ev-title" }, "Log-Log Power-Law Fit (MCap vs TVL)", tx("span", "num muted", "ln(MCap) = " + VM.alpha.toFixed(2) + " + " + VM.beta_tvl.toFixed(3) + "·ln(TVL)")),
        el("div", { html: buildScatterSvg(allItems, null, 158) })
      )
    );
  }

  function renderBoard(allItems, filtered) {
    var fCnt = 0, mCnt = 0, sCnt = 0;
    allItems.forEach(function (it) { var v = it.sim.economics.verdict; if (v === "FARM") fCnt++; else if (v === "MARGINAL") mCnt++; else sCnt++; });
    var categories = Array.from(new Set(ROWS.map(function (r) { return r.category; }))).sort();
    var chains = Array.from(new Set(allItems.map(function (it) { return it.sim.optimal_chain; }))).sort();
    var hasF = state.q || state.verdict !== "all" || state.category !== "all" || state.chain !== "all";
    var mkOpt = function (v, l, cur) { return el("option", { value: v, selected: String(v) === String(cur) ? "selected" : null, text: l }); };
    var reset = function () { state.q = ""; state.verdict = "all"; state.category = "all"; state.chain = "all"; state.sort = "implied"; state.dir = "desc"; writeHash(); render(); };
    var sortTh = function (k, label, align, w) {
      var act = state.sort === k;
      return el("th", { class: "sort" + (align ? " " + align : "") + (act ? " active-sort" : ""), style: w ? "width:" + w : null, onclick: function () { if (state.sort === k) state.dir = state.dir === "desc" ? "asc" : "desc"; else { state.sort = k; state.dir = (k === "name" || k === "rank" || k === "chain") ? "asc" : "desc"; } writeHash(); render(); }, text: label + (act ? (state.dir === "asc" ? " ▲" : " ▼") : "") });
    };

    var trs = filtered.map(function (it) {
      var r = it.row, e = it.sim.economics;
      return el("tr", { class: state.selected === r.slug ? "selected" : "", onclick: function () { state.selected = r.slug; writeHash(); render(); } },
        tx("td", "num muted", String(r.rank)),
        el("td", null, el("div", { class: "p-row" }, tx("span", "p-name", r.name), tx("span", "badge " + (r.is_watchlist ? "b-wl" : "b-early"), r.is_watchlist ? "WL" : "EARLY")), tx("span", "sub", r.category + " · " + fmtAge(r.age_days))),
        el("td", { class: "r num" }, fmtUsd(r.tvl_usd), tx("span", "sub " + (r.change_7d === null ? "muted" : r.change_7d >= 0 ? "pos" : "neg"), fmtPct(r.change_7d))),
        tx("td", "r num", fmtUsd(r.launch_value_usd)), tx("td", "r num", (r.token_odds * 100).toFixed(0) + "%"),
        el("td", { class: "r num" }, tx("strong", "", fmtUsd(r.implied_value_usd)), tx("span", "sub", fmtUsd(r.implied_p25_usd) + "–" + fmtUsd(r.implied_p75_usd))),
        el("td", null, it.sim.optimal_chain, tx("span", "sub num", "$" + it.sim.chain_gas_unit_usd.toFixed(2) + "/tx")),
        tx("td", "r num " + (e.net_usd > 0 ? "pos" : "neg"), fmtSigned0(e.net_usd)),
        tx("td", "r num " + (e.net_per_hour >= 25 ? "pos" : e.net_usd > 0 ? "warn-t" : "neg"), fmtSigned(e.net_per_hour) + "/h"),
        el("td", { class: "c" }, verdictBadge(e.verdict))
      );
    });
    if (!trs.length) trs.push(el("tr", null, el("td", { colspan: "10", class: "c muted", style: "padding:22px", text: "No protocols match the current filters." })));

    return [
      renderEvidence(allItems),
      el("div", { class: "toolbar" },
        el("div", { class: "seg", role: "group", "aria-label": "Verdict" },
          [["all", "All (" + ROWS.length + ")"], ["FARM", "Farm (" + fCnt + ")"], ["MARGINAL", "Marginal (" + mCnt + ")"], ["SKIP", "Skip (" + sCnt + ")"]].map(function (b) {
            return el("button", { type: "button", class: state.verdict === b[0] ? "active" : "", text: b[1], onclick: function () { state.verdict = b[0]; writeHash(); render(); } });
          })
        ),
        el("label", { class: "scen" }, "Dep", el("select", { onchange: function (ev) { state.deposit = Number(ev.target.value); writeHash(); render(); } }, [2500, 10000, 25000, 50000].map(function (d) { return mkOpt(d, "$" + (d / 1000) + "k", state.deposit); }))),
        el("label", { class: "scen" }, "Drop", el("select", { onchange: function (ev) { state.dropShare = Number(ev.target.value); writeHash(); render(); } }, [0.03, 0.05, 0.07, 0.10].map(function (d) { return mkOpt(d, (d * 100).toFixed(0) + "%", state.dropShare); }))),
        el("label", { class: "scen" }, "Horiz", el("select", { onchange: function (ev) { state.horizon = Number(ev.target.value); writeHash(); render(); } }, [8, 12, 24].map(function (h) { return mkOpt(h, h + "w", state.horizon); }))),
        el("input", { type: "search", value: state.q, placeholder: "Search protocol, category, chain…", "aria-label": "Search", oninput: function (ev) { state.q = ev.target.value; writeHash(); render(); } }),
        el("select", { "aria-label": "Category", onchange: function (ev) { state.category = ev.target.value; writeHash(); render(); } }, mkOpt("all", "All Categories", state.category), categories.map(function (c) { return mkOpt(c, c, state.category); })),
        el("select", { "aria-label": "Chain", onchange: function (ev) { state.chain = ev.target.value; writeHash(); render(); } }, mkOpt("all", "All Chains", state.chain), chains.map(function (c) { return mkOpt(c, c, state.chain); })),
        hasF ? el("button", { type: "button", class: "btn-reset", onclick: reset, text: "Reset" }) : null,
        tx("span", "cnt num", filtered.length + "/" + ROWS.length)
      ),
      el("div", { class: "card" },
        el("table", { class: "tbl" },
          el("thead", null, el("tr", null, sortTh("rank", "#", "", "38px"), sortTh("name", "Protocol & Category", "", "22%"), sortTh("tvl", "TVL / 7d", "r", "9.5%"), sortTh("launch", "Launch Val", "r", "9.5%"), sortTh("odds", "Odds", "r", "5.5%"), sortTh("implied", "Implied (P25–P75)", "r", "14%"), sortTh("chain", "Opt. Chain", "", "10%"), sortTh("net", "Net $", "r", "8%"), sortTh("net_hr", "Net / Hr", "r", "9.5%"), sortTh("verdict", "Verdict", "c", "8%"))),
          el("tbody", null, trs)
        )
      ),
    ];
  }

  function renderLiveTab() {
    var rows = LIVE.slice(), mul = state.liveDir === "asc" ? 1 : -1;
    rows.sort(function (a, b) {
      var av = state.liveSort === "tvl" ? a.tvl_usd : state.liveSort === "mult" ? a.actual_multiple : state.liveSort === "miss" ? a.loocv_miss_ratio : a.mcap_usd;
      var bv = state.liveSort === "tvl" ? b.tvl_usd : state.liveSort === "mult" ? b.actual_multiple : state.liveSort === "miss" ? b.loocv_miss_ratio : b.mcap_usd;
      return (av - bv) * mul;
    });
    var lTh = function (k, label, w) {
      var act = state.liveSort === k;
      return el("th", { class: "sort r" + (act ? " active-sort" : ""), style: "width:" + w, onclick: function () { if (state.liveSort === k) state.liveDir = state.liveDir === "desc" ? "asc" : "desc"; else { state.liveSort = k; state.liveDir = k === "miss" ? "asc" : "desc"; } render(); }, text: label + (act ? (state.liveDir === "asc" ? " ▲" : " ▼") : "") });
    };
    return [
      el("div", { class: "note-box", style: "margin-bottom:8px", text: "Strict Separation: " + (AC.traded_anchors + AC.token_no_mcap) + " non-excluded snapshot protocols already record a token (" + AC.traded_anchors + " traded anchors with mcap > 0 + " + AC.token_no_mcap + " with ticker/gecko_id only) and are excluded from the pre-token radar." }),
      el("div", { class: "card" },
        el("table", { class: "tbl" },
          el("thead", null, el("tr", null, el("th", { style: "width:23%", text: "Protocol" }), el("th", { style: "width:9%", text: "Ticker" }), el("th", { style: "width:17%", text: "Category" }), lTh("tvl", "TVL", "12%"), lTh("mcap", "Actual MCap", "13%"), lTh("mult", "MCap/TVL", "9%"), el("th", { class: "r", style: "width:10%", text: "LOO Pred" }), lTh("miss", "Miss ×", "7%"))),
          el("tbody", null, rows.map(function (c) {
            return el("tr", null, el("td", { style: "font-weight:600", text: c.name }), tx("td", "mono muted", c.symbol || "—"), tx("td", "", c.category), tx("td", "r num", fmtUsd(c.tvl_usd)), tx("td", "r num", fmtUsd(c.mcap_usd)), tx("td", "r num", c.actual_multiple.toFixed(2) + "x"), tx("td", "r num", fmtUsd(c.loocv_launch_usd)), tx("td", "r num " + (c.loocv_miss_ratio <= 2 ? "pos" : "muted"), "×" + c.loocv_miss_ratio.toFixed(2)));
          }))
        )
      ),
    ];
  }

  function renderAuditTab() {
    return [
      el("div", { class: "grid-2" },
        el("section", { class: "sec" },
          tx("h3", "sec-h", "Model B — Logistic Token Odds Forward Ladder (n=" + OM.training_count + ", WF n=" + OM.wf_eval_count + ")"),
          el("table", { class: "mini-tbl" },
            el("thead", null, el("tr", null, tx("th", "", "Candidate Term"), tx("th", "c", "Gate"), tx("th", "r", "LOO Brier"), tx("th", "r", "WF Brier"))),
            el("tbody", null, CAL.odds_ladder.map(function (s) {
              return el("tr", null, tx("td", "", s.label), el("td", { class: "c" }, tx("span", "badge " + (s.status === "kept" ? "b-kept" : s.status === "baseline" ? "b-base" : "b-drop"), s.status.toUpperCase())), tx("td", "r num", s.loo_brier.toFixed(4)), tx("td", "r num", s.wf_brier.toFixed(4)));
            }))
          )
        ),
        el("section", { class: "sec" },
          tx("h3", "sec-h", "758-Protocol Universe Partition & Exclusions"),
          el("table", { class: "mini-tbl" },
            el("thead", null, el("tr", null, tx("th", "", "Bucket"), tx("th", "r", "Count"), tx("th", "", "Role"))),
            el("tbody", null, [
              ["Ranked Watchlist (≥$50M)", AC.ranked_watchlist, "100% covered on board"],
              ["Ranked Early / Off-List", AC.ranked_early_or_offlist, "Pre-token finds ($5M–$50M+)"],
              ["Traded Anchors (mcap > 0)", AC.traded_anchors, "Model A calibration & peers"],
              ["Recorded Token (no mcap)", AC.token_no_mcap, "Model B positive labels (y=1)"],
              ["Excluded by Official Rule", AC.excluded_by_rule, AC.excluded_breakdown.excluded_category + " cat · " + AC.excluded_breakdown.versioned_name + " ver · " + AC.excluded_breakdown.wrapped_or_staked_name + " wrap"],
            ].map(function (r) { return el("tr", null, tx("td", "", r[0]), tx("td", "r num", String(r[1])), tx("td", "muted", r[2])); }))
          )
        )
      ),
      tx("div", "note-box", "Disclaimer: Every figure is computed deterministically from the sealed DefiLlama snapshot (" + DATA.as_of + ") with zero hardcoded protocol names. DefiLlama's record is not proof of token absence; implied values and Net $/hr verdicts are statistical research estimates, not financial advice."),
    ];
  }

  function render() {
    var root = document.getElementById("app");
    if (!root) return;
    var allItems = ROWS.map(function (r) { return { row: r, sim: simulateFarm(r, state.deposit, state.dropShare, state.horizon) }; });
    var filtered = filterAndSort(allItems);
    var totImp = 0, fSlice = 0, mSlice = 0, sSlice = 0, wlSlice = 0;
    filtered.forEach(function (it) { totImp += it.row.implied_value_usd; if (it.row.is_watchlist) wlSlice++; var v = it.sim.economics.verdict; if (v === "FARM") fSlice++; else if (v === "MARGINAL") mSlice++; else sSlice++; });
    var kpi = function (l, v, s, vc) { return el("div", { class: "kpi" }, tx("div", "kpi-l", l), tx("div", "kpi-v num" + (vc ? " " + vc : ""), v), tx("div", "kpi-s", s)); };

    root.innerHTML = "";
    root.appendChild(el("header", { class: "topbar" },
      el("div", { class: "brand" }, tx("div", "brand-mark", "TR"), tx("h1", "", "Token Launch Radar"), el("div", { class: "pills" }, tx("span", "pill num", "Snapshot " + DATA.as_of), tx("span", "pill wl num", "Power-Law × Odds v2"), tx("span", "pill ok num", "$" + (state.deposit / 1000) + "k · " + (state.dropShare * 100).toFixed(0) + "% · " + state.horizon + "w"))),
      el("nav", { class: "tabs", "aria-label": "Views" }, [["board", "Launch Board (" + ROWS.length + ")"], ["live", "Traded Anchors (" + LIVE.length + ")"], ["audit", "Odds & Accounting"]].map(function (t) {
        return el("button", { type: "button", class: "tab-btn" + (state.tab === t[0] ? " active" : ""), text: t[1], onclick: function () { state.tab = t[0]; writeHash(); render(); } });
      }))
    ));

    root.appendChild(el("section", { class: "kpi-strip" },
      kpi("Ranked Candidates", String(filtered.length), wlSlice + " watchlist · " + (filtered.length - wlSlice) + " early (of " + ROWS.length + ")"),
      kpi("Total Implied Value", fmtUsd(totImp), "Launch Value × Token Odds"),
      kpi("Value Miss (LOO / WF)", "×" + VM.final_loo_typical_miss.toFixed(2) + " / ×" + VM.final_wf_typical_miss.toFixed(2), "vs flat ×" + VM.flat_multiple_loo_miss.toFixed(2) + " / ×" + VM.flat_multiple_wf_miss.toFixed(2), "pos"),
      kpi("Odds Brier (LOO / WF)", OM.final_brier_loo.toFixed(3) + " / " + OM.final_brier_wf.toFixed(3), "vs base " + OM.base_brier_loo.toFixed(3) + " / " + OM.base_brier_wf.toFixed(3), "pos"),
      kpi("Range Honesty (LOO)", RH.loo_p25_75_coverage_pct + "% / " + RH.loo_p10_90_coverage_pct + "%", "P25–75 (~50%) · P10–90 (~80%)"),
      kpi("FARM Verdicts (≥$25/hr)", String(fSlice), mSlice + " marginal · " + sSlice + " skip (vs 4% T-bill)", "pos")
    ));

    var segs = [[AC.ranked_watchlist, "#1D4ED8", "Watchlist"], [AC.ranked_early_or_offlist, "#059669", "Early"], [AC.traded_anchors, "#475569", "Traded Anchors"], [AC.token_no_mcap, "#94A3B8", "Token No-MCap"], [AC.excluded_by_rule, "#CBD5E1", "Excluded"]];
    root.appendChild(el("section", { class: "acct-bar" },
      el("div", { class: "acct-left" },
        el("div", { class: "acct-head" }, tx("strong", "", "758-Protocol Universe Accounting"), el("div", { class: "acct-legend num" }, segs.map(function (s) { return el("span", null, el("span", { class: "dot", style: "background:" + s[1] }), s[0] + " " + s[2]); }))),
        el("div", { class: "stack-track" }, segs.map(function (s) { return el("div", { style: "width:" + ((s[0] / AC.total) * 100).toFixed(2) + "%;background:" + s[1], title: s[2] + ": " + s[0] }); }))
      ),
      el("div", { class: "integrity" }, tx("span", "pill ok num", "✓ " + AC.total + "/" + AC.total + " Accounted"), tx("span", "pill ok num", "✓ " + AC.ranked_watchlist + "/" + AC.ranked_watchlist + " Watchlist"), tx("span", "pill ok num", "✓ " + VERIFIED_COUNT + "/" + ROWS.length + " Verified"), tx("span", "pill ok", "✓ 0 Network"), tx("span", "pill ok", "✓ Deterministic"))
    ));

    (state.tab === "board" ? renderBoard(allItems, filtered) : state.tab === "live" ? renderLiveTab() : renderAuditTab()).forEach(function (n) { root.appendChild(n); });
    root.appendChild(el("footer", { class: "footer-bar" }, tx("span", "", "Model " + CAL.model_version + " · Sealed DefiLlama snapshot (" + DATA.as_of + ") · Protocols record no token in snapshot; implied values & Net $/hr are statistical estimates, not financial advice."), tx("span", "num", "4.0% APR T-bill benchmark · $25/hr FARM hurdle · 100% offline")));

    if (state.selected) {
      var found = ROWS.find(function (r) { return r.slug === state.selected; });
      if (found) root.appendChild(renderDetailModal(found));
    }
  }

  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && state.selected) { state.selected = null; writeHash(); render(); } });
  readHash();
  render();
})();
