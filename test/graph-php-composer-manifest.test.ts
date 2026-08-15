import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readComposerManifest } from "../src/graph/php/composer-manifest.js";

const FIXTURES_ROOT = join(__dirname, "fixtures", "php-composer-manifest");

describe("readComposerManifest (AC-1)", () => {
  test("single-dir psr-4 entry", async () => {
    const manifest = await readComposerManifest(join(FIXTURES_ROOT, "single-psr4"));
    expect(manifest.autoload.psr4).toEqual({ "App\\": ["src/"] });
  });

  test("array-of-dirs psr-4 entry normalizes to string[]", async () => {
    const manifest = await readComposerManifest(join(FIXTURES_ROOT, "array-dirs"));
    expect(manifest.autoload.psr4).toEqual({ "App\\": ["src/", "app/"] });
  });

  test("autoload-dev block parses independently of autoload", async () => {
    const manifest = await readComposerManifest(join(FIXTURES_ROOT, "dev-block"));
    expect(manifest.autoload.psr4).toEqual({ "App\\": ["src/"] });
    expect(manifest.autoloadDev.psr4).toEqual({ "Tests\\": ["tests/"] });
  });

  test("missing composer.json returns an empty manifest, does not throw", async () => {
    const manifest = await readComposerManifest(join(FIXTURES_ROOT, "missing-file"));
    expect(manifest).toEqual({
      autoload: { psr4: {}, psr0: {}, classmap: [], files: [] },
      autoloadDev: { psr4: {}, psr0: {}, classmap: [], files: [] },
      bin: [],
    });
  });

  test("malformed JSON returns an empty manifest, does not throw", async () => {
    const manifest = await readComposerManifest(join(FIXTURES_ROOT, "malformed-json"));
    expect(manifest.autoload.psr4).toEqual({});
  });

  test("composer.json with no autoload block returns an empty manifest", async () => {
    const manifest = await readComposerManifest(join(FIXTURES_ROOT, "no-autoload"));
    expect(manifest.autoload).toEqual({ psr4: {}, psr0: {}, classmap: [], files: [] });
  });

  test("psr-0 entry parses like psr-4 (dir normalization only, no convention logic here)", async () => {
    const manifest = await readComposerManifest(join(FIXTURES_ROOT, "psr0"));
    expect(manifest.autoload.psr0).toEqual({ App_: ["src/"] });
  });

  test("classmap entries (dirs and explicit files) preserved as a flat list", async () => {
    const manifest = await readComposerManifest(join(FIXTURES_ROOT, "classmap"));
    expect(manifest.autoload.classmap).toEqual(["src/legacy/", "src/Compat.php"]);
  });

  test("files entries preserved as a flat list", async () => {
    const manifest = await readComposerManifest(join(FIXTURES_ROOT, "files-autoload"));
    expect(manifest.autoload.files).toEqual(["src/bootstrap.php", "src/helpers.php"]);
  });

  test("top-level bin field as a bare string normalizes to string[] (75-01 T4, AC-4)", async () => {
    const manifest = await readComposerManifest(join(FIXTURES_ROOT, "bin-string"));
    expect(manifest.bin).toEqual(["bin/console"]);
  });

  test("top-level bin field as an array of strings is preserved (75-01 T4, AC-4)", async () => {
    const manifest = await readComposerManifest(join(FIXTURES_ROOT, "bin-array"));
    expect(manifest.bin).toEqual(["bin/console", "bin/worker"]);
  });

  test("no bin field returns an empty array, not undefined (75-01 T4, AC-4)", async () => {
    const manifest = await readComposerManifest(join(FIXTURES_ROOT, "single-psr4"));
    expect(manifest.bin).toEqual([]);
  });
});
