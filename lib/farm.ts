/**
 * Token Launch Radar — Deterministic Net-to-the-Dollar 7-Step Farm Plan Engine
 * Runtime: Node.js 22.18+ (erasable TypeScript syntax, standard library only, 0 network)
 *
 * Selects the lowest-gas chain from candidate.chains (tie-break ASCII), computes
 * category-specific 7-step farming actions with exact dollar costs (gas + protocol fee
 * + opportunity cost), break-even capital, strict penny-level reconciliation, and
 * gate-compliant concise farm_steps strings.
 */

import { asciiCompare, clamp, roundTo } from "./model.ts";
import type { ScoredCandidate } from "./model.ts";

export type ViabilityTier = "VIABLE" | "WHALE_ONLY" | "NEGATIVE";

export interface FarmStep {
  step: number;
  title: string;
  action: string;
  gas_multiplier: number;
  gas_cost_usd: number;
  fee_cost_usd: number;
  opp_cost_usd: number;
  step_total_usd: number;
  active_minutes: number;
  holding_days: number;
}

export interface FarmEconomics {
  capital_usd: number;
  gross_ev_usd: number;
  gas_total_usd: number;
  fee_total_usd: number;
  opp_cost_usd: number;
  total_cost_usd: number;
  net_ev_usd: number;
  net_ev_low_usd: number;
  net_ev_high_usd: number;
  net_roi_pct: number;
  break_even_capital_usd: number | null;
  viability_tier: ViabilityTier;
}

export interface FarmPlan {
  optimal_chain: string;
  chain_gas_unit_usd: number;
  category_fee_bps: number;
  holding_days: number;
  launch_prob: number;
  total_active_minutes: number;
  economics: FarmEconomics;
  steps: FarmStep[];
  farm_steps: string[];
  risks: string[];
}

export const FARM_CONSTANTS = {
  defaultCapitalUsd: 2_500,
  airdropPoolShare: 0.05,
  eligibleTvlShare: 0.7,
  riskFreeAnnualRate: 0.045,
  defaultGasUnitUsd: 0.5,
  defaultCategoryFeeBps: 20,
  chainGasUsd: {
    ethereum: 3.5,
    bitcoin: 4.0,
    tron: 0.35,
    avalanche: 0.2,
    scroll: 0.18,
    linea: 0.18,
    arbitrum: 0.15,
    binance: 0.15,
    bsc: 0.15,
    zksync: 0.15,
    "zksync era": 0.15,
    blast: 0.15,
    berachain: 0.15,
    base: 0.12,
    optimism: 0.12,
    mantle: 0.1,
    mode: 0.1,
    polygon: 0.08,
    unichain: 0.08,
    ink: 0.08,
    hemi: 0.08,
    soneium: 0.08,
    hyperliquid: 0.05,
    "hyperliquid l1": 0.05,
    plasma: 0.05,
    "robinhood chain": 0.05,
    "plume mainnet": 0.05,
    starknet: 0.05,
    cronos: 0.05,
    bittensor: 0.05,
    katana: 0.05,
    fantom: 0.03,
    monad: 0.02,
    sonic: 0.02,
    ton: 0.02,
    gnosis: 0.02,
    xdai: 0.02,
    noble: 0.02,
    celo: 0.02,
    solana: 0.01,
    sui: 0.01,
    aptos: 0.01,
    near: 0.01,
    sei: 0.01,
    algorand: 0.01,
  } as Record<string, number>,
  categoryFeeBps: {
    lending: 10,
    "uncollateralized lending": 12,
    "collateral markets": 12,
    yield: 10,
    "yield aggregator": 10,
    "risk curators": 10,
    "onchain capital allocator": 10,
    payments: 10,
    "liquid staking": 10,
    "staking pool": 10,
    "liquid restaking": 12,
    restaking: 12,
    cdp: 15,
    "cdp manager": 15,
    "basis trading": 15,
    derivatives: 15,
    "interest rate derivatives": 15,
    perps: 15,
    rwa: 15,
    farm: 15,
    "dual-token stablecoin": 15,
    "stablecoin wrapper": 15,
    "anchor btc": 15,
    "decentralized btc": 15,
    cedefi: 15,
    "crypto card issuer": 15,
    insurance: 20,
    indexes: 20,
    "leveraged farming": 20,
    "governance incentives": 20,
    "otc marketplace": 20,
    "cross chain": 20,
    "cross chain bridge": 20,
    bridge: 20,
    chain: 15,
    "prediction market": 25,
    dexs: 55,
    dex: 55,
    amm: 55,
    "liquidity manager": 45,
  } as Record<string, number>,
} as const;

