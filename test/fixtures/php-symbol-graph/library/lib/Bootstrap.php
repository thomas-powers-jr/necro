<?php

// An unrelated prod entry (via necro.config.json-style `entries`, not
// composer bin/public-index) purely so `entryResolution.collapsed` is
// `false` — isolating the assertion on `Widget::doThing` to the library
// quarantine mechanism alone, matching `scan-php-library-quarantine.test.ts`'s
// established `Bootstrap.php` precedent exactly.
echo "boot";
