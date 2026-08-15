<?php

namespace App;

class Worker
{
    use Loggable;

    /** Never called anywhere in this fixture — a genuinely dead method living alongside a live, trait-composed one. */
    public function work(): string
    {
        return "working";
    }
}
