const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { initParser, parse } = require('../out/parser');
const { collectFindings } = require('../out/rules');
const { specFor, specForPath } = require('../out/languages');
const { inferContext } = require('../out/context');

const ROOT = path.join(__dirname, '..');

before(async () => {
  await initParser(ROOT);
});

const analyze = (code) => collectFindings(parse(code, 'php').rootNode, specFor('php'), 'server');
const byRule = (findings, ruleId) => findings.filter(f => f.ruleId === ruleId);

const errorCount = (node, n = 0) => {
  if (node.type === 'ERROR' || node.isMissing) n++;
  for (const c of node.children) n = errorCount(c, n);
  return n;
};

describe('descripteur PHP', () => {
  test('.php est reconnu, en serveur fixe', () => {
    const spec = specForPath('src/Controller.php');
    assert.strictEqual(spec.label, 'PHP');
    assert.strictEqual(spec.fixedContext, 'server');
  });

  test('seules les deux règles transposables sont actives', () => {
    assert.deepStrictEqual([...specFor('php').rules].sort(), ['nested-loops', 'sql-without-limit']);
  });

  test('le contexte est serveur sans inférence', () => {
    const tree = parse('<?php echo "x";', 'php');
    assert.strictEqual(inferContext(tree.rootNode, specFor('php')).context, 'server');
  });
});

describe('parsing PHP', () => {
  test('parse sans erreur, HTML mêlé compris', () => {
    const code = '<html><?php foreach ($xs as $x): ?><li><?= $x ?></li><?php endforeach; ?></html>';
    assert.strictEqual(errorCount(parse(code, 'php').rootNode), 0);
  });
});

describe('règle boucle imbriquée en PHP', () => {
  test('foreach imbriqués', () => {
    const findings = analyze(`<?php
foreach ($matrix as $row) {
  foreach ($row as $v) { $t += $v; }
}`);
    assert.strictEqual(byRule(findings, 'nested-loops').length, 1);
  });

  test('for, while et do-while comptent comme des boucles', () => {
    const findings = analyze(`<?php
for ($i = 0; $i < 3; $i++) { while ($a) { do { } while ($b); } }`);
    assert.strictEqual(byRule(findings, 'nested-loops').length, 2);
  });

  test('boucles successives : rien', () => {
    const findings = analyze(`<?php
foreach ($xs as $x) { f($x); }
foreach ($ys as $y) { g($y); }`);
    assert.strictEqual(findings.length, 0);
  });
});

describe('règle SQL sans LIMIT en PHP', () => {
  test('guillemets simples et doubles', () => {
    const findings = analyze(`<?php
$a = 'SELECT id FROM users';
$b = "SELECT id FROM users";`);
    assert.strictEqual(byRule(findings, 'sql-without-limit').length, 2);
  });

  test('chaîne interpolée', () => {
    const findings = analyze('<?php $q = "SELECT * FROM $table";');
    assert.strictEqual(byRule(findings, 'sql-without-limit').length, 1);
  });

  test('heredoc et nowdoc', () => {
    const findings = analyze(`<?php
$h = <<<SQL
  SELECT id FROM users
  SQL;
$n = <<<'SQL'
  SELECT id FROM users
  SQL;`);
    assert.strictEqual(byRule(findings, 'sql-without-limit').length, 2);
  });

  test('requête paginée : rien', () => {
    const findings = analyze(`<?php
$q = "SELECT id FROM users LIMIT 50";
$h = <<<SQL
  SELECT id FROM users LIMIT 50
  SQL;`);
    assert.strictEqual(byRule(findings, 'sql-without-limit').length, 0);
  });

  test('texte qui contient les mots sans être une requête : rien', () => {
    const findings = analyze('<?php $label = "Please select a file from the list";');
    assert.strictEqual(findings.length, 0);
  });
});

describe('règles volontairement absentes de PHP', () => {
  test('`.=`, `new`, `preg_match()` et `fgets()` en boucle ne sont pas signalés', () => {
    const findings = analyze(`<?php
while (($line = fgets($f)) !== false) {
  $out .= $line;
  $o = new Row($line);
  preg_match('/x/', $line);
}`);
    assert.deepStrictEqual(findings, []);
  });
});

describe('samples/example.php', () => {
  test('déclenche exactement les cas annoncés en commentaire', () => {
    const code = fs.readFileSync(path.join(ROOT, 'samples', 'example.php'), 'utf8');
    const findings = analyze(code);
    assert.strictEqual(byRule(findings, 'nested-loops').length, 1);
    // ALL_USERS, la requête interpolée et le heredoc ; pas RECENT_USERS.
    assert.strictEqual(byRule(findings, 'sql-without-limit').length, 3);
    assert.strictEqual(findings.length, 4);
  });
});
