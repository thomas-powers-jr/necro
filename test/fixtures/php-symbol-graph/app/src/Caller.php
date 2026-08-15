<?php

namespace App;

/**
 * Called from `tests/AppTest.php` via a typed-property `->` chain
 * (`$this->caller->invoke(...)`) — proves T1+T2+T3 wiring: a
 * typed-property-directed call resolves to a real edge and the target reads
 * non-dead. `invoke()` itself then calls `Greeter::greet()` through its own
 * typed PARAMETER (a second, independent resolution shape) — one call site
 * exercising two of T2's resolution paths at once.
 */
class Caller
{
    public function invoke(Greeter $greeter): string
    {
        return $greeter->greet();
    }
}
