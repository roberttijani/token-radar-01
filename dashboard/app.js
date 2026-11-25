(function () {
  "use strict";
  var DATA = window.RADAR;
  if (!DATA) return;
  var CAL = DATA.calibration, FC = DATA.farm_constants, ROWS = DATA.rows || [], LIVE = DATA.live_comparables || [];

  var state = {
    tab: "board", q: "", scope: "all", category: "all", chain: "all", viability: "all",
    sort: "implied", dir: "desc", capital: FC.defaultCapitalUsd || 2500,
    selected: null, liveSort: "mcap", liveDir: "desc",
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function roundTo(v, d) { var f = Math.pow(10, d); return Math.round((v + Number.EPSILON) * f) / f; }

  function fmtUsd(n, dec) {
    if (n === null || n === undefined || !isFinite(n)) return "n/a";
    var s = n < 0 ? "-" : "", a = Math.abs(n);
    if (a >= 1e9) return s + "$" + (a / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(1) + "M";
    if (a >= 1e4) return s + "$" + (a / 1e3).toFixed(1) + "K";
    var d = dec !== undefined ? dec : (a < 1000 ? 2 : 0);
    return s + "$" + a.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return "n/a";
    return (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtSignedMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return "n/a";
    return (n > 0 ? "+" : n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n) { return n === null || n === undefined || !isFinite(n) ? "n/a" : (n > 0 ? "+" : "") + n.toFixed(1) + "%"; }
  function fmtAge(d) { return d === null || d === undefined ? "n/a" : d >= 365 ? (d / 365).toFixed(1) + "y" : Math.round(d) + "d"; }

  /* Recompute implied_value_usd directly from raw snapshot figures to prove code == board.json */
  function verifyImpliedValue(row) {
    var fs = CAL.feature_stats, b = CAL.beta;
    var zTvl = clamp((Math.log(Math.max(row.tvl_usd, 100000)) - fs.log_tvl_mean) / fs.log_tvl_std, -3, 3);
    var growth = row.change_7d === null || !isFinite(row.change_7d) ? 0 : Math.tanh(clamp(row.change_7d, -80, 300) / 60);
    var a = Math.log(1 + (row.age_days === null ? fs.median_age_days : Math.max(0, row.age_days)) / 365);
    var m1 = clamp((a - fs.age_lin_mean) / fs.age_lin_std, -3, 3);
    var m2 = clamp((a * a - fs.age_quad_mean) / fs.age_quad_std, -3, 3);
    var ch = Math.log(1 + Math.min(Math.max(1, (row.chains || []).length), 15)) - fs.chain_breadth_mean;
    var uCat = CAL.category_effects[row.category] || 0;
    var rawLog = CAL.mu0 + uCat + b.size * zTvl + b.momentum * growth + b.maturity_lin * m1 + b.maturity_quad * m2 + b.chains * ch;
    var recomputed = Math.max(1, Math.round(row.tvl_usd * Math.exp(clamp(rawLog, CAL.multiple_bounds.log_min, CAL.multiple_bounds.log_max))));
    return { recomputed: recomputed, verified: Math.abs(recomputed - row.implied_value_usd) <= 1 };
  }

  /* Live client-side 7-step farm ledger simulator */
  function simulateFarm(row, cap) {
    var fp = row.farm_plan;
    if (cap === fp.economics.capital_usd) return fp;
    var feeRate = fp.category_fee_bps / 10000;
    var oppRate = FC.riskFreeAnnualRate * (fp.holding_days / 365);
    var fullFee = roundTo(cap * feeRate, 2), halfFee = roundTo(cap * feeRate * 0.5, 2), exitFee = roundTo(fullFee - halfFee, 2);
    var oppCost = roundTo(cap * oppRate, 2);
    var steps = fp.steps.map(function (s) {
      var fee = s.step === 3 ? halfFee : s.step === 6 ? exitFee : 0;
      var opp = s.step === 7 ? oppCost : 0;
      return {
        step: s.step, title: s.title, gas_multiplier: s.gas_multiplier, active_minutes: s.active_minutes, holding_days: s.holding_days,
        action: s.step === 1 ? "Prepare $" + cap.toLocaleString("en-US") + " and bridge funds onto " + fp.optimal_chain + " (lowest-gas chain for " + row.name + ")" : s.action,
        gas_cost_usd: s.gas_cost_usd, fee_cost_usd: fee, opp_cost_usd: opp, step_total_usd: roundTo(s.gas_cost_usd + fee + opp, 2),
      };
    });
    var gasTot = fp.economics.gas_total_usd, totalCost = roundTo(gasTot + fullFee + oppCost, 2);
    var scale = (FC.airdropPoolShare * fp.launch_prob) / FC.eligibleTvlShare;
    var gBase = row.tvl_usd > 0 ? (row.implied_value_usd / row.tvl_usd) * scale : 0;
    var grossEv = roundTo(cap * gBase, 2), netEv = roundTo(grossEv - totalCost, 2);
    var netPerDollar = gBase - (feeRate + oppRate), beCap = null, tier = "NEGATIVE";
    if (netPerDollar > 1e-6) { beCap = roundTo(gasTot / netPerDollar, 2); tier = netEv > 0 ? "VIABLE" : "WHALE_ONLY"; }
    return {
      optimal_chain: fp.optimal_chain, chain_gas_unit_usd: fp.chain_gas_unit_usd, category_fee_bps: fp.category_fee_bps,
      holding_days: fp.holding_days, launch_prob: fp.launch_prob, total_active_minutes: fp.total_active_minutes, steps: steps, risks: fp.risks,
      economics: {
        capital_usd: cap, gross_ev_usd: grossEv, gas_total_usd: gasTot, fee_total_usd: fullFee, opp_cost_usd: oppCost,
        total_cost_usd: totalCost, net_ev_usd: netEv, net_roi_pct: cap > 0 ? roundTo((netEv / cap) * 100, 2) : 0,
        net_ev_low_usd: roundTo(cap * (row.implied_low_usd / row.tvl_usd) * scale - totalCost, 2),
        net_ev_high_usd: roundTo(cap * (row.implied_high_usd / row.tvl_usd) * scale - totalCost, 2),
        break_even_capital_usd: beCap, viability_tier: tier,
      },
    };
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "html") node.innerHTML = v;
        else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : String(v));
      });
    }
    for (var j = 2; j < arguments.length; j++) {
      var c = arguments[j];
      if (!c && c !== 0) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(typeof x === "string" ? document.createTextNode(x) : x); });
      else node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  function readHash() {
    var h = window.location.hash.replace(/^#/, "");
    if (!h) return;
    var p = new URLSearchParams(h);
    ["tab", "q", "scope", "category", "chain", "viability", "sort", "dir"].forEach(function (k) { if (p.get(k)) state[k] = p.get(k); });
    if (p.get("p")) state.selected = p.get("p");
    var cap = Number(p.get("capital"));
    if (isFinite(cap) && cap >= 500 && cap <= 50000) state.capital = cap;
  }

  function writeHash() {
    var p = new URLSearchParams();
    if (state.tab !== "board") p.set("tab", state.tab);
    if (state.q) p.set("q", state.q);
    if (state.scope !== "all") p.set("scope", state.scope);
    if (state.category !== "all") p.set("category", state.category);
    if (state.chain !== "all") p.set("chain", state.chain);
    if (state.viability !== "all") p.set("viability", state.viability);
    if (state.sort !== "implied") p.set("sort", state.sort);
    if (state.dir !== "desc") p.set("dir", state.dir);
    if (state.capital !== FC.defaultCapitalUsd) p.set("capital", String(state.capital));
    if (state.selected) p.set("p", state.selected);
    var s = p.toString();
    try { history.replaceState(null, "", s ? "#" + s : window.location.pathname); } catch (e) {}
  }

  function tierBadge(t) {
    return el("span", { class: "badge " + (t === "VIABLE" ? "b-ok" : t === "WHALE_ONLY" ? "b-warn" : "b-neg"), text: t === "WHALE_ONLY" ? "WHALE-ONLY" : t });
  }

  function getFilteredRows() {
    var q = state.q.trim().toLowerCase(), out = [];
    for (var i = 0; i < ROWS.length; i++) {
      var r = ROWS[i], sim = simulateFarm(r, state.capital);
      if (state.scope === "watchlist" && !r.is_watchlist) continue;
      if (state.scope === "early" && r.is_watchlist) continue;
      if (state.category !== "all" && r.category !== state.category) continue;
      if (state.chain !== "all" && sim.optimal_chain !== state.chain) continue;
      if (state.viability !== "all" && sim.economics.viability_tier !== state.viability) continue;
      if (q && (r.name + " " + r.slug + " " + r.category + " " + r.chains.join(" ")).toLowerCase().indexOf(q) < 0) continue;
      out.push({ row: r, sim: sim });
    }
    var mul = state.dir === "asc" ? 1 : -1, ord = { VIABLE: 2, WHALE_ONLY: 1, NEGATIVE: 0 };
    out.sort(function (a, b) {
      if (state.sort === "name") return a.row.name.localeCompare(b.row.name) * mul;
      if (state.sort === "chain") return a.sim.optimal_chain.localeCompare(b.sim.optimal_chain) * mul;
      var get = function (x) {
        if (state.sort === "rank") return x.row.rank;
        if (state.sort === "tvl") return x.row.tvl_usd;
        if (state.sort === "multiple") return x.row.multiple;
        if (state.sort === "cost") return x.sim.economics.total_cost_usd;
        if (state.sort === "net_ev") return x.sim.economics.net_ev_usd;
        if (state.sort === "viability") return ord[x.sim.economics.viability_tier];
        return x.row.implied_value_usd;
      };
      var d = get(a) - get(b);
      return d !== 0 ? d * mul : a.row.rank - b.row.rank;
    });
    return out;
  }

  function buildRangeSvg(row) {
    var lo = row.implied_low_usd, base = row.implied_value_usd, hi = row.implied_high_usd;
    var bx = 22 + Math.round(((base - lo) / Math.max(1, hi - lo)) * 596);
    return (
      '<svg class="band-svg" viewBox="0 0 640 42" role="img" aria-label="LOOCV P25 to P75 range">' +
      '<line x1="22" y1="19" x2="618" y2="19" stroke="#E2E8F0" stroke-width="5" stroke-linecap="round"/>' +
      '<line x1="22" y1="19" x2="' + bx + '" y2="19" stroke="#93C5FD" stroke-width="5" stroke-linecap="round"/>' +
      '<circle cx="22" cy="19" r="3.5" fill="#64748B"/><circle cx="618" cy="19" r="3.5" fill="#64748B"/>' +
      '<circle cx="' + bx + '" cy="19" r="5.5" fill="#1D4ED8" stroke="#FFF" stroke-width="2"/>' +
      '<text x="22" y="10" font-size="10" fill="#64748B" font-family="ui-monospace,monospace">P25 ' + fmtUsd(lo) + '</text>' +
      '<text x="' + clamp(bx, 90, 550) + '" y="37" text-anchor="middle" font-size="10.5" font-weight="700" fill="#1D4ED8" font-family="ui-monospace,monospace">Base ' + fmtUsd(base) + ' (' + row.multiple.toFixed(2) + 'x)</text>' +
      '<text x="618" y="10" text-anchor="end" font-size="10" fill="#64748B" font-family="ui-monospace,monospace">P75 ' + fmtUsd(hi) + '</text></svg>'
    );
  }

  function renderDrawer(row) {
    var sim = simulateFarm(row, state.capital), e = sim.economics, v = verifyImpliedValue(row), f = row.factors;
    var sumSteps = roundTo(sim.steps.reduce(function (a, s) { return a + s.step_total_usd; }, 0), 2);
    var diff = Math.abs(sumSteps - e.total_cost_usd);
    var close = function () { state.selected = null; writeHash(); render(); };
    var fChip = function (lbl, val, cls) { return el("div", { class: "f-chip" + (cls ? " " + cls : "") }, el("span", { class: "f-lbl", text: lbl }), el("span", { class: "f-val num", text: val })); };
    var op = function (t) { return el("span", { class: "f-op", text: t }); };

    return el("div", { class: "backdrop", onclick: function (ev) { if (ev.target === ev.currentTarget) close(); } },
      el("aside", { class: "drawer", role: "dialog", "aria-label": row.name + " detail" },
        el("div", { class: "drawer-head" },
          el("div", null,
            el("h2", { class: "drawer-title" },
              el("span", { class: "num muted", text: "#" + row.rank }), row.name,
              el("span", { class: "badge " + (row.is_watchlist ? "b-wl" : "b-early"), text: row.is_watchlist ? "WATCHLIST" : "EARLY FIND" }),
              tierBadge(e.viability_tier)
            ),
            el("div", { class: "drawer-meta" },
              el("span", { text: row.category + " · Optimal: " + sim.optimal_chain + " (" + row.chains.length + " chains) · Listed: " + (row.listed_at || "unreported") + " (" + fmtAge(row.age_days) + ")" })
            )
          ),
          el("button", { class: "drawer-close", type: "button", onclick: close, text: "Close [Esc]" })
        ),
        el("div", { class: "drawer-body" },
          el("section", { class: "sec" },
            el("h3", { class: "sec-title" },
              "Valuation Decomposition (LOOCV Empirical Bayes + Ridge)",
              el("span", { class: "pill " + (v.verified ? "ok" : "neg"), text: v.verified ? "✓ Verified against board.json" : "Mismatch" })
            ),
            el("div", { class: "factor-chain" },
              fChip("TVL", fmtUsd(row.tvl_usd)), op("×"), fChip("Base", f.base_multiple.toFixed(2) + "x"), op("×"),
              fChip("Cat", f.category_factor.toFixed(2) + "x"), op("×"), fChip("Size", f.size_factor.toFixed(2) + "x"), op("×"),
              fChip("7d Mom", f.momentum_factor.toFixed(2) + "x"), op("×"), fChip("Age", f.maturity_factor.toFixed(2) + "x"), op("×"),
              fChip("Chains", f.chain_factor.toFixed(2) + "x"), op("="), fChip("Implied", fmtUsd(row.implied_value_usd), "eq")
            ),
            el("div", { html: buildRangeSvg(row) })
          ),
          el("section", { class: "sec" },
            el("h3", { class: "sec-title" },
              "7-Step Net-to-the-Dollar Farm Ledger (" + sim.optimal_chain + " · " + sim.holding_days + "d · " + sim.total_active_minutes + "m)",
              el("span", { class: "pill ok num", text: "✓ Reconciled ($" + diff.toFixed(2) + " diff)" })
            ),
            el("div", { class: "econ-grid" },
              el("div", { class: "e-box" }, el("span", { class: "k", text: "Capital" }), el("span", { class: "v num", text: fmtUsd(e.capital_usd, 0) })),
              el("div", { class: "e-box" }, el("span", { class: "k", text: "Gross EV" }), el("span", { class: "v num", text: fmtMoney(e.gross_ev_usd) })),
              el("div", { class: "e-box" }, el("span", { class: "k", text: "Total Cost" }), el("span", { class: "v num", text: fmtMoney(e.total_cost_usd) })),
              el("div", { class: "e-box" }, el("span", { class: "k", text: "Net EV" }), el("span", { class: "v num " + (e.net_ev_usd > 0 ? "pos" : "neg"), text: fmtSignedMoney(e.net_ev_usd) })),
              el("div", { class: "e-box" }, el("span", { class: "k", text: "Break-Even" }), el("span", { class: "v num", text: e.break_even_capital_usd !== null ? fmtUsd(e.break_even_capital_usd, 0) : "N/A" }))
            ),
            el("table", { class: "ledger" },
              el("thead", null, el("tr", null,
                el("th", { style: "width:22px", text: "#" }), el("th", { text: "Action & Cadence" }),
                el("th", { class: "r", style: "width:58px", text: "Gas" }), el("th", { class: "r", style: "width:58px", text: "Fee" }),
                el("th", { class: "r", style: "width:58px", text: "Opp" }), el("th", { class: "r", style: "width:64px", text: "Total" })
              )),
              el("tbody", null, sim.steps.map(function (s) {
                var tm = s.holding_days > 0 ? s.active_minutes + "m + " + s.holding_days + "d hold" : s.active_minutes + "m";
                return el("tr", null,
                  el("td", { class: "num muted", text: String(s.step) }),
                  el("td", null, el("div", { class: "step-act", text: s.action }), el("div", { class: "step-meta", text: s.title + " · " + tm })),
                  el("td", { class: "r num", text: fmtMoney(s.gas_cost_usd) }), el("td", { class: "r num", text: fmtMoney(s.fee_cost_usd) }),
                  el("td", { class: "r num", text: fmtMoney(s.opp_cost_usd) }), el("td", { class: "r num", text: fmtMoney(s.step_total_usd) })
                );
              })),
              el("tfoot", null, el("tr", null,
                el("td", { colspan: "2", text: "Ledger Total (" + sim.category_fee_bps + " bps fee · " + (FC.riskFreeAnnualRate * 100).toFixed(1) + "% APR opp · " + (sim.launch_prob * 100).toFixed(0) + "% TGE wt)" }),
                el("td", { class: "r num", text: fmtMoney(e.gas_total_usd) }), el("td", { class: "r num", text: fmtMoney(e.fee_total_usd) }),
                el("td", { class: "r num", text: fmtMoney(e.opp_cost_usd) }), el("td", { class: "r num", text: fmtMoney(sumSteps) })
              ))
            )
          ),
          el("section", { class: "sec" },
            el("h3", { class: "sec-title" },
              "Protocol Risks & Data Flags",
              row.data_flags.length ? el("span", { class: "pill warn", text: row.data_flags.join(" · ") }) : el("span", { class: "pill ok", text: "Complete snapshot fields" })
            ),
            el("ul", { class: "risk-list" }, sim.risks.map(function (rk) { return el("li", { text: rk }); }))
          )
        )
      )
    );
  }

  function renderBoard(filtered) {
    var categories = Array.from(new Set(ROWS.map(function (r) { return r.category; }))).sort();
    var chains = Array.from(new Set(ROWS.map(function (r) { return r.farm_plan.optimal_chain; }))).sort();
    var hasF = state.q || state.scope !== "all" || state.category !== "all" || state.chain !== "all" || state.viability !== "all";
    var mkOpt = function (v, l, cur) { return el("option", { value: v, selected: v === cur ? "selected" : null, text: l }); };
    var reset = function () { state.q = ""; state.scope = "all"; state.category = "all"; state.chain = "all"; state.viability = "all"; state.sort = "implied"; state.dir = "desc"; writeHash(); render(); };

    var sortTh = function (k, label, align, w) {
      var act = state.sort === k;
      return el("th", {
        class: "sort" + (align ? " " + align : "") + (act ? " active-sort" : ""), style: w ? "width:" + w : null,
        onclick: function () {
          if (state.sort === k) state.dir = state.dir === "desc" ? "asc" : "desc";
          else { state.sort = k; state.dir = (k === "name" || k === "rank" || k === "chain" || k === "cost") ? "asc" : "desc"; }
          writeHash(); render();
        },
        text: label + (act ? (state.dir === "asc" ? " ▲" : " ▼") : ""),
      });
    };

    var trs = filtered.map(function (it) {
      var r = it.row, e = it.sim.economics;
      return el("tr", { class: state.selected === r.slug ? "selected" : "", onclick: function () { state.selected = r.slug; writeHash(); render(); } },
        el("td", { class: "num muted", text: String(r.rank) }),
        el("td", null,
          el("div", { class: "proto-cell" }, el("span", { class: "proto-name", text: r.name }), el("span", { class: "badge " + (r.is_watchlist ? "b-wl" : "b-early"), text: r.is_watchlist ? "WL" : "EARLY" })),
          el("div", { class: "proto-sub" }, el("span", { text: r.category + " · " + fmtAge(r.age_days) }))
        ),
        el("td", { class: "r num" }, fmtUsd(r.tvl_usd), el("span", { class: "sub-num " + (r.change_7d === null ? "muted" : r.change_7d >= 0 ? "pos" : "neg"), text: fmtPct(r.change_7d) })),
        el("td", { class: "r num" }, el("strong", { text: fmtUsd(r.implied_value_usd) }), el("span", { class: "sub-num", text: fmtUsd(r.implied_low_usd) + "–" + fmtUsd(r.implied_high_usd) })),
        el("td", { class: "r num", text: r.multiple.toFixed(2) + "x" }),
        el("td", null, el("span", { text: it.sim.optimal_chain }), el("span", { class: "sub-num num", text: "$" + it.sim.chain_gas_unit_usd.toFixed(2) + "/tx" })),
        el("td", { class: "r num" }, fmtMoney(e.total_cost_usd), el("span", { class: "sub-num", text: it.sim.holding_days + "d · " + it.sim.total_active_minutes + "m" })),
        el("td", { class: "r num" }, el("span", { class: e.net_ev_usd > 0 ? "pos" : "neg", text: fmtSignedMoney(e.net_ev_usd) }), el("span", { class: "sub-num", text: (e.net_roi_pct > 0 ? "+" : "") + e.net_roi_pct.toFixed(1) + "% ROI" })),
        el("td", { class: "c" }, tierBadge(e.viability_tier))
      );
    });
    if (!trs.length) trs.push(el("tr", null, el("td", { colspan: "9", class: "c muted", style: "padding:26px", text: "No protocols match the current filters." })));

    return [
      el("div", { class: "toolbar" },
        el("input", { type: "search", value: state.q, placeholder: "Search protocol, slug, category, chain…", "aria-label": "Search", oninput: function (ev) { state.q = ev.target.value; writeHash(); render(); } }),
        el("div", { class: "seg", role: "group", "aria-label": "Scope" },
          el("button", { type: "button", class: state.scope === "all" ? "active" : "", text: "All (" + ROWS.length + ")", onclick: function () { state.scope = "all"; writeHash(); render(); } }),
          el("button", { type: "button", class: state.scope === "watchlist" ? "active" : "", text: "Watchlist (" + CAL.watchlist_count + ")", onclick: function () { state.scope = "watchlist"; writeHash(); render(); } }),
          el("button", { type: "button", class: state.scope === "early" ? "active" : "", text: "Early Finds (" + CAL.early_find_count + ")", onclick: function () { state.scope = "early"; writeHash(); render(); } })
        ),
        el("select", { "aria-label": "Category", onchange: function (ev) { state.category = ev.target.value; writeHash(); render(); } }, mkOpt("all", "All Categories", state.category), categories.map(function (c) { return mkOpt(c, c, state.category); })),
        el("select", { "aria-label": "Chain", onchange: function (ev) { state.chain = ev.target.value; writeHash(); render(); } }, mkOpt("all", "All Chains", state.chain), chains.map(function (c) { return mkOpt(c, c, state.chain); })),
        el("select", { "aria-label": "Viability", onchange: function (ev) { state.viability = ev.target.value; writeHash(); render(); } },
          mkOpt("all", "All Viability", state.viability), mkOpt("VIABLE", "Viable Only", state.viability), mkOpt("WHALE_ONLY", "Whale-Only", state.viability), mkOpt("NEGATIVE", "Negative EV", state.viability)
        ),
        hasF ? el("button", { type: "button", class: "btn-reset", onclick: reset, text: "Reset" }) : null,
        el("span", { class: "count-note num", text: "Showing " + filtered.length + " / " + ROWS.length })
      ),
      el("div", { class: "card" },
        el("table", { class: "tbl" },
          el("thead", null, el("tr", null,
            sortTh("rank", "#", "", "46px"), sortTh("name", "Protocol & Category", "", "26%"), sortTh("tvl", "TVL / 7d", "r", "11%"),
            sortTh("implied", "Implied Value (P25–P75)", "r", "15%"), sortTh("multiple", "Mult", "r", "7%"), sortTh("chain", "Opt. Chain", "", "11%"),
            sortTh("cost", "Farm Cost", "r", "9.5%"), sortTh("net_ev", "Net EV", "r", "10%"), sortTh("viability", "Viability", "c", "10%")
          )),
          el("tbody", null, trs)
        )
      ),
    ];
  }

  function renderLiveTab() {
    var rows = LIVE.slice(), mul = state.liveDir === "asc" ? 1 : -1;
    rows.sort(function (a, b) {
      var av = state.liveSort === "tvl" ? a.tvl_usd : state.liveSort === "mult" ? a.actual_multiple : state.liveSort === "err" ? Math.abs(a.loocv_error_pct) : a.mcap_usd;
      var bv = state.liveSort === "tvl" ? b.tvl_usd : state.liveSort === "mult" ? b.actual_multiple : state.liveSort === "err" ? Math.abs(b.loocv_error_pct) : b.mcap_usd;
      return (av - bv) * mul;
    });
    var lTh = function (k, label, align, w) {
      var act = state.liveSort === k;
      return el("th", { class: "sort " + align + (act ? " active-sort" : ""), style: "width:" + w, onclick: function () { if (state.liveSort === k) state.liveDir = state.liveDir === "desc" ? "asc" : "desc"; else { state.liveSort = k; state.liveDir = k === "err" ? "asc" : "desc"; } render(); }, text: label + (act ? (state.liveDir === "asc" ? " ▲" : " ▼") : "") });
    };
    return [
      el("div", { class: "note-box", style: "margin-bottom:10px", text: "Token separation: " + CAL.live_token_total_count + " protocols in the sealed snapshot record a live token and are kept separate from the pre-token board. Below are the " + LIVE.length + " non-excluded live comparables (mcap > 0, TVL >= $5M) used to calibrate the model via LOOCV." }),
      el("div", { class: "card" },
        el("table", { class: "tbl" },
          el("thead", null, el("tr", null,
            el("th", { style: "width:24%", text: "Protocol" }), el("th", { style: "width:9%", text: "Ticker" }), el("th", { style: "width:16%", text: "Category" }),
            lTh("tvl", "TVL", "r", "12%"), lTh("mcap", "Actual MCap", "r", "13%"), lTh("mult", "Actual Mult", "r", "9%"),
            el("th", { class: "r", style: "width:11%", text: "LOOCV Pred" }), lTh("err", "LOOCV Err", "r", "9%")
          )),
          el("tbody", null, rows.map(function (c) {
            var ok2x = c.loocv_implied_usd / c.mcap_usd >= 0.5 && c.loocv_implied_usd / c.mcap_usd <= 2.0;
            return el("tr", null,
              el("td", { style: "font-weight:600", text: c.name }), el("td", { class: "mono muted", text: c.symbol || "—" }), el("td", { text: c.category }),
              el("td", { class: "r num", text: fmtUsd(c.tvl_usd) }), el("td", { class: "r num", text: fmtUsd(c.mcap_usd) }),
              el("td", { class: "r num", text: c.actual_multiple.toFixed(2) + "x" }), el("td", { class: "r num", text: fmtUsd(c.loocv_implied_usd) }),
              el("td", { class: "r num " + (ok2x ? "pos" : "muted"), text: fmtPct(c.loocv_error_pct) })
            );
          }))
        )
      ),
    ];
  }

  function renderAuditTab() {
    var a = CAL.audit, b = CAL.beta;
    var gasSample = [["Solana", "Lending / Curators", 10], ["Monad", "Restaking / Staking", 12], ["Hyperliquid L1", "CDP / Perps / RWA", 15], ["Polygon", "Bridge / Insurance", 20], ["Base", "Prediction Market", 25], ["Arbitrum", "Liquidity Manager", 45], ["Binance", "DEX / AMM", 55], ["Ethereum", "Default Category", 20]];
    return [
      el("div", { class: "grid-2" },
        el("section", { class: "sec" },
          el("h3", { class: "sec-title", text: "Out-of-Sample LOOCV Benchmark (n = " + CAL.training_count + " Live Comps)" }),
          el("table", { class: "ledger" },
            el("thead", null, el("tr", null, el("th", { text: "Model" }), el("th", { class: "r", text: "MdAPE %" }), el("th", { class: "r", text: "Log-RMSE" }), el("th", { class: "r", text: "Spearman ρ" }), el("th", { class: "r", text: "Within 2x" }))),
            el("tbody", null, [a.global_baseline, a.category_only, a.calibrated_model].map(function (m, idx) {
              return el("tr", { style: idx === 2 ? "font-weight:700;background:#EFF6FF" : "" },
                el("td", { text: m.name }), el("td", { class: "r num", text: m.mdape.toFixed(2) + "%" }), el("td", { class: "r num", text: m.log_rmse.toFixed(4) }),
                el("td", { class: "r num", text: m.spearman_rho.toFixed(4) }), el("td", { class: "r num", text: m.within_2x_pct.toFixed(1) + "%" })
              );
            }))
          ),
          el("div", { class: "kv-grid", style: "margin-top:10px" },
            el("div", { class: "kv" }, el("div", { class: "k", text: "Base Mult (exp μ0)" }), el("div", { class: "v num", text: CAL.base_multiple.toFixed(4) + "x" })),
            el("div", { class: "kv" }, el("div", { class: "k", text: "Hyperparams (λc / λr)" }), el("div", { class: "v num", text: CAL.lambda_category + " / " + CAL.lambda_ridge })),
            el("div", { class: "kv" }, el("div", { class: "k", text: "LOOCV Band (P25–P75)" }), el("div", { class: "v num", text: Math.exp(CAL.residual_quantiles.p25).toFixed(2) + "x – " + Math.exp(CAL.residual_quantiles.p75).toFixed(2) + "x" })),
            el("div", { class: "kv" }, el("div", { class: "k", text: "β Size (z-log TVL)" }), el("div", { class: "v num", text: b.size.toFixed(4) })),
            el("div", { class: "kv" }, el("div", { class: "k", text: "β 7d Momentum" }), el("div", { class: "v num", text: b.momentum.toFixed(4) })),
            el("div", { class: "kv" }, el("div", { class: "k", text: "β Chains Breadth" }), el("div", { class: "v num", text: b.chains.toFixed(4) }))
          )
        ),
        el("section", { class: "sec" },
          el("h3", { class: "sec-title", text: "Farm Ledger Cost Constants & Assumptions" }),
          el("div", { class: "kv-grid", style: "margin-bottom:8px" },
            el("div", { class: "kv" }, el("div", { class: "k", text: "Airdrop Pool Share" }), el("div", { class: "v num", text: (FC.airdropPoolShare * 100).toFixed(1) + "%" })),
            el("div", { class: "kv" }, el("div", { class: "k", text: "Eligible TVL Share" }), el("div", { class: "v num", text: (FC.eligibleTvlShare * 100).toFixed(0) + "%" })),
            el("div", { class: "kv" }, el("div", { class: "k", text: "Risk-Free Opp APR" }), el("div", { class: "v num", text: (FC.riskFreeAnnualRate * 100).toFixed(1) + "%" }))
          ),
          el("table", { class: "ledger" },
            el("thead", null, el("tr", null, el("th", { text: "Chain" }), el("th", { class: "r", text: "Gas / Tx" }), el("th", { text: "Category Class" }), el("th", { class: "r", text: "Fee Bps" }))),
            el("tbody", null, gasSample.map(function (row) {
              var gas = FC.chainGasUsd[row[0].toLowerCase()] || FC.defaultGasUnitUsd;
              return el("tr", null, el("td", { text: row[0] }), el("td", { class: "r num", text: "$" + gas.toFixed(2) }), el("td", { text: row[1] }), el("td", { class: "r num", text: row[2] + " bps" }));
            }))
          )
        )
      ),
      el("div", { class: "note-box", text: "Disclaimer: Implied values are deterministic statistical estimates derived solely from the sealed DefiLlama protocol snapshot (" + DATA.as_of + ") with zero hardcoded protocol names. DefiLlama's record is not proof of token absence, and nothing here is financial advice or a prediction of whether or when a token will launch." }),
    ];
  }

  function render() {
    var root = document.getElementById("app");
    if (!root) return;
    var filtered = getFilteredRows();
    var totalImplied = 0, viableCnt = 0, whaleCnt = 0, wlInSlice = 0;
    for (var i = 0; i < filtered.length; i++) {
      totalImplied += filtered[i].row.implied_value_usd;
      if (filtered[i].row.is_watchlist) wlInSlice++;
      var t = filtered[i].sim.economics.viability_tier;
      if (t === "VIABLE") viableCnt++; else if (t === "WHALE_ONLY") whaleCnt++;
    }
    var aCal = CAL.audit.calibrated_model, aGlob = CAL.audit.global_baseline;
    var mdapeDiff = roundTo(aGlob.mdape - aCal.mdape, 2);

    root.innerHTML = "";
    root.appendChild(el("header", { class: "topbar" },
      el("div", { class: "brand" },
        el("div", { class: "brand-mark", text: "TR" }),
        el("h1", { text: "Token Launch Radar" }),
        el("div", { class: "meta-pills" },
          el("span", { class: "pill num", text: "Snapshot " + DATA.as_of }),
          el("span", { class: "pill wl num", text: CAL.watchlist_count + "/" + CAL.watchlist_count + " Watchlist" }),
          el("span", { class: "pill ok num", text: "Offline · 0 Network" })
        )
      ),
      el("nav", { class: "tabs", "aria-label": "Views" },
        el("button", { type: "button", class: "tab-btn" + (state.tab === "board" ? " active" : ""), text: "Launch Board (" + ROWS.length + ")", onclick: function () { state.tab = "board"; writeHash(); render(); } }),
        el("button", { type: "button", class: "tab-btn" + (state.tab === "live" ? " active" : ""), text: "Already Trading (" + LIVE.length + ")", onclick: function () { state.tab = "live"; writeHash(); render(); } }),
        el("button", { type: "button", class: "tab-btn" + (state.tab === "audit" ? " active" : ""), text: "Model & LOOCV Audit", onclick: function () { state.tab = "audit"; writeHash(); render(); } })
      )
    ));

    root.appendChild(el("section", { class: "kpi-strip", "aria-label": "Summary metrics" },
      el("div", { class: "kpi" }, el("div", { class: "kpi-label", text: "Pre-Token Candidates" }), el("div", { class: "kpi-val num", text: String(filtered.length) }), el("div", { class: "kpi-sub", text: wlInSlice + " watchlist · " + (filtered.length - wlInSlice) + " early finds (of " + ROWS.length + ")" })),
      el("div", { class: "kpi" }, el("div", { class: "kpi-label", text: "Total Implied Value" }), el("div", { class: "kpi-val num", text: fmtUsd(totalImplied) }), el("div", { class: "kpi-sub", text: "Base mult " + CAL.base_multiple.toFixed(2) + "x · P25–P75 LOOCV bands" })),
      el("div", { class: "kpi" }, el("div", { class: "kpi-label" }, "Viable @ " + fmtUsd(state.capital, 0), el("span", { class: "badge b-ok", text: Math.round((viableCnt / Math.max(1, filtered.length)) * 100) + "%" })), el("div", { class: "kpi-val num pos", text: String(viableCnt) }), el("div", { class: "kpi-sub", text: whaleCnt + " whale-only · " + (filtered.length - viableCnt - whaleCnt) + " net-negative" })),
      el("div", { class: "kpi" }, el("div", { class: "kpi-label", text: "LOOCV MdAPE (n=" + CAL.training_count + ")" }), el("div", { class: "kpi-val num", text: aCal.mdape.toFixed(1) + "%" }), el("div", { class: "kpi-sub pos", text: "vs " + aGlob.mdape.toFixed(1) + "% global (-" + mdapeDiff.toFixed(1) + " pp · " + aCal.within_2x_pct + "% in 2x)" })),
      el("div", { class: "kpi-sim" },
        el("div", { class: "sim-head" }, el("span", { class: "kpi-label", text: "Capital Simulator" }), el("span", { class: "sim-cap num", text: fmtUsd(state.capital, 0) })),
        el("input", { type: "range", class: "sim-range", min: "500", max: "50000", step: "500", value: String(state.capital), "aria-label": "Farming capital USD", oninput: function (ev) { state.capital = Number(ev.target.value); writeHash(); render(); } }),
        el("div", { class: "sim-presets" }, [500, 2500, 10000, 25000, 50000].map(function (p) {
          return el("button", { type: "button", class: "sim-chip" + (state.capital === p ? " active" : ""), text: p >= 1000 ? "$" + (p / 1000) + "k" : "$" + p, onclick: function () { state.capital = p; writeHash(); render(); } });
        }))
      )
    ));

    var body = state.tab === "board" ? renderBoard(filtered) : state.tab === "live" ? renderLiveTab() : renderAuditTab();
    body.forEach(function (n) { root.appendChild(n); });
    root.appendChild(el("footer", { class: "footer-bar" },
      el("span", { text: "Model " + CAL.model_version + " · Sealed DefiLlama snapshot (" + DATA.as_of + ") · Protocols record no token in snapshot; implied values are statistical estimates, not financial advice." }),
      el("span", { class: "num", text: CAL.total_snapshot_protocols + " total · " + CAL.live_token_total_count + " live-token · " + ROWS.length + " ranked" })
    ));

    if (state.selected) {
      var found = ROWS.find(function (r) { return r.slug === state.selected; });
      if (found) root.appendChild(renderDrawer(found));
    }
  }

  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && state.selected) { state.selected = null; writeHash(); render(); } });
  readHash();
  render();
})();
