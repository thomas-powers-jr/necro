<?php

namespace Scripts;

use App\Service;

/**
 * Deliberately declared under `scripts/` — a directory this fixture's
 * `composer.json` maps via NEITHER `autoload` nor `autoload-dev`. This is
 * the gotcha, isolated: `$this->service->run()` is a one-property-hop `->`
 * call (T2's own-declaring-file resolution shape), and resolving it requires
 * looking up *this class's own* declared-property type — which requires
 * `classToFile.get("Scripts\\Caller")` to succeed. Since this file isn't
 * covered by any PSR-4 prefix, that lookup fails, and the call to
 * `Service::run()` (itself perfectly well-mapped under `App\`) silently
 * produces zero edges. `Service::run()` therefore reads `dead` even though a
 * real, typed call site exists — a false positive this fixture documents on
 * purpose (not routed around) as a known limitation of the current resolver.
 */
class Caller
{
    private Service $service;

    public function invoke(): string
    {
        return $this->service->run();
    }
}
