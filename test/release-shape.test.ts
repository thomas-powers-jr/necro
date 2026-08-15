import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { VERSION } from "../src/version.js";
import pkg from "../package.json";

/** Repo-root-relative path resolver (test cwd-independent). */
const root = (p: string): string => fileURLToPath(new URL(`../${p}`, import.meta.url));

describe("release / package shape", () => {
  test("package.json is shaped for a public scoped publish (AC-1)", () => {
    expect(pkg.name).toBe("@thomas-powers-jr/necro");
    expect(pkg.private).toBe(false);
    expect(pkg.bin.necro).toBe("dist/cli.js");
    expect(pkg.files).toEqual(["dist"]);
    // prepublishOnly guarantees a fresh bundle ships even on a manual publish.
    expect(pkg.scripts.prepublishOnly).toBe("npm run build");
  });

  test("package.json carries npm-page metadata (AC-1)", () => {
    expect(pkg.repository.url).toContain("github.com/thomas-powers-jr/necro");
    expect(pkg.homepage).toContain("github.com/thomas-powers-jr/necro");
    expect(pkg.bugs.url).toContain("github.com/thomas-powers-jr/necro/issues");
    expect(pkg.keywords.length).toBeGreaterThan(0);
  });

  test("CLI/MCP version is sourced from package.json and cannot drift (AC-1)", () => {
    // VERSION is what `necro --version` and the MCP server identity report.
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("release workflow publishes the package on a v* tag (AC-1)", () => {
    const wf = readFileSync(root(".github/workflows/release.yml"), "utf8");
    expect(wf).toMatch(/tags:\s*[\s\S]*-\s*"v\*"/);
    expect(wf).toContain("npm publish --access public");
    expect(wf).toContain("secrets.NPM_TOKEN");
    // Guards a tag/package.json version mismatch before publishing.
    expect(wf).toMatch(/does not match package\.json version/);
  });
});

describe("fail-closed entry resolution — CHANGELOG + boundary compliance", () => {
  test("CHANGELOG documents the fail-closed entry-resolution slice under 1.2.0 Unreleased (AC-8)", () => {
    const changelog = readFileSync(root("CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(/## \[1\.2\.0\][^\n]*\n/);
    const section = changelog.slice(changelog.indexOf("## [1.2.0]"), changelog.indexOf("## [1.1.0]"));
    expect(section).toMatch(/fail-closed entry resolution/i);
    expect(section).toMatch(/entries.*string\[\]|"entries"/i);
    expect(section).toMatch(/dist.*src|tsconfig/i);
    expect(section).toMatch(/scripts/i);
    expect(section).toMatch(/exit code/i);
  });
});
