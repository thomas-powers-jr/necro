import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildReachabilityModel } from "../src/engine/model.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-php-library-model-"));
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

const config = { ...DEFAULT_CONFIG, include: ["**/*.php"] };

const widgetSource = [
  "<?php",
  "namespace App;",
  "",
  "class Widget {",
  "    public function doThing() {",
  "        return 1;",
  "    }",
  "}",
  "",
].join("\n");

describe("buildReachabilityModel — PHP library publicApiIds (75-01 T5, AC-5)", () => {
  test("library-shaped composer.json (name + type=library, no public/index.php) quarantines its own PSR-4-namespace symbols", async () => {
    await write(
      "composer.json",
      JSON.stringify({
        type: "library",
        name: "vendor/pkg",
        autoload: { "psr-4": { "App\\": "src/" } },
      }),
    );
    await write("src/Widget.php", widgetSource);

    const model = await buildReachabilityModel(dir, config);
    const node = model.graph.nodes.find((n) => n.name === "doThing");
    expect(node).toBeDefined();
    expect(model.publicApiIds.has(node?.id ?? "")).toBe(true);
  });

  test("real guzzlehttp/guzzle shape (name present, no `type` field at all) still quarantines — the corrected recall-favoring signal", async () => {
    await write(
      "composer.json",
      JSON.stringify({
        name: "guzzlehttp/guzzle",
        autoload: { "psr-4": { "App\\": "src/" } },
      }),
    );
    await write("src/Widget.php", widgetSource);

    const model = await buildReachabilityModel(dir, config);
    const node = model.graph.nodes.find((n) => n.name === "doThing");
    expect(model.publicApiIds.has(node?.id ?? "")).toBe(true);
  });

  test("real phpunit/phpunit shape (type=library, bin non-empty) still quarantines — bin presence does not veto library status", async () => {
    await write(
      "composer.json",
      JSON.stringify({
        type: "library",
        name: "phpunit/phpunit",
        autoload: { "psr-4": { "App\\": "src/" } },
        bin: "bin/phpunit",
      }),
    );
    await write("src/Widget.php", widgetSource);
    await write("bin/phpunit", "<?php\necho 'phpunit';\n");

    const model = await buildReachabilityModel(dir, config);
    const node = model.graph.nodes.find((n) => n.name === "doThing");
    expect(model.publicApiIds.has(node?.id ?? "")).toBe(true);
  });

  test("application-shaped composer.json (public/index.php present) does not quarantine anything", async () => {
    await write(
      "composer.json",
      JSON.stringify({
        name: "acme/my-app",
        autoload: { "psr-4": { "App\\": "src/" } },
      }),
    );
    await write("src/Widget.php", widgetSource);
    await write("public/index.php", "<?php\nrequire 'x';\n");

    const model = await buildReachabilityModel(dir, config);
    expect(model.publicApiIds.size).toBe(0);
  });

  test("type=project (explicit application-skeleton declaration) does not quarantine anything, even with a name and no public/index.php", async () => {
    await write(
      "composer.json",
      JSON.stringify({
        type: "project",
        name: "acme/my-app",
        autoload: { "psr-4": { "App\\": "src/" } },
      }),
    );
    await write("src/Widget.php", widgetSource);

    const model = await buildReachabilityModel(dir, config);
    expect(model.publicApiIds.size).toBe(0);
  });

  test("library-shaped, but a symbol outside the package's own psr-4 dir is NOT quarantined", async () => {
    await write(
      "composer.json",
      JSON.stringify({
        type: "library",
        name: "vendor/pkg",
        autoload: { "psr-4": { "App\\": "src/" } },
      }),
    );
    await write("src/Widget.php", widgetSource);
    await write(
      "scripts/Standalone.php",
      [
        "<?php",
        "class Standalone {",
        "    public function outside() {",
        "        return 1;",
        "    }",
        "}",
        "",
      ].join("\n"),
    );

    const model = await buildReachabilityModel(dir, config);
    const inNode = model.graph.nodes.find((n) => n.name === "doThing");
    const outNode = model.graph.nodes.find((n) => n.name === "outside");
    expect(model.publicApiIds.has(inNode?.id ?? "")).toBe(true);
    expect(model.publicApiIds.has(outNode?.id ?? "")).toBe(false);
  });

  test("a TS-only repo is unaffected — publicApiIds stays empty for PHP's mechanism", async () => {
    await write("src/index.ts", "export function tsFn() { return 1; }\n");
    const tsConfig = { ...DEFAULT_CONFIG, include: ["**/*.ts"] };

    const model = await buildReachabilityModel(dir, tsConfig);
    expect(model.publicApiIds.size).toBe(0);
  });
});
