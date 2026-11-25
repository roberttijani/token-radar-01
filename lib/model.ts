/**
 * Token Launch Radar — Out-of-Sample Calibrated Valuation Model
 * Runtime: Node.js 22.18+ (erasable TypeScript syntax, standard library only, 0 network)
 *
 * Reads the sealed 10-field DefiLlama snapshot, separates live-token comparables from
 * pre-token candidates using the official exclusion rules (zero hardcoded protocol names),
 * and fits a Two-Stage Empirical Bayes (category shrinkage) + Ridge regression model
 * calibrated by Leave-One-Out Cross-Validation (LOOCV).
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

export interface ModelFactors {
  base_multiple: number;
  category_factor: number;
  size_factor: number;
  momentum_factor: number;
  maturity_factor: number;
  chain_factor: number;
  raw_multiple: number;
  clamped_multiple: number;
}

export interface AuditMetrics {
  name: string;
  n: number;
  mdape: number;
  log_rmse: number;
  spearman_rho: number;
  within_2x_pct: number;
}

export interface CategoryStat {
  category: string;
  peer_count: number;
  raw_median_multiple: number | null;
  shrunk_factor: number;
  log_effect: number;
  is_global_fallback: boolean;
}

export interface FeatureStats {
  log_tvl_mean: number;
  log_tvl_std: number;
  median_age_days: number;
  age_lin_mean: number;
  age_lin_std: number;
  age_quad_mean: number;
  age_quad_std: number;
  chain_breadth_mean: number;
}

export interface CalibrationSummary {
  model_version: string;
  as_of: string;
  floor_usd: number;
  total_snapshot_protocols: number;
  live_token_total_count: number;
  training_count: number;
  candidate_count: number;
  watchlist_count: number;
  early_find_count: number;
  lambda_category: number;
  lambda_ridge: number;
  used_ridge_fallback: boolean;
  mu0: number;
  base_multiple: number;
  beta: {
    size: number;
    momentum: number;
    maturity_lin: number;
    maturity_quad: number;
    chains: number;
  };
  feature_stats: FeatureStats;
  category_effects: Record<string, number>;
  multiple_bounds: {
    min: number;
    max: number;
    log_min: number;
    log_max: number;
  };
  residual_quantiles: {
    p25: number;
    p75: number;
  };
  audit: {
    global_baseline: AuditMetrics;
    category_only: AuditMetrics;
    calibrated_model: AuditMetrics;
  };
  category_stats: CategoryStat[];
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
  category_peer_count: number;
  category_fallback: boolean;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  multiple: number;
  factors: ModelFactors;
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
  loocv_implied_usd: number;
  loocv_error_pct: number;
}

export interface ModelOutput {
  calibration: CalibrationSummary;
  candidates: ScoredCandidate[];
  live_comparables: LiveComparable[];
}

/**
 * Official watchlist exclusion criteria from input/README.md applied uniformly
 * across the protocol universe (no hardcoded protocol names).
 */
