/**
 * Token Launch Radar (v2) — Two-Model Valuation Engine (Power-Law Launch Value × Logistic Token Odds)
 * Runtime: Node.js 22.18+ (erasable TypeScript syntax, standard library only, 0 network)
 *
 * Model A (Launch Value): Power-law log-linear model on ln(mcap_usd) across all non-excluded traded
 * comparables (mcap_usd > 0), with forward term selection strictly gated by BOTH Leave-One-Out CV
 * and Chronological Walk-Forward CV typical miss (exp(median(|ln(pred/actual)|))).
 *
 * Model B (Token Launch Odds): Ridge-regularized Logistic Regression (IRLS / Newton-Raphson) on all
 * non-excluded snapshot protocols (y = 1 if token recorded, 0 if pre-token), with forward term
 * selection strictly gated by BOTH LOO and Walk-Forward Brier Score.
 */

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

export interface ProtocolAccounting {
  total: number;
  ranked_watchlist: number;
  ranked_early_or_offlist: number;
  traded_anchors: number;
  token_no_mcap: number;
  excluded_by_rule: number;
  excluded_breakdown: {
    excluded_category: number;
    versioned_name: number;
    wrapped_or_staked_name: number;
    exchange_prefix: number;
  };
}

export interface ValueLadderStep {
  term: string;
  label: string;
  status: "baseline" | "kept" | "dropped";
  loo_typical_miss: number;
  wf_typical_miss: number;
  loo_mdape: number;
  loo_log_rmse: number;
  loo_spearman_rho: number;
  delta_loo_miss: number;
  delta_wf_miss: number;
}

export interface OddsLadderStep {
  term: string;
  label: string;
  status: "baseline" | "kept" | "dropped";
  loo_brier: number;
  wf_brier: number;
  delta_loo_brier: number;
  delta_wf_brier: number;
}

export interface RangeHonesty {
  loo_p25_75_coverage_pct: number;
  loo_p10_90_coverage_pct: number;
  wf_p25_75_coverage_pct: number;
  wf_p10_90_coverage_pct: number;
  quantiles: {
    q10: number;
    q25: number;
    q75: number;
    q90: number;
  };
}

export interface NearestPeer {
  slug: string;
  name: string;
  symbol: string | null;
  category: string;
  tvl_usd: number;
  mcap_usd: number;
  mcap_tvl_ratio: number;
  same_category: boolean;
}

export interface ValueModelFit {
  kept_terms: string[];
  alpha: number;
  beta_tvl: number;
  beta_growth: number;
  beta_chains: number;
  beta_maturity: number;
  lambda_category: number;
  lambda_ridge: number;
  feature_stats: {
    ln_tvl_mean: number;
    ln_tvl_std: number;
    growth_mean: number;
    growth_std: number;
    ln_chains_mean: number;
    ln_chains_std: number;
    median_years_listed: number;
    years_mean: number;
    years_std: number;
  };
  category_effects: Record<string, number>;
  flat_multiple_loo_miss: number;
  flat_multiple_wf_miss: number;
  flat_multiple_median: number;
  final_loo_typical_miss: number;
  final_wf_typical_miss: number;
  final_loo_mdape: number;
  final_loo_log_rmse: number;
  final_loo_spearman_rho: number;
  wf_warmup: number;
  wf_eval_count: number;
}

export interface OddsModelFit {
  kept_terms: string[];
  base_rate: number;
  base_brier_loo: number;
  base_brier_wf: number;
  final_brier_loo: number;
  final_brier_wf: number;
  lambda_ridge: number;
  category_prior_m: number;
  intercept: number;
  beta_years: number;
  beta_cat_share: number;
  beta_ln_tvl: number;
  beta_growth: number;
  beta_chains: number;
  feature_stats: {
    median_years_listed: number;
    years_mean: number;
    years_std: number;
    cat_logodds_mean: number;
    cat_logodds_std: number;
    ln_tvl_mean: number;
    ln_tvl_std: number;
    growth_mean: number;
    growth_std: number;
    ln_chains_mean: number;
    ln_chains_std: number;
  };
  category_token_logodds: Record<string, number>;
  odds_clamp: { min: number; max: number };
  training_count: number;
  wf_eval_count: number;
}

export interface CalibrationSummary {
  model_version: string;
  as_of: string;
  floor_usd: number;
  accounting: ProtocolAccounting;
  value_model: ValueModelFit;
  value_ladder: ValueLadderStep[];
  range_honesty: RangeHonesty;
  odds_model: OddsModelFit;
  odds_ladder: OddsLadderStep[];
}

export interface ValuationBreakdown {
  ln_tvl_contrib: number;
  power_law_usd: number;
  category_multiplier: number;
  growth_multiplier: number;
  chains_multiplier: number;
  maturity_multiplier: number;
  launch_value_usd: number;
  token_odds: number;
  implied_value_usd: number;
  category_peer_count: number;
}

export interface ScoredCandidate {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  age_days: number | null;
  is_watchlist: boolean;
  launch_value_usd: number;
  token_odds: number;
  implied_value_usd: number;
  implied_p10_usd: number;
  implied_p25_usd: number;
  implied_p75_usd: number;
  implied_p90_usd: number;
  multiple: number;
  breakdown: ValuationBreakdown;
  nearest_peers: NearestPeer[];
  data_flags: string[];
}

export interface LiveComparable {
  slug: string;
  name: string;
  symbol: string | null;
  category: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  actual_multiple: number;
  loocv_launch_usd: number;
  loocv_miss_ratio: number;
}

export interface ModelOutput {
  calibration: CalibrationSummary;
  candidates: ScoredCandidate[];
  live_comparables: LiveComparable[];
}

export const MODEL_CONFIG = {
  version: "powerlaw-x-odds-v2",
  minTrainingTvlUsd: 5_000_000,
  minCandidateTvlUsd: 5_000_000,
  wfWarmup: 25,
  valueLambdaCategory: 5,
  valueLambdaRidge: 2.0,
  oddsLambdaRidge: 5.0,
  oddsCategoryPriorM: 6,
  oddsClampMin: 0.05,
  oddsClampMax: 0.95,
  excludedCategories: new Set([
    "Bridge",
    "Canonical Bridge",
    "Liquid Staking",
    "Liquid Restaking",
    "Restaked BTC",
    "CEX",
  ]),
  versionedNamePattern: /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/,
  excludedNameWordPattern: /\b(wrapped|staked|staking)\b/i,
  exchangePrefixPattern:
    /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i,
} as const;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Deterministic numerical utilities
// ---------------------------------------------------------------------------

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export function asciiCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function quantile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const pos = clamp(q, 0, 1) * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (pos - lo) * (sortedAsc[hi]! - sortedAsc[lo]!);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const copy = [...values].sort((a, b) => a - b);
  return quantile(copy, 0.5);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i]!;
  return sum / values.length;
}

