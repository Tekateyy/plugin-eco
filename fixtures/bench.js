// Fixture pour `plugin-eco measure` — un script qui brûle un peu de CPU puis
// se termine de lui-même, pour valider la chaîne sonde → mesure → estimation.
//
// À la racine dans fixtures/, ni dans samples/ ni dans test/ :
//  - samples/ est balayé par les scans `plugin-eco samples/` des tests CLI, qui
//    reconnaissent l'extension .js — un fichier de plus y aurait décalé les
//    scores figés dans ces tests ;
//  - le test runner de Node découvre par défaut tout fichier .js sous un
//    dossier nommé test/ (y compris ses sous-dossiers), et l'exécuterait comme
//    un test à part entière.
//
// Silencieux volontairement (pas de console.log) : `measure` hérite le
// stdout du script mesuré pour que l'utilisateur le voie tourner en direct,
// et écrit son propre rapport sur ce même flux — un script bavard romprait le
// format `--format json`. Voir MEASURE_USAGE dans src/cli.ts.
let total = 0;
for (let i = 0; i < 50_000_000; i++) {
  total += Math.sqrt(i);
}

// Empêche l'optimiseur d'éliminer la boucle faute d'usage de `total`, sans
// rien écrire sur stdout.
if (total < 0) {
  process.exitCode = 1;
}
