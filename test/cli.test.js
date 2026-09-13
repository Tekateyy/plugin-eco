const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, meetsThreshold, collectPaths, renderText, renderRuleList, USAGE } = require('../out/cli');
const { ALL_RULE_IDS } = require('../out/languages');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'out', 'cli.js');

/**
 * Lance le CLI pour de vrai et retourne { code, stdout, stderr }.
 *
 * `spawnSync` plutôt que `execFileSync` : ce dernier ne rend `stderr` que
 * lorsqu'il lève, donc les avertissements d'une exécution réussie étaient
 * invisibles au test.
 */
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// --- Analyse des arguments -----------------------------------------------

describe('parseArgs', () => {
  test('sans argument, analyse le dossier courant en texte', () => {
    const o = parseArgs([]);
    assert.deepStrictEqual(o.paths, ['.']);
    assert.strictEqual(o.format, 'text');
    assert.strictEqual(o.min, undefined);
  });

  test('accepte plusieurs chemins', () => {
    assert.deepStrictEqual(parseArgs(['src', 'samples']).paths, ['src', 'samples']);
  });

  test('--format json', () => {
    assert.strictEqual(parseArgs(['--format', 'json']).format, 'json');
  });

  test('--min accepte la minuscule', () => {
    assert.strictEqual(parseArgs(['--min', 'c']).min, 'C');
  });

  test('un format inconnu est refusé', () => {
    assert.throws(() => parseArgs(['--format', 'xml']), /Format inconnu/);
  });

  test('une note invalide est refusée', () => {
    assert.throws(() => parseArgs(['--min', 'Z']), /Note minimale invalide/);
  });

  test('une option inconnue est refusée', () => {
    assert.throws(() => parseArgs(['--turbo']), /Option inconnue/);
  });

  test('-h et --help sont reconnus', () => {
    assert.ok(parseArgs(['-h']).help);
    assert.ok(parseArgs(['--help']).help);
  });

  test('--ignore-rule accumule les occurrences répétées', () => {
    const o = parseArgs(['--ignore-rule', 'nested-loops', '--ignore-rule', 'sql-without-limit']);
    assert.deepStrictEqual(o.ignoreRules, ['nested-loops', 'sql-without-limit']);
  });

  test('--ignore-rule refuse un identifiant inconnu', () => {
    assert.throws(() => parseArgs(['--ignore-rule', 'n-importe-quoi']), /Règle inconnue/);
  });

  test('--list-rules est reconnu', () => {
    assert.ok(parseArgs(['--list-rules']).listRules);
  });
});

// --- Seuil ----------------------------------------------------------------

describe('meetsThreshold', () => {
  test('A est la meilleure note', () => {
    assert.ok(meetsThreshold('A', 'E'));
    assert.ok(meetsThreshold('A', 'A'));
  });

  test('une note égale au seuil passe', () => {
    assert.ok(meetsThreshold('C', 'C'));
  });

  test('une note plus mauvaise échoue', () => {
    assert.ok(!meetsThreshold('D', 'C'));
    assert.ok(!meetsThreshold('E', 'A'));
  });
});

// --- Découverte des fichiers ---------------------------------------------

describe('collectPaths', () => {
  test('un fichier analysable est retenu', () => {
    assert.strictEqual(collectPaths(path.join(ROOT, 'samples', 'example.ts')).length, 1);
  });

  test('un fichier non analysable est ignoré', () => {
    assert.deepStrictEqual(collectPaths(path.join(ROOT, 'README.md')), []);
  });

  test('un dossier est parcouru récursivement', () => {
    const found = collectPaths(path.join(ROOT, 'src'));
    assert.ok(found.length >= 8, `attendu au moins 8 fichiers, obtenu ${found.length}`);
    assert.ok(found.every(f => f.endsWith('.ts')));
  });

  test('les dossiers exclus ne sont pas parcourus', () => {
    // node_modules est sous ROOT : sans exclusion, le scan exploserait.
    const found = collectPaths(ROOT);
    assert.ok(!found.some(f => f.includes('node_modules')), 'node_modules aurait dû être exclu');
    assert.ok(!found.some(f => f.includes(`${path.sep}out${path.sep}`)), 'out aurait dû être exclu');
  });

  test('un chemin introuvable lève une erreur explicite', () => {
    assert.throws(() => collectPaths(path.join(ROOT, 'nexistepas')), /Chemin introuvable/);
  });
});

// --- Rendu ----------------------------------------------------------------

