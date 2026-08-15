import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** A `psr-4`/`psr-0` block: namespace prefix -> directories (composer allows a bare string or an array per prefix; always normalized to `string[]` here). */
export type ComposerPrefixMap = Record<string, string[]>;

export interface ComposerAutoloadBlock {
  psr4: ComposerPrefixMap;
  psr0: ComposerPrefixMap;
  /** Directories and/or explicit file paths scanned for class-like declarations. */
  classmap: string[];
  /** Unconditionally-included scripts (composer requires these on every autoload, not namespace-derived). */
  files: string[];
}

export interface ComposerManifest {
  autoload: ComposerAutoloadBlock;
  autoloadDev: ComposerAutoloadBlock;
  /** Composer's top-level `bin` field (a sibling of `autoload`, not inside it) — script paths relative to the manifest's own directory. Composer allows a bare string or an array of strings; always normalized to `string[]` here, matching this file's existing psr-4/psr-0 array normalization convention. */
  bin: string[];
}

function emptyAutoloadBlock(): ComposerAutoloadBlock {
  return { psr4: {}, psr0: {}, classmap: [], files: [] };
}

function emptyManifest(): ComposerManifest {
  return {
    autoload: emptyAutoloadBlock(),
    autoloadDev: emptyAutoloadBlock(),
    bin: [],
  };
}

/** Read and normalize `composer.json`'s `autoload`/`autoload-dev` blocks from `root`. Best-effort: a missing file, malformed JSON, or missing/empty autoload block returns an empty manifest — never throws. */
export async function readComposerManifest(
  root: string,
): Promise<ComposerManifest> {
  let raw: string;
  try {
    raw = await readFile(join(root, "composer.json"), "utf8");
  } catch {
    return emptyManifest();
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return emptyManifest();
  }

  if (typeof json !== "object" || json === null) return emptyManifest();
  const obj = json as Record<string, unknown>;

  return {
    autoload: parseAutoloadBlock(obj.autoload),
    autoloadDev: parseAutoloadBlock(obj["autoload-dev"]),
    bin: parseStringOrArray(obj.bin),
  };
}

function parseAutoloadBlock(value: unknown): ComposerAutoloadBlock {
  if (typeof value !== "object" || value === null) return emptyAutoloadBlock();
  const block = value as Record<string, unknown>;

  return {
    psr4: parsePrefixMap(block["psr-4"]),
    psr0: parsePrefixMap(block["psr-0"]),
    classmap: parseStringArray(block.classmap),
    files: parseStringArray(block.files),
  };
}

function parsePrefixMap(value: unknown): ComposerPrefixMap {
  if (typeof value !== "object" || value === null) return {};
  const out: ComposerPrefixMap = {};
  for (const [prefix, dirs] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (typeof dirs === "string") out[prefix] = [dirs];
    else if (Array.isArray(dirs))
      out[prefix] = dirs.filter((d): d is string => typeof d === "string");
  }
  return out;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Composer's `bin` field: a bare string or an array of strings — unlike `classmap`/`files` (always arrays per the composer schema), `bin` allows either shape, so it always normalizes to `string[]` here. */
function parseStringOrArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