export function getChainGasUnit(chain: string): number {
  const key = chain.trim().toLowerCase();
  return FARM_CONSTANTS.chainGasUsd[key] ?? FARM_CONSTANTS.defaultGasUnitUsd;
}

export function getCategoryFeeBps(category: string): number {
  const key = category.trim().toLowerCase();
  if (key in FARM_CONSTANTS.categoryFeeBps) {
    return FARM_CONSTANTS.categoryFeeBps[key]!;
  }
  if (key.includes("dex") || key.includes("amm") || key.includes("swap")) return 55;
  if (key.includes("lend") || key.includes("yield") || key.includes("vault") || key.includes("curator")) return 10;
  if (key.includes("perp") || key.includes("deriv") || key.includes("option") || key.includes("basis")) return 15;
  if (key.includes("restak") || key.includes("stak")) return 12;
  if (key.includes("predict")) return 25;
  return FARM_CONSTANTS.defaultCategoryFeeBps;
}

/**
 * Picks the lowest-gas chain from candidate.chains (tie-break ASCII ascending).
 */
export function selectOptimalChain(candidate: ScoredCandidate): string {
  if (candidate.chains.length > 0) {
    const sorted = [...candidate.chains].sort(
      (a, b) => getChainGasUnit(a) - getChainGasUnit(b) || asciiCompare(a, b),
    );
    return sorted[0]!;
  }
  return "Multi-Chain";
}

function deriveHoldingDays(ageDays: number | null): number {
  const effectiveAge = ageDays ?? 365;
  if (effectiveAge >= 365) return 60;
  if (effectiveAge >= 180) return 90;
  return 120;
}

/**
 * Conservative hump-shaped TGE probability weight in [0.25, 0.65],
 * peaking around 18 months (540 days) and tapering for very new or >4y protocols.
 */
function deriveLaunchProbability(ageDays: number | null): number {
  const effectiveAge = ageDays ?? 365;
  const years = effectiveAge / 365;
  const distFromPeak = Math.abs(Math.log(Math.max(years, 0.15) / 1.5));
  const raw = 0.65 * Math.exp(-0.45 * distFromPeak * distFromPeak);
  return roundTo(clamp(raw, 0.25, 0.65), 3);
}

function coreActionText(category: string, protocolName: string, chain: string): string {
  const key = category.toLowerCase();
  if (key.includes("lend") || key.includes("collateral")) {
    return `Supply blue-chip collateral on ${protocolName} (${chain}) below 40% LTV to accrue points safely`;
  }
  if (key.includes("dex") || key.includes("amm") || key.includes("liquidity")) {
    return `Provide correlated stablecoin LP on ${protocolName} (${chain}) to curb IL while logging fee volume`;
  }
  if (key.includes("perp") || key.includes("deriv") || key.includes("basis")) {
    return `Deposit margin and run delta-neutral volume cycles on ${protocolName} (${chain})`;
  }
  if (key.includes("restak") || key.includes("stak")) {
    return `Stake or restake base asset into ${protocolName} (${chain}) and hold receipt token`;
  }
  if (key.includes("curator") || key.includes("allocator")) {
    return `Deposit stablecoins into a curated ${protocolName} vault on ${chain} and hold vault shares`;
  }
  if (key.includes("predict")) {
    return `Fund account on ${protocolName} (${chain}) and open hedged binary market positions`;
  }
  if (key.includes("bridge") || key.includes("cross")) {
    return `Execute periodic organic bridge transfers via ${protocolName} using ${chain} as low-gas hub`;
  }
  return `Deposit stablecoin or base collateral into ${protocolName}'s core vault on ${chain}`;
}