function stdDev(values: readonly number[], avg: number): number {
  if (values.length <= 1) return 1;
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i]! - avg;
    acc += d * d;
  }
  const s = Math.sqrt(acc / values.length);
  return s > 1e-9 ? s : 1;
}

function sigmoid(z: number): number {
  if (z >= 35) return 1 - 1e-15;
  if (z <= -35) return 1e-15;
  return 1 / (1 + Math.exp(-z));
}

function ranksWithTies(values: readonly number[]): number[] {
  const indexed = values.map((v, idx) => ({ v, idx }));
  indexed.sort((a, b) => a.v - b.v || a.idx - b.idx);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[indexed[k]!.idx] = avgRank;
    i = j + 1;
  }
  return ranks;
}

export function spearmanCorrelation(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length < 3) return 0;
  const rx = ranksWithTies(xs);
  const ry = ranksWithTies(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < rx.length; i++) {
    const dx = rx[i]! - mx;
    const dy = ry[i]! - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 1e-12 ? num / denom : 0;
}

export function solveLinearSystem(
  matrix: readonly (readonly number[])[],
  rhs: readonly number[],
): number[] {
  const n = rhs.length;
  const A = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(A[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(A[r]![col]!);
      if (val > maxAbs) {
        maxAbs = val;
        pivotRow = r;
      }
    }
    if (maxAbs < 1e-12) return new Array<number>(n).fill(0);
    if (pivotRow !== col) {
      const tmp = A[col]!;
      A[col] = A[pivotRow]!;
      A[pivotRow] = tmp;
    }
    const pivot = A[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const factor = A[r]![col]! / pivot;
      for (let c = col; c <= n; c++) A[r]![c]! -= factor * A[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = A[r]![n]!;
    for (let c = r + 1; c < n; c++) sum -= A[r]![c]! * x[c]!;
    x[r] = sum / A[r]![r]!;
  }
  return x;
}

// ---------------------------------------------------------------------------
// Snapshot parsing & 758-protocol partitioning
// ---------------------------------------------------------------------------

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError("snapshot.json is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SnapshotError("snapshot.json must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError("snapshot.json lacks a valid YYYY-MM-DD as_of date");
  }
  if (typeof o.source !== "string") {
    throw new SnapshotError("snapshot.json lacks a source string");
  }
  if (typeof o.floor_usd !== "number" || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError("snapshot.json lacks a positive integer floor_usd");
  }
  if (!Array.isArray(o.protocols)) {
    throw new SnapshotError("snapshot.json lacks a protocols array");
  }
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== "string")) {
    throw new SnapshotError("snapshot.json lacks a watchlist array of slugs");
  }

  const protocols: SnapshotProtocol[] = o.protocols.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new SnapshotError(`snapshot.json protocol[${i}] is not an object`);
    }
    const p = item as Record<string, unknown>;
    if (
      typeof p.slug !== "string" ||
      typeof p.name !== "string" ||
      typeof p.tvl_usd !== "number" ||
      !Number.isFinite(p.tvl_usd)
    ) {
      throw new SnapshotError(`snapshot.json protocol[${i}] lacks slug, name, or finite tvl_usd`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === "string" && p.category.trim().length > 0 ? p.category.trim() : null,
      chains: Array.isArray(p.chains)
        ? p.chains.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
        : [],
      tvl_usd: p.tvl_usd,
      change_7d:
        typeof p.change_7d === "number" && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd:
        typeof p.mcap_usd === "number" && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at:
        typeof p.listed_at === "string" && p.listed_at.trim().length > 0 ? p.listed_at.trim() : null,
      gecko_id:
        typeof p.gecko_id === "string" && p.gecko_id.trim().length > 0 ? p.gecko_id.trim() : null,
      symbol:
        typeof p.symbol === "string" && p.symbol.trim().length > 0 && p.symbol.trim() !== "-"
          ? p.symbol.trim()
          : null,
    };
  });

  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

function normalizeCategory(raw: string | null): string {
  return raw !== null && raw.trim().length > 0 ? raw.trim() : "Other";
}

export function ageDaysFromIso(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

type ExclusionReason =
  | "excluded_category"
  | "versioned_name"
  | "wrapped_or_staked_name"
  | "exchange_prefix"
  | null;

function exclusionReason(
  p: SnapshotProtocol,
  watchlistSet: ReadonlySet<string>,
): ExclusionReason {
  if (watchlistSet.has(p.slug)) return null;
  if (MODEL_CONFIG.excludedCategories.has(normalizeCategory(p.category))) {
    return "excluded_category";
  }
  if (MODEL_CONFIG.versionedNamePattern.test(p.name)) return "versioned_name";
  if (MODEL_CONFIG.excludedNameWordPattern.test(p.name)) return "wrapped_or_staked_name";
  if (MODEL_CONFIG.exchangePrefixPattern.test(p.name)) return "exchange_prefix";
  return null;
}

export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null && p.mcap_usd === null;
}

// ---------------------------------------------------------------------------
// Model A helpers: Power-law ln(mcap_usd) + ridge + category shrinkage
// ---------------------------------------------------------------------------

type ValueTerm = "size" | "category" | "growth" | "chains" | "maturity";

interface ValueRow {
  protocol: SnapshotProtocol;
  category: string;
  tvl_usd: number;
  mcap_usd: number;
  ln_tvl: number;
  ln_mcap: number;
  growth_c: number;
  ln_chains: number;
  years_listed: number | null;
  listed_at: string | null;
}

interface ValueFoldModel {
  alpha: number;
  betas: Record<string, number>;
  catEffects: Map<string, number>;
  stats: {
    ln_tvl_mean: number;
    ln_tvl_std: number;
    growth_mean: number;
    growth_std: number;
    ln_chains_mean: number;
    ln_chains_std: number;
    median_years_listed: number;
    years_mean: number;
    years_std: number;
  };
  useFlat: boolean;
  flatOffset: number;
}

