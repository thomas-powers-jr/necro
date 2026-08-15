<?php

namespace App;

/**
 * Interface-implementation "virtual dispatch" pairing edge (T2). A property
 * typed as this interface (`Renderable`, never the concrete `HtmlRenderer`)
 * calls `render()` — the resolver can only statically know the interface's
 * own method, so the call edge targets `Renderable::render` (this file, this
 * method's own node — interface methods are bodiless but still get a
 * `SymbolNode`, per T1). A second, separate edge (emitted by
 * `buildPhpReferenceEdges`'s own pairing pass, not by call-site resolution)
 * carries reachability from THIS node onward to `HtmlRenderer`'s own
 * override — without it, every concrete implementation of an
 * interface-typed call site would falsely read dead.
 */
interface Renderable
{
    public function render(): string;
}
