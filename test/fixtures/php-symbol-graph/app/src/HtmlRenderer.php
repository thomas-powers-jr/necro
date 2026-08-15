<?php

namespace App;

/** The concrete implementation reached only via `Renderable::render`'s pairing edge — see that file's doc comment. */
class HtmlRenderer implements Renderable
{
    public function render(): string
    {
        return "<html></html>";
    }
}
