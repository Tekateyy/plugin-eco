<?php
// Sonde de mesure runtime pour PHP — préchargée, pas une instrumentation.
//
// Lancée comme `php -d auto_prepend_file=probe.php script.php [args...]` : PHP
// exécute ce fichier avant le script, dans le même processus, sans toucher au
// code de l'utilisateur. Même patron que le `--require probe.js` de Node.
//
// Contrat identique à probe.js et probe.py : aucune sortie sur stdout/stderr,
// un seul effet de bord — le JSON écrit dans PLUGIN_ECO_PROBE_OUT à la fin du
// script. measure.ts en est le seul lecteur. Pas de balise fermante : suivie
// d'un saut de ligne, elle enverrait ce saut de ligne sur stdout. Et jamais la
// balise elle-même, même en commentaire : PHP la reconnaît aussi dans un `//`
// et repasse en mode texte, ce qui imprimerait la suite du fichier.
//
// Deux écarts assumés par rapport aux sondes Node et Python :
//  - maxRssBytes est `memory_get_peak_usage(true)`, le pic de mémoire que PHP a
//    réservé pour le script, pas un RSS de pointe — il n'existe pas de lecture
//    portable de celui-ci en PHP sans extension (même arbitrage que le pic de
//    tas côté Java) ;
//  - sans getrusage(), la sonde n'écrit rien plutôt qu'un CPU à zéro : measure.ts
//    le signale comme une absence de mesure.

(function () {
    $outPath = getenv('PLUGIN_ECO_PROBE_OUT');
    if ($outPath === false || $outPath === '' || !function_exists('getrusage')) {
        return;
    }

    $startedAt = hrtime(true);

    $write = function () use ($outPath, $startedAt) {
        $usage = getrusage();
        $result = [
            'cpuUserUs' => $usage['ru_utime.tv_sec'] * 1000000 + $usage['ru_utime.tv_usec'],
            'cpuSystemUs' => $usage['ru_stime.tv_sec'] * 1000000 + $usage['ru_stime.tv_usec'],
            'wallMs' => (hrtime(true) - $startedAt) / 1e6,
            'maxRssBytes' => memory_get_peak_usage(true),
        ];
        // Rien à faire depuis une fonction d'arrêt : le parent constatera
        // l'absence du fichier et le signalera lui-même.
        @file_put_contents($outPath, json_encode($result));
    };

    // Les fonctions d'arrêt s'exécutent dans l'ordre d'enregistrement, et celle-ci
    // est enregistrée avant celles du script. En s'enregistrant depuis une
    // fonction d'arrêt, `$write` passe après elles et compte leur travail.
    register_shutdown_function(function () use ($write) {
        register_shutdown_function($write);
    });
})();
