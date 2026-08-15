<?php

namespace Lib;

/**
 * Genuinely unreferenced (no caller anywhere in this fixture) and declared
 * under the package's own PSR-4 namespace (`Lib\`, mapped to `lib/` by
 * `composer.json`'s `autoload.psr-4`). AC-5's library-quarantine mechanism
 * should demote this from what would otherwise be tier `likely` to `maybe`
 * — a library's own unreferenced-within-the-package public API is exactly
 * the case `publicApiIds` exists to protect from a false "certain/likely
 * dead" verdict.
 */
class Widget
{
    public function doThing(): string
    {
        return "thing";
    }
}
