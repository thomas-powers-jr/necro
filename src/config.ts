import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ComplexityThresholds } from "./syntactic/types.js";

/** User-facing scan configuration. */
export interface NecroConfig {
  /** Globs of files to analyze. */
  include: string[];
  /** Globs to exclude from analysis. */
  ignore: string[];
  /** Path to an lcov coverage report (relative to scan target or absolute). */
  coveragePath?: string;
  /** Path to a Cobertura (Python `coverage xml`) report (relative to scan target or absolute). */
  pythonCoveragePath?: string;
  /** Globs (relative to the scan target) declaring production entry points —
   * the escape hatch for the fail-closed entry-resolution warning (§2.2). */
  entries?: string[];
  /** Syntactic-detector thresholds (always resolved; defaults applied per key). */
  complexity: ComplexityThresholds;
  /** Risk-hotspot ranking options. */
  hotspots: HotspotOptions;
  /** Duplication-detector options. */
  duplication: DuplicationOptions;
  /** LLM-triage options (the `necro triage` command). */
  llm: LlmOptions;
}

/** LLM-triage options (used only by the opt-in `necro triage` command). */
export interface LlmOptions {
  /** Claude model id. Defaults to `claude-opus-4-8`. */
  model: string;
  /** Lines of source context to extract on each side of a finding when the
   * enclosing declaration can't be resolved. */
  snippetRadius: number;
  /** Cap on how many `maybe` findings to triage in one run (spend guard).
   * Unset = no cap. */
  maxFindings?: number;
  /** Optional API-key override; `ANTHROPIC_API_KEY` (env) takes precedence. */
  apiKey?: string;
  /** Model backend: `"anthropic"` calls the SDK directly with an API key;
   * `"host-cli"` shells out to an already-authenticated `claude` binary
   * headlessly, so live calls work inside a Claude Code session with no
   * separate API key. Defaults to `"anthropic"`. */
  provider?: "anthropic" | "host-cli";
  /** Host CLI binary name or path used when `provider` is `"host-cli"`.
   * Defaults to `"claude"`. */
  hostCliBin?: string;
}

/** Risk-hotspot ranking options. */
export interface HotspotOptions {
  /** How many hotspots to show. */
  top: number;
}

/** Duplication-detector options. */
export interface DuplicationOptions {
  /** Minimum normalized-token length for a clone to be reported. */
  minTokens: number;
}

/** §4 default detector thresholds. */
export const DEFAULT_COMPLEXITY: ComplexityThresholds = {
  nesting: 3,
  cyclomatic: 10,
  cognitive: 15,
  godFunctionLoc: 50,
  godFunctionParams: 5,
};

export const DEFAULT_HOTSPOTS: HotspotOptions = { top: 10 };

export const DEFAULT_DUPLICATION: DuplicationOptions = { minTokens: 50 };

/** Default LLM-triage options (§ build-order step 12). */
export const DEFAULT_LLM: LlmOptions = {
  model: "claude-opus-4-8",
  snippetRadius: 20,
  provider: "anthropic",
  hostCliBin: "claude",
};

export const DEFAULT_CONFIG: NecroConfig = {
  include: [
    "**/*.ts",
    "**/*.tsx",
    "**/*.js",
    "**/*.jsx",
    "**/*.mts",
    "**/*.cts",
    "**/*.py",
  ],
  ignore: ["**/node_modules/**", "**/dist/**"],
  complexity: DEFAULT_COMPLEXITY,
  hotspots: DEFAULT_HOTSPOTS,
  duplication: DEFAULT_DUPLICATION,
  llm: DEFAULT_LLM,
};

/** The on-disk shape: every field optional, nested blocks partial overrides. */
interface RawConfig {
  include?: string[];
  ignore?: string[];
  coveragePath?: string;
  pythonCoveragePath?: string;
  entries?: string[];
  complexity?: Partial<ComplexityThresholds>;
  hotspots?: Partial<HotspotOptions>;
  duplication?: Partial<DuplicationOptions>;
  llm?: Partial<LlmOptions>;
}

/**
 * Load `necro.config.json` from `cwd`, merged over {@link DEFAULT_CONFIG}.
 * Top-level keys replace their default; the `complexity` block is merged
 * per-threshold so a partial override keeps the other defaults.
 */
export async function loadConfig(cwd: string): Promise<NecroConfig> {
  const user = await readJsonConfig(join(cwd, "necro.config.json"));
  return {
    include: user.include ?? DEFAULT_CONFIG.include,
    ignore: user.ignore ?? DEFAULT_CONFIG.ignore,
    coveragePath: user.coveragePath,
    pythonCoveragePath: user.pythonCoveragePath,
    entries: user.entries,
    complexity: { ...DEFAULT_COMPLEXITY, ...(user.complexity ?? {}) },
    hotspots: { ...DEFAULT_HOTSPOTS, ...(user.hotspots ?? {}) },
    duplication: { ...DEFAULT_DUPLICATION, ...(user.duplication ?? {}) },
    llm: { ...DEFAULT_LLM, ...(user.llm ?? {}) },
  };
}

/**
 * Resolve the directory `loadConfig` should read `necro.config.json` from for
 * a given scan target: `target` itself if it's a directory, its parent if it's
 * a file, or its parent if `target` doesn't exist (e.g. a not-yet-created
 * removal target). Lets MCP tools honor a scan target's own config instead of
 * always reading from the server process's cwd.
 */
export async function resolveConfigDir(target: string): Promise<string> {
  try {
    const s = await stat(target);
    return s.isDirectory() ? target : dirname(target);
  } catch {
    return dirname(target);
  }
}

async function readJsonConfig(path: string): Promise<RawConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  return JSON.parse(raw) as RawConfig;
}
