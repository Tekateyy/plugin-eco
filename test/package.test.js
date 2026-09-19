const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/**
 * Ce que `npm publish` embarquerait réellement.
 *
 * `.npmignore` est une liste d'exclusion : tout fichier ajouté plus tard à la
 * racine y échappe par défaut. Ces tests renversent la charge de la preuve en
 * vérifiant le contenu effectif du paquet — ils échouent dès qu'un fichier
 * inattendu s'y invite.
 */
function packedFiles() {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32',
  });
  assert.strictEqual(r.status, 0, `npm pack a échoué : ${r.stderr}`);
  // npm < 12 rend un tableau `[{...}]` ; npm >= 12 un objet `{"<nom>": {...}}`.
  // `Object.values` lit les deux formes indifféremment, sans figer sur l'une.
  const [paquet] = Object.values(JSON.parse(r.stdout));
  return paquet.files.map(f => f.path.replace(/\\/g, '/'));
}

describe('contenu du paquet npm', () => {
  const files = packedFiles();

  test('rien de local ni de confidentiel n\'est publié', () => {
    // CLAUDE.md contient le journal de décisions, des chemins machine et des
    // références à d'autres dépôts privés ; .claude/ contient la configuration
    // locale de l'outillage. Les deux partaient avant ce correctif.
    const interdits = [
      'CLAUDE.md', '.claude/', '.vscode/', '.github/',
      '.env', '.npmrc', 'tsconfig.json', '.vscodeignore', '.npmignore',
    ];
    for (const motif of interdits) {
      const fuite = files.filter(f => f === motif || f.startsWith(motif));
      assert.deepStrictEqual(fuite, [], `${motif} ne doit pas être publié`);
    }
  });

  test('ni les sources, ni les tests, ni les exemples', () => {
    for (const prefixe of ['src/', 'test/', 'samples/', 'fixtures/', 'scripts/']) {
      assert.deepStrictEqual(
        files.filter(f => f.startsWith(prefixe)), [],
        `${prefixe} ne doit pas être publié`
      );
    }
  });

  test('pas de carte de source — elle expose l\'arborescence interne', () => {
    assert.deepStrictEqual(files.filter(f => f.endsWith('.map')), []);
  });

  test('le paquet contient tout ce qu\'il faut pour tourner', () => {
    for (const requis of [
      'package.json', 'README.md', 'LICENSE',
      'out/index.js', 'out/index.d.ts',
      'out/cli.js', 'out/rules.js', 'out/scoring.js', 'out/context.js',
      'out/languages.js', 'out/parser.js', 'out/measure.js', 'out/probe.js',
      'out/wasm/tree-sitter.wasm', 'out/wasm/tree-sitter-java.wasm',
      'out/wasm/tree-sitter-tsx.wasm', 'out/wasm/tree-sitter-typescript.wasm',
      'out/wasm/tree-sitter-python.wasm',
    ]) {
      assert.ok(files.includes(requis), `${requis} manque au paquet`);
    }
  });

  test('aucun fichier hors de la liste attendue', () => {
    // Le filet : si quelqu'un ajoute un fichier à la racine, ce test tombe et
    // l'oblige à décider explicitement s'il doit être publié.
    const inattendus = files.filter(f =>
      !f.startsWith('out/') && !['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'].includes(f)
    );
    assert.deepStrictEqual(inattendus, []);
  });

  test('le changelog est publié', () => {
    // Pas nécessaire à l'exécution, mais lu par le Marketplace VSCode (onglet
    // « Changelog » automatique si le fichier est présent dans le .vsix) et
    // utile sur la page npm.
    assert.ok(files.includes('CHANGELOG.md'));
  });
});

