const { test, describe } = require('node:test');
const assert = require('node:assert');

const { buildWebviewHtml, buildWorkspaceHtml } = require('../out/webview');

const score = (letter, value, high = 0, medium = 0) =>
  ({ letter, value, findingCount: { high, medium, low: 0 } });

const finding = (msg, severity = 'high') =>
  ({ startLine: 0, startChar: 0, endLine: 0, endChar: 0, severity, weight: 10, message: msg });

describe('rapport mono-fichier — analyse partielle', () => {
  test('sans hasError, aucune réserve dans le rapport', () => {
    const html = buildWebviewHtml([], score('A', 100), 'Example.java', 'nonce');
    assert.doesNotMatch(html, /Analyse partielle/);
  });

  test('avec hasError, le rapport affiche une réserve', () => {
    const html = buildWebviewHtml([], score('A', 100), 'Example.java', 'nonce', true);
    assert.match(html, /Analyse partielle/);
    assert.match(html, /prendre avec réserve/);
  });
});

// --- Échappement : fileName et message viennent du disque, jamais fiables --

describe('rapport mono-fichier — échappement', () => {
  test('un nom de fichier hostile n\'atteint pas le HTML tel quel', () => {
    const html = buildWebviewHtml([], score('A', 100), '<script>alert(1)</script>.java', 'nonce');
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  test('un message de finding hostile n\'atteint pas le HTML tel quel', () => {
    const html = buildWebviewHtml(
      [finding('<img src=x onerror=alert(1)>')], score('E', 10, 1), 'A.java', 'nonce'
    );
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img/);
  });
});

// --- Rapport workspace ------------------------------------------------------

const workspaceReport = (files) => ({
  files,
  global: score('C', 70, 1, 1),
  filesWithFindings: files.filter(f => f.findings.length > 0).length,
  scannedAt: '3 sept. 2026 10:00:00',
});

describe('rapport workspace', () => {
  const report = workspaceReport([
    { uri: 'file:///A.java', fileName: 'src/A.java', score: score('E', 20, 1, 1), findings: [finding('boucle')] },
    { uri: 'file:///B.java', fileName: 'src/B.java', score: score('A', 100), findings: [] },
  ]);

  test('le pire fichier est mis en avant', () => {
    const html = buildWorkspaceHtml(report, 'nonce');
    assert.match(html, /À regarder en premier/);
    assert.match(html, /src\/A\.java/);
  });

  test('un fichier sans alerte n\'a pas de bloc "à regarder en premier"', () => {
    const sain = workspaceReport([
      { uri: 'file:///B.java', fileName: 'src/B.java', score: score('A', 100), findings: [] },
    ]);
    assert.doesNotMatch(buildWorkspaceHtml(sain, 'nonce'), /À regarder en premier/);
  });

  test('le nonce du CSP est repris dans le script inline', () => {
    const html = buildWorkspaceHtml(report, 'le-nonce');
    assert.match(html, /script-src 'nonce-le-nonce'/);
    assert.match(html, /<script nonce="le-nonce">/);
  });

  test('un nom ou une URI de fichier hostile n\'atteint pas le HTML tel quel', () => {
    const hostile = workspaceReport([{
      uri: '"><script>alert(1)</script>',
      fileName: '<script>alert(1)</script>.java',
      score: score('E', 10, 1),
      findings: [finding('x')],
    }]);
    const html = buildWorkspaceHtml(hostile, 'nonce');
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  });
});

// --- Bouton « Mesurer » et panneau de mesure ---------------------------------

const { buildMeasureHtml } = require('../out/webview');

describe('rapport mono-fichier — bouton Mesurer', () => {
  test('présent dès qu\'un fichier est affiché, avec un script autorisé par nonce', () => {
    const html = buildWebviewHtml([], score('A', 100), 'a.js', 'n0nce');
    assert.match(html, /<button id="measure"/);
    assert.match(html, /<script nonce="n0nce">/);
    assert.match(html, /script-src 'nonce-n0nce'/);
    assert.match(html, /command: 'measure'/);
  });

  test('absent tant qu\'aucun fichier n\'a été analysé', () => {
    const html = buildWebviewHtml([], score('A', 100), '', 'n0nce');
    assert.doesNotMatch(html, /<button/);
    assert.doesNotMatch(html, /script-src/);
  });
});

describe('panneau de mesure', () => {
  const result = {
    raw: { cpuUserUs: 1_500_000, cpuSystemUs: 250_000, wallMs: 2000, maxRssBytes: 50 * 1024 ** 2 },
    exitCode: 0,
    samples: [],
  };
  const est = { wh: 0.0123, gCO2: 0.00064, hypotheses: '8.1 W/cœur (TDP 65 W / 8 cœurs)' };

  test('reprend les grandeurs du CLI', () => {
    const html = buildMeasureHtml('/p/bench.js', result, est, 'n');
    assert.match(html, /code 0/);
    assert.match(html, /1\.75 s \(user 1\.50 · system 0\.25\)/);
    assert.match(html, /2\.00 s/);
    assert.match(html, /max 50 Mo/);
    assert.match(html, /0\.0123 Wh/);
    assert.match(html, /0\.64 mg CO₂/);
    assert.match(html, /8\.1 W\/cœur/);
  });

  test('aucun script, et le chemin du fichier est échappé', () => {
    const html = buildMeasureHtml('<img src=x onerror=alert(1)>.js', result, est, 'n');
    assert.doesNotMatch(html, /<script/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img/);
  });
});
