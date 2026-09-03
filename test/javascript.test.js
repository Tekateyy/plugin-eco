const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { initParser, parse } = require('../out/parser');
const { collectFindings } = require('../out/rules');
const { specFor } = require('../out/languages');

const ROOT = path.join(__dirname, '..');

before(async () => {
  await initParser(ROOT);
});

const analyze = (code, languageId) =>
  collectFindings(parse(code, languageId).rootNode, specFor(languageId));

const errorCount = (node, n = 0) => {
  if (node.type === 'ERROR' || node.isMissing) n++;
  for (const c of node.children) n = errorCount(c, n);
  return n;
};

// --- Parsing : chaque langage lit sa propre syntaxe -----------------------

describe('parsing par langage', () => {
  const CASES = [
    ['javascript', "import _ from 'lodash';\nexport default () => _.groupBy(xs, 'k');"],
    ['javascriptreact', 'export const A = () => <ul className="x">{xs.map(x => <li key={x}>{x}</li>)}</ul>;'],
    ['typescript', 'interface O<T> { id: string; meta?: T }\nexport const f = (o: O<number>): boolean => o.id !== "";'],
    ['typescriptreact', 'type P = { xs: readonly string[] };\nexport const A = ({ xs }: P) => <div>{xs.map(x => <b key={x}>{x}</b>)}</div>;'],
  ];

  for (const [languageId, code] of CASES) {
    test(`${languageId} parse sans erreur`, () => {
      const tree = parse(code, languageId);
      assert.strictEqual(errorCount(tree.rootNode), 0);
    });
  }

  test('typescript avale l\'assertion à l\'ancienne <T>v, que tsx refuse', () => {
    // C'est la raison d'être des deux grammaires (mesuré le 3 sept. 2026).
    const code = "const el = <HTMLInputElement>document.getElementById('q');";
    assert.strictEqual(errorCount(parse(code, 'typescript').rootNode), 0);
    assert.ok(errorCount(parse(code, 'typescriptreact').rootNode) > 0);
  });

  test('un langage non supporté lève une erreur explicite', () => {
    assert.throws(() => parse('print(1)', 'python'), /Langage non supporté/);
  });
});

// --- Règles portables ----------------------------------------------------

describe('règle boucle imbriquée en JS/TS', () => {
  test('for imbriqués en JavaScript', () => {
    const findings = analyze(`
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) { total += grid[i][j]; }
      }`, 'javascript');
    assert.strictEqual(findings.filter(f => f.message.includes('imbriquée')).length, 1);
  });

  test('for-of imbriqué dans un for-of', () => {
    const findings = analyze(`
      for (const a of xs) {
        for (const b of ys) { use(a, b); }
      }`, 'javascript');
    assert.strictEqual(findings.filter(f => f.message.includes('imbriquée')).length, 1);
  });

  test('boucles successives : rien', () => {
    const findings = analyze(`
      for (const a of xs) { f(a); }
      for (const b of ys) { g(b); }`, 'javascript');
    assert.strictEqual(findings.length, 0);
  });

  test('fonctionne aussi en TypeScript typé', () => {
    const findings = analyze(`
      export function compute(grid: number[][]): number {
        let total = 0;
        for (let i = 0; i < grid.length; i++) {
          for (let j = 0; j < grid[i].length; j++) { total += grid[i][j]; }
        }
        return total;
      }`, 'typescript');
    assert.strictEqual(findings.filter(f => f.message.includes('imbriquée')).length, 1);
  });

  test('fonctionne dans un composant TSX', () => {
    const findings = analyze(`
      export const Grid = ({ rows }: { rows: string[][] }) => {
        for (const r of rows) { for (const c of r) { void c; } }
        return <div />;
      };`, 'typescriptreact');
    assert.strictEqual(findings.filter(f => f.message.includes('imbriquée')).length, 1);
  });
});

describe('règle SQL sans LIMIT en JS/TS', () => {
  test('chaîne simple', () => {
    const findings = analyze(`const q = "SELECT * FROM orders";`, 'javascript');
    assert.strictEqual(findings.filter(f => f.message.includes('LIMIT')).length, 1);
  });

  test('gabarit (template string)', () => {
    const findings = analyze('const q = `SELECT * FROM orders WHERE id = ${id}`;', 'javascript');
    assert.strictEqual(findings.filter(f => f.message.includes('LIMIT')).length, 1);
  });

  test('avec LIMIT : rien', () => {
    const findings = analyze(`const q = "SELECT * FROM orders LIMIT 50";`, 'javascript');
    assert.strictEqual(findings.length, 0);
  });
});

// --- Règles volontairement inactives en JS -------------------------------

describe('règles Java non transposées', () => {
  test('+= en boucle ne déclenche rien en JS', () => {
    // V8 représente les concaténations par des ropes : la règle Java
    // produirait du bruit. Décision documentée dans languages.ts.
    const findings = analyze(`
      let s = '';
      for (const r of rows) { s += r; }`, 'javascript');
    assert.deepStrictEqual(findings, []);
  });

  test('new en boucle ne déclenche rien en JS', () => {
    const findings = analyze(`
      for (const p of pts) { out.push(new Point(p.x, p.y)); }`, 'javascript');
    assert.deepStrictEqual(findings, []);
  });

  test('mais les deux restent actives en Java', () => {
    const java = 'class T { void m() { String s=""; for (int i=0;i<n;i++) { s += x; new P(); } } }';
    const findings = collectFindings(parse(java, 'java').rootNode, specFor('java'));
    assert.ok(findings.some(f => f.message.includes('+=')));
    assert.ok(findings.some(f => f.message.includes('new')));
  });
});
