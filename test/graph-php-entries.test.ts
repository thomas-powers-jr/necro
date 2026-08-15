import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ComposerManifest } from "../src/graph/php/composer-manifest.js";
import { resolvePhpEntries } from "../src/graph/php/php-entries.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necro-php-entries-"));
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

function manifestWithBin(bin: string[] = []): ComposerManifest {
  return {
    autoload: { psr4: {}, psr0: {}, classmap: [], files: [] },
    autoloadDev: { psr4: {}, psr0: {}, classmap: [], files: [] },
    bin,
  };
}

describe("resolvePhpEntries — composer bin (75-01 T4, AC-4)", () => {
  test("bin as a bare string resolves a single prod entry, tagged composer-bin", async () => {
    const binFile = await write("bin/console.php", "<?php\necho 'hi';\n");
    const result = await resolvePhpEntries(
      dir,
      [binFile],
      manifestWithBin(["bin/console.php"]),
    );
    expect(result.entries).toEqual(new Set([binFile]));
    expect(result.records).toEqual([{ file: binFile, source: "composer-bin" }]);
  });

  test("bin as an array of strings resolves an entry per existing script", async () => {
    const foo = await write("bin/foo.php", "<?php\n");
    const bar = await write("bin/bar.php", "<?php\n");
    const result = await resolvePhpEntries(
      dir,
      [foo, bar],
      manifestWithBin(["bin/foo.php", "bin/bar.php"]),
    );
    expect(result.entries).toEqual(new Set([foo, bar]));
    expect(result.records).toEqual([
      { file: foo, source: "composer-bin" },
      { file: bar, source: "composer-bin" },
    ]);
  });

  test("a bin path with no corresponding discovered file resolves no entry (existence-gated, matching resolveProdEntries' own convention)", async () => {
    const result = await resolvePhpEntries(
      dir,
      [],
      manifestWithBin(["bin/missing.php"]),
    );
    expect(result.entries.size).toBe(0);
  });
});

describe("resolvePhpEntries — public/index.php convention (75-01 T4, AC-4)", () => {
  test("public/index.php resolves as a convention prod entry when present", async () => {
    const indexFile = await write("public/index.php", "<?php\n");
    const result = await resolvePhpEntries(dir, [indexFile], manifestWithBin());
    expect(result.records).toEqual([{ file: indexFile, source: "convention" }]);
  });

  test("no public/index.php resolves zero entries from that mechanism", async () => {
    const otherFile = await write("src/Foo.php", "<?php\nclass Foo {}\n");
    const result = await resolvePhpEntries(dir, [otherFile], manifestWithBin());
    expect(result.entries.size).toBe(0);
  });

  test("an index.php at the repo root (not under public/) is not matched — AC-4's literal scope is public/index.php only", async () => {
    const rootIndex = await write("index.php", "<?php\n");
    const result = await resolvePhpEntries(dir, [rootIndex], manifestWithBin());
    expect(result.entries.size).toBe(0);
  });
});