function fitValueFold(
  train: readonly ValueRow[],
  activeTerms: ReadonlySet<ValueTerm>,
): ValueFoldModel {
  const lnTvls = train.map((r) => r.ln_tvl);
  const growths = train.map((r) => r.growth_c);
  const lnChains = train.map((r) => r.ln_chains);
  const validYears = train
    .map((r) => r.years_listed)
    .filter((v): v is number => v !== null);
  const medianYears = validYears.length > 0 ? median(validYears) : 1.0;
  const yearsAll = train.map((r) => r.years_listed ?? medianYears);

  const stats = {
    ln_tvl_mean: mean(lnTvls),
    ln_tvl_std: stdDev(lnTvls, mean(lnTvls)),
    growth_mean: mean(growths),
    growth_std: stdDev(growths, mean(growths)),
    ln_chains_mean: mean(lnChains),
    ln_chains_std: stdDev(lnChains, mean(lnChains)),
    median_years_listed: medianYears,
    years_mean: mean(yearsAll),
    years_std: stdDev(yearsAll, mean(yearsAll)),
  };

  if (!activeTerms.has("size")) {
    const flatOffset = median(train.map((r) => r.ln_mcap - r.ln_tvl));
    return {
      alpha: 0,
      betas: {},
      catEffects: new Map(),
      stats,
      useFlat: true,
      flatOffset,
    };
  }

  // Numeric design terms in fixed order: intercept + active numeric terms
  const numTerms: ValueTerm[] = [];
  if (activeTerms.has("size")) numTerms.push("size");
  if (activeTerms.has("growth")) numTerms.push("growth");
  if (activeTerms.has("chains")) numTerms.push("chains");
  if (activeTerms.has("maturity")) numTerms.push("maturity");

  const featVal = (r: ValueRow, t: ValueTerm): number => {
    if (t === "size") return r.ln_tvl; // raw ln(tvl_usd) so beta_tvl is direct power-law exponent
    if (t === "growth") return (r.growth_c - stats.growth_mean) / stats.growth_std;
    if (t === "chains") return (r.ln_chains - stats.ln_chains_mean) / stats.ln_chains_std;
    return ((r.years_listed ?? stats.median_years_listed) - stats.years_mean) / stats.years_std;
  };

  const p = 1 + numTerms.length;
  const XtX: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const Xty = new Array<number>(p).fill(0);

  for (let i = 0; i < train.length; i++) {
    const r = train[i]!;
    const x = [1, ...numTerms.map((t) => featVal(r, t))];
    for (let a = 0; a < p; a++) {
      Xty[a]! += x[a]! * r.ln_mcap;
      for (let b = a; b < p; b++) XtX[a]![b]! += x[a]! * x[b]!;
    }
  }
  for (let a = 0; a < p; a++) {
    // Do not penalize intercept (a=0) or primary power-law slope (a=1: ln_tvl); ridge-penalize auxiliary terms
    if (a >= 2) XtX[a]![a]! += MODEL_CONFIG.valueLambdaRidge;
    for (let b = 0; b < a; b++) XtX[a]![b] = XtX[b]![a]!;
  }
  const w = solveLinearSystem(XtX, Xty);
  const alpha = w[0]!;
  const betas: Record<string, number> = {};
  for (let k = 0; k < numTerms.length; k++) betas[numTerms[k]!] = w[k + 1]!;

  const catEffects = new Map<string, number>();
  if (activeTerms.has("category")) {
    const byCat = new Map<string, number[]>();
    for (let i = 0; i < train.length; i++) {
      const r = train[i]!;
      let predBase = alpha;
      for (const t of numTerms) predBase += betas[t]! * featVal(r, t);
      const resid = r.ln_mcap - predBase;
      let arr = byCat.get(r.category);
      if (!arr) {
        arr = [];
        byCat.set(r.category, arr);
      }
      arr.push(resid);
    }
    for (const [cat, resids] of byCat.entries()) {
      const nc = resids.length;
      const shrunk = (nc / (nc + MODEL_CONFIG.valueLambdaCategory)) * median(resids);
      catEffects.set(cat, shrunk);
    }
  }

  return { alpha, betas, catEffects, stats, useFlat: false, flatOffset: 0 };
}

function predictValueFold(model: ValueFoldModel, r: ValueRow): number {
  if (model.useFlat) return r.ln_tvl + model.flatOffset;
  let y = model.alpha;
  if (model.betas.size !== undefined) y += model.betas.size * r.ln_tvl;
  if (model.betas.growth !== undefined) {
    y += model.betas.growth * ((r.growth_c - model.stats.growth_mean) / model.stats.growth_std);
  }
  if (model.betas.chains !== undefined) {
    y += model.betas.chains * ((r.ln_chains - model.stats.ln_chains_mean) / model.stats.ln_chains_std);
  }
  if (model.betas.maturity !== undefined) {
    const yrs = r.years_listed ?? model.stats.median_years_listed;
    y += model.betas.maturity * ((yrs - model.stats.years_mean) / model.stats.years_std);
  }
  y += model.catEffects.get(r.category) ?? 0;
  return y;
}

function evaluateValueMetrics(
  actualLn: readonly number[],
  predLn: readonly number[],
): { typicalMiss: number; mdape: number; logRmse: number; spearmanRho: number } {
  const n = actualLn.length;
  if (n === 0) return { typicalMiss: 1, mdape: 0, logRmse: 0, spearmanRho: 0 };
  const absLogs: number[] = [];
  const apes: number[] = [];
  let sq = 0;
  const actUsd: number[] = [];
  const predUsd: number[] = [];
  for (let i = 0; i < n; i++) {
    const diff = predLn[i]! - actualLn[i]!;
    absLogs.push(Math.abs(diff));
    sq += diff * diff;
    const a = Math.exp(actualLn[i]!);
    const p = Math.exp(predLn[i]!);
    apes.push(Math.abs(p - a) / a);
    actUsd.push(a);
    predUsd.push(p);
  }
  return {
    typicalMiss: Math.exp(median(absLogs)),
    mdape: median(apes) * 100,
    logRmse: Math.sqrt(sq / n),
    spearmanRho: spearmanCorrelation(actUsd, predUsd),
  };
}

function runValueDoubleOos(
  rows: readonly ValueRow[],
  wfRows: readonly ValueRow[],
  activeTerms: ReadonlySet<ValueTerm>,
): {
  looPreds: number[];
  looMetrics: ReturnType<typeof evaluateValueMetrics>;
  wfActuals: number[];
  wfPreds: number[];
  wfMetrics: ReturnType<typeof evaluateValueMetrics>;
} {
  const looPreds = new Array<number>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const train = rows.filter((_, idx) => idx !== i);
    const fit = fitValueFold(train, activeTerms);
    looPreds[i] = predictValueFold(fit, rows[i]!);
  }
  const looActuals = rows.map((r) => r.ln_mcap);
  const looMetrics = evaluateValueMetrics(looActuals, looPreds);

  const wfActuals: number[] = [];
  const wfPreds: number[] = [];
  const warmup = MODEL_CONFIG.wfWarmup;
  for (let k = warmup; k < wfRows.length; k++) {
    const train = wfRows.slice(0, k);
    const fit = fitValueFold(train, activeTerms);
    wfActuals.push(wfRows[k]!.ln_mcap);
    wfPreds.push(predictValueFold(fit, wfRows[k]!));
  }
  const wfMetrics = evaluateValueMetrics(wfActuals, wfPreds);
  return { looPreds, looMetrics, wfActuals, wfPreds, wfMetrics };
}

// ---------------------------------------------------------------------------
// Model B helpers: Ridge-regularized Logistic Regression (IRLS / Newton-Raphson)
// ---------------------------------------------------------------------------

type OddsTerm = "years" | "cat_share" | "ln_tvl" | "growth" | "chains";

interface OddsRow {
  protocol: SnapshotProtocol;
  category: string;
  y: number; // 1 = live/recorded token, 0 = pre-token
  ln_tvl: number;
  growth_c: number;
  ln_chains: number;
  years_listed: number | null;
  listed_at: string | null;
}

