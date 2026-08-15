import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildComposerAutoloadMap } from "../src/graph/php/composer-autoload.js";

const ROOT = "/repo";
const emptyManifest = () => ({
  autoload: { psr4: {}, psr0: {}, classmap: [], files: [] },
  autoloadDev: { psr4: {}, psr0: {}, classmap: [], files: [] },
});

describe("buildComposerAutoloadMap — psr-4 (AC-1)", () => {
  test("single prefix, single dir: FQCN derived by path manipulation only", async () => {
    const files = [join(ROOT, "src", "Models", "User.php")];
    const manifest = { ...emptyManifest(), autoload: { ...emptyManifest().autoload, psr4: { "App\\": ["src/"] } } };
    const map = await buildComposerAutoloadMap(ROOT, files, manifest);
    expect(map.classToFile.get("App\\Models\\User")).toBe(join(ROOT, "src", "Models", "User.php"));
  });

  test("multiple prefixes, each resolved independently", async () => {
    const files = [join(ROOT, "src", "Foo.php"), join(ROOT, "lib", "Bar.php")];
    const manifest = {
      ...emptyManifest(),
      autoload: { ...emptyManifest().autoload, psr4: { "App\\": ["src/"], "Lib\\": ["lib/"] } },
    };
    const map = await buildComposerAutoloadMap(ROOT, files, manifest);
    expect(map.classToFile.get("App\\Foo")).toBe(join(ROOT, "src", "Foo.php"));
    expect(map.classToFile.get("Lib\\Bar")).toBe(join(ROOT, "lib", "Bar.php"));
  });

  test("array-of-dirs-per-prefix: a file under either dir resolves", async () => {
    const files = [join(ROOT, "src", "Foo.php"), join(ROOT, "app", "Bar.php")];
    const manifest = {
      ...emptyManifest(),
      autoload: { ...emptyManifest().autoload, psr4: { "App\\": ["src/", "app/"] } },
    };
    const map = await buildComposerAutoloadMap(ROOT, files, manifest);
    expect(map.classToFile.get("App\\Foo")).toBe(join(ROOT, "src", "Foo.php"));
    expect(map.classToFile.get("App\\Bar")).toBe(join(ROOT, "app", "Bar.php"));
  });

  test("overlapping prefixes: the longer, more specific prefix wins for files under its own dir", async () => {
    const files = [join(ROOT, "custom-models", "User.php")];
    const manifest = {
      ...emptyManifest(),
      autoload: {
        ...emptyManifest().autoload,
        psr4: { "App\\": ["src/"], "App\\Models\\": ["custom-models/"] },
      },
    };
    const map = await buildComposerAutoloadMap(ROOT, files, manifest);
    expect(map.classToFile.get("App\\Models\\User")).toBe(join(ROOT, "custom-models", "User.php"));
    expect(map.classToFile.has("App\\Custom-models\\User")).toBe(false);
  });
});

describe("buildComposerAutoloadMap — psr-0 (AC-1)", () => {
  test("flat/legacy-style prefix (ends in `_`): nested dirs fold into one underscore-joined class name", async () => {
    const files = [join(ROOT, "library", "Zend", "Db", "Table.php")];
    const manifest = {
      ...emptyManifest(),
      autoload: { ...emptyManifest().autoload, psr0: { Zend_: ["library/"] } },
    };
    const map = await buildComposerAutoloadMap(ROOT, files, manifest);
    expect(map.classToFile.get("Zend_Db_Table")).toBe(join(ROOT, "library", "Zend", "Db", "Table.php"));
  });

  test("namespace-style prefix (ends in `\\\\`): mirrors psr-4, no underscore conversion", async () => {
    const files = [join(ROOT, "lib", "Doctrine", "Common", "Persistence", "ObjectManager.php")];
    const manifest = {
      ...emptyManifest(),
      autoload: { ...emptyManifest().autoload, psr0: { "Doctrine\\Common\\": ["lib/"] } },
    };
    const map = await buildComposerAutoloadMap(ROOT, files, manifest);
    expect(map.classToFile.get("Doctrine\\Common\\Persistence\\ObjectManager")).toBe(
      join(ROOT, "lib", "Doctrine", "Common", "Persistence", "ObjectManager.php"),
    );
  });

  test("namespace-style prefix: an underscore in an intermediate (non-final) directory segment is preserved literally, not converted", async () => {
    const files = [join(ROOT, "lib", "Doctrine", "Foo_Bar", "Baz.php")];
    const manifest = {
      ...emptyManifest(),
      autoload: { ...emptyManifest().autoload, psr0: { "Doctrine\\": ["lib/"] } },
    };
    const map = await buildComposerAutoloadMap(ROOT, files, manifest);
    expect(map.classToFile.get("Doctrine\\Foo_Bar\\Baz")).toBe(join(ROOT, "lib", "Doctrine", "Foo_Bar", "Baz.php"));
  });
});

describe("buildComposerAutoloadMap — classmap (AC-1)", () => {
  const CLASSMAP_FIXTURES = join(__dirname, "fixtures", "php-composer-autoload");

  test("classmap directory: every declared class under it resolves, even without a matching psr-4/psr-0 rule", async () => {
    const root = join(CLASSMAP_FIXTURES, "classmap-dir");
    const files = [join(root, "legacy", "OldThing.php")];
    const manifest = {
      ...emptyManifest(),
      autoload: { ...emptyManifest().autoload, classmap: ["legacy/"] },
    };
    const map = await buildComposerAutoloadMap(root, files, manifest);
    expect(map.classToFile.get("OldThing")).toBe(join(root, "legacy", "OldThing.php"));
  });

  test("classmap explicit file entry resolves without scanning the rest of its directory", async () => {
    const root = join(CLASSMAP_FIXTURES, "classmap-file");
    const files = [join(root, "src", "Compat.php"), join(root, "src", "NotListed.php")];
    const manifest = {
      ...emptyManifest(),
      autoload: { ...emptyManifest().autoload, classmap: ["src/Compat.php"] },
    };
    const map = await buildComposerAutoloadMap(root, files, manifest);
    expect(map.classToFile.get("Compat")).toBe(join(root, "src", "Compat.php"));
    expect(map.classToFile.has("NotListed")).toBe(false);
  });
});

describe("buildComposerAutoloadMap — files (AC-1)", () => {
  test("files entries are surfaced as absolute paths, kept separate from the FQCN map", async () => {
    const files: string[] = [];
    const manifest = {
      ...emptyManifest(),
      autoload: { ...emptyManifest().autoload, files: ["src/bootstrap.php"] },
    };
    const map = await buildComposerAutoloadMap(ROOT, files, manifest);
    expect(map.filesAutoload).toEqual([join(ROOT, "src", "bootstrap.php")]);
    expect(map.classToFile.size).toBe(0);
  });
});
