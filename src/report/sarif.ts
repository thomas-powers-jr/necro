import { VERSION } from "../version.js";
import type { JsonInput } from "./json.js";
import { toRelativePath } from "./paths.js";
import {
  complexitySeverity,
  deadCodeSeverity,
  duplicationSeverity,
  hotspotSeverity,
  type Severity,
} from "./severity.js";

/** Minimal SARIF 2.1.0 shapes (only what we emit). */
type SarifLevel = "error" | "warning" | "note";

interface SarifArtifactLocation {
  uri: string;
}
interface SarifRegion {
  startLine: number;
  startColumn: number;
}
interface SarifPhysicalLocation {
  physicalLocation: {
    artifactLocation: SarifArtifactLocation;
    region: SarifRegion;
  };
}
interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: SarifPhysicalLocation[];
  relatedLocations?: SarifPhysicalLocation[];
}
interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  helpUri: string;
}
export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: Array<{
    tool: {
      driver: {
        name: string;
        informationUri: string;
        semanticVersion: string;
        rules: SarifRule[];
      };
    };
    results: SarifResult[];
    /** Free-form property bag (SARIF's `properties` extension point) — carries
     * the fail-closed entry-resolution diagnostic (§2.1) when present. */
    properties?: Record<string, unknown>;
  }>;
}

const SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";
const INFO_URI = "https://github.com/thomas-powers-jr/necro";

const LEVEL: Record<Severity, SarifLevel> = {
  high: "error",
  medium: "warning",
  low: "note",
};

/** Every ruleId necro can emit, declared up front so results always resolve. */
const RULES: SarifRule[] = [
  {
    id: "dead-code",
    name: "DeadCode",
    shortDescription: { text: "Unreferenced (dead) code" },
    helpUri: INFO_URI,
  },
  {
    id: "complexity/nesting",
    name: "Nesting",
    shortDescription: { text: "Excessive nesting depth" },
    helpUri: INFO_URI,
  },
  {
    id: "complexity/cyclomatic",
    name: "Cyclomatic",
    shortDescription: { text: "High cyclomatic complexity" },
    helpUri: INFO_URI,
  },
  {
    id: "complexity/cognitive",
    name: "Cognitive",
    shortDescription: { text: "High cognitive complexity" },
    helpUri: INFO_URI,
  },
  {
    id: "complexity/god-function",
    name: "GodFunction",
    shortDescription: { text: "God function" },
    helpUri: INFO_URI,
  },
  {
    id: "duplication",
    name: "Duplication",
    shortDescription: { text: "Duplicated code (clone)" },
    helpUri: INFO_URI,
  },
  {
    id: "hotspot",
    name: "Hotspot",
    shortDescription: { text: "Risk hotspot" },
    helpUri: INFO_URI,
  },
];

function physical(
  file: string,
  line: number,
  srcRoot: string,
): SarifPhysicalLocation {
  return {
    physicalLocation: {
      artifactLocation: { uri: toRelativePath(file, srcRoot) },
      // Findings carry no column; SARIF startColumn is 1-based, default to 1.
      region: { startLine: line, startColumn: 1 },
    },
  };
}

/**
 * Transform a scan (the same `JsonInput` the JSON reporter consumes) into a
 * schema-valid SARIF 2.1.0 log. Pure: paths are made relative to `srcRoot` so
 * GitHub code-scanning can match them against repository files.
 */
export function toSarif(input: JsonInput, opts: { srcRoot: string }): SarifLog {
  const { srcRoot } = opts;
  const results: SarifResult[] = [];

  for (const f of input.findings) {
    const sev = deadCodeSeverity(f.tier, f.verdict);
    const tag = f.verdict === "test-only" ? "test-only" : f.tier;
    results.push({
      ruleId: "dead-code",
      level: LEVEL[sev],
      message: { text: `Dead code: ${f.node.name} (${tag})` },
      locations: [physical(f.node.file, f.node.line, srcRoot)],
    });
  }

  for (const c of input.complexity) {
    results.push({
      ruleId: `complexity/${c.detector}`,
      level: LEVEL[complexitySeverity()],
      message: { text: `${c.name}: ${c.message}` },
      locations: [physical(c.file, c.line, srcRoot)],
    });
  }

  for (const d of input.duplication) {
    const [primary, ...rest] = d.locations;
    if (!primary) continue;
    results.push({
      ruleId: "duplication",
      level: LEVEL[duplicationSeverity()],
      message: {
        text: `Duplicated code: ${d.tokens} tokens across ${d.locations.length} locations`,
      },
      locations: [physical(primary.file, primary.startLine, srcRoot)],
      ...(rest.length > 0
        ? {
            relatedLocations: rest.map((l) =>
              physical(l.file, l.startLine, srcRoot),
            ),
          }
        : {}),
    });
  }

  for (const h of input.hotspots) {
    results.push({
      ruleId: "hotspot",
      level: LEVEL[hotspotSeverity()],
      message: { text: `Risk hotspot: ${h.name} (risk ${h.risk})` },
      locations: [physical(h.file, h.line, srcRoot)],
    });
  }

  return {
    $schema: SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "necro",
            informationUri: INFO_URI,
            semanticVersion: VERSION,
            rules: RULES,
          },
        },
        results,
        ...(input.diagnostics
          ? {
              properties: {
                entryResolution: input.diagnostics.entryResolution,
              },
            }
          : {}),
      },
    ],
  };
}