export function computeFarmEconomics(
  candidate: ScoredCandidate,
  capitalUsd: number,
  gasTotalUsd: number,
  categoryFeeBps: number,
  holdingDays: number,
  launchProb: number,
): FarmEconomics {
  const feeRate = categoryFeeBps / 10_000;
  const oppRate = FARM_CONSTANTS.riskFreeAnnualRate * (holdingDays / 365);

  const feeTotalUsd = roundTo(capitalUsd * feeRate, 2);
  const oppCostUsd = roundTo(capitalUsd * oppRate, 2);
  const totalCostUsd = roundTo(gasTotalUsd + feeTotalUsd + oppCostUsd, 2);

  const yieldScale =
    (FARM_CONSTANTS.airdropPoolShare * launchProb) / FARM_CONSTANTS.eligibleTvlShare;

  const grossRateBase =
    candidate.tvl_usd > 0 ? (candidate.implied_value_usd / candidate.tvl_usd) * yieldScale : 0;
  const grossRateLow =
    candidate.tvl_usd > 0 ? (candidate.implied_low_usd / candidate.tvl_usd) * yieldScale : 0;
  const grossRateHigh =
    candidate.tvl_usd > 0 ? (candidate.implied_high_usd / candidate.tvl_usd) * yieldScale : 0;

  const grossEvUsd = roundTo(capitalUsd * grossRateBase, 2);
  const netEvUsd = roundTo(grossEvUsd - totalCostUsd, 2);
  const netEvLowUsd = roundTo(capitalUsd * grossRateLow - totalCostUsd, 2);
  const netEvHighUsd = roundTo(capitalUsd * grossRateHigh - totalCostUsd, 2);
  const netRoiPct = capitalUsd > 0 ? roundTo((netEvUsd / capitalUsd) * 100, 2) : 0;

  const netYieldPerDollar = grossRateBase - (feeRate + oppRate);
  let breakEvenCapitalUsd: number | null = null;
  let viabilityTier: ViabilityTier = "NEGATIVE";

  if (netYieldPerDollar > 1e-6) {
    breakEvenCapitalUsd = roundTo(gasTotalUsd / netYieldPerDollar, 2);
    viabilityTier = netEvUsd > 0 ? "VIABLE" : "WHALE_ONLY";
  }

  return {
    capital_usd: roundTo(capitalUsd, 2),
    gross_ev_usd: grossEvUsd,
    gas_total_usd: roundTo(gasTotalUsd, 2),
    fee_total_usd: feeTotalUsd,
    opp_cost_usd: oppCostUsd,
    total_cost_usd: totalCostUsd,
    net_ev_usd: netEvUsd,
    net_ev_low_usd: netEvLowUsd,
    net_ev_high_usd: netEvHighUsd,
    net_roi_pct: netRoiPct,
    break_even_capital_usd: breakEvenCapitalUsd,
    viability_tier: viabilityTier,
  };
}

function formatStepString(s: FarmStep, chain: string): string {
  const timeText =
    s.holding_days > 0
      ? `${s.active_minutes} min active / ${s.holding_days}d hold`
      : `${s.active_minutes} min`;
  const parts: string[] = [];
  if (s.gas_cost_usd > 0) parts.push(`gas $${s.gas_cost_usd.toFixed(2)}`);
  if (s.fee_cost_usd > 0) parts.push(`fee $${s.fee_cost_usd.toFixed(2)}`);
  if (s.opp_cost_usd > 0) parts.push(`opp $${s.opp_cost_usd.toFixed(2)}`);
  const breakdown = parts.length > 0 ? ` (${parts.join(" + ")})` : "";
  let line = `Step ${s.step} [${chain}]: ${s.action}. Cost: $${s.step_total_usd.toFixed(2)}${breakdown}. Time: ${timeText}.`;
  if (line.length > 240) {
    line = `${line.slice(0, 236)}...`;
  }
  return line;
}

