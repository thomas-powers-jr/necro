<?php

// Realistic composer `bin` entry shape: a thin bootstrap script, never a
// class of its own. `resolvePhpEntries` (T4) resolves this file's path into
// `prodEntries` via the composer.json `bin` field ("composer-bin" source) —
// but `buildPhpReferenceEdges` (T2) only walks call sites *inside class
// method bodies*, never top-level script statements, and `model.ts` never
// roots this file's own exported symbols the way it does for the analogous
// `testEntries` case. So `BinTarget::run()` below, though genuinely invoked
// every time this script runs, produces zero edges and is never seeded into
// `prodEntries` as a node id — see the KNOWN GAP assertion in
// `graph-php-symbol-graph-fixtures.test.ts`.

require __DIR__ . '/../vendor/autoload.php';

use App\BinTarget;

$target = new BinTarget();
$target->run();
