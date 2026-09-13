const { test, describe } = require('node:test');
const assert = require('node:assert');

const { LANGUAGES, specFor, isSupported, grammarFiles, ALL_RULE_IDS, RULE_CONTEXTS } = require('../out/languages');

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
    for (const id of ['java', 'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'python']) {
      assert.ok(isSupported(id), `${id} devrait être supporté`);
    }
  });

  test('un langage inconnu ne l\'est pas', () => {
    for (const id of ['go', 'ruby', 'plaintext', '']) {
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

  test('Python a un contexte fixé au serveur, comme Java', () => {
    assert.strictEqual(specFor('python').fixedContext, 'server');
  });

  test('Python exclut += en boucle et les règles web', () => {
    const py = specFor('python').rules;
    assert.ok(py.includes('nested-loops'));
    assert.ok(py.includes('regex-compile-in-loop'));
    assert.ok(py.includes('sql-without-limit'));
    assert.ok(py.includes('await-in-loop'));
    assert.ok(!py.includes('string-concat-in-loop'), 'bruit en Python : réallocation sur place');
    assert.ok(!py.includes('object-creation-in-loop'), 'pas de `new` en Python');
    assert.ok(!py.includes('polling-interval'), 'règle web, sans objet côté serveur');
  });
});

describe('ALL_RULE_IDS', () => {
  test('couvre exactement les clés de RULE_CONTEXTS, sans doublon', () => {
    const expected = Object.keys(RULE_CONTEXTS);
    assert.strictEqual(ALL_RULE_IDS.length, expected.length);
    assert.strictEqual(new Set(ALL_RULE_IDS).size, ALL_RULE_IDS.length, 'doublon dans ALL_RULE_IDS');
    for (const id of expected) assert.ok(ALL_RULE_IDS.includes(id), `${id} manquant`);
  });
});
