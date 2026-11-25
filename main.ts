/**
 * Token Launch Radar — Main Entrypoint (token-radar-01)
 * Runtime: Node.js 22.18+ (erasable TypeScript syntax, standard library only, 0 network)
 *
 * Reads the sealed DefiLlama snapshot (/input/snapshot.json or --input <file|dir>),
 * runs the LOOCV-calibrated Empirical Bayes + Ridge valuation model and deterministic
 * 7-step farm plan engine, writes board.json and data.js, copies dashboard/ and
 * screenshots/ to /output (or MAKEFUN_OUTPUT_DIR), and builds dossier.json via
 * vendor/makefun-board.ts.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FARM_CONSTANTS, buildFarmPlan } from "./lib/farm.ts";
import type { FarmPlan } from "./lib/farm.ts";
import { parseSnapshot, runValuationModel } from "./lib/model.ts";
import type { ScoredCandidate, Snapshot } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MAX_IMPLIED_VALUE = 100_000_000_000_000;

export interface BoardRow extends ScoredCandidate {
  farm_steps: string[];
  farm_plan: FarmPlan;
}

function getArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1]!;
  const prefix = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(prefix));
  return eq === undefined ? fallback : eq.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function validateBoard(rows: readonly BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4_000) {
    return `board row count ${rows.length} is outside [100, 4000]`;
  }
  const snapshotSlugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  const ranks = new Array<number>(rows.length);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.slug || r.slug.length > 128 || /\s/.test(r.slug)) {
      return `invalid slug at row ${i}: ${JSON.stringify(r.slug)}`;
    }
    if (!snapshotSlugs.has(r.slug)) {
      return `slug not present in snapshot: ${r.slug}`;
    }
    if (seen.has(r.slug)) {
      return `duplicate slug: ${r.slug}`;
    }
    seen.add(r.slug);

    if (!r.name || r.name.trim().length === 0) {
      return `empty name for ${r.slug}`;
    }
    if (!Number.isSafeInteger(r.rank) || r.rank <= 0) {
      return `invalid rank for ${r.slug}: ${r.rank}`;
    }
    ranks[i] = r.rank;

    if (
      !Number.isSafeInteger(r.implied_value_usd) ||
      r.implied_value_usd <= 0 ||
      r.implied_value_usd > MAX_IMPLIED_VALUE
    ) {
      return `invalid implied_value_usd for ${r.slug}: ${r.implied_value_usd}`;
    }
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `invalid farm_steps count for ${r.slug}: ${r.farm_steps?.length}`;
    }
    for (const step of r.farm_steps) {
      const trimmed = typeof step === "string" ? step.trim() : "";
      if (trimmed.length < 20 || trimmed.length > 600) {
        return `farm step length ${trimmed.length} outside [20, 600] for ${r.slug}`;
      }
    }
  }

  for (const w of snapshot.watchlist) {
    if (!seen.has(w)) {
      return `missing watchlist slug: ${w}`;
    }
  }

  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) {
      return `ranks are not contiguous 1..N (expected ${i + 1}, got ${byRank[i]!.rank})`;
    }
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) {
      return `implied_value_usd rises at rank ${i + 1} (${byRank[i]!.slug})`;
    }
  }
  if (
    byRank.length >= 2 &&
    byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd
  ) {
    return `all ${byRank.length} rows share identical implied_value_usd`;
  }
  return null;
}

function copyFlatFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names = readdirSync(from).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const copied: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    copied.push(name);
  }
  return copied;
}

function main(): void {
  const inputArg = getArg("input", "/input");
  const inputFile = inputArg.endsWith(".json") ? inputArg : join(inputArg, "snapshot.json");
  if (!existsSync(inputFile)) {
    process.stderr.write(
      `token-radar: no snapshot at ${inputFile} (pass --input <file|dir> or mount /input)\n`,
    );
    process.exit(2);
  }

  const outDir = getArg("output", process.env.MAKEFUN_OUTPUT_DIR ?? "/output");
  const skipDossier = hasFlag("skip-dossier");

  const snapshot = parseSnapshot(readFileSync(inputFile, "utf8"));
  const modelOut = runValuationModel(snapshot);

  const rows: BoardRow[] = modelOut.candidates.map((candidate) => {
    const farm_plan = buildFarmPlan(candidate, FARM_CONSTANTS.defaultCapitalUsd);
    return {
      ...candidate,
      farm_steps: farm_plan.farm_steps,
      farm_plan,
    };
  });

  const issue = validateBoard(rows, snapshot);
  if (issue !== null) {
    process.stderr.write(`token-radar: board validation failed: ${issue}\n`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  const boardPayload = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    rows,
    calibration: modelOut.calibration,
    live_comparables: modelOut.live_comparables,
    farm_constants: FARM_CONSTANTS,
  };

  const boardJson = `${JSON.stringify(boardPayload)}\n`;
  writeFileSync(join(outDir, "board.json"), boardJson, "utf8");
  writeFileSync(join(outDir, "data.js"), `window.RADAR=${JSON.stringify(boardPayload)};\n`, "utf8");

  const dashFiles = copyFlatFiles(join(here, "dashboard"), join(outDir, "dashboard"));
  const shotFiles = copyFlatFiles(join(here, "screenshots"), join(outDir, "screenshots"));

  if (!skipDossier) {
    if (shotFiles.length < 3 || shotFiles.length > 4) {
      process.stderr.write(
        `token-radar: screenshots/ has ${shotFiles.length} image(s); gate requires 3 to 4\n`,
      );
      process.exit(1);
    }
    for (const name of shotFiles) {
      if (!PLAIN_NAME.test(name)) {
        process.stderr.write(`token-radar: invalid screenshot filename: ${name}\n`);
        process.exit(1);
      }
    }
    const dossierBytes = buildDossier(outDir, {
      text_max_bytes: TEXT_MAX_BYTES,
      screenshots: SCREENSHOT_CAPS,
      dashboard: DASHBOARD_CAPS,
    });
    writeFileSync(join(outDir, "dossier.json"), dossierBytes);
  }

  const cal = modelOut.calibration;
  const viableCount = rows.filter((r) => r.farm_plan.economics.viability_tier === "VIABLE").length;
  process.stdout.write(
    `token-radar: as_of=${snapshot.as_of} | candidates=${rows.length} (watchlist=${cal.watchlist_count}/${snapshot.watchlist.length}, early=${cal.early_find_count}) | live_comps=${cal.training_count} | viable@$2.5k=${viableCount}\n` +
      `token-radar: LOOCV MdAPE global=${cal.audit.global_baseline.mdape}% cat=${cal.audit.category_only.mdape}% calibrated=${cal.audit.calibrated_model.mdape}% (rho=${cal.audit.calibrated_model.spearman_rho}, within2x=${cal.audit.calibrated_model.within_2x_pct}%)\n` +
      `token-radar: wrote board.json, data.js, dashboard/ (${dashFiles.length} files), screenshots/ (${shotFiles.length} files)${skipDossier ? " [dossier skipped]" : ", dossier.json"}\n`,
  );
}

main();
