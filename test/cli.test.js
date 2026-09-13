const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const fs = require('node:fs');
const os = require('node:os');

const {
  parseArgs, meetsThreshold, collectPaths,
  renderText, renderRuleList, renderGithubCommands, renderMarkdown, USAGE,
} = require('../out/cli');
const { ALL_RULE_IDS } = require('../out/languages');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'out', 'cli.js');

/**
 * Lance le CLI pour de vrai et retourne { code, stdout, stderr }.
 *
 * `spawnSync` plutôt que `execFileSync` : ce dernier ne rend `stderr` que
 * lorsqu'il lève, donc les avertissements d'une exécution réussie étaient
 * invisibles au test.
 *
 * `env` s'ajoute à l'environnement courant ; `GITHUB_STEP_SUMMARY` en est
 * retiré par défaut pour que la suite ne dépende pas de là où elle tourne.
 */
function run(args, env = {}) {
  const { GITHUB_STEP_SUMMARY: _ignored, ...base } = process.env;
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...base, ...env },
  });
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

  test('--format github', () => {
    assert.strictEqual(parseArgs(['--format', 'github']).format, 'github');
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

describe('format github — renderGithubCommands', () => {
  const finding = (over) => ({
    startLine: 4, startChar: 2, endLine: 4, endChar: 9,
    severity: 'high', weight: 12, ruleId: 'nested-loops', message: 'Boucle imbriquée — détail',
    ...over,
  });
  const report = (files) => ({
    global: { letter: 'C', value: 70, findingCount: { high: 1, medium: 0, low: 0 } },
    filesWithFindings: files.length, scannedAt: '', files,
  });
  const file = (fileName, findings) => ({
    uri: fileName, fileName, findings,
    score: { letter: 'C', value: 70, findingCount: { high: 1, medium: 0, low: 0 } },
  });

  test('une commande par alerte, position en base 1, règle en titre', () => {
    const out = renderGithubCommands(report([file('src/a.ts', [finding({})])]));
    assert.strictEqual(
      out,
      '::error file=src/a.ts,line=5,col=3,title=nested-loops::Boucle imbriquée — détail'
    );
  });

  test('la sévérité donne le niveau : haute → error, moyenne → warning, faible → notice', () => {
    const out = renderGithubCommands(report([file('a', [
      finding({ severity: 'high' }), finding({ severity: 'medium' }), finding({ severity: 'low' }),
    ])]));
    assert.deepStrictEqual(out.split('\n').map(l => l.split(' ')[0]), ['::error', '::warning', '::notice']);
  });

  test('les délimiteurs sont échappés dans les propriétés et le message', () => {
    // `:` et `,` dans un nom de fichier casseraient la liste de propriétés ;
    // un retour à la ligne dans le message terminerait la commande.
    const out = renderGithubCommands(report([file('C:/a,b.ts', [
      finding({ message: 'ligne 1\nligne 2 à 100%' }),
    ])]));
    assert.match(out, /file=C%3A\/a%2Cb\.ts,/);
    assert.match(out, /::ligne 1%0Aligne 2 à 100%25$/);
    assert.strictEqual(out.split('\n').length, 1);
  });

  test('le verdict sous le seuil devient une erreur en tête', () => {
    const out = renderGithubCommands(report([file('a', [finding({})])]), 'A');
    assert.ok(out.startsWith('::error title=Plugin Eco::Note C en dessous du seuil A.\n'));
  });

  test('sans alerte ni seuil manqué, rien', () => {
    assert.strictEqual(renderGithubCommands(report([file('a', [])])), '');
  });
});

describe('format github — renderMarkdown', () => {
  const report = {
    global: { letter: 'D', value: 40, findingCount: { high: 2, medium: 1, low: 0 } },
    filesWithFindings: 1, scannedAt: '',
    files: [
      {
        uri: 'a', fileName: 'src/a|b.ts',
        score: { letter: 'D', value: 40, findingCount: { high: 2, medium: 1, low: 0 } },
        findings: [{
          startLine: 4, startChar: 2, endLine: 4, endChar: 9, severity: 'high', weight: 12,
          ruleId: 'nested-loops', message: 'Boucle imbriquée — détail',
        }],
      },
      {
        uri: 'b', fileName: 'src/sain.ts',
        score: { letter: 'A', value: 100, findingCount: { high: 0, medium: 0, low: 0 } },
        findings: [],
      },
    ],
  };

  test('l\'étiquette est en titre, avec son icône et son libellé', () => {
    assert.match(renderMarkdown(report), /^## 🟧 Éco : D 40\/100 — Faible/);
  });

  test('les fichiers sains ne sont pas listés, la barre verticale est échappée', () => {
    const md = renderMarkdown(report);
    assert.ok(!md.includes('src/sain.ts'));
    assert.match(md, /\| `src\/a\\\|b\.ts` \| 🟧 D 40 \| 1 \|/);
  });

  test('le détail est replié et porte la règle', () => {
    const md = renderMarkdown(report);
    assert.match(md, /<details><summary>Détail des alertes<\/summary>/);
    assert.match(md, /\| 5 \| high \| `nested-loops` \| Boucle imbriquée \|/);
  });

  test('un rapport sans alerte le dit', () => {
    const vide = { ...report, files: [report.files[1]], filesWithFindings: 0 };
    assert.match(renderMarkdown(vide), /Aucune alerte/);
    assert.ok(!renderMarkdown(vide).includes('<details>'));
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

  test('--format github émet les annotations puis le résumé sur stdout', () => {
    const r = run(['--format', 'github', 'samples/Example.java']);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /^::error file=samples\/Example\.java,line=21,col=13,title=nested-loops::/m);
    assert.match(r.stdout, /^## 🟥 Éco : E 28\/100/m);
  });

  test('--format github ajoute le résumé à GITHUB_STEP_SUMMARY quand la variable existe', () => {
    const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eco-')), 'summary.md');
    fs.writeFileSync(summary, 'déjà là\n');
    const r = run(['--format', 'github', 'samples/example.ts'], { GITHUB_STEP_SUMMARY: summary });
    assert.strictEqual(r.code, 0);
    const written = fs.readFileSync(summary, 'utf8');
    // Ajouté, pas écrasé : d'autres steps peuvent avoir écrit avant.
    assert.ok(written.startsWith('déjà là\n'));
    assert.match(written, /## 🟨 Éco : C 73\/100/);
    assert.ok(!written.includes('::error'), 'les commandes ne vont pas dans le résumé');
  });

  test('--format github sous le seuil : erreur de verdict en tête et code 1', () => {
    const r = run(['--format', 'github', '--min', 'A', 'samples/example.ts']);
    assert.strictEqual(r.code, 1);
    assert.ok(r.stdout.startsWith('::error title=Plugin Eco::Note C en dessous du seuil A.\n'));
    assert.match(r.stderr, /en dessous du seuil A/);
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