export function buildFarmPlan(
  candidate: ScoredCandidate,
  capitalUsd: number = FARM_CONSTANTS.defaultCapitalUsd,
): FarmPlan {
  const optimalChain = selectOptimalChain(candidate);
  const chainGasUnitUsd = getChainGasUnit(optimalChain);
  const categoryFeeBps = getCategoryFeeBps(candidate.category);
  const holdingDays = deriveHoldingDays(candidate.age_days);
  const launchProb = deriveLaunchProbability(candidate.age_days);
  const maintenanceCycles = Math.max(1, Math.floor(holdingDays / 30));

  const feeRate = categoryFeeBps / 10_000;
  const halfFeeUsd = roundTo(capitalUsd * feeRate * 0.5, 2);
  const fullFeeUsd = roundTo(capitalUsd * feeRate, 2);
  const exitFeeUsd = roundTo(fullFeeUsd - halfFeeUsd, 2);
  const oppCostUsd = roundTo(
    capitalUsd * FARM_CONSTANTS.riskFreeAnnualRate * (holdingDays / 365),
    2,
  );

  const stepSpecs = [
    {
      step: 1,
      title: "Fund & Bridge to Optimal Chain",
      action: `Prepare $${capitalUsd.toLocaleString("en-US")} and bridge funds onto ${optimalChain} (lowest-gas chain for ${candidate.name})`,
      gasMultiplier: 1.5,
      feeCostUsd: 0,
      oppCostUsd: 0,
      activeMinutes: 10,
      holdingDays: 0,
    },
    {
      step: 2,
      title: "Verify Contracts & Risk Caps",
      action: `Verify official ${candidate.name} contracts on ${optimalChain}, check audit history, and cap exposure`,
      gasMultiplier: 0,
      feeCostUsd: 0,
      oppCostUsd: 0,
      activeMinutes: 10,
      holdingDays: 0,
    },
    {
      step: 3,
      title: "Convert Assets & Approve",
      action: `Swap into required ${candidate.category} asset(s) on ${optimalChain} and submit exact-amount approval`,
      gasMultiplier: 1.0,
      feeCostUsd: halfFeeUsd,
      oppCostUsd: 0,
      activeMinutes: 5,
      holdingDays: 0,
    },
    {
      step: 4,
      title: "Execute Core Farming Position",
      action: coreActionText(candidate.category, candidate.name, optimalChain),
      gasMultiplier: 2.0,
      feeCostUsd: 0,
      oppCostUsd: 0,
      activeMinutes: 10,
      holdingDays: 0,
    },
    {
      step: 5,
      title: "Maintain Organic Cadence",
      action: `Run ${maintenanceCycles} monthly maintenance tx(s) across ${holdingDays}d on ${optimalChain} to clear sybil checks`,
      gasMultiplier: maintenanceCycles * 1.0,
      feeCostUsd: 0,
      oppCostUsd: 0,
      activeMinutes: maintenanceCycles * 5,
      holdingDays,
    },
    {
      step: 6,
      title: "Claim & Realize TGE Allocation",
      action: `Claim ${candidate.name} allocation at TGE on ${optimalChain} via official portal and convert to stablecoins`,
      gasMultiplier: 2.5,
      feeCostUsd: exitFeeUsd,
      oppCostUsd: 0,
      activeMinutes: 10,
      holdingDays: 0,
    },
    {
      step: 7,
      title: "Unwind Principal & Reconcile P&L",
      action: `Withdraw principal from ${candidate.name} on ${optimalChain} and book ${holdingDays}d risk-free opportunity cost`,
      gasMultiplier: 1.5,
      feeCostUsd: 0,
      oppCostUsd,
      activeMinutes: 10,
      holdingDays: 0,
    },
  ];

  const steps: FarmStep[] = stepSpecs.map((s) => {
    const gasCostUsd = roundTo(chainGasUnitUsd * s.gasMultiplier, 2);
    const stepTotalUsd = roundTo(gasCostUsd + s.feeCostUsd + s.oppCostUsd, 2);
    return {
      step: s.step,
      title: s.title,
      action: s.action,
      gas_multiplier: s.gasMultiplier,
      gas_cost_usd: gasCostUsd,
      fee_cost_usd: s.feeCostUsd,
      opp_cost_usd: s.oppCostUsd,
      step_total_usd: stepTotalUsd,
      active_minutes: s.activeMinutes,
      holding_days: s.holdingDays,
    };
  });

  const gasTotalUsd = roundTo(
    steps.reduce((acc, s) => acc + s.gas_cost_usd, 0),
    2,
  );
  const economics = computeFarmEconomics(
    candidate,
    capitalUsd,
    gasTotalUsd,
    categoryFeeBps,
    holdingDays,
    launchProb,
  );

  // Strict penny reconciliation check
  const sumSteps = roundTo(
    steps.reduce((acc, s) => acc + s.step_total_usd, 0),
    2,
  );
  if (Math.abs(sumSteps - economics.total_cost_usd) >= 0.01) {
    throw new Error(
      `Farm cost reconciliation mismatch for ${candidate.slug}: steps=${sumSteps}, total=${economics.total_cost_usd}`,
    );
  }

  const farm_steps = steps.map((s) => formatStepString(s, optimalChain));

  const risks: string[] = [
    `DefiLlama records no token for ${candidate.name}; no guarantee it will launch a token or reward retroactive users (launch weight ${(launchProb * 100).toFixed(0)}%).`,
    `Smart-contract, liquidity, and depeg risk on ${optimalChain} throughout the ${holdingDays}-day holding window.`,
  ];
  if (candidate.category_fallback) {
    risks.push(
      `Category "${candidate.category}" has fewer than 3 live peers (${candidate.category_peer_count}); valuation uses shrunk global fallback.`,
    );
  }
  if (economics.viability_tier === "NEGATIVE") {
    risks.push(
      `Structurally net-negative under base assumptions: fee + opportunity cost exceed expected pro-rata airdrop yield.`,
    );
  } else if (
    economics.viability_tier === "WHALE_ONLY" &&
    economics.break_even_capital_usd !== null
  ) {
    risks.push(
      `Gas-negative at $${capitalUsd.toLocaleString("en-US")}; requires at least $${economics.break_even_capital_usd.toLocaleString("en-US")} to break even.`,
    );
  }

  const totalActiveMinutes = steps.reduce((acc, s) => acc + s.active_minutes, 0);

  return {
    optimal_chain: optimalChain,
    chain_gas_unit_usd: chainGasUnitUsd,
    category_fee_bps: categoryFeeBps,
    holding_days: holdingDays,
    launch_prob: launchProb,
    total_active_minutes: totalActiveMinutes,
    economics,
    steps,
    farm_steps,
    risks,
  };
}
