<?php

namespace App;

/**
 * Composed into `Worker` (`use Loggable;`). `Worker` never redeclares
 * `log()` itself, so the only `SymbolNode` for it lives here — a call
 * resolved through `Worker` must target *this* file's node, not a synthetic
 * one on `Worker` (T2's documented trait-edge-direction rule).
 */
trait Loggable
{
    public function log(string $message): string
    {
        return "[LOG] " . $message;
    }
}