describe('renderText', () => {
  const report = {
    global: { letter: 'C', value: 70, findingCount: { high: 1, medium: 1, low: 0 } },
    filesWithFindings: 1,
    scannedAt: '2026-09-03T00:00:00.000Z',
    files: [
      {
        uri: 'a.ts', fileName: 'src/a.ts',
        score: { letter: 'C', value: 70, findingCount: { high: 1, medium: 1, low: 0 } },
        findings: [{ startLine: 4, startChar: 2, endLine: 4, endChar: 9, severity: 'high', weight: 12, ruleId: 'nested-loops', message: 'Boucle imbriquée — détail' }],
      },
      {
        uri: 'b.ts', fileName: 'src/b.ts',
        score: { letter: 'A', value: 100, findingCount: { high: 0, medium: 0, low: 0 } },
        findings: [],
      },
    ],
  };

  test('les positions sont au format fichier:ligne:colonne, en base 1', () => {
    assert.match(renderText(report), /src\/a\.ts:5:3/);
  });

  test('les fichiers sans alerte ne sont pas listés', () => {
    assert.ok(!renderText(report).includes('src/b.ts'));
  });

  test('l\'étendue est rappelée', () => {
    assert.match(renderText(report), /1 fichier\(s\) concerné\(s\) sur 2 analysé\(s\)/);
  });

  test('un rapport sans alerte le dit', () => {
    const vide = { ...report, files: [report.files[1]], filesWithFindings: 0 };
    assert.match(renderText(vide), /Aucune alerte/);
  });

  test('le ruleId de chaque finding est affiché', () => {
    assert.match(renderText(report), /\(nested-loops\)/);
  });
});

describe('renderRuleList', () => {
  test('liste chaque règle avec son contexte d\'application', () => {
    const out = renderRuleList();
    for (const id of ALL_RULE_IDS) assert.match(out, new RegExp(id));
    assert.match(out, /polling-interval\s+client/);
    assert.match(out, /nested-loops\s+partout/);
  });
});

// --- Bout en bout ---------------------------------------------------------

describe('exécution réelle du binaire', () => {
  test('--help sort en succès et affiche l\'usage', () => {
    const r = run(['--help']);
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.startsWith('Usage : plugin-eco'));
  });

  test('analyse samples/ et rend le score attendu', () => {
    const r = run(['samples']);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /Éco : D 48\/100/);
    assert.match(r.stdout, /samples\/Example\.java/);
  });

  test('--min au-dessus de la note fait échouer le processus', () => {
    const r = run(['--min', 'C', 'samples']);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /en dessous du seuil C/);
  });

  test('--min atteignable laisse passer', () => {
    assert.strictEqual(run(['--min', 'E', 'samples']).code, 0);
  });

  test('la sortie json est un rapport valide', () => {
    const r = run(['--format', 'json', 'samples']);
    assert.strictEqual(r.code, 0);
    const report = JSON.parse(r.stdout);
    assert.strictEqual(report.global.letter, 'D');
    assert.strictEqual(report.filesWithFindings, 4);
    assert.ok(Array.isArray(report.files));
    // Le pire fichier vient en premier.
    assert.strictEqual(report.files[0].score.letter, 'E');
  });

  test('une option inconnue sort en code 2 avec l\'usage', () => {
    const r = run(['--turbo']);
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /Option inconnue/);
    assert.ok(r.stderr.includes('Usage : plugin-eco'));
  });

  test('un chemin introuvable sort en code 2', () => {
    assert.strictEqual(run(['nexistepas']).code, 2);
  });

  test('un dossier sans code analysable avertit mais n\'échoue pas', () => {
    const r = run(['.github']);
    assert.strictEqual(r.code, 0);
    assert.match(r.stderr, /Aucun fichier analysable/);
  });

  test('--list-rules affiche les règles et quitte sans analyser', () => {
    const r = run(['--list-rules']);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /Règles disponibles/);
    assert.match(r.stdout, /nested-loops/);
  });

  test('--ignore-rule retire les findings de cette règle et recalcule le score', () => {
    // samples/Example.java : E 28/100 (voir sample.test.js). En retirant les
    // deux règles hautes nested-loops et sql-without-limit, il ne reste que
    // 2 hautes (24) + 3 moyennes (21) = 45 de pénalité, donc C 55/100.
    const r = run(['--ignore-rule', 'nested-loops', '--ignore-rule', 'sql-without-limit', 'samples/Example.java']);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /Éco : C 55\/100/);
    assert.ok(!r.stdout.includes('imbriquée'));
    assert.ok(!r.stdout.includes('LIMIT'));
  });

  test('--ignore-rule avec un identifiant inconnu sort en code 2', () => {
    const r = run(['--ignore-rule', 'n-importe-quoi', 'samples/Example.java']);
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /Règle inconnue/);
  });

  test('le CLI ne charge jamais le code d\'extension', () => {
    // Il tourne hors de VSCode : importer `vscode` le ferait planter.
    // Ce test échoue donc si quelqu'un branche cli.ts sur extension.ts.
    assert.ok(!USAGE.includes('vscode'));
    assert.strictEqual(run(['samples/example.ts']).code, 0);
  });
});
