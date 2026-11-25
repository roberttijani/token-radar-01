/**
 * Token Launch Radar (v2) — Net $/Hour Costed 8-Step Farm Engine, T-Bill Benchmark & 2D Sensitivity
 * Runtime: Node.js 22.18+ (erasable TypeScript syntax, standard library only, 0 network)
 *
 * Default scenario: $10,000 deposit, 7.0% airdrop share, 12-week (84-day) horizon, 4.0% APR T-bill benchmark.
 * Evaluates expected_drop_usd = implied_value_usd * drop_share * (deposit / (tvl_usd + deposit)),
 * subtracts exact 8-step costs (optimal low-gas chain gas + category fees + 4% T-bill benchmark),
 * reconciles step costs to the exact cent, produces Net $/Hour verdicts (FARM / MARGINAL / SKIP),
 * and generates a 4×4 Drop Share × Deposit sensitivity matrix.
 */

import { asciiCompare, roundTo } from "./model.ts";
import type { ScoredCandidate } from "./model.ts";

export type FarmVerdict = "FARM" | "MARGINAL" | "SKIP";

export interface FarmStep {
  step: number;
  when: string;
  title: string;
  action: string;
  gas_multiplier: number;
  gas_cost_usd: number;
  fee_cost_usd: number;
  tbill_cost_usd: number;
  cost_usd: number;
  minutes: number;
}

export interface SensitivityCell {
  drop_share: number;
  deposit_usd: number;
  net_usd: number;
  net_per_hour: number;
  verdict: FarmVerdict;
}

export interface FarmEconomics {
  deposit_usd: number;
  drop_share: number;
  horizon_weeks: number;
  horizon_days: number;
  expected_drop_usd: number;
  gas_total_usd: number;
  fee_total_usd: number;
  tbill_benchmark_usd: number;
  total_cost_usd: number;
  net_usd: number;
  net_p25_usd: number;
  net_p75_usd: number;
  hands_on_minutes: number;
  hands_on_hours: number;
  net_per_hour: number;
  break_even_deposit_usd: number | null;
  verdict: FarmVerdict;
}

export interface FarmPlan {
  optimal_chain: string;
  chain_gas_unit_usd: number;
  category_fee_bps: number;
  economics: FarmEconomics;
  sensitivity: SensitivityCell[];
  steps: FarmStep[];
  farm_steps: string[];
  risks: string[];
}

export const FARM_CONSTANTS = {
  defaultDepositUsd: 10_000,
  defaultDropShare: 0.07,
  defaultHorizonWeeks: 12,
  tbillAnnualRate: 0.04,
  farmHourlyThresholdUsd: 25,
  sensitivityDropShares: [0.03, 0.05, 0.07, 0.10] as const,
  sensitivityDeposits: [2_500, 10_000, 25_000, 50_000] as const,
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
  if (key in FARM_CONSTANTS.categoryFeeBps) return FARM_CONSTANTS.categoryFeeBps[key]!;
  if (key.includes("dex") || key.includes("amm") || key.includes("swap")) return 55;
  if (key.includes("lend") || key.includes("yield") || key.includes("vault") || key.includes("curator")) return 10;
  if (key.includes("perp") || key.includes("deriv") || key.includes("option") || key.includes("basis")) return 15;
  if (key.includes("restak") || key.includes("stak")) return 12;
  if (key.includes("predict")) return 25;
  return FARM_CONSTANTS.defaultCategoryFeeBps;
}

export function selectOptimalChain(candidate: ScoredCandidate): string {
  if (candidate.chains.length > 0) {
    const sorted = [...candidate.chains].sort(
      (a, b) => getChainGasUnit(a) - getChainGasUnit(b) || asciiCompare(a, b),
    );
    return sorted[0]!;
  }
  return "Multi-Chain";
}

function coreActionText(category: string, name: string, chain: string): string {
  const k = category.toLowerCase();
  if (k.includes("lend") || k.includes("collateral")) {
    return `Supply USDC/blue-chip collateral on ${name} (${chain}) under 40% LTV to accrue points safely`;
  }
  if (k.includes("dex") || k.includes("amm") || k.includes("liquidity")) {
    return `Provide correlated stablecoin LP on ${name} (${chain}) to curb IL while logging fee volume`;
  }
  if (k.includes("perp") || k.includes("deriv") || k.includes("basis")) {
    return `Deposit USDC margin and run delta-neutral volume cycles on ${name} (${chain})`;
  }
  if (k.includes("restak") || k.includes("stak")) {
    return `Stake or restake base asset into ${name} (${chain}) and hold receipt token`;
  }
  if (k.includes("curator") || k.includes("allocator")) {
    return `Deposit stablecoins into a curated ${name} vault on ${chain} and retain vault shares`;
  }
  if (k.includes("predict")) {
    return `Fund account on ${name} (${chain}) and open hedged binary positions`;
  }
  if (k.includes("bridge") || k.includes("cross")) {
    return `Execute periodic organic bridge transfers via ${name} using ${chain} as low-gas hub`;
  }
  return `Deposit stablecoins into ${name}'s primary vault on ${chain} and retain receipt shares`;
}