export const MODEL_CONFIG = {
  version: "eb-ridge-loocv-v1",
  minTrainingTvlUsd: 5_000_000,
  minCandidateTvlUsd: 5_000_000,
  hardMinMultiple: 0.01,
  hardMaxMultiple: 5.0,
  lambdaCategoryGrid: [2, 4, 8] as const,
  lambdaRidgeGrid: [1, 5, 15, 40] as const,
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
// Deterministic numeric & string utilities
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

function ranksWithTies(values: readonly number[]): number[] {
  const indexed = values.map((v, idx) => ({ v, idx }));
  indexed.sort((a, b) => a.v - b.v || a.idx - b.idx);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) {
      j++;
    }
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      ranks[indexed[k]!.idx] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

export function spearmanCorrelation(
  xs: readonly number[],
  ys: readonly number[],
): number {
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

/**
 * Deterministic Gaussian elimination with partial pivoting for small dense systems (p = 5).
 */
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
    if (maxAbs < 1e-12) {
      return new Array<number>(n).fill(0);
    }
    if (pivotRow !== col) {
      const tmp = A[col]!;
      A[col] = A[pivotRow]!;
      A[pivotRow] = tmp;
    }
    const pivot = A[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const factor = A[r]![col]! / pivot;
      for (let c = col; c <= n; c++) {
        A[r]![c]! -= factor * A[col]![c]!;
      }
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = A[r]![n]!;
    for (let c = r + 1; c < n; c++) {
      sum -= A[r]![c]! * x[c]!;
    }
    x[r] = sum / A[r]![r]!;
  }
  return x;
}

// ---------------------------------------------------------------------------
// Snapshot parsing & universe classification
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
      listed_at: typeof p.listed_at === "string" && p.listed_at.trim().length > 0 ? p.listed_at.trim() : null,
      gecko_id: typeof p.gecko_id === "string" && p.gecko_id.trim().length > 0 ? p.gecko_id.trim() : null,
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

export function isExcludedProtocol(
  p: SnapshotProtocol,
  watchlistSet: ReadonlySet<string>,
): boolean {
  if (watchlistSet.has(p.slug)) return false;
  const cat = normalizeCategory(p.category);
  if (MODEL_CONFIG.excludedCategories.has(cat)) return true;
  if (MODEL_CONFIG.versionedNamePattern.test(p.name)) return true;
  if (MODEL_CONFIG.excludedNameWordPattern.test(p.name)) return true;
  if (MODEL_CONFIG.exchangePrefixPattern.test(p.name)) return true;
  return false;
}

export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null && p.mcap_usd === null;
}

export function isTrainingComparable(
  p: SnapshotProtocol,
  watchlistSet: ReadonlySet<string>,
): boolean {
  if (isExcludedProtocol(p, watchlistSet)) return false;
  return (
    p.mcap_usd !== null &&
    Number.isFinite(p.mcap_usd) &&
    p.mcap_usd > 0 &&
    p.tvl_usd >= MODEL_CONFIG.minTrainingTvlUsd
  );
}

export function isPreTokenCandidate(
  p: SnapshotProtocol,
  watchlistSet: ReadonlySet<string>,
): boolean {
  if (watchlistSet.has(p.slug)) return true;
  if (isExcludedProtocol(p, watchlistSet)) return false;
  return recordsNoToken(p) && p.tvl_usd >= MODEL_CONFIG.minCandidateTvlUsd;
}

interface RawRow {
  protocol: SnapshotProtocol;
  category: string;
  tvl_usd: number;
  mcap_usd: number;
  rawLogMultiple: number;
  yWinsorized: number;
  change7d: number | null;
  ageDays: number | null;
  chainCount: number;
}

export function buildFeatureVector(
  tvlUsd: number,
  change7d: number | null,
  ageDays: number | null,
  chainCount: number,
  stats: FeatureStats,
): [number, number, number, number, number] {
  const logTvl = Math.log(Math.max(tvlUsd, 100_000));
  const zTvl = clamp((logTvl - stats.log_tvl_mean) / stats.log_tvl_std, -3, 3);

  const growth =
    change7d === null || !Number.isFinite(change7d)
      ? 0
      : Math.tanh(clamp(change7d, -80, 300) / 60);

  const effectiveAge = ageDays === null ? stats.median_age_days : Math.max(0, ageDays);
  const a = Math.log(1 + effectiveAge / 365);
  const m1 = clamp((a - stats.age_lin_mean) / stats.age_lin_std, -3, 3);
  const m2 = clamp((a * a - stats.age_quad_mean) / stats.age_quad_std, -3, 3);

  const b = Math.log(1 + Math.min(Math.max(1, chainCount), 15)) - stats.chain_breadth_mean;
  return [zTvl, growth, m1, m2, b];
}

