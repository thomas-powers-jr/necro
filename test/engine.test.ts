import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { scan } from "../src/engine/index.js";
import { buildReachabilityModel } from "../src/engine/model.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-engine-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, contents: string): Promise<string> {
  const path = join(dir, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

describe("scan", () => {
  test("returns no findings for an empty directory", async () => {
    const result = await scan(dir, DEFAULT_CONFIG);
    expect(result.findings).toEqual([]);
  });

  test("AC-4: scan still reports the dead orphan after model extraction", async () => {
    await write("src/index.ts", `import { live } from "./util";\nlive();\n`);
    await write(
      "src/util.ts",
      `export function live() {}\nexport function orphan() {}\n`,
    );
    const result = await scan(dir, DEFAULT_CONFIG);
    expect(result.findings.some((f) => f.node.id.endsWith(":orphan"))).toBe(true);
    expect(result.findings.some((f) => f.node.id.endsWith(":live"))).toBe(false);
  });

  // Phase 71 (AC-4): the design doc flagged "the graph merge must be tested
  // with both languages present" as an open risk of flipping Python
  // default-on. test/model-python-merge.test.ts covers this at the
  // buildReachabilityModel level, but only with a manually-overridden
  // config.include — this exercises the real entry point under the bare
  // DEFAULT_CONFIG an actual user gets for free, with no necro.config.json.
  test("AC-4: a mixed TS+Python repo scans correctly under the unmodified default config", async () => {
    await write("src/index.ts", "export function tsFn() { return 1; }\n");
    await write("pkg/mod.py", "def py_fn():\n    pass\n");

    const result = await scan(dir, DEFAULT_CONFIG, { complexity: false });

    const names = result.findings.map((f) => f.node.name).sort();
    expect(names).toEqual(["py_fn", "tsFn"]);

    const ids = result.findings.map((f) => f.node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildReachabilityModel", () => {
  test("AC-4: classifies reachability and exposes graph + prod entries", async () => {
    const index = await write(
      "src/index.ts",
      `import { live } from "./util";\nlive();\n`,
    );
    await write(
      "src/util.ts",
      `export function live() {}\nexport function orphan() {}\n`,
    );

    const model = await buildReachabilityModel(dir, DEFAULT_CONFIG);

    const verdict = (name: string) =>
      model.reachability.find((r) => r.id.endsWith(`:${name}`))?.reachability;
    expect(verdict("live")).toBe("alive");
    expect(verdict("orphan")).toBe("dead");
    expect(model.prodEntries.has(index)).toBe(true);
    expect(model.graph.nodes.some((n) => n.id.endsWith(":live"))).toBe(true);
  });
});