export function classifyVerdict(netUsd: number, netPerHour: number): FarmVerdict {
  if (netUsd <= 0) return "SKIP";
  return netPerHour >= FARM_CONSTANTS.farmHourlyThresholdUsd ? "FARM" : "MARGINAL";
}

/**
 * Exact quadratic break-even deposit solving:
 *   implied * drop_share * D / (tvl + D) - (feeRate + tbillRate) * D - gas = 0
 */
export function computeBreakEvenDeposit(
  impliedValueUsd: number,
  tvlUsd: number,
  dropShare: number,
  gasTotalUsd: number,
  feeRate: number,
  tbillRate: number,
): number | null {
  const A = impliedValueUsd * dropShare;
  const r = feeRate + tbillRate;
  const T = Math.max(1, tvlUsd);
  const G = Math.max(0, gasTotalUsd);
  if (r <= 1e-12) {
    if (A <= G) return null;
    return roundTo((G * T) / (A - G), 2);
  }
  const b = r * T + G - A;
  if (b >= 0) return null; // even at optimal D, yield cannot beat variable rate + gas
  const disc = b * b - 4 * r * G * T;
  if (disc < 0) return null;
  const root = (-b - Math.sqrt(disc)) / (2 * r);
  return root > 0 && Number.isFinite(root) ? roundTo(root, 2) : null;
}

export function computeFarmEconomics(
  candidate: ScoredCandidate,
  depositUsd: number,
  dropShare: number,
  horizonWeeks: number,
  gasTotalUsd: number,
  categoryFeeBps: number,
  handsOnMinutes: number,
): FarmEconomics {
  const horizonDays = horizonWeeks * 7;
  const feeRate = categoryFeeBps / 10_000;
  const tbillRate = FARM_CONSTANTS.tbillAnnualRate * (horizonDays / 365);

  const feeTotalUsd = roundTo(depositUsd * feeRate, 2);
  const tbillBenchmarkUsd = roundTo(depositUsd * tbillRate, 2);
  const totalCostUsd = roundTo(gasTotalUsd + feeTotalUsd + tbillBenchmarkUsd, 2);

  const share = depositUsd / (candidate.tvl_usd + depositUsd);
  const expectedDropUsd = roundTo(candidate.implied_value_usd * dropShare * share, 2);
  const p25DropUsd = roundTo(candidate.implied_p25_usd * dropShare * share, 2);
  const p75DropUsd = roundTo(candidate.implied_p75_usd * dropShare * share, 2);

  const netUsd = roundTo(expectedDropUsd - totalCostUsd, 2);
  const netP25Usd = roundTo(p25DropUsd - totalCostUsd, 2);
  const netP75Usd = roundTo(p75DropUsd - totalCostUsd, 2);

  const exactHours = handsOnMinutes / 60;
  const handsOnHours = roundTo(exactHours, 2);
  const netPerHour = exactHours > 0 ? roundTo(netUsd / exactHours, 2) : 0;
  const verdict = classifyVerdict(netUsd, netPerHour);
  const breakEvenDepositUsd = computeBreakEvenDeposit(
    candidate.implied_value_usd,
    candidate.tvl_usd,
    dropShare,
    gasTotalUsd,
    feeRate,
    tbillRate,
  );

  return {
    deposit_usd: roundTo(depositUsd, 2),
    drop_share: dropShare,
    horizon_weeks: horizonWeeks,
    horizon_days: horizonDays,
    expected_drop_usd: expectedDropUsd,
    gas_total_usd: roundTo(gasTotalUsd, 2),
    fee_total_usd: feeTotalUsd,
    tbill_benchmark_usd: tbillBenchmarkUsd,
    total_cost_usd: totalCostUsd,
    net_usd: netUsd,
    net_p25_usd: netP25Usd,
    net_p75_usd: netP75Usd,
    hands_on_minutes: handsOnMinutes,
    hands_on_hours: handsOnHours,
    net_per_hour: netPerHour,
    break_even_deposit_usd: breakEvenDepositUsd,
    verdict,
  };
}