function computeAuditMetrics(
  name: string,
  actualLogMultiples: readonly number[],
  predLogMultiples: readonly number[],
  tvls: readonly number[],
): AuditMetrics {
  const n = actualLogMultiples.length;
  if (n === 0) {
    return { name, n: 0, mdape: 0, log_rmse: 0, spearman_rho: 0, within_2x_pct: 0 };
  }
  const apes: number[] = [];
  let sqErrSum = 0;
  let within2x = 0;
  const actualMcaps: number[] = [];
  const predMcaps: number[] = [];

  for (let i = 0; i < n; i++) {
    const actualMult = Math.exp(actualLogMultiples[i]!);
    const predMult = Math.exp(predLogMultiples[i]!);
    apes.push(Math.abs(predMult - actualMult) / actualMult);
    const diff = predLogMultiples[i]! - actualLogMultiples[i]!;
    sqErrSum += diff * diff;
    const ratio = predMult / actualMult;
    if (ratio >= 0.5 && ratio <= 2.0) within2x++;
    actualMcaps.push(tvls[i]! * actualMult);
    predMcaps.push(tvls[i]! * predMult);
  }

  return {
    name,
    n,
    mdape: roundTo(median(apes) * 100, 2),
    log_rmse: roundTo(Math.sqrt(sqErrSum / n), 4),
    spearman_rho: roundTo(spearmanCorrelation(actualMcaps, predMcaps), 4),
    within_2x_pct: roundTo((within2x / n) * 100, 1),
  };
}

function fitCategoryEffects(
  rows: readonly RawRow[],
  lambdaC: number,
  skipIdx: number,
): { mu0: number; effects: Map<string, number> } {
  const ys: number[] = [];
  const byCat = new Map<string, number[]>();

  for (let i = 0; i < rows.length; i++) {
    if (i === skipIdx) continue;
    const row = rows[i]!;
    ys.push(row.yWinsorized);
    let list = byCat.get(row.category);
    if (!list) {
      list = [];
      byCat.set(row.category, list);
    }
    list.push(row.yWinsorized);
  }

  const mu0 = median(ys);
  const effects = new Map<string, number>();
  for (const [cat, vals] of byCat.entries()) {
    const nCat = vals.length;
    const shrunk = (nCat / (nCat + lambdaC)) * (median(vals) - mu0);
    effects.set(cat, shrunk);
  }
  return { mu0, effects };
}

function fitRidge(
  X: readonly (readonly number[])[],
  residuals: readonly number[],
  lambdaR: number,
  skipIdx: number,
): number[] {
  const p = 5;
  const XtX: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const Xtr = new Array<number>(p).fill(0);

  for (let i = 0; i < X.length; i++) {
    if (i === skipIdx) continue;
    const xi = X[i]!;
    const ri = residuals[i]!;
    for (let r = 0; r < p; r++) {
      Xtr[r]! += xi[r]! * ri;
      for (let c = r; c < p; c++) {
        XtX[r]![c]! += xi[r]! * xi[c]!;
      }
    }
  }
  for (let r = 0; r < p; r++) {
    XtX[r]![r]! += lambdaR;
    for (let c = 0; c < r; c++) {
      XtX[r]![c] = XtX[c]![r]!;
    }
  }
  return solveLinearSystem(XtX, Xtr);
}

// ---------------------------------------------------------------------------
// Main model calibration & scoring entrypoint
// ---------------------------------------------------------------------------