interface OddsFoldModel {
  useBaseRate: boolean;
  baseRate: number;
  intercept: number;
  betas: Record<string, number>;
  catLogOdds: Map<string, number>;
  stats: {
    median_years_listed: number;
    years_mean: number;
    years_std: number;
    cat_logodds_mean: number;
    cat_logodds_std: number;
    ln_tvl_mean: number;
    ln_tvl_std: number;
    growth_mean: number;
    growth_std: number;
    ln_chains_mean: number;
    ln_chains_std: number;
  };
}

function fitOddsFold(
  train: readonly OddsRow[],
  activeTerms: ReadonlySet<OddsTerm>,
): OddsFoldModel {
  const n = train.length;
  const baseRate = n > 0 ? mean(train.map((r) => r.y)) : 0.5;
  const validYears = train
    .map((r) => r.years_listed)
    .filter((v): v is number => v !== null);
  const medianYears = validYears.length > 0 ? median(validYears) : 1.0;

  // Shrunk empirical-Bayes category token share -> log-odds, strictly from training fold
  const catCounts = new Map<string, { tot: number; pos: number }>();
  for (const r of train) {
    let entry = catCounts.get(r.category);
    if (!entry) {
      entry = { tot: 0, pos: 0 };
      catCounts.set(r.category, entry);
    }
    entry.tot++;
    entry.pos += r.y;
  }
  const m = MODEL_CONFIG.oddsCategoryPriorM;
  const defaultShare = clamp(baseRate, 0.02, 0.98);
  const defaultLogOdds = Math.log(defaultShare / (1 - defaultShare));
  const catLogOdds = new Map<string, number>();
  for (const [cat, c] of catCounts.entries()) {
    const pHat = clamp((c.pos + m * baseRate) / (c.tot + m), 0.02, 0.98);
    catLogOdds.set(cat, Math.log(pHat / (1 - pHat)));
  }

  const yearsArr = train.map((r) => r.years_listed ?? medianYears);
  const catLoArr = train.map((r) => catLogOdds.get(r.category) ?? defaultLogOdds);
  const lnTvlArr = train.map((r) => r.ln_tvl);
  const growthArr = train.map((r) => r.growth_c);
  const chainsArr = train.map((r) => r.ln_chains);

  const stats = {
    median_years_listed: medianYears,
    years_mean: mean(yearsArr),
    years_std: stdDev(yearsArr, mean(yearsArr)),
    cat_logodds_mean: mean(catLoArr),
    cat_logodds_std: stdDev(catLoArr, mean(catLoArr)),
    ln_tvl_mean: mean(lnTvlArr),
    ln_tvl_std: stdDev(lnTvlArr, mean(lnTvlArr)),
    growth_mean: mean(growthArr),
    growth_std: stdDev(growthArr, mean(growthArr)),
    ln_chains_mean: mean(chainsArr),
    ln_chains_std: stdDev(chainsArr, mean(chainsArr)),
  };

  const terms: OddsTerm[] = [];
  for (const t of ["years", "cat_share", "ln_tvl", "growth", "chains"] as const) {
    if (activeTerms.has(t)) terms.push(t);
  }
  if (terms.length === 0) {
    return {
      useBaseRate: true,
      baseRate,
      intercept: defaultLogOdds,
      betas: {},
      catLogOdds,
      stats,
    };
  }

  const feat = (r: OddsRow, t: OddsTerm): number => {
    if (t === "years") return ((r.years_listed ?? stats.median_years_listed) - stats.years_mean) / stats.years_std;
    if (t === "cat_share") return ((catLogOdds.get(r.category) ?? defaultLogOdds) - stats.cat_logodds_mean) / stats.cat_logodds_std;
    if (t === "ln_tvl") return (r.ln_tvl - stats.ln_tvl_mean) / stats.ln_tvl_std;
    if (t === "growth") return (r.growth_c - stats.growth_mean) / stats.growth_std;
    return (r.ln_chains - stats.ln_chains_mean) / stats.ln_chains_std;
  };

  const p = 1 + terms.length;
  const X = train.map((r) => [1, ...terms.map((t) => feat(r, t))]);
  const w = new Array<number>(p).fill(0);
  w[0] = defaultLogOdds;

  // Deterministic Ridge-regularized IRLS / Newton-Raphson (max 25 iters, tol 1e-9)
  const lambda = MODEL_CONFIG.oddsLambdaRidge;
  for (let iter = 0; iter < 25; iter++) {
    const H: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    const g = new Array<number>(p).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i]!;
      let z = 0;
      for (let a = 0; a < p; a++) z += w[a]! * xi[a]!;
      const pi = sigmoid(z);
      const wi = Math.max(pi * (1 - pi), 1e-6);
      const diff = pi - train[i]!.y;
      for (let a = 0; a < p; a++) {
        g[a]! += xi[a]! * diff;
        for (let b = a; b < p; b++) H[a]![b]! += wi * xi[a]! * xi[b]!;
      }
    }
    for (let a = 0; a < p; a++) {
      if (a >= 1) {
        H[a]![a]! += lambda;
        g[a]! += lambda * w[a]!;
      }
      for (let b = 0; b < a; b++) H[a]![b] = H[b]![a]!;
    }
    const step = solveLinearSystem(H, g);
    let maxStep = 0;
    for (let a = 0; a < p; a++) {
      w[a]! -= step[a]!;
      maxStep = Math.max(maxStep, Math.abs(step[a]!));
    }
    if (maxStep < 1e-9) break;
  }

  const betas: Record<string, number> = {};
  for (let k = 0; k < terms.length; k++) betas[terms[k]!] = w[k + 1]!;
  return {
    useBaseRate: false,
    baseRate,
    intercept: w[0]!,
    betas,
    catLogOdds,
    stats,
  };
}

function predictOddsFold(model: OddsFoldModel, r: OddsRow): number {
  if (model.useBaseRate) {
    return clamp(model.baseRate, MODEL_CONFIG.oddsClampMin, MODEL_CONFIG.oddsClampMax);
  }
  const defaultShare = clamp(model.baseRate, 0.02, 0.98);
  const defaultLogOdds = Math.log(defaultShare / (1 - defaultShare));
  let z = model.intercept;
  if (model.betas.years !== undefined) {
    z += model.betas.years * (((r.years_listed ?? model.stats.median_years_listed) - model.stats.years_mean) / model.stats.years_std);
  }
  if (model.betas.cat_share !== undefined) {
    const lo = model.catLogOdds.get(r.category) ?? defaultLogOdds;
    z += model.betas.cat_share * ((lo - model.stats.cat_logodds_mean) / model.stats.cat_logodds_std);
  }
  if (model.betas.ln_tvl !== undefined) {
    z += model.betas.ln_tvl * ((r.ln_tvl - model.stats.ln_tvl_mean) / model.stats.ln_tvl_std);
  }
  if (model.betas.growth !== undefined) {
    z += model.betas.growth * ((r.growth_c - model.stats.growth_mean) / model.stats.growth_std);
  }
  if (model.betas.chains !== undefined) {
    z += model.betas.chains * ((r.ln_chains - model.stats.ln_chains_mean) / model.stats.ln_chains_std);
  }
  return clamp(sigmoid(z), MODEL_CONFIG.oddsClampMin, MODEL_CONFIG.oddsClampMax);
}

