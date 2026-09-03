const { test, describe } = require('node:test');
const assert = require('node:assert');

const { letterFor, computeScore, scoreSummary } = require('../out/scoring');

const finding = (severity, weight) => ({
  startLine: 0, startChar: 0, endLine: 0, endChar: 0,
  message: '', severity, weight,
});

describe('letterFor — seuils de l\'étiquette', () => {
  test('bornes basses de chaque lettre', () => {
    assert.strictEqual(letterFor(100), 'A');
    assert.strictEqual(letterFor(90), 'A');
    assert.strictEqual(letterFor(75), 'B');
    assert.strictEqual(letterFor(55), 'C');
    assert.strictEqual(letterFor(35), 'D');
    assert.strictEqual(letterFor(0), 'E');
  });

  test('juste sous une borne, la lettre se dégrade', () => {
    assert.strictEqual(letterFor(89), 'B');
    assert.strictEqual(letterFor(74), 'C');
    assert.strictEqual(letterFor(54), 'D');
    assert.strictEqual(letterFor(34), 'E');
  });
});

describe('computeScore — agrégation des pénalités', () => {
  test('sans finding, le score est parfait', () => {
    const score = computeScore([]);
    assert.strictEqual(score.value, 100);
    assert.strictEqual(score.letter, 'A');
    assert.deepStrictEqual(score.findingCount, { high: 0, medium: 0, low: 0 });
  });

  test('les poids se cumulent et se retranchent de 100', () => {
    const score = computeScore([finding('high', 15), finding('medium', 7)]);
    assert.strictEqual(score.value, 78);
    assert.strictEqual(score.letter, 'B');
  });

  test('le score ne descend jamais sous 0', () => {
    const score = computeScore(Array.from({ length: 20 }, () => finding('high', 15)));
    assert.strictEqual(score.value, 0);
    assert.strictEqual(score.letter, 'E');
  });

  test('les findings sont comptés par sévérité', () => {
    const score = computeScore([
      finding('high', 12), finding('high', 15),
      finding('medium', 7), finding('low', 1),
    ]);
    assert.deepStrictEqual(score.findingCount, { high: 2, medium: 1, low: 1 });
  });
});

describe('scoreSummary', () => {
  test('chaque lettre a un libellé non vide', () => {
    for (const letter of ['A', 'B', 'C', 'D', 'E']) {
      const label = scoreSummary({ letter, value: 0, findingCount: { high: 0, medium: 0, low: 0 } });
      assert.ok(label.length > 0, `libellé manquant pour ${letter}`);
    }
  });
});
