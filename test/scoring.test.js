const { test, describe } = require('node:test');
const assert = require('node:assert');

const { letterFor, computeScore, scoreSummary, aggregateScore } = require('../out/scoring');

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

describe('aggregateScore — score global d\'un scan', () => {
  const withCount = (value, high = 0, medium = 0) => ({
    letter: letterFor(value), value, findingCount: { high, medium, low: 0 },
  });

  test('un projet sans aucune alerte vaut A 100', () => {
    const g = aggregateScore([withCount(100), withCount(100), withCount(100)]);
    assert.strictEqual(g.value, 100);
    assert.strictEqual(g.letter, 'A');
  });

  test('sans aucun fichier, le score reste A 100', () => {
    assert.strictEqual(aggregateScore([]).value, 100);
  });

  test('les fichiers sains ne diluent pas la note', () => {
    // Le cas baby-tracker : un fichier a C 72, vingt-deux sont a 100.
    // L'ancienne moyenne donnait A 99, ce qui masquait le seul vrai probleme.
    const scores = [withCount(72, 0, 4), ...Array.from({ length: 22 }, () => withCount(100))];
    const g = aggregateScore(scores);
    assert.strictEqual(g.value, 72);
    assert.strictEqual(g.letter, 'C');
  });

  test('plusieurs fichiers concernés sont moyennés entre eux', () => {
    const g = aggregateScore([withCount(40, 2), withCount(80, 1), withCount(100)]);
    assert.strictEqual(g.value, 60);
  });

  test('ajouter du code sain ne peut pas améliorer la note', () => {
    const base = [withCount(40, 2)];
    const avecSain = [...base, ...Array.from({ length: 50 }, () => withCount(100))];
    assert.strictEqual(aggregateScore(base).value, aggregateScore(avecSain).value);
  });

  test('le compte d\'alertes reste calculé sur tous les fichiers', () => {
    const g = aggregateScore([withCount(60, 1, 2), withCount(80, 0, 3), withCount(100)]);
    assert.deepStrictEqual(g.findingCount, { high: 1, medium: 5, low: 0 });
  });

  test('un fichier à 100 mais porteur d\'une alerte compte quand même', () => {
    // Cas limite : penalite nulle impossible aujourd hui, mais la regle est
    // « au moins une alerte », pas « score < 100 ».
    const g = aggregateScore([withCount(100, 1), withCount(100)]);
    assert.strictEqual(g.value, 100);
    assert.strictEqual(g.findingCount.high, 1);
  });
});