function brierScore(ys: readonly number[], ps: readonly number[]): number {
  if (ys.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < ys.length; i++) {
    const d = ps[i]! - ys[i]!;
    sum += d * d;
  }
  return sum / ys.length;
}

function runOddsDoubleOos(
  rows: readonly OddsRow[],
  wfRows: readonly OddsRow[],
  activeTerms: ReadonlySet<OddsTerm>,
): { looBrier: number; wfBrier: number } {
  const looPs = new Array<number>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const train = rows.filter((_, idx) => idx !== i);
    const fit = fitOddsFold(train, activeTerms);
    looPs[i] = predictOddsFold(fit, rows[i]!);
  }
  const looBrier = brierScore(rows.map((r) => r.y), looPs);

  const wfYs: number[] = [];
  const wfPs: number[] = [];
  const warmup = MODEL_CONFIG.wfWarmup;
  for (let k = warmup; k < wfRows.length; k++) {
    const train = wfRows.slice(0, k);
    const fit = fitOddsFold(train, activeTerms);
    wfYs.push(wfRows[k]!.y);
    wfPs.push(predictOddsFold(fit, wfRows[k]!));
  }
  const wfBrier = brierScore(wfYs, wfPs);
  return { looBrier, wfBrier };
}

// ---------------------------------------------------------------------------
// Main v2 Calibration & Scoring Entrypoint
// ---------------------------------------------------------------------------

