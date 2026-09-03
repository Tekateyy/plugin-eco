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
