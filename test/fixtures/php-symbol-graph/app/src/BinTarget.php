<?php

namespace App;

/**
 * Called ONLY from `bin/console.php`'s top-level script code (see that
 * file's own comment) — the realistic shape of a composer `bin` entry point
 * actually invoking application code. Deliberately kept separate from every
 * other class in this fixture (not called from any test, not called from any
 * other production class) so its verdict isolates exactly one thing: whether
 * a composer-`bin`-resolved entry point roots reachability into the class it
 * invokes. As of this session's T3/T4 wiring, it does not — see the KNOWN
 * GAP assertion in `graph-php-symbol-graph-fixtures.test.ts`.
 */
class BinTarget
{
    public function run(): string
    {
        return "ran";
    }
}
