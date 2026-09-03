const { test, describe } = require('node:test');
const assert = require('node:assert');

const { buildWebviewHtml } = require('../out/webview');

const score = { letter: 'A', value: 100, findingCount: { high: 0, medium: 0, low: 0 } };

describe('rapport mono-fichier — analyse partielle', () => {
  test('sans hasError, aucune réserve dans le rapport', () => {
    const html = buildWebviewHtml([], score, 'Example.java', 'nonce');
    assert.doesNotMatch(html, /Analyse partielle/);
  });

  test('avec hasError, le rapport affiche une réserve', () => {
    const html = buildWebviewHtml([], score, 'Example.java', 'nonce', true);
    assert.match(html, /Analyse partielle/);
    assert.match(html, /prendre avec réserve/);
  });
});