export function runValuationModel(snapshot: Snapshot): ModelOutput {
  const watchlistSet = new Set<string>(snapshot.watchlist);
  const sortedProtocols = [...snapshot.protocols].sort((a, b) => asciiCompare(a.slug, b.slug));

  const liveTokenTotalCount = sortedProtocols.filter((p) => !recordsNoToken(p)).length;

  const trainingDraft: RawRow[] = [];
  for (const p of sortedProtocols) {
    if (!isTrainingComparable(p, watchlistSet)) continue;
    const tvl_usd = p.tvl_usd;
    const mcap_usd = p.mcap_usd as number;
    const rawLogMultiple = Math.log(mcap_usd / tvl_usd);
    if (!Number.isFinite(rawLogMultiple)) continue;
    trainingDraft.push({
      protocol: p,
      category: normalizeCategory(p.category),
      tvl_usd,
      mcap_usd,
      rawLogMultiple,
      yWinsorized: rawLogMultiple,
      change7d: p.change_7d,
      ageDays: ageDaysFromIso(snapshot.as_of, p.listed_at),
      chainCount: Math.max(1, p.chains.length),
    });
  }

  // Data-driven winsorization [max(P5, ln 0.01), min(P95, ln 5.0)]
  const sortedRawY = trainingDraft.map((r) => r.rawLogMultiple).sort((a, b) => a - b);
  const winLo = Math.max(quantile(sortedRawY, 0.05), Math.log(MODEL_CONFIG.hardMinMultiple));
  const winHi = Math.min(quantile(sortedRawY, 0.95), Math.log(MODEL_CONFIG.hardMaxMultiple));
  const boundLo = roundTo(
    Math.max(quantile(sortedRawY, 0.02), Math.log(MODEL_CONFIG.hardMinMultiple)),
    6,
  );
  const boundHi = roundTo(
    Math.min(quantile(sortedRawY, 0.98), Math.log(MODEL_CONFIG.hardMaxMultiple)),
    6,
  );

  for (const r of trainingDraft) {
    r.yWinsorized = clamp(r.rawLogMultiple, winLo, winHi);
  }

  // Feature standardization statistics from training set (rounded deterministically so client verification is exact)
  const logTvls = trainingDraft.map((r) => Math.log(Math.max(r.tvl_usd, 100_000)));
  const logTvlMean = roundTo(mean(logTvls), 6);
  const logTvlStd = roundTo(stdDev(logTvls, logTvlMean), 6);

  const validAges = trainingDraft
    .map((r) => r.ageDays)
    .filter((d): d is number => d !== null);
  const medianAgeDays = validAges.length > 0 ? roundTo(median(validAges), 2) : 365;

  const ageLins = trainingDraft.map((r) =>
    Math.log(1 + (r.ageDays ?? medianAgeDays) / 365),
  );
  const ageQuads = ageLins.map((a) => a * a);
  const ageLinMean = roundTo(mean(ageLins), 6);
  const ageLinStd = roundTo(stdDev(ageLins, ageLinMean), 6);
  const ageQuadMean = roundTo(mean(ageQuads), 6);
  const ageQuadStd = roundTo(stdDev(ageQuads, ageQuadMean), 6);

  const chainBreadths = trainingDraft.map((r) =>
    Math.log(1 + Math.min(Math.max(1, r.chainCount), 15)),
  );
  const chainBreadthMean = roundTo(mean(chainBreadths), 6);

  const featureStats: FeatureStats = {
    log_tvl_mean: logTvlMean,
    log_tvl_std: logTvlStd,
    median_age_days: medianAgeDays,
    age_lin_mean: ageLinMean,
    age_lin_std: ageLinStd,
    age_quad_mean: ageQuadMean,
    age_quad_std: ageQuadStd,
    chain_breadth_mean: chainBreadthMean,
  };

  const X = trainingDraft.map((r) =>
    buildFeatureVector(r.tvl_usd, r.change7d, r.ageDays, r.chainCount, featureStats),
  );
  const actualLogMultiples = trainingDraft.map((r) => r.rawLogMultiple);
  const trainTvls = trainingDraft.map((r) => r.tvl_usd);

  // Baseline 1: Global Median LOOCV
  const globalPreds = trainingDraft.map((_, i) => {
    const ys: number[] = [];
    for (let j = 0; j < trainingDraft.length; j++) {
      if (j !== i) ys.push(trainingDraft[j]!.yWinsorized);
    }
    return median(ys);
  });
  const globalAudit = computeAuditMetrics(
    "Global Median Baseline",
    actualLogMultiples,
    globalPreds,
    trainTvls,
  );

  // Grid search LOOCV for (lambdaCategory, lambdaRidge)
  let bestLambdaC: number = MODEL_CONFIG.lambdaCategoryGrid[1];
  let bestLambdaR: number = MODEL_CONFIG.lambdaRidgeGrid[1];
  let bestCalibratedPreds: number[] = globalPreds;
  let bestCalibratedAudit = globalAudit;

  let bestCatOnlyPreds: number[] = globalPreds;
  let bestCatOnlyAudit: AuditMetrics | null = null;
  let bestCatOnlyLambdaC: number = MODEL_CONFIG.lambdaCategoryGrid[1];

  for (const lambdaC of MODEL_CONFIG.lambdaCategoryGrid) {
    const catOnlyPreds: number[] = new Array<number>(trainingDraft.length);
    for (let i = 0; i < trainingDraft.length; i++) {
      const { mu0, effects } = fitCategoryEffects(trainingDraft, lambdaC, i);
      catOnlyPreds[i] = clamp(
        mu0 + (effects.get(trainingDraft[i]!.category) ?? 0),
        boundLo,
        boundHi,
      );
    }
    const catAudit = computeAuditMetrics(
      "Category Median Only",
      actualLogMultiples,
      catOnlyPreds,
      trainTvls,
    );
    if (
      bestCatOnlyAudit === null ||
      catAudit.mdape < bestCatOnlyAudit.mdape ||
      (catAudit.mdape === bestCatOnlyAudit.mdape && catAudit.log_rmse < bestCatOnlyAudit.log_rmse)
    ) {
      bestCatOnlyAudit = catAudit;
      bestCatOnlyPreds = catOnlyPreds;
      bestCatOnlyLambdaC = lambdaC;
    }

    for (const lambdaR of MODEL_CONFIG.lambdaRidgeGrid) {
      const looPreds: number[] = new Array<number>(trainingDraft.length);
      for (let i = 0; i < trainingDraft.length; i++) {
        const { mu0, effects } = fitCategoryEffects(trainingDraft, lambdaC, i);
        const residuals = trainingDraft.map(
          (r) => r.yWinsorized - (mu0 + (effects.get(r.category) ?? 0)),
        );
        const beta = fitRidge(X, residuals, lambdaR, i);
        const xi = X[i]!;
        const linearTerm =
          beta[0]! * xi[0]! +
          beta[1]! * xi[1]! +
          beta[2]! * xi[2]! +
          beta[3]! * xi[3]! +
          beta[4]! * xi[4]!;
        looPreds[i] = clamp(
          mu0 + (effects.get(trainingDraft[i]!.category) ?? 0) + linearTerm,
          boundLo,
          boundHi,
        );
      }
      const audit = computeAuditMetrics(
        "Empirical Bayes + Ridge (LOOCV)",
        actualLogMultiples,
        looPreds,
        trainTvls,
      );
      if (
        audit.mdape < bestCalibratedAudit.mdape ||
        (audit.mdape === bestCalibratedAudit.mdape && audit.log_rmse < bestCalibratedAudit.log_rmse)
      ) {
        bestCalibratedAudit = audit;
        bestCalibratedPreds = looPreds;
        bestLambdaC = lambdaC;
        bestLambdaR = lambdaR;
      }
    }
  }

  const catOnlySummary = bestCatOnlyAudit ?? globalAudit;

  // Anti-overfitting guardrail: fall back to category-only if Ridge does not improve LOOCV MdAPE
  let usedRidgeFallback = false;
  if (bestCalibratedAudit.mdape > catOnlySummary.mdape) {
    usedRidgeFallback = true;
    bestLambdaC = bestCatOnlyLambdaC;
    bestCalibratedPreds = bestCatOnlyPreds;
    bestCalibratedAudit = {
      ...catOnlySummary,
      name: "Empirical Bayes (Category Fallback)",
    };
  }

  // Final full-sample fit using chosen hyperparameters; round parameters once so client recomputation is bit-identical
  const fullCatFit = fitCategoryEffects(trainingDraft, bestLambdaC, -1);
  const mu0 = roundTo(fullCatFit.mu0, 6);
  const categoryEffectsObj: Record<string, number> = {};
  for (const [cat, eff] of [...fullCatFit.effects.entries()].sort((a, b) => asciiCompare(a[0], b[0]))) {
    categoryEffectsObj[cat] = roundTo(eff, 6);
  }

  const fullResiduals = trainingDraft.map(
    (r) => r.yWinsorized - (mu0 + (categoryEffectsObj[r.category] ?? 0)),
  );
  const rawBeta = usedRidgeFallback
    ? [0, 0, 0, 0, 0]
    : fitRidge(X, fullResiduals, bestLambdaR, -1);
  const finalBeta = rawBeta.map((v) => roundTo(v, 6));

  // Empirical LOOCV residual quantiles for calibrated Low/High bands
  const looResiduals = trainingDraft
    .map((r, i) => r.rawLogMultiple - bestCalibratedPreds[i]!)
    .sort((a, b) => a - b);
  const q25 = roundTo(quantile(looResiduals, 0.25), 6);
  const q75 = roundTo(quantile(looResiduals, 0.75), 6);

  // Category statistics summary
  const catPeerValues = new Map<string, number[]>();
  for (const r of trainingDraft) {
    let list = catPeerValues.get(r.category);
    if (!list) {
      list = [];
      catPeerValues.set(r.category, list);
    }
    list.push(Math.exp(r.yWinsorized));
  }
  const categoryStats: CategoryStat[] = [...catPeerValues.entries()]
    .sort((a, b) => asciiCompare(a[0], b[0]))
    .map(([category, mults]) => {
      const logEff = categoryEffectsObj[category] ?? 0;
      return {
        category,
        peer_count: mults.length,
        raw_median_multiple: roundTo(median(mults), 4),
        shrunk_factor: roundTo(Math.exp(logEff), 4),
        log_effect: logEff,
        is_global_fallback: mults.length < 3,
      };
    });

  // Score all pre-token candidates
  const rawCandidates: Omit<ScoredCandidate, "rank">[] = [];
  let watchlistCount = 0;

  for (const p of sortedProtocols) {
    if (!isPreTokenCandidate(p, watchlistSet)) continue;
    const isWatchlist = watchlistSet.has(p.slug);
    if (isWatchlist) watchlistCount++;

    const category = normalizeCategory(p.category);
    const tvl_usd = p.tvl_usd;
    const change_7d = p.change_7d;
    const age_days = ageDaysFromIso(snapshot.as_of, p.listed_at);
    const chains = p.chains.length > 0 ? [...p.chains] : ["Multi-Chain"];
    const chainCount = Math.max(1, chains.length);

    const peerCount = catPeerValues.get(category)?.length ?? 0;
    const categoryFallback = peerCount < 3;
    const uCat = categoryEffectsObj[category] ?? 0;

    const dataFlags: string[] = [];
    if (change_7d === null) dataFlags.push("MISSING_7D_CHANGE");
    if (age_days === null) dataFlags.push("MISSING_LISTED_AT");
    if (categoryFallback) dataFlags.push("CATEGORY_GLOBAL_FALLBACK");

    const xi = buildFeatureVector(tvl_usd, change_7d, age_days, chainCount, featureStats);
    const sizeLog = finalBeta[0]! * xi[0]!;
    const momLog = finalBeta[1]! * xi[1]!;
    const matLog = finalBeta[2]! * xi[2]! + finalBeta[3]! * xi[3]!;
    const chainLog = finalBeta[4]! * xi[4]!;

    const rawLogPred = mu0 + uCat + sizeLog + momLog + matLog + chainLog;
    const clampedLogPred = clamp(rawLogPred, boundLo, boundHi);
    const clampedMultiple = Math.exp(clampedLogPred);

    const implied_value_usd = Math.max(1, Math.round(tvl_usd * clampedMultiple));
    const implied_low_usd = Math.max(1, Math.round(implied_value_usd * Math.exp(q25)));
    const implied_high_usd = Math.max(
      implied_value_usd,
      Math.round(implied_value_usd * Math.exp(q75)),
    );

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
      category_peer_count: peerCount,
      category_fallback: categoryFallback,
      implied_value_usd,
      implied_low_usd,
      implied_high_usd,
      multiple: roundTo(clampedMultiple, 4),
      factors: {
        base_multiple: roundTo(Math.exp(mu0), 4),
        category_factor: roundTo(Math.exp(uCat), 4),
        size_factor: roundTo(Math.exp(sizeLog), 4),
        momentum_factor: roundTo(Math.exp(momLog), 4),
        maturity_factor: roundTo(Math.exp(matLog), 4),
        chain_factor: roundTo(Math.exp(chainLog), 4),
        raw_multiple: roundTo(Math.exp(rawLogPred), 4),
        clamped_multiple: roundTo(clampedMultiple, 4),
      },
      data_flags: dataFlags,
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

  const live_comparables: LiveComparable[] = trainingDraft
    .map((r, i) => {
      const predVal = Math.max(1, Math.round(r.tvl_usd * Math.exp(bestCalibratedPreds[i]!)));
      return {
        slug: r.protocol.slug,
        name: r.protocol.name,
        symbol: r.protocol.symbol,
        category: r.category,
        chains: r.protocol.chains,
        tvl_usd: r.tvl_usd,
        mcap_usd: r.mcap_usd,
        change_7d: r.change7d === null ? null : roundTo(r.change7d, 2),
        listed_at: r.protocol.listed_at,
        actual_multiple: roundTo(r.mcap_usd / r.tvl_usd, 4),
        loocv_implied_usd: predVal,
        loocv_error_pct: roundTo(((predVal - r.mcap_usd) / r.mcap_usd) * 100, 1),
      };
    })
    .sort((a, b) => b.mcap_usd - a.mcap_usd || asciiCompare(a.slug, b.slug));

  return {
    calibration: {
      model_version: MODEL_CONFIG.version,
      as_of: snapshot.as_of,
      floor_usd: snapshot.floor_usd,
      total_snapshot_protocols: sortedProtocols.length,
      live_token_total_count: liveTokenTotalCount,
      training_count: trainingDraft.length,
      candidate_count: candidates.length,
      watchlist_count: watchlistCount,
      early_find_count: candidates.length - watchlistCount,
      lambda_category: bestLambdaC,
      lambda_ridge: bestLambdaR,
      used_ridge_fallback: usedRidgeFallback,
      mu0,
      base_multiple: roundTo(Math.exp(mu0), 4),
      beta: {
        size: finalBeta[0]!,
        momentum: finalBeta[1]!,
        maturity_lin: finalBeta[2]!,
        maturity_quad: finalBeta[3]!,
        chains: finalBeta[4]!,
      },
      feature_stats: featureStats,
      category_effects: categoryEffectsObj,
      multiple_bounds: {
        min: roundTo(Math.exp(boundLo), 4),
        max: roundTo(Math.exp(boundHi), 4),
        log_min: boundLo,
        log_max: boundHi,
      },
      residual_quantiles: {
        p25: q25,
        p75: q75,
      },
      audit: {
        global_baseline: globalAudit,
        category_only: catOnlySummary,
        calibrated_model: bestCalibratedAudit,
      },
      category_stats: categoryStats,
    },
    candidates,
    live_comparables,
  };
}