export function runValuationModel(snapshot: Snapshot): ModelOutput {
  const watchlistSet = new Set<string>(snapshot.watchlist);
  const sortedProtocols = [...snapshot.protocols].sort((a, b) => asciiCompare(a.slug, b.slug));

  // 1. Exact non-overlapping 758-protocol accounting
  let rankedWatchlist = 0;
  let rankedEarly = 0;
  let tradedAnchorsCount = 0;
  let tokenNoMcap = 0;
  let excludedCount = 0;
  const exclBreakdown = {
    excluded_category: 0,
    versioned_name: 0,
    wrapped_or_staked_name: 0,
    exchange_prefix: 0,
  };

  const valueRows: ValueRow[] = [];
  const oddsRows: OddsRow[] = [];
  const candidateProtocols: SnapshotProtocol[] = [];

  for (const p of sortedProtocols) {
    const isWl = watchlistSet.has(p.slug);
    const excl = exclusionReason(p, watchlistSet);
    const noTok = recordsNoToken(p);
    const ageDays = ageDaysFromIso(snapshot.as_of, p.listed_at);
    const yearsListed = ageDays !== null ? ageDays / 365.25 : null;
    const cat = normalizeCategory(p.category);
    const lnTvl = Math.log(Math.max(p.tvl_usd, 1));
    const growthC = clamp(p.change_7d ?? 0, -60, 60) / 100;
    const lnChains = Math.log(Math.max(1, p.chains.length));

    if (isWl) {
      rankedWatchlist++;
      candidateProtocols.push(p);
      oddsRows.push({
        protocol: p, category: cat, y: 0, ln_tvl: lnTvl, growth_c: growthC,
        ln_chains: lnChains, years_listed: yearsListed, listed_at: p.listed_at,
      });
    } else if (excl !== null) {
      excludedCount++;
      exclBreakdown[excl]++;
    } else if (noTok) {
      rankedEarly++;
      candidateProtocols.push(p);
      oddsRows.push({
        protocol: p, category: cat, y: 0, ln_tvl: lnTvl, growth_c: growthC,
        ln_chains: lnChains, years_listed: yearsListed, listed_at: p.listed_at,
      });
    } else if (p.mcap_usd !== null && Number.isFinite(p.mcap_usd) && p.mcap_usd > 0) {
      tradedAnchorsCount++;
      valueRows.push({
        protocol: p, category: cat, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd,
        ln_tvl: lnTvl, ln_mcap: Math.log(p.mcap_usd), growth_c: growthC,
        ln_chains: lnChains, years_listed: yearsListed, listed_at: p.listed_at,
      });
      oddsRows.push({
        protocol: p, category: cat, y: 1, ln_tvl: lnTvl, growth_c: growthC,
        ln_chains: lnChains, years_listed: yearsListed, listed_at: p.listed_at,
      });
    } else {
      tokenNoMcap++;
      oddsRows.push({
        protocol: p, category: cat, y: 1, ln_tvl: lnTvl, growth_c: growthC,
        ln_chains: lnChains, years_listed: yearsListed, listed_at: p.listed_at,
      });
    }
  }

  const accountingTotal =
    rankedWatchlist + rankedEarly + tradedAnchorsCount + tokenNoMcap + excludedCount;
  if (accountingTotal !== sortedProtocols.length) {
    throw new Error(
      `758-protocol accounting mismatch: sum=${accountingTotal}, total=${sortedProtocols.length}`,
    );
  }
  const accounting: ProtocolAccounting = {
    total: sortedProtocols.length,
    ranked_watchlist: rankedWatchlist,
    ranked_early_or_offlist: rankedEarly,
    traded_anchors: tradedAnchorsCount,
    token_no_mcap: tokenNoMcap,
    excluded_by_rule: excludedCount,
    excluded_breakdown: exclBreakdown,
  };

  // 2. Model A — Launch Value Forward Selection (LOO + Chronological Walk-Forward)
  const wfValueRows = valueRows
    .filter((r) => r.listed_at !== null)
    .sort((a, b) => asciiCompare(a.listed_at!, b.listed_at!) || asciiCompare(a.protocol.slug, b.protocol.slug));

  const activeValueTerms = new Set<ValueTerm>();
  const flatRes = runValueDoubleOos(valueRows, wfValueRows, activeValueTerms);
  const flatMultipleMedian = roundTo(
    Math.exp(median(valueRows.map((r) => r.ln_mcap - r.ln_tvl))),
    4,
  );

  const valueLadder: ValueLadderStep[] = [
    {
      term: "flat",
      label: "Flat TVL Multiple (Baseline)",
      status: "baseline",
      loo_typical_miss: roundTo(flatRes.looMetrics.typicalMiss, 3),
      wf_typical_miss: roundTo(flatRes.wfMetrics.typicalMiss, 3),
      loo_mdape: roundTo(flatRes.looMetrics.mdape, 2),
      loo_log_rmse: roundTo(flatRes.looMetrics.logRmse, 4),
      loo_spearman_rho: roundTo(flatRes.looMetrics.spearmanRho, 4),
      delta_loo_miss: 0,
      delta_wf_miss: 0,
    },
  ];

  let curValueRes = flatRes;
  const valueCandidates: Array<{ term: ValueTerm; label: string }> = [
    { term: "size", label: "Size Curve (Power-Law ln TVL)" },
    { term: "category", label: "Category Effect (Ridge Shrinkage)" },
    { term: "growth", label: "7d TVL Growth (Clamped ±60%)" },
    { term: "chains", label: "Chain Breadth (ln Chains)" },
    { term: "maturity", label: "Maturity (Years Listed)" },
  ];

  for (const cand of valueCandidates) {
    const trialSet = new Set<ValueTerm>(activeValueTerms);
    trialSet.add(cand.term);
    const trialRes = runValueDoubleOos(valueRows, wfValueRows, trialSet);
    const dLoo = trialRes.looMetrics.typicalMiss - curValueRes.looMetrics.typicalMiss;
    const dWf = trialRes.wfMetrics.typicalMiss - curValueRes.wfMetrics.typicalMiss;
    const keep = dLoo < -1e-4 && dWf < -1e-4;
    if (keep) {
      activeValueTerms.add(cand.term);
      curValueRes = trialRes;
    }
    valueLadder.push({
      term: cand.term,
      label: cand.label,
      status: keep ? "kept" : "dropped",
      loo_typical_miss: roundTo(trialRes.looMetrics.typicalMiss, 3),
      wf_typical_miss: roundTo(trialRes.wfMetrics.typicalMiss, 3),
      loo_mdape: roundTo(trialRes.looMetrics.mdape, 2),
      loo_log_rmse: roundTo(trialRes.looMetrics.logRmse, 4),
      loo_spearman_rho: roundTo(trialRes.looMetrics.spearmanRho, 4),
      delta_loo_miss: roundTo(dLoo, 3),
      delta_wf_miss: roundTo(dWf, 3),
    });
  }

  // Range Honesty (blind out-of-sample P25-P75 & P10-P90 coverage on both LOO and Walk-Forward)
  const looResids = valueRows.map((r, i) => r.ln_mcap - curValueRes.looPreds[i]!);
  let looIn50 = 0;
  let looIn80 = 0;
  for (let i = 0; i < looResids.length; i++) {
    const others = looResids.filter((_, idx) => idx !== i).sort((a, b) => a - b);
    const e = looResids[i]!;
    if (e >= quantile(others, 0.25) && e <= quantile(others, 0.75)) looIn50++;
    if (e >= quantile(others, 0.10) && e <= quantile(others, 0.90)) looIn80++;
  }

  // Causal Walk-Forward range honesty: for each step k >= warmup, compute quantiles strictly from training fold residuals
  let wfIn50 = 0;
  let wfIn80 = 0;
  const wfEvalN = Math.max(0, wfValueRows.length - MODEL_CONFIG.wfWarmup);
  for (let k = MODEL_CONFIG.wfWarmup; k < wfValueRows.length; k++) {
    const train = wfValueRows.slice(0, k);
    const fit = fitValueFold(train, activeValueTerms);
    const trainResids = train
      .map((r) => r.ln_mcap - predictValueFold(fit, r))
      .sort((a, b) => a - b);
    const errK = wfValueRows[k]!.ln_mcap - predictValueFold(fit, wfValueRows[k]!);
    if (errK >= quantile(trainResids, 0.25) && errK <= quantile(trainResids, 0.75)) wfIn50++;
    if (errK >= quantile(trainResids, 0.10) && errK <= quantile(trainResids, 0.90)) wfIn80++;
  }

  const sortedLooResids = [...looResids].sort((a, b) => a - b);
  const q10 = roundTo(quantile(sortedLooResids, 0.10), 6);
  const q25 = roundTo(quantile(sortedLooResids, 0.25), 6);
  const q75 = roundTo(quantile(sortedLooResids, 0.75), 6);
  const q90 = roundTo(quantile(sortedLooResids, 0.90), 6);

  const rangeHonesty: RangeHonesty = {
    loo_p25_75_coverage_pct: roundTo((looIn50 / Math.max(1, looResids.length)) * 100, 1),
    loo_p10_90_coverage_pct: roundTo((looIn80 / Math.max(1, looResids.length)) * 100, 1),
    wf_p25_75_coverage_pct: roundTo((wfIn50 / Math.max(1, wfEvalN)) * 100, 1),
    wf_p10_90_coverage_pct: roundTo((wfIn80 / Math.max(1, wfEvalN)) * 100, 1),
    quantiles: { q10, q25, q75, q90 },
  };

  // Final full-sample Model A fit with deterministically rounded exported params
  const fullValueFitRaw = fitValueFold(valueRows, activeValueTerms);
  const valAlpha = roundTo(fullValueFitRaw.alpha, 6);
  const valBetaTvl = roundTo(fullValueFitRaw.betas.size ?? 1, 6);
  const valBetaGrowth = roundTo(fullValueFitRaw.betas.growth ?? 0, 6);
  const valBetaChains = roundTo(fullValueFitRaw.betas.chains ?? 0, 6);
  const valBetaMaturity = roundTo(fullValueFitRaw.betas.maturity ?? 0, 6);
  const valStats = {
    ln_tvl_mean: roundTo(fullValueFitRaw.stats.ln_tvl_mean, 6),
    ln_tvl_std: roundTo(fullValueFitRaw.stats.ln_tvl_std, 6),
    growth_mean: roundTo(fullValueFitRaw.stats.growth_mean, 6),
    growth_std: roundTo(fullValueFitRaw.stats.growth_std, 6),
    ln_chains_mean: roundTo(fullValueFitRaw.stats.ln_chains_mean, 6),
    ln_chains_std: roundTo(fullValueFitRaw.stats.ln_chains_std, 6),
    median_years_listed: roundTo(fullValueFitRaw.stats.median_years_listed, 6),
    years_mean: roundTo(fullValueFitRaw.stats.years_mean, 6),
    years_std: roundTo(fullValueFitRaw.stats.years_std, 6),
  };
  const valCatEffects: Record<string, number> = {};
  for (const [cat, eff] of [...fullValueFitRaw.catEffects.entries()].sort((a, b) =>
    asciiCompare(a[0], b[0]),
  )) {
    valCatEffects[cat] = roundTo(eff, 6);
  }

  const valueModelFit: ValueModelFit = {
    kept_terms: [...activeValueTerms],
    alpha: valAlpha,
    beta_tvl: valBetaTvl,
    beta_growth: valBetaGrowth,
    beta_chains: valBetaChains,
    beta_maturity: valBetaMaturity,
    lambda_category: MODEL_CONFIG.valueLambdaCategory,
    lambda_ridge: MODEL_CONFIG.valueLambdaRidge,
    feature_stats: valStats,
    category_effects: valCatEffects,
    flat_multiple_loo_miss: roundTo(flatRes.looMetrics.typicalMiss, 3),
    flat_multiple_wf_miss: roundTo(flatRes.wfMetrics.typicalMiss, 3),
    flat_multiple_median: flatMultipleMedian,
    final_loo_typical_miss: roundTo(curValueRes.looMetrics.typicalMiss, 3),
    final_wf_typical_miss: roundTo(curValueRes.wfMetrics.typicalMiss, 3),
    final_loo_mdape: roundTo(curValueRes.looMetrics.mdape, 2),
    final_loo_log_rmse: roundTo(curValueRes.looMetrics.logRmse, 4),
    final_loo_spearman_rho: roundTo(curValueRes.looMetrics.spearmanRho, 4),
    wf_warmup: MODEL_CONFIG.wfWarmup,
    wf_eval_count: wfEvalN,
  };

  // 3. Model B — Token Launch Odds Forward Selection (LOO + Chronological Walk-Forward Brier)
  const wfOddsRows = oddsRows
    .filter((r) => r.listed_at !== null)
    .sort((a, b) => asciiCompare(a.listed_at!, b.listed_at!) || asciiCompare(a.protocol.slug, b.protocol.slug));

  const activeOddsTerms = new Set<OddsTerm>();
  const baseOddsRes = runOddsDoubleOos(oddsRows, wfOddsRows, activeOddsTerms);
  const oddsLadder: OddsLadderStep[] = [
    {
      term: "base_rate",
      label: "Base Token Rate (Baseline)",
      status: "baseline",
      loo_brier: roundTo(baseOddsRes.looBrier, 4),
      wf_brier: roundTo(baseOddsRes.wfBrier, 4),
      delta_loo_brier: 0,
      delta_wf_brier: 0,
    },
  ];

  let curOddsRes = baseOddsRes;
  const oddsCandidates: Array<{ term: OddsTerm; label: string }> = [
    { term: "years", label: "Years Listed" },
    { term: "cat_share", label: "Category Token Share (Shrunk)" },
    { term: "ln_tvl", label: "Protocol Scale (ln TVL)" },
    { term: "growth", label: "7d TVL Growth (Clamped ±60%)" },
    { term: "chains", label: "Chain Breadth (ln Chains)" },
  ];

  for (const cand of oddsCandidates) {
    const trialSet = new Set<OddsTerm>(activeOddsTerms);
    trialSet.add(cand.term);
    const trialRes = runOddsDoubleOos(oddsRows, wfOddsRows, trialSet);
    const dLoo = trialRes.looBrier - curOddsRes.looBrier;
    const dWf = trialRes.wfBrier - curOddsRes.wfBrier;
    const keep = dLoo < -1e-4 && dWf < -1e-4;
    if (keep) {
      activeOddsTerms.add(cand.term);
      curOddsRes = trialRes;
    }
    oddsLadder.push({
      term: cand.term,
      label: cand.label,
      status: keep ? "kept" : "dropped",
      loo_brier: roundTo(trialRes.looBrier, 4),
      wf_brier: roundTo(trialRes.wfBrier, 4),
      delta_loo_brier: roundTo(dLoo, 4),
      delta_wf_brier: roundTo(dWf, 4),
    });
  }

  const fullOddsRaw = fitOddsFold(oddsRows, activeOddsTerms);
  const oddsBaseRate = roundTo(fullOddsRaw.baseRate, 6);
  const oddsIntercept = roundTo(fullOddsRaw.intercept, 6);
  const oddsBetaYears = roundTo(fullOddsRaw.betas.years ?? 0, 6);
  const oddsBetaCat = roundTo(fullOddsRaw.betas.cat_share ?? 0, 6);
  const oddsBetaTvl = roundTo(fullOddsRaw.betas.ln_tvl ?? 0, 6);
  const oddsBetaGrowth = roundTo(fullOddsRaw.betas.growth ?? 0, 6);
  const oddsBetaChains = roundTo(fullOddsRaw.betas.chains ?? 0, 6);
  const oddsStats = {
    median_years_listed: roundTo(fullOddsRaw.stats.median_years_listed, 6),
    years_mean: roundTo(fullOddsRaw.stats.years_mean, 6),
    years_std: roundTo(fullOddsRaw.stats.years_std, 6),
    cat_logodds_mean: roundTo(fullOddsRaw.stats.cat_logodds_mean, 6),
    cat_logodds_std: roundTo(fullOddsRaw.stats.cat_logodds_std, 6),
    ln_tvl_mean: roundTo(fullOddsRaw.stats.ln_tvl_mean, 6),
    ln_tvl_std: roundTo(fullOddsRaw.stats.ln_tvl_std, 6),
    growth_mean: roundTo(fullOddsRaw.stats.growth_mean, 6),
    growth_std: roundTo(fullOddsRaw.stats.growth_std, 6),
    ln_chains_mean: roundTo(fullOddsRaw.stats.ln_chains_mean, 6),
    ln_chains_std: roundTo(fullOddsRaw.stats.ln_chains_std, 6),
  };
  const oddsCatLogOdds: Record<string, number> = {};
  for (const [cat, lo] of [...fullOddsRaw.catLogOdds.entries()].sort((a, b) =>
    asciiCompare(a[0], b[0]),
  )) {
    oddsCatLogOdds[cat] = roundTo(lo, 6);
  }

  const oddsModelFit: OddsModelFit = {
    kept_terms: [...activeOddsTerms],
    base_rate: oddsBaseRate,
    base_brier_loo: roundTo(baseOddsRes.looBrier, 4),
    base_brier_wf: roundTo(baseOddsRes.wfBrier, 4),
    final_brier_loo: roundTo(curOddsRes.looBrier, 4),
    final_brier_wf: roundTo(curOddsRes.wfBrier, 4),
    lambda_ridge: MODEL_CONFIG.oddsLambdaRidge,
    category_prior_m: MODEL_CONFIG.oddsCategoryPriorM,
    intercept: oddsIntercept,
    beta_years: oddsBetaYears,
    beta_cat_share: oddsBetaCat,
    beta_ln_tvl: oddsBetaTvl,
    beta_growth: oddsBetaGrowth,
    beta_chains: oddsBetaChains,
    feature_stats: oddsStats,
    category_token_logodds: oddsCatLogOdds,
    odds_clamp: { min: MODEL_CONFIG.oddsClampMin, max: MODEL_CONFIG.oddsClampMax },
    training_count: oddsRows.length,
    wf_eval_count: Math.max(0, wfOddsRows.length - MODEL_CONFIG.wfWarmup),
  };

  // 4. Score all ranked candidates using exact exported rounded parameters (so client verification is 0-diff!)
  const catPeerCountMap = new Map<string, number>();
  for (const vr of valueRows) {
    catPeerCountMap.set(vr.category, (catPeerCountMap.get(vr.category) ?? 0) + 1);
  }
  const defaultShare = clamp(oddsBaseRate, 0.02, 0.98);
  const defaultCatLo = Math.log(defaultShare / (1 - defaultShare));

  const rawCandidates: Omit<ScoredCandidate, "rank">[] = [];
  for (const p of candidateProtocols) {
    const isWatchlist = watchlistSet.has(p.slug);
    const category = normalizeCategory(p.category);
    const tvl_usd = p.tvl_usd;
    const change_7d = p.change_7d;
    const age_days = ageDaysFromIso(snapshot.as_of, p.listed_at);
    const chains = p.chains.length > 0 ? [...p.chains] : ["Multi-Chain"];
    const lnTvl = Math.log(Math.max(tvl_usd, 1));
    const growthC = clamp(change_7d ?? 0, -60, 60) / 100;
    const lnChains = Math.log(Math.max(1, chains.length));
    const yearsListed = age_days !== null ? age_days / 365.25 : null;

    // Model A exact scoring from exported params
    const lnPowerLaw = valAlpha + valBetaTvl * lnTvl;
    const uCat = valCatEffects[category] ?? 0;
    const uGrowth =
      valBetaGrowth * ((growthC - valStats.growth_mean) / valStats.growth_std);
    const uChains =
      valBetaChains * ((lnChains - valStats.ln_chains_mean) / valStats.ln_chains_std);
    const uMat =
      valBetaMaturity *
      (((yearsListed ?? valStats.median_years_listed) - valStats.years_mean) / valStats.years_std);
    const lnLaunch = lnPowerLaw + uCat + uGrowth + uChains + uMat;
    const launch_value_usd = Math.max(1, Math.round(Math.exp(lnLaunch)));

    // Model B exact scoring from exported params
    let z = oddsIntercept;
    z +=
      oddsBetaYears *
      (((yearsListed ?? oddsStats.median_years_listed) - oddsStats.years_mean) / oddsStats.years_std);
    const catLo = oddsCatLogOdds[category] ?? defaultCatLo;
    z += oddsBetaCat * ((catLo - oddsStats.cat_logodds_mean) / oddsStats.cat_logodds_std);
    z += oddsBetaTvl * ((lnTvl - oddsStats.ln_tvl_mean) / oddsStats.ln_tvl_std);
    z += oddsBetaGrowth * ((growthC - oddsStats.growth_mean) / oddsStats.growth_std);
    z += oddsBetaChains * ((lnChains - oddsStats.ln_chains_mean) / oddsStats.ln_chains_std);
    const token_odds = roundTo(
      clamp(sigmoid(z), MODEL_CONFIG.oddsClampMin, MODEL_CONFIG.oddsClampMax),
      4,
    );

    const implied_value_usd = Math.max(1, Math.round(launch_value_usd * token_odds));
    const implied_p10_usd = Math.max(1, Math.round(implied_value_usd * Math.exp(q10)));
    const implied_p25_usd = Math.max(implied_p10_usd, Math.round(implied_value_usd * Math.exp(q25)));
    const implied_p75_usd = Math.max(implied_value_usd, Math.round(implied_value_usd * Math.exp(q75)));
    const implied_p90_usd = Math.max(implied_p75_usd, Math.round(implied_value_usd * Math.exp(q90)));

    // Nearest 4 traded comparables (same category first, then closest ln(TVL))
    const nearest_peers: NearestPeer[] = [...valueRows]
      .sort((a, b) => {
        const aSame = a.category === category ? 0 : 1;
        const bSame = b.category === category ? 0 : 1;
        if (aSame !== bSame) return aSame - bSame;
        const da = Math.abs(lnTvl - a.ln_tvl);
        const db = Math.abs(lnTvl - b.ln_tvl);
        if (Math.abs(da - db) > 1e-12) return da - db;
        return asciiCompare(a.protocol.slug, b.protocol.slug);
      })
      .slice(0, 4)
      .map((peer) => ({
        slug: peer.protocol.slug,
        name: peer.protocol.name,
        symbol: peer.protocol.symbol,
        category: peer.category,
        tvl_usd: peer.tvl_usd,
        mcap_usd: peer.mcap_usd,
        mcap_tvl_ratio: roundTo(peer.mcap_usd / peer.tvl_usd, 3),
        same_category: peer.category === category,
      }));

    const peerCount = catPeerCountMap.get(category) ?? 0;
    const data_flags: string[] = [];
    if (change_7d === null) data_flags.push("MISSING_7D_CHANGE");
    if (age_days === null) data_flags.push("MISSING_LISTED_AT");
    if (peerCount < 3) data_flags.push("SPARSE_CATEGORY_PEERS");

    rawCandidates.push({
      slug: p.slug,
      name: p.name,
      category,
      chains,
      tvl_usd,
      change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      age_days,
      is_watchlist: isWatchlist,
      launch_value_usd,
      token_odds,
      implied_value_usd,
      implied_p10_usd,
      implied_p25_usd,
      implied_p75_usd,
      implied_p90_usd,
      multiple: roundTo(implied_value_usd / tvl_usd, 4),
      breakdown: {
        ln_tvl_contrib: roundTo(lnPowerLaw, 4),
        power_law_usd: Math.max(1, Math.round(Math.exp(lnPowerLaw))),
        category_multiplier: roundTo(Math.exp(uCat), 4),
        growth_multiplier: roundTo(Math.exp(uGrowth), 4),
        chains_multiplier: roundTo(Math.exp(uChains), 4),
        maturity_multiplier: roundTo(Math.exp(uMat), 4),
        launch_value_usd,
        token_odds,
        implied_value_usd,
        category_peer_count: peerCount,
      },
      nearest_peers,
      data_flags,
    });
  }

  rawCandidates.sort(
    (a, b) =>
      b.implied_value_usd - a.implied_value_usd ||
      b.tvl_usd - a.tvl_usd ||
      asciiCompare(a.slug, b.slug),
  );

  const candidates: ScoredCandidate[] = rawCandidates.map((c, idx) => ({
    rank: idx + 1,
    ...c,
  }));

  const live_comparables: LiveComparable[] = valueRows
    .map((r, i) => {
      const predUsd = Math.max(1, Math.round(Math.exp(curValueRes.looPreds[i]!)));
      const missRatio = Math.exp(Math.abs(curValueRes.looPreds[i]! - r.ln_mcap));
      return {
        slug: r.protocol.slug,
        name: r.protocol.name,
        symbol: r.protocol.symbol,
        category: r.category,
        chains: r.protocol.chains,
        tvl_usd: r.tvl_usd,
        mcap_usd: r.mcap_usd,
        change_7d: r.protocol.change_7d,
        listed_at: r.protocol.listed_at,
        actual_multiple: roundTo(r.mcap_usd / r.tvl_usd, 4),
        loocv_launch_usd: predUsd,
        loocv_miss_ratio: roundTo(missRatio, 2),
      };
    })
    .sort((a, b) => b.mcap_usd - a.mcap_usd || asciiCompare(a.slug, b.slug));

  return {
    calibration: {
      model_version: MODEL_CONFIG.version,
      as_of: snapshot.as_of,
      floor_usd: snapshot.floor_usd,
      accounting,
      value_model: valueModelFit,
      value_ladder: valueLadder,
      range_honesty: rangeHonesty,
      odds_model: oddsModelFit,
      odds_ladder: oddsLadder,
    },
    candidates,
    live_comparables,
  };
}
