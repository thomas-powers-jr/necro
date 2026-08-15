<?php

namespace App;

/**
 * Declares `__call` — T6's magic-method taint. Kept in its own file
 * (deliberately): `findPhpTaintedFiles` taints at file granularity, so if
 * this class shared a file with any other fixture class, that class's own
 * unrelated dead methods would spuriously read `maybe` too, muddying the
 * truth table. Isolating it here means only `MagicBox`'s own members carry
 * the taint.
 */
class MagicBox
{
    private array $data = [];

    public function __call(string $name, array $arguments)
    {
        return $this->data[$name] ?? null;
    }

    /** Never called directly (only reachable, if at all, through the implicit __call dispatch this analyzer can't trace) — still genuinely unreferenced by a static `->` call, but the file's taint must demote it to `maybe`, not `likely`. */
    public function unreferenced(): string
    {
        return "never called directly";
    }
}
