import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { discoverFiles } from "../src/discover.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-discover-"));
  await mkdir(join(dir, "src"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("discoverFiles (AC-1, AC-3)", () => {
  test("discovers .js/.jsx/.mts/.cts alongside .ts/.tsx with the default config", async () => {
    await writeFile(join(dir, "src", "a.ts"), "");
    await writeFile(join(dir, "src", "b.tsx"), "");
    await writeFile(join(dir, "src", "c.js"), "");
    await writeFile(join(dir, "src", "d.jsx"), "");
    await writeFile(join(dir, "src", "e.mts"), "");
    await writeFile(join(dir, "src", "f.cts"), "");

    const files = await discoverFiles(dir, DEFAULT_CONFIG);
    const names = files.map((f) => f.split("/").pop()).sort();
    expect(names).toEqual(["a.ts", "b.tsx", "c.js", "d.jsx", "e.mts", "f.cts"]);
  });

  test("skips .d.ts, .d.mts, and .d.cts declaration files", async () => {
    await writeFile(join(dir, "src", "real.mts"), "");
    await writeFile(join(dir, "src", "real.cts"), "");
    await writeFile(join(dir, "src", "types.d.ts"), "");
    await writeFile(join(dir, "src", "types.d.mts"), "");
    await writeFile(join(dir, "src", "types.d.cts"), "");

    const files = await discoverFiles(dir, DEFAULT_CONFIG);
    const names = files.map((f) => f.split("/").pop()).sort();
    expect(names).toEqual(["real.cts", "real.mts"]);
  });
});

describe("discoverFiles — Python (AC-4)", () => {
  test("DEFAULT_CONFIG.include contains .py — Python is default-on (AC-1)", () => {
    expect(DEFAULT_CONFIG.include).toContain("**/*.py");
  });

  test("discovers .py when a user explicitly includes it, and skips .pyi stubs", async () => {
    await writeFile(join(dir, "src", "real.py"), "");
    await writeFile(join(dir, "src", "types.pyi"), "");

    const config = { ...DEFAULT_CONFIG, include: [...DEFAULT_CONFIG.include, "**/*.py", "**/*.pyi"] };
    const files = await discoverFiles(dir, config);
    const names = files.map((f) => f.split("/").pop()).sort();
    expect(names).toEqual(["real.py"]);
  });

  test("skips __pycache__, .venv, venv, .tox, and .eggs unconditionally", async () => {
    for (const skipDir of ["__pycache__", ".venv", "venv", ".tox", ".eggs"]) {
      await mkdir(join(dir, skipDir), { recursive: true });
      await writeFile(join(dir, skipDir, "ghost.py"), "");
    }
    await writeFile(join(dir, "src", "real.py"), "");

    const config = { ...DEFAULT_CONFIG, include: [...DEFAULT_CONFIG.include, "**/*.py"] };
    const files = await discoverFiles(dir, config);
    const names = files.map((f) => f.split("/").pop()).sort();
    expect(names).toEqual(["real.py"]);
  });

  test("discovers a build/ subpackage under a Python-only config (AC-1)", async () => {
    await mkdir(join(dir, "build"), { recursive: true });
    // Real evidence shape (pip/_internal/operations/build/__init__.py):
    // a build/ dir is only treated as a Python package if it directly
    // contains __init__.py — that's the per-directory signal, not the config.
    await writeFile(join(dir, "build", "__init__.py"), "");
    await writeFile(join(dir, "build", "build_tracker.py"), "");
    await writeFile(join(dir, "src", "real.py"), "");

    const config = { ...DEFAULT_CONFIG, include: ["**/*.py"] };
    const files = await discoverFiles(dir, config);
    const names = files.map((f) => f.split("/").pop()).sort();
    expect(names).toEqual(["__init__.py", "build_tracker.py", "real.py"]);
  });

  test("build/ without __init__.py is skipped even under a Python-only config (no overcorrection) (AC-3)", async () => {
    await mkdir(join(dir, "build"), { recursive: true });
    await writeFile(join(dir, "build", "build_tracker.py"), "");
    await writeFile(join(dir, "src", "real.py"), "");

    const config = { ...DEFAULT_CONFIG, include: ["**/*.py"] };
    const files = await discoverFiles(dir, config);
    const names = files.map((f) => f.split("/").pop()).sort();
    expect(names).toEqual(["real.py"]);
  });

  test("still skips build/-as-bundler-output under the default config, even though it now includes Python too (AC-2)", async () => {
    await mkdir(join(dir, "build"), { recursive: true });
    await writeFile(join(dir, "build", "bundle.ts"), "");
    await writeFile(join(dir, "src", "real.ts"), "");

    const files = await discoverFiles(dir, DEFAULT_CONFIG);
    const names = files.map((f) => f.split("/").pop()).sort();
    expect(names).toEqual(["real.ts"]);
  });
});
