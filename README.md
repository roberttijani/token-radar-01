# Token Launch Radar

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/roberttijani/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/roberttijani/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A deterministic, zero-network **Token Launch Radar** and Light-Editorial research terminal built in pure Node.js 22+ TypeScript (standard library only) for make.fun's `token-radar-01` bounty.

## Exact 758-Protocol Universe Accounting

Every protocol in the sealed DefiLlama snapshot (`as_of: 2026-11-14`, TVL >= $5M) is partitioned into five mutually exclusive buckets summing strictly to **758 / 758**:

- **40 Ranked Watchlist** (`100%` of the official watchlist, TVL >= $50M)
- **158 Ranked Early / Off-List Finds** (pre-token protocols passing the official exclusion rule, TVL >= $5M)
- **92 Traded Anchors** (non-excluded protocols with positive `mcap_usd > 0`, used to calibrate Model A and populate nearest comparables)
- **152 Recorded Token (No MCap)** (non-excluded protocols with `symbol`/`gecko_id` or `mcap_usd <= 0`, included as positive labels in Model B)
- **316 Excluded by Official Rule** (`233` excluded categories, `76` versioned names, `7` wrapped/staked names, `0` exchange prefixes)

Every ranked protocol's implied value is recomputed independently in `dashboard/app.js` directly from raw snapshot figures (`198 / 198` exact matches against `board.json`).

## Two-Model Valuation Architecture (`Power-Law Launch Value × Logistic Token Odds`)

All candidate terms are tested sequentially on **two blind out-of-sample protocols**—**Leave-One-Out CV (LOOCV)** and **Chronological Walk-Forward CV** (sorted by `listed_at` ascending after a 25-peer warm-up)—and kept **only if they improve both**.

### Model A — Power-Law Launch Value (`n = 92` Traded Anchors, `n = 45` Walk-Forward)

Fitted in log-space on `ln(mcap_usd)` (`ln(MCap) = 9.1133 + 0.3940 · ln(TVL)`):

| Forward Ladder Term | Double-OOS Gate | LOO Typical Miss | Walk-Forward Miss | LOO MdAPE | LOO Spearman ρ |
| --- | :---: | ---: | ---: | ---: | ---: |
| Flat TVL Multiple (Baseline) | `BASELINE` | ×4.647 | ×4.031 | 86.84% | 0.3354 |
| **Size Curve (Power-Law `ln TVL`)** | **`KEPT`** | **×3.269** | **×2.095** | **83.60%** | **0.2803** |
| Category Effect (Ridge Shrinkage) | `DROPPED` | ×3.312 | ×2.434 | 84.38% | 0.2892 |
| 7d TVL Growth (Clamped ±60%) | `DROPPED` | ×3.254 | ×2.487 | 84.12% | 0.2323 |
| Chain Breadth (`ln Chains`) | `DROPPED` | ×3.222 | ×2.555 | 82.39% | 0.2805 |
| Maturity (Years Listed) | `DROPPED` | ×3.071 | ×2.868 | 85.70% | 0.2962 |

- **Blind Out-of-Sample Range Honesty:** LOO empirical coverage is **`48.9%`** inside `P25–P75` (target ~50%) and **`78.3%`** inside `P10–P90` (target ~80%); causal Walk-Forward coverage is **`51.1%`** inside `P25–P75` and **`66.7%`** inside `P10–P90`.

### Model B — Logistic Token Launch Odds (`n = 442` Non-Excluded Protocols, `n = 358` Walk-Forward)

Deterministic Ridge-regularized Logistic Regression (IRLS / Newton-Raphson, tol `1e-9`), gated by double-OOS Brier Score:

| Forward Ladder Term | Double-OOS Gate | LOO Brier | Walk-Forward Brier |
| --- | :---: | ---: | ---: |
| Base Token Rate (55.2% Baseline) | `BASELINE` | 0.2484 | 0.2618 |
| **Years Listed** | **`KEPT`** | **0.2153** | **0.2192** |
| Category Token Share (Shrunk) | `DROPPED` | 0.2101 | 0.2224 |
| **Protocol Scale (`ln TVL`)** | **`KEPT`** | **0.2108** | **0.2139** |
| **7d TVL Growth (Clamped ±60%)** | **`KEPT`** | **0.2073** | **0.2122** |
| Chain Breadth (`ln Chains`) | `DROPPED` | 0.2083 | 0.2117 |

Final Implied Value: `implied_value_usd = Math.max(1, Math.round(launch_value_usd * token_odds))`.

## `Net $/Hour` Costed 8-Step Farm Plans & 2D Sensitivity Matrix

Default scenario (`$10,000` deposit, `7.0%` airdrop share, `12-week / 84-day` horizon, `4.0%` APR T-bill capital benchmark):

- `expected_drop_usd = implied_value_usd * drop_share * (deposit / (tvl_usd + deposit))`
- Subtracts exact 8-step costs on the lowest-gas supported chain (tx gas + category fee + 4.0% T-bill benchmark), reconciled strictly to the cent (`|sum(steps) - total_cost_usd| < $0.01`).
- Verdicts: **`FARM`** (`Net $/hr >= $25` and `Net $ > 0`: **33** protocols), **`MARGINAL`** (`Net $ > 0` and `< $25/hr`: **28**), **`SKIP`** (`Net $ <= 0`: **137**).
- Every protocol detail card includes a live **4×4 Sensitivity Matrix** (`Drop Share [3%, 5%, 7%, 10%] × Deposit [$2.5k, $10k, $25k, $50k]`), **4 Nearest Traded Comparables**, and an inline SVG log-log scatter plot.

## Run It

Requires Node.js 22.18+ (standard library only, zero `npm install`, zero network):

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input token-radar-01-kit/input/snapshot.json
```

Open `out/dashboard/index.html` directly in any browser with zero network access.

## Disclaimer

DefiLlama's snapshot record is not proof of token absence; protocols ranked on the board record no token in the sealed snapshot. All implied valuations, uncertainty intervals, token odds, and `Net $/hr` farm verdicts are deterministic statistical estimates for research purposes only—not financial advice or a prediction of whether or when a token will launch.

---

<sub>Entered on [make.fun](https://make.fun/?ref=2mby0mc5&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
