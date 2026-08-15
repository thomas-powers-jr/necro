<?php

// The `public/index.php` web-entry convention (T4's second entry-resolution
// mechanism, "convention" source). Same structural limitation as
// `bin/console.php` (see that file's comment): this script's own calls never
// produce edges or root any node id, so it doesn't change any verdict below
// beyond making `entryResolution.sources` report the "convention" source.
// `Greeter::greet()` happens to already be test-reachable via
// `tests/AppTest.php`'s call chain, independent of this file.

require __DIR__ . '/../vendor/autoload.php';

use App\Greeter;

$greeter = new Greeter();
echo $greeter->greet();
