<?php
// Fixture pour `plugin-eco measure` — pendant PHP de bench.js. Brûle un peu de
// CPU et alloue un peu de mémoire, se termine de lui-même.
//
// Silencieux volontairement (pas d'echo) : mêmes raisons que bench.js, voir son
// commentaire — `measure` hérite le stdout du script mesuré.
$total = 0.0;
$data = [];
for ($i = 0; $i < 20000000; $i++) {
    $total += sqrt($i);
    if ($i % 500 === 0) {
        $data[] = str_repeat("x", 1024);
    }
}

if ($total < 0) {
    exit(1);
}