describe("resolvePhpEntries — PHPUnit test entries (75-01 T4, AC-4)", () => {
  test("phpunit.xml's configured <directory> resolves testEntries, not the *Test.php fallback", async () => {
    // Deliberately not named `*Test.php` — proves the config path, not the
    // filename convention, is what resolved this file.
    const configuredFile = await write("qa/CalcCheck.php", "<?php\nclass CalcCheck {}\n");
    await write(
      "phpunit.xml",
      [
        '<?xml version="1.0"?>',
        "<phpunit>",
        '  <testsuites>',
        '    <testsuite name="Unit">',
        "      <directory>qa</directory>",
        "    </testsuite>",
        "  </testsuites>",
        "</phpunit>",
      ].join("\n"),
    );
    const result = await resolvePhpEntries(dir, [configuredFile], manifestWithBin());
    expect(result.testEntries).toEqual(new Set([configuredFile]));
  });

  test("phpunit.xml's configured <file> path resolves as a testEntry directly", async () => {
    const bootstrapTest = await write("tests/bootstrap-check.php", "<?php\n");
    await write(
      "phpunit.xml",
      [
        '<?xml version="1.0"?>',
        "<phpunit>",
        '  <testsuites>',
        '    <testsuite name="Unit">',
        "      <file>tests/bootstrap-check.php</file>",
        "    </testsuite>",
        "  </testsuites>",
        "</phpunit>",
      ].join("\n"),
    );
    const result = await resolvePhpEntries(dir, [bootstrapTest], manifestWithBin());
    expect(result.testEntries).toEqual(new Set([bootstrapTest]));
  });

  test("a present phpunit.xml suppresses the *Test.php fallback even for files it doesn't configure", async () => {
    const outsideConfig = await write("legacy/FooTest.php", "<?php\nclass FooTest {}\n");
    await write(
      "phpunit.xml",
      [
        '<?xml version="1.0"?>',
        "<phpunit>",
        '  <testsuites>',
        '    <testsuite name="Unit">',
        "      <directory>qa</directory>",
        "    </testsuite>",
        "  </testsuites>",
        "</phpunit>",
      ].join("\n"),
    );
    const result = await resolvePhpEntries(dir, [outsideConfig], manifestWithBin());
    expect(result.testEntries.size).toBe(0);
  });

  test("no phpunit.xml/phpunit.xml.dist falls back to the *Test.php filename convention", async () => {
    const testFile = await write("tests/FooTest.php", "<?php\nclass FooTest {}\n");
    const nonTestFile = await write("src/Foo.php", "<?php\nclass Foo {}\n");
    const result = await resolvePhpEntries(
      dir,
      [testFile, nonTestFile],
      manifestWithBin(),
    );
    expect(result.testEntries).toEqual(new Set([testFile]));
  });

  test("phpunit.xml takes precedence over phpunit.xml.dist when both are present", async () => {
    const xmlFile = await write("tests/XmlDir/AFile.php", "<?php\n");
    const distFile = await write("tests/DistDir/BFile.php", "<?php\n");
    await write(
      "phpunit.xml",
      '<?xml version="1.0"?>\n<phpunit><testsuites><testsuite name="U"><directory>tests/XmlDir</directory></testsuite></testsuites></phpunit>\n',
    );
    await write(
      "phpunit.xml.dist",
      '<?xml version="1.0"?>\n<phpunit><testsuites><testsuite name="U"><directory>tests/DistDir</directory></testsuite></testsuites></phpunit>\n',
    );
    const result = await resolvePhpEntries(dir, [xmlFile, distFile], manifestWithBin());
    expect(result.testEntries).toEqual(new Set([xmlFile]));
  });

  test("phpunit.xml.dist is used when phpunit.xml is absent", async () => {
    const distFile = await write("tests/DistDir/BFile.php", "<?php\n");
    await write(
      "phpunit.xml.dist",
      '<?xml version="1.0"?>\n<phpunit><testsuites><testsuite name="U"><directory>tests/DistDir</directory></testsuite></testsuites></phpunit>\n',
    );
    const result = await resolvePhpEntries(dir, [distFile], manifestWithBin());
    expect(result.testEntries).toEqual(new Set([distFile]));
  });

  test("a sibling directory sharing a name prefix (tests-legacy/ vs configured tests/) is not matched", async () => {
    const sibling = await write("tests-legacy/FooTest.php", "<?php\n");
    await write(
      "phpunit.xml",
      '<?xml version="1.0"?>\n<phpunit><testsuites><testsuite name="U"><directory>tests</directory></testsuite></testsuites></phpunit>\n',
    );
    const result = await resolvePhpEntries(dir, [sibling], manifestWithBin());
    expect(result.testEntries.size).toBe(0);
  });

  test("a <coverage><include><directory> source dir is not misread as a test root", async () => {
    const srcFile = await write("src/Lib.php", "<?php\nclass Lib {}\n");
    await write(
      "phpunit.xml",
      [
        '<?xml version="1.0"?>',
        "<phpunit>",
        "  <coverage>",
        "    <include>",
        "      <directory>src</directory>",
        "    </include>",
        "  </coverage>",
        '  <testsuites>',
        '    <testsuite name="Unit">',
        "      <directory>tests</directory>",
        "    </testsuite>",
        "  </testsuites>",
        "</phpunit>",
      ].join("\n"),
    );
    const result = await resolvePhpEntries(dir, [srcFile], manifestWithBin());
    expect(result.testEntries.size).toBe(0);
  });
});