function formatStepString(s: FarmStep, chain: string): string {
  const parts: string[] = [];
  if (s.gas_cost_usd > 0) parts.push(`gas $${s.gas_cost_usd.toFixed(2)}`);
  if (s.fee_cost_usd > 0) parts.push(`fee $${s.fee_cost_usd.toFixed(2)}`);
  if (s.tbill_cost_usd > 0) parts.push(`4% T-bill opp $${s.tbill_cost_usd.toFixed(2)}`);
  const breakdown = parts.length > 0 ? ` (${parts.join(" + ")})` : "";
  let line = `Step ${s.step} [${s.when} · ${chain}]: ${s.action}. Cost: $${s.cost_usd.toFixed(2)}${breakdown}. Time: ${s.minutes} min.`;
  if (line.length > 240) line = `${line.slice(0, 236)}...`;
  return line;
}

export function buildFarmPlan(
  candidate: ScoredCandidate,
  depositUsd: number = FARM_CONSTANTS.defaultDepositUsd,
  dropShare: number = FARM_CONSTANTS.defaultDropShare,
  horizonWeeks: number = FARM_CONSTANTS.defaultHorizonWeeks,
): FarmPlan {
  const optimalChain = selectOptimalChain(candidate);
  const chainGasUnitUsd = getChainGasUnit(optimalChain);
  const categoryFeeBps = getCategoryFeeBps(candidate.category);
  const horizonDays = horizonWeeks * 7;

  const feeRate = categoryFeeBps / 10_000;
  const fullFeeUsd = roundTo(depositUsd * feeRate, 2);
  const entryFeeUsd = roundTo(depositUsd * feeRate * 0.5, 2);
  const exitFeeUsd = roundTo(fullFeeUsd - entryFeeUsd, 2);
  const tbillBenchmarkUsd = roundTo(
    depositUsd * FARM_CONSTANTS.tbillAnnualRate * (horizonDays / 365),
    2,
  );

  const midWeekEnd = Math.max(2, Math.floor(horizonWeeks / 2));
  const lateWeekStart = Math.min(horizonWeeks - 1, midWeekEnd + 1);
  const cyclesPerPhase = Math.max(1, Math.round(horizonWeeks / 6));

  const stepSpecs = [
    {
      step: 1,
      when: "Day 0",
      title: "Isolate Wallet & Verify Contracts",
      action: `Create clean farm wallet, verify official ${candidate.name} contracts on ${optimalChain}, and cap allocation`,
      gasMultiplier: 0,
      feeCostUsd: 0,
      tbillCostUsd: 0,
      minutes: 10,
    },
    {
      step: 2,
      when: "Day 0",
      title: "Bridge Deposit to Optimal Chain",
      action: `Bridge $${depositUsd.toLocaleString("en-US")} onto ${optimalChain} (lowest-gas supported chain for ${candidate.name})`,
      gasMultiplier: 1.5,
      feeCostUsd: 0,
      tbillCostUsd: 0,
      minutes: 10,
    },
    {
      step: 3,
      when: "Day 0",
      title: "Swap Assets & Exact Approval",
      action: `Convert into required ${candidate.category} asset(s) on ${optimalChain} and sign exact-amount approval`,
      gasMultiplier: 1.0,
      feeCostUsd: entryFeeUsd,
      tbillCostUsd: 0,
      minutes: 8,
    },
    {
      step: 4,
      when: "Day 0",
      title: "Deploy Core Farming Position",
      action: coreActionText(candidate.category, candidate.name, optimalChain),
      gasMultiplier: 2.0,
      feeCostUsd: 0,
      tbillCostUsd: 0,
      minutes: 12,
    },
    {
      step: 5,
      when: `Weeks 2–${midWeekEnd}`,
      title: "Early-Window Organic Cadence",
      action: `Run ${cyclesPerPhase} lightweight activity tx(s) on ${optimalChain} to clear sybil cadence thresholds`,
      gasMultiplier: cyclesPerPhase * 1.0,
      feeCostUsd: 0,
      tbillCostUsd: 0,
      minutes: cyclesPerPhase * 8,
    },
    {
      step: 6,
      when: `Weeks ${lateWeekStart}–${Math.max(lateWeekStart, horizonWeeks - 1)}`,
      title: "Retention & Points Checkpoint",
      action: `Verify snapshot eligibility and run ${cyclesPerPhase} retention tx(s) on ${optimalChain} without breaking streak`,
      gasMultiplier: cyclesPerPhase * 1.0,
      feeCostUsd: 0,
      tbillCostUsd: 0,
      minutes: cyclesPerPhase * 7,
    },
    {
      step: 7,
      when: `Week ${horizonWeeks} (TGE)`,
      title: "Claim & Realize Token Allocation",
      action: `Claim ${candidate.name} TGE allocation via official portal on ${optimalChain} and convert to stablecoins`,
      gasMultiplier: 2.5,
      feeCostUsd: exitFeeUsd,
      tbillCostUsd: 0,
      minutes: 15,
    },
    {
      step: 8,
      when: `Week ${horizonWeeks}`,
      title: "Unwind Principal & Book T-Bill Cost",
      action: `Withdraw principal from ${candidate.name} on ${optimalChain} and account for ${horizonDays}d 4.0% APR T-bill benchmark`,
      gasMultiplier: 1.5,
      feeCostUsd: 0,
      tbillCostUsd: tbillBenchmarkUsd,
      minutes: 10,
    },
  ];

  const steps: FarmStep[] = stepSpecs.map((s) => {
    const gasCostUsd = roundTo(chainGasUnitUsd * s.gasMultiplier, 2);
    const costUsd = roundTo(gasCostUsd + s.feeCostUsd + s.tbillCostUsd, 2);
    return {
      step: s.step,
      when: s.when,
      title: s.title,
      action: s.action,
      gas_multiplier: s.gasMultiplier,
      gas_cost_usd: gasCostUsd,
      fee_cost_usd: s.feeCostUsd,
      tbill_cost_usd: s.tbillCostUsd,
      cost_usd: costUsd,
      minutes: s.minutes,
    };
  });

  const gasTotalUsd = roundTo(steps.reduce((acc, s) => acc + s.gas_cost_usd, 0), 2);
  const handsOnMinutes = steps.reduce((acc, s) => acc + s.minutes, 0);
  const economics = computeFarmEconomics(
    candidate,
    depositUsd,
    dropShare,
    horizonWeeks,
    gasTotalUsd,
    categoryFeeBps,
    handsOnMinutes,
  );

  // Strict penny reconciliation check
  const sumSteps = roundTo(steps.reduce((acc, s) => acc + s.cost_usd, 0), 2);
  if (Math.abs(sumSteps - economics.total_cost_usd) >= 0.01) {
    throw new Error(
      `Farm step reconciliation mismatch for ${candidate.slug}: sum=${sumSteps}, total=${economics.total_cost_usd}`,
    );
  }

  // 4×4 Sensitivity Matrix (drop_share × deposit_usd)
  const sensitivity: SensitivityCell[] = [];
  for (const ds of FARM_CONSTANTS.sensitivityDropShares) {
    for (const dep of FARM_CONSTANTS.sensitivityDeposits) {
      const econ = computeFarmEconomics(
        candidate,
        dep,
        ds,
        horizonWeeks,
        gasTotalUsd,
        categoryFeeBps,
        handsOnMinutes,
      );
      sensitivity.push({
        drop_share: ds,
        deposit_usd: dep,
        net_usd: econ.net_usd,
        net_per_hour: econ.net_per_hour,
        verdict: econ.verdict,
      });
    }
  }

  const farm_steps = steps.map((s) => formatStepString(s, optimalChain));

  const risks: string[] = [
    `DefiLlama records no token for ${candidate.name}; Model B estimates ${(candidate.token_odds * 100).toFixed(1)}% token odds — no launch is guaranteed.`,
    `Smart-contract, liquidity, and depeg exposure on ${optimalChain} over the ${horizonWeeks}-week (${horizonDays}d) horizon.`,
  ];
  if (candidate.breakdown.category_peer_count < 3) {
    risks.push(
      `Category "${candidate.category}" has ${candidate.breakdown.category_peer_count} traded comp(s); category effect shrinks toward global power-law.`,
    );
  }
  if (economics.verdict === "SKIP") {
    risks.push(
      `Net-negative at $${depositUsd.toLocaleString("en-US")} (${economics.net_usd < 0 ? `-$${Math.abs(economics.net_usd).toFixed(2)}` : "$0.00"}) after ${categoryFeeBps} bps fees and 4.0% T-bill benchmark.`,
    );
  } else if (economics.verdict === "MARGINAL") {
    risks.push(
      `Positive Net EV (+$${economics.net_usd.toFixed(2)}) but $${economics.net_per_hour.toFixed(2)}/hr falls below the $25/hr FARM hurdle.`,
    );
  }

  return {
    optimal_chain: optimalChain,
    chain_gas_unit_usd: chainGasUnitUsd,
    category_fee_bps: categoryFeeBps,
    economics,
    sensitivity,
    steps,
    farm_steps,
    risks,
  };
}
