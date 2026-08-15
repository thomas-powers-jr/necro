import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Must live *inside* the repo (not the OS tmpdir) so Node/tsc's package
// self-reference resolution walks up and finds this repo's own package.json
// (name + exports) — proving the exports map itself resolves the bare
// specifier, not just that dist/index.d.ts happens to be well-formed.
let checkDir: string;

afterEach(async () => {
  if (checkDir) await rm(checkDir, { recursive: true, force: true });
});

describe("library exports (dist/index.js + exports map)", () => {
  test("a consumer type-checks against the bare specifier, resolved through the real exports map", async () => {
    checkDir = await mkdtemp(join(repoRoot, ".tmp-lib-check-"));

    await writeFile(
      join(checkDir, "consumer.ts"),
      `
import { scan, explain, buildReachabilityModel, loadConfig } from "@thomas-powers-jr/necro";
import type { NecroConfig, ScanResult, ExplainResult } from "@thomas-powers-jr/necro";

const _s: typeof scan = scan;
const _e: typeof explain = explain;
const _m: typeof buildReachabilityModel = buildReachabilityModel;
const _c: typeof loadConfig = loadConfig;
const _cfg: NecroConfig | null = null as unknown as NecroConfig;
const _sr: ScanResult | null = null as unknown as ScanResult;
const _er: ExplainResult | null = null as unknown as ExplainResult;
void [_s, _e, _m, _c, _cfg, _sr, _er];
`,
    );

    await writeFile(
      join(checkDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            types: [],
          },
          include: ["consumer.ts"],
        },
        null,
        2,
      ),
    );

    await expect(
      exec("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], {
        cwd: checkDir,
      }),
    ).resolves.toBeDefined();
  });

  test("dist/index.js's runtime exports are real functions", async () => {
    // Bare specifier, self-referenced through this repo's own package.json
    // "exports" map — NOT a relative path into dist/. A relative import here
    // would silently pass even if the exports map's "import" condition were
    // wrong, since it'd never actually be consulted.
    const lib = await import("@thomas-powers-jr/necro");
    expect(typeof lib.scan).toBe("function");
    expect(typeof lib.explain).toBe("function");
    expect(typeof lib.buildReachabilityModel).toBe("function");
    expect(typeof lib.loadConfig).toBe("function");
    expect(typeof lib.resolveQuery).toBe("function");
  });

  test("scan() runs end-to-end from the built library entry against a real fixture directory", async () => {
    const fixtureDir = await mktempFixture();
    try {
      // Bare specifier, self-referenced through this repo's own package.json
    // "exports" map — NOT a relative path into dist/. A relative import here
    // would silently pass even if the exports map's "import" condition were
    // wrong, since it'd never actually be consulted.
    const lib = await import("@thomas-powers-jr/necro");
      const config = await lib.loadConfig(fixtureDir);
      const result = await lib.scan(fixtureDir, config);
      const names = result.findings.map((f: { node: { name: string } }) => f.node.name);
      expect(names).toContain("deadHelper");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});

async function mktempFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "necro-lib-fixture-"));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "index.ts"),
    `export function live() {\n  return 1;\n}\n\nfunction deadHelper() {\n  return 2;\n}\n`,
  );
  return dir;
}
