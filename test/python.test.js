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

const analyze = (code) => collectFindings(parse(code, 'python').rootNode, specFor('python'), 'server');

const errorCount = (node, n = 0) => {
  if (node.type === 'ERROR' || node.isMissing) n++;
  for (const c of node.children) n = errorCount(c, n);
  return n;
};

describe('parsing Python', () => {
  test('parse sans erreur', () => {
    const code = 'async def f(xs):\n    return [x async for x in xs]\n';
    assert.strictEqual(errorCount(parse(code, 'python').rootNode), 0);
  });
});

describe('règle boucle imbriquée en Python', () => {
  test('for imbriqués', () => {
    const findings = analyze(`
def total(matrix):
    total = 0
    for row in matrix:
        for value in row:
            total += value
    return total`);
    assert.strictEqual(findings.filter(f => f.message.includes('imbriquée')).length, 1);
  });

  test('boucles successives : rien', () => {
    const findings = analyze(`
for a in xs:
    f(a)
for b in ys:
    g(b)`);
    assert.strictEqual(findings.length, 0);
  });
});

describe('règle re.compile() en boucle', () => {
  test('compilation en boucle : signalée', () => {
    const findings = analyze(`
import re
def validate(emails):
    out = []
    for email in emails:
        pattern = re.compile(r"^[\\w.-]+@[\\w.-]+$")
        out.append(pattern.match(email))
    return out`);
    assert.strictEqual(findings.filter(f => f.message.includes('compile')).length, 1);
  });

  test('compilation hors boucle : rien', () => {
    const findings = analyze(`
import re
PATTERN = re.compile(r"^[\\w.-]+@[\\w.-]+$")
def validate(email):
    return PATTERN.match(email)`);
    assert.strictEqual(findings.length, 0);
  });

  test('autre appel en boucle : rien', () => {
    const findings = analyze(`
for x in xs:
    p = build(x)`);
    assert.strictEqual(findings.length, 0);
  });
});

describe('règle SQL sans LIMIT en Python', () => {
  test('chaîne simple', () => {
    const findings = analyze(`q = "SELECT * FROM users"`);
    assert.strictEqual(findings.filter(f => f.message.includes('LIMIT')).length, 1);
  });

  test('avec LIMIT : rien', () => {
    const findings = analyze(`q = "SELECT * FROM users LIMIT 50"`);
    assert.strictEqual(findings.length, 0);
  });
});

describe('règle await en boucle en Python', () => {
  test('await séquentiel en boucle : signalée', () => {
    const findings = analyze(`
async def fetch_all(ids, db):
    rows = []
    for id_ in ids:
        rows.append(await db.get(id_))
    return rows`);
    assert.strictEqual(findings.filter(f => f.message.includes('await')).length, 1);
  });

  test('await hors boucle : rien', () => {
    const findings = analyze(`
async def fetch_one(id_, db):
    return await db.get(id_)`);
    assert.strictEqual(findings.length, 0);
  });
});

describe('règles Java/JS non transposées en Python', () => {
  test('+= en boucle ne déclenche rien', () => {
    // CPython réalloue `s += t` sur place ; `total += 1` est un idiome courant.
    const findings = analyze(`
report = ""
for item in items:
    report += item`);
    assert.deepStrictEqual(findings, []);
  });

  test('les règles web (polling, imports lourds…) ne s\'appliquent jamais', () => {
    const findings = analyze(`
import time
while True:
    time.sleep(0.05)`);
    assert.deepStrictEqual(findings, []);
  });
});
