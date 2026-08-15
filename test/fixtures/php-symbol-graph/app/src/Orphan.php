<?php

namespace App;

/** The negative-case baseline: no caller anywhere (prod, test, or trait/interface dispatch), no taint, not public API. Proves the truth table isn't "everything defaults to live." */
class Orphan
{
    public function neverCalled(): string
    {
        return "dead";
    }
}
