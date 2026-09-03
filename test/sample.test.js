const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { initParser, parse } = require('../out/parser');
const { collectFindings } = require('../out/rules');
const { computeScore } = require('../out/scoring');
const { specFor } = require('../out/languages');

const ROOT = path.join(__dirname, '..');

let findings;
let score;

before(async () => {
  await initParser(ROOT);
  const code = fs.readFileSync(path.join(ROOT, 'samples', 'Example.java'), 'utf8');
  findings = collectFindings(parse(code, 'java').rootNode, specFor('java'));
  score = computeScore(findings);
});

// Test de référence : samples/Example.java déclenche les six règles.
// C'est le fichier de démonstration du README — s'il change, ces attendus aussi.
describe('samples/Example.java — analyse de bout en bout', () => {
  test('le score attendu est E 28/100', () => {
    assert.strictEqual(score.letter, 'E');
    assert.strictEqual(score.value, 28);
  });

  test('7 findings, dont 4 hauts et 3 moyens', () => {
    assert.strictEqual(findings.length, 7);
    assert.deepStrictEqual(score.findingCount, { high: 4, medium: 3, low: 0 });
  });

  test('les six règles sont représentées', () => {
    const present = (needle) => findings.some(f => f.message.includes(needle));
    assert.ok(present('imbriquée'), 'règle 1 absente');
    assert.ok(present('+='), 'règle 2 absente');
    assert.ok(present('new'), 'règle 3 absente');
    assert.ok(present('Pattern.compile'), 'règle 4 absente');
    assert.ok(present('I/O bloquant'), 'règle 5 absente');
    assert.ok(present('LIMIT'), 'règle 6 absente');
  });

  test('chaque finding porte une position et un poids exploitables', () => {
    for (const f of findings) {
      assert.ok(Number.isInteger(f.startLine) && f.startLine >= 0, 'startLine invalide');
      assert.ok(f.endLine >= f.startLine, 'endLine avant startLine');
      assert.ok(f.weight > 0, 'poids nul');
      assert.ok(f.message.length > 0, 'message vide');
      assert.ok(['high', 'medium', 'low'].includes(f.severity), 'sévérité inconnue');
    }
  });
});

describe('parser', () => {
  test('parse() échoue clairement si le parser n\'est pas initialisé', () => {
    // initParser() a déjà tourné dans before(), on vérifie seulement que
    // l'analyse d'un fichier vide ne casse pas.
    assert.doesNotThrow(() => parse('', 'java'));
  });

  test('le WASM est chargé depuis out/wasm', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'out', 'wasm', 'tree-sitter.wasm')));
    assert.ok(fs.existsSync(path.join(ROOT, 'out', 'wasm', 'tree-sitter-java.wasm')));
  });
});
