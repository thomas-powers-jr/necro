<?php

namespace Tests;

use App\Caller;
use App\Greeter;
use App\Renderable;
use App\Worker;

/**
 * No `phpunit.xml`/`phpunit.xml.dist` in this fixture, so T4 resolves this
 * file as a test entry via the `*Test.php` filename convention. Its own
 * declared properties (`$caller`, `$worker`) matter beyond typing: T2's
 * one-property-hop `->` resolution (`$this->caller->invoke(...)`) requires
 * looking up *this class's own* declared-property types, which requires
 * `getTypeInfo("Tests\\AppTest")` to succeed — which requires this file's
 * own namespace to be covered by a composer autoload block. That's why
 * `composer.json` declares `autoload-dev` for `Tests\` alongside `autoload`
 * for `App\`: omit it and both calls below silently produce zero edges (see
 * the dedicated `autoload-dev-gotcha` fixture for a minimal, isolated
 * demonstration of exactly that failure).
 */
class AppTest
{
    private Caller $caller;
    private Worker $worker;
    private Renderable $renderable;

    public function testInvokesGreeter(): string
    {
        return $this->caller->invoke(new Greeter());
    }

    public function testCallsTraitMethod(): string
    {
        return $this->worker->log("hi");
    }

    /**
     * `$renderable` is typed as the INTERFACE, never the concrete
     * `HtmlRenderer` — the resolver can only statically know
     * `Renderable::render`, so the direct call edge targets that (bodiless)
     * interface node. A separate pairing edge (see `Renderable.php`'s doc
     * comment) is what carries reachability onward to `HtmlRenderer::render`.
     */
    public function testRendersThroughInterface(): string
    {
        return $this->renderable->render();
    }
}