describe('sûreté du manifeste', () => {
  const manifest = require(path.join(ROOT, 'package.json'));

  test('aucun script ne s\'exécute à l\'installation', () => {
    // Un postinstall est le vecteur classique de compromission npm : il tourne
    // sur la machine de qui installe, sans qu il ait lu une ligne du code.
    for (const hook of ['preinstall', 'install', 'postinstall']) {
      assert.strictEqual(manifest.scripts[hook], undefined, `${hook} ne doit pas exister`);
    }
  });

  test('la publication reconstruit et reteste', () => {
    // npm ignore vscode:prepublish : sans prepublishOnly, on publierait le
    // contenu de out/ tel qu'il traîne sur la machine.
    assert.match(manifest.scripts.prepublishOnly, /compile/);
    assert.match(manifest.scripts.prepublishOnly, /test/);
  });

  test('une seule dépendance d\'exécution', () => {
    // Chaque dépendance est une surface de compromission supplémentaire.
    assert.deepStrictEqual(Object.keys(manifest.dependencies), ['web-tree-sitter']);
  });

  test('la licence et le dépôt sont déclarés', () => {
    assert.strictEqual(manifest.license, 'MIT');
    assert.ok(manifest.repository?.url);
  });

  test('le point d\'entrée npm ne passe pas par le code d\'extension', () => {
    // `main` sert VSCode, qui le charge en chemin absolu et ignore `exports`.
    // Un `require('plugin-eco')` doit atterrir sur le moteur, pas sur
    // extension.js — qui importe `vscode` et casse hors de l'éditeur.
    assert.strictEqual(manifest.exports['.'], './out/index.js');
    assert.strictEqual(manifest.main, './out/extension');
  });
});

describe('frontière d\'exécution', () => {
  // `plugin-eco measure` exécute du code : c'est le seul endroit du paquet qui
  // le fait, et il ne doit être atteignable que sur commande explicite du CLI.
  // Ni l'extension (activation, sauvegarde, scan du workspace), ni la
  // bibliothèque `require('plugin-eco')` ne doivent pouvoir y mener. Ces
  // tests lisent le code réellement packagé (out/), pas les sources.
  const OUT = path.join(ROOT, 'out');
  const compiled = Object.fromEntries(
    fs.readdirSync(OUT).filter(f => f.endsWith('.js'))
      .map(f => [f, fs.readFileSync(path.join(OUT, f), 'utf8')])
  );

  test('seul measure.js importe child_process', () => {
    for (const [file, code] of Object.entries(compiled)) {
      const uses = /require\(["']child_process["']\)/.test(code);
      assert.strictEqual(uses, file === 'measure.js',
        `${file} ${uses ? 'ne doit pas' : 'doit'} importer child_process`);
    }
  });

  test('seul le CLI importe measure.js', () => {
    for (const [file, code] of Object.entries(compiled)) {
      const uses = /require\(["']\.\/measure["']\)/.test(code);
      assert.strictEqual(uses, file === 'cli.js',
        `${file} ${uses ? 'ne doit pas' : 'doit'} importer ./measure`);
    }
  });

  test('l\'extension ne lance aucun processus', () => {
    for (const file of ['extension.js', 'workspace.js', 'webview.js', 'index.js']) {
      assert.doesNotMatch(compiled[file], /\b(spawn|exec|execFile|fork)(Sync)?\(/,
        `${file} ne doit lancer aucun processus`);
    }
  });

  test('la sonde ne dépend que de fs', () => {
    // Elle tourne dans le processus de l'utilisateur : rien d'autre que
    // l'écriture de sa mesure ne doit y entrer.
    const requires = [...compiled['probe.js'].matchAll(/require\(["']([^"']+)["']\)/g)].map(m => m[1]);
    assert.deepStrictEqual(requires, ['fs']);
  });

  test('charger la bibliothèque ne charge pas measure.js', () => {
    require(path.join(OUT, 'index.js'));
    const loaded = Object.keys(require.cache).filter(k => k.endsWith('measure.js'));
    assert.deepStrictEqual(loaded, []);
  });
});

describe('point d\'entrée bibliothèque', () => {
  // Le vrai test de non-régression : charger le paquet comme le ferait un
  // consommateur npm. Avant `exports`, ceci levait sur `require('vscode')`.
  const api = require(path.join(ROOT, 'out', 'index.js'));

  test('le moteur est exposé', () => {
    for (const nom of ['initParser', 'parse', 'collectFindings',
                       'computeScore', 'inferContext', 'specFor']) {
      assert.strictEqual(typeof api[nom], 'function', `${nom} manque à l'API`);
    }
  });

  test('rien de l\'intégration VSCode ne fuit', () => {
    for (const interdit of ['activate', 'buildWebviewHtml', 'analyzeWorkspace']) {
      assert.strictEqual(api[interdit], undefined, `${interdit} ne doit pas être exposé`);
    }
  });

  test('initParser trouve les grammaires sans qu\'on lui donne le chemin', async () => {
    // Un consommateur npm ne peut pas connaître la racine d'installation.
    await api.initParser();
    const findings = api.collectFindings(
      api.parse('class T { void m() { String q = "SELECT * FROM t"; } }', 'java').rootNode,
      api.specFor('java')
    );
    assert.strictEqual(findings.length, 1);
  });
});
