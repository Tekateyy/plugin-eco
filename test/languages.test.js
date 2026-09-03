const { test, describe } = require('node:test');
const assert = require('node:assert');

const { LANGUAGES, specFor, isSupported, grammarFiles } = require('../out/languages');

describe('descripteurs de langage', () => {
  test('chaque languageId VSCode ne résout que vers un seul descripteur', () => {
    const seen = new Map();
    for (const spec of LANGUAGES) {
      for (const id of spec.vscodeLanguageIds) {
        assert.ok(!seen.has(id), `${id} est revendiqué par ${seen.get(id)} et ${spec.label}`);
        seen.set(id, spec.label);
      }
    }
  });

  test('les langages attendus sont supportés', () => {
    for (const id of ['java', 'javascript', 'javascriptreact', 'typescript', 'typescriptreact']) {
      assert.ok(isSupported(id), `${id} devrait être supporté`);
    }
  });

  test('un langage inconnu ne l\'est pas', () => {
    for (const id of ['python', 'go', 'plaintext', '']) {
      assert.strictEqual(isSupported(id), false);
      assert.strictEqual(specFor(id), undefined);
    }
  });

  test('les grammaires sont dédoublonnées — tsx sert deux descripteurs', () => {
    const files = grammarFiles();
    assert.strictEqual(files.length, new Set(files).size, 'doublon dans la liste');
    // tsx couvre javascript ET typescriptreact
    const tsxUsers = LANGUAGES.filter(l => l.grammarFile === 'tree-sitter-tsx.wasm');
    assert.strictEqual(tsxUsers.length, 2);
  });

  test('.ts utilise la grammaire typescript, pas tsx', () => {
    // Décision du 3 sept. : tsx lit `<T>v` comme du JSX et perd le fichier.
    assert.strictEqual(specFor('typescript').grammarFile, 'tree-sitter-typescript.wasm');
  });

  test('les règles JS excluent volontairement += et new en boucle', () => {
    const js = specFor('javascript').rules;
    assert.ok(js.includes('nested-loops'));
    assert.ok(js.includes('sql-without-limit'));
    assert.ok(!js.includes('string-concat-in-loop'), 'bruit en JS : ropes V8');
    assert.ok(!js.includes('object-creation-in-loop'), 'bruit en JS : GC générationnel');
  });

  test('Java conserve les six règles', () => {
    assert.strictEqual(specFor('java').rules.length, 6);
  });
});
