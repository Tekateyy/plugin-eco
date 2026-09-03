const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { initParser, parse } = require('../out/parser');
const { collectFindings } = require('../out/rules');
const { specFor } = require('../out/languages');

const ROOT = path.join(__dirname, '..');

/** Analyse un extrait Java et retourne ses findings. */
const analyze = (code) => collectFindings(parse(code, 'java').rootNode, specFor('java'));

/** Enveloppe un corps de méthode dans une classe compilable. */
const inMethod = (body) => `class T {\n  void m() throws Exception {\n${body}\n  }\n}`;

before(async () => {
  await initParser(ROOT);
});

describe('règle 1 — boucle imbriquée', () => {
  test('deux boucles imbriquées produisent un finding haut', () => {
    const findings = analyze(inMethod(`
      for (int i = 0; i < n; i++) {
        for (int j = 0; j < n; j++) { total += grid[i][j]; }
      }`));
    const nested = findings.filter(f => f.message.includes('imbriquée'));
    assert.strictEqual(nested.length, 1);
    assert.strictEqual(nested[0].severity, 'high');
    assert.strictEqual(nested[0].weight, 15);
  });

  test('deux boucles successives ne déclenchent rien', () => {
    const findings = analyze(inMethod(`
      for (int i = 0; i < n; i++) { a(); }
      for (int j = 0; j < n; j++) { b(); }`));
    assert.strictEqual(findings.filter(f => f.message.includes('imbriquée')).length, 0);
  });

  test('trois niveaux produisent deux findings', () => {
    const findings = analyze(inMethod(`
      for (int i = 0; i < n; i++) {
        for (int j = 0; j < n; j++) {
          for (int k = 0; k < n; k++) { a(); }
        }
      }`));
    assert.strictEqual(findings.filter(f => f.message.includes('imbriquée')).length, 2);
  });

  test('while et for imbriqués comptent aussi', () => {
    const findings = analyze(inMethod(`
      while (hasNext()) {
        for (int j = 0; j < n; j++) { a(); }
      }`));
    assert.strictEqual(findings.filter(f => f.message.includes('imbriquée')).length, 1);
  });
});

describe('règle 2 — concaténation += en boucle', () => {
  test('déclenchée dans une boucle', () => {
    const findings = analyze(inMethod(`
      String s = "";
      for (int i = 0; i < n; i++) { s += row[i]; }`));
    const hits = findings.filter(f => f.message.includes('+='));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].severity, 'medium');
  });

  test('hors boucle, rien', () => {
    const findings = analyze(inMethod(`String s = ""; s += "x";`));
    assert.strictEqual(findings.filter(f => f.message.includes('+=')).length, 0);
  });

  test('limitation connue : un += numérique déclenche aussi la règle', () => {
    // La règle ne consulte pas le type de la variable. Si ce test casse,
    // c'est que quelqu'un a affiné la détection — mettre à jour l'attendu.
    const findings = analyze(inMethod(`
      int total = 0;
      for (int i = 0; i < n; i++) { total += i; }`));
    assert.strictEqual(findings.filter(f => f.message.includes('+=')).length, 1);
  });
});

describe('règle 3 — création d\'objet en boucle', () => {
  test('un new dans une boucle est signalé', () => {
    const findings = analyze(inMethod(`
      for (int i = 0; i < n; i++) { list.add(new Point(i, i)); }`));
    const hits = findings.filter(f => f.message.includes('new'));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].severity, 'medium');
  });

  test('un new hors boucle ne l\'est pas', () => {
    const findings = analyze(inMethod(`Point p = new Point(1, 2);`));
    assert.strictEqual(findings.filter(f => f.message.includes('new')).length, 0);
  });
});

describe('règle 4 — Pattern.compile en boucle', () => {
  test('signalée en haute sévérité', () => {
    const findings = analyze(inMethod(`
      for (int i = 0; i < n; i++) { Pattern p = Pattern.compile("[a-z]+"); }`));
    const hits = findings.filter(f => f.message.includes('Pattern.compile'));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].severity, 'high');
  });

  test('hors boucle, rien', () => {
    const findings = analyze(inMethod(`Pattern p = Pattern.compile("[a-z]+");`));
    assert.strictEqual(findings.filter(f => f.message.includes('Pattern.compile')).length, 0);
  });
});

describe('règle 5 — I/O bloquant en boucle', () => {
  test('readLine en boucle est signalé', () => {
    const findings = analyze(inMethod(`
      while (true) { String line = reader.readLine(); }`));
    const hits = findings.filter(f => f.message.includes('I/O bloquant'));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].severity, 'high');
  });

  test('le nom de la méthode apparaît dans le message', () => {
    const findings = analyze(inMethod(`
      for (int i = 0; i < n; i++) { sc.nextLine(); }`));
    const hits = findings.filter(f => f.message.includes('I/O bloquant'));
    assert.strictEqual(hits.length, 1);
    assert.match(hits[0].message, /nextLine/);
  });

  test('hors boucle, rien', () => {
    const findings = analyze(inMethod(`String line = reader.readLine();`));
    assert.strictEqual(findings.filter(f => f.message.includes('I/O bloquant')).length, 0);
  });
});

describe('règle 6 — requête SQL sans LIMIT', () => {
  test('un SELECT sans LIMIT est signalé, même hors boucle', () => {
    const findings = analyze(inMethod(`String q = "SELECT * FROM orders";`));
    const hits = findings.filter(f => f.message.includes('LIMIT'));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].severity, 'high');
  });

  test('un SELECT avec LIMIT ne l\'est pas', () => {
    const findings = analyze(inMethod(`String q = "SELECT * FROM orders LIMIT 50";`));
    assert.strictEqual(findings.filter(f => f.message.includes('LIMIT')).length, 0);
  });

  test('ROWNUM vaut aussi pagination', () => {
    const findings = analyze(inMethod(`String q = "SELECT * FROM orders WHERE ROWNUM < 50";`));
    assert.strictEqual(findings.filter(f => f.message.includes('LIMIT')).length, 0);
  });

  test('la détection ignore la casse', () => {
    const findings = analyze(inMethod(`String q = "select * from orders";`));
    assert.strictEqual(findings.filter(f => f.message.includes('LIMIT')).length, 1);
  });
});

describe('positions des findings', () => {
  test('la ligne signalée est celle du code fautif', () => {
    // Ligne 0 : class T | ligne 1 : void m | ligne 2 : for | ligne 3 : for imbriqué
    const findings = analyze(
      'class T {\n  void m() {\n    for (int i = 0; i < n; i++) {\n      for (int j = 0; j < n; j++) { a(); }\n    }\n  }\n}'
    );
    const nested = findings.find(f => f.message.includes('imbriquée'));
    assert.strictEqual(nested.startLine, 3);
  });
});

describe('code sobre', () => {
  test('un fichier sans pattern énergivore ne produit aucun finding', () => {
    const findings = analyze(`
      class T {
        int sum(int[] values) {
          int total = 0;
          for (int v : values) { total = total + v; }
          return total;
        }
      }`);
    assert.deepStrictEqual(findings, []);
  });
});
