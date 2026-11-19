// query-in-loop : une requête SQL à chaque tour de boucle (N+1).
//
// Pour chaque langage, les cas qui doivent déclencher et ceux qui ne le doivent
// pas. Les seconds comptent autant : l'en-tête d'une boucle
// (`for row in cur.execute(q)`) est la bonne façon de faire, un nom de méthode
// générique (`task.execute()`) n'est pas une requête, et exécuter une liste de
// textes SQL différents (`for sql in liste: cur.execute(sql)`) n'est pas un N+1.
//
// Les appels HTTP en boucle ne sont pas couverts (trop de cas légitimes : tests, attente d'un port).

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { initParser, parse } = require('../out/parser');
const { collectFindings } = require('../out/rules');
const { specFor } = require('../out/languages');

before(async () => {
  await initParser(path.join(__dirname, '..'));
});

/** Lignes (1-based) où query-in-loop se déclenche. */
const lines = (code, lang, context = 'server') =>
  collectFindings(parse(code, lang).rootNode, specFor(lang), context)
    .filter(f => f.ruleId === 'query-in-loop')
    .map(f => f.startLine + 1);

describe('query-in-loop — Python', () => {
  test('une requête dans le corps de la boucle', () => {
    assert.deepStrictEqual(lines('for i in ids:\n    cur.execute(q, (i,))', 'python'), [2]);
  });

  test('la collection parcourue n\'est évaluée qu\'une fois', () => {
    assert.deepStrictEqual(lines('for row in cur.execute(q):\n    print(row)', 'python'), []);
  });

  test('une requête dans le corps et dans le filtre d\'une compréhension', () => {
    assert.deepStrictEqual(
      lines('xs = [cur.execute(q, (i,)) for i in ids if db.execute(c)]', 'python'), [1, 1]);
  });

  test('la collection du premier for d\'une compréhension n\'est évaluée qu\'une fois', () => {
    assert.deepStrictEqual(lines('ys = [r for r in conn.cursor().execute(q)]', 'python'), []);
  });

  test('la collection d\'un for suivant est réévaluée à chaque tour', () => {
    assert.deepStrictEqual(
      lines('zs = [r for i in ids for r in cur.execute(q, (i,))]', 'python'), [1]);
  });

  test('objets reconnus par leur nom : cursor, session, attribut, curseur produit', () => {
    const code = [
      'for i in ids:',
      '    self.order_cursor.execute(q)',
      '    session.execute(q)',
      '    conn.cursor().execute(q)',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'python'), [2, 3, 4]);
  });

  test('les appels HTTP ne sont pas couverts', () => {
    const code = [
      'for u in urls:',
      '    requests.get(u)',
      '    httpx.post(u)',
      '    urlopen(u)',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'python'), []);
  });

  test('exécuter une liste de textes SQL différents n\'est pas un N+1', () => {
    const code = [
      'for sql in statements:',
      '    cursor.execute(sql)',
      'for sql, params in compiled:',
      '    cursor.execute(sql, params)',
      'for q in queries:',
      '    cursor.execute(q["sql"])',
      'for q in queries:',
      '    cursor.execute(q.sql)',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'python'), []);
  });

  test('le même texte SQL avec un paramètre qui change reste un N+1', () => {
    const code = [
      'for i in ids:',
      '    cursor.execute("SELECT * FROM t WHERE id = %s", (i,))',
      '    cursor.execute(query, [i])',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'python'), [2, 3]);
  });

  test('la variable d\'une boucle qui n\'enveloppe pas l\'appel ne l\'exclut pas', () => {
    const code = 'for sql in statements:\n    pass\ncursor.execute(sql)\nfor i in ids:\n    cursor.execute(sql)';
    assert.deepStrictEqual(lines(code, 'python'), [5]);
  });

  test('la variable d\'une compréhension exclut aussi', () => {
    assert.deepStrictEqual(lines('[cursor.execute(s) for s in statements]', 'python'), []);
  });

  test('ni un execute() générique, ni executemany (le remède), ni un get() de dict', () => {
    const code = [
      'for t in tasks:',
      '    t.execute()',
      '    task.execute()',
      '    cur.executemany(q, rows)',
      '    cache.get(k)',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'python'), []);
  });

  test('hors boucle, rien', () => {
    assert.deepStrictEqual(lines('cur.execute(q)\nrequests.get(u)', 'python'), []);
  });

  test('une fonction définie dans la boucle a son propre flot', () => {
    assert.deepStrictEqual(
      lines('for i in ids:\n    def f():\n        cur.execute(q)', 'python'), []);
  });

  test('await dans la boucle : await-in-loop et query-in-loop sortent toutes les deux', () => {
    const code = 'async def f(ids):\n    for i in ids:\n        await session.execute(q)';
    const rules = collectFindings(parse(code, 'python').rootNode, specFor('python'), 'server')
      .map(f => f.ruleId).sort();
    assert.deepStrictEqual(rules, ['await-in-loop', 'query-in-loop']);
  });
});

describe('query-in-loop — PHP', () => {
  test('foreach : le corps oui, la collection non', () => {
    const code = '<?php\nforeach ($pdo->query($sql) as $row) {\n  $stmt->execute([$row]);\n}';
    assert.deepStrictEqual(lines(code, 'php'), [3]);
  });

  test('for : l\'initialisation non, le corps oui', () => {
    const code = "<?php\nfor ($i = $db->query('x'); $i < 3; $i++) {\n  mysqli_query($c, $q);\n}";
    assert.deepStrictEqual(lines(code, 'php'), [3]);
  });

  test('while : la condition est réévaluée à chaque tour', () => {
    const code = "<?php\nwhile ($db->query('SELECT 1')) {\n  $n++;\n}";
    assert.deepStrictEqual(lines(code, 'php'), [2]);
  });

  test('objets et fonctions reconnus : $this->dbh, $wpdb, pg_query', () => {
    const code = [
      '<?php',
      'foreach ($ids as $id) {',
      '  $this->dbh->query($q);',
      '  $wpdb->get_results($q);',
      '  pg_query($c, $q);',
      '}',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'php'), [3, 4, 5]);
  });

  test('les appels HTTP ne sont pas couverts', () => {
    const code = [
      '<?php',
      'foreach ($ids as $id) {',
      '  curl_exec($ch);',
      "  file_get_contents('https://api.example.com/x');",
      '}',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'php'), []);
  });

  test('exécuter une liste de textes SQL différents n\'est pas un N+1', () => {
    const code = [
      '<?php',
      'foreach ($statements as $sql) {',
      '  $pdo->query($sql);',
      '}',
      'foreach ($queries as $key => $q) {',
      '  $pdo->exec($q->sql);',
      '  $pdo->exec($q["sql"]);',
      '}',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'php'), []);
  });

  test('le même texte SQL avec un paramètre qui change reste un N+1', () => {
    const code = '<?php\nforeach ($ids as $id) {\n  $wpdb->get_var($wpdb->prepare($sql, $id));\n  $stmt->execute([$id]);\n}';
    assert.deepStrictEqual(lines(code, 'php'), [3, 4]);
  });

  test('un query() générique ne compte pas', () => {
    const code = '<?php\nforeach ($ids as $id) {\n  $builder->query();\n  $task->execute();\n}';
    assert.deepStrictEqual(lines(code, 'php'), []);
  });
});

describe('query-in-loop — Java', () => {
  test('JDBC dans le corps, pas dans la collection', () => {
    const code = [
      'class A { void f() throws Exception {',
      '  for (Row r : stmt.executeQuery(q)) {',
      '    ps.executeUpdate();',
      '  }',
      '}}',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'java'), [3]);
  });

  test('jdbcTemplate et statement chaîné', () => {
    const code = [
      'class A { void f() throws Exception {',
      '  while (rs.next()) {',
      '    jdbcTemplate.query(q, m);',
      '    conn.prepareStatement(sql).executeQuery();',
      '  }',
      '}}',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'java'), [3, 4]);
  });

  test('ni task.execute(), ni un appel HTTP', () => {
    const code = [
      'class A { void f() {',
      '  for (int i = 0; i < n; i++) {',
      '    task.execute();',
      '    httpClient.send(req, h);',
      '    restTemplate.getForObject(u, String.class);',
      '  }',
      '}}',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'java'), []);
  });

  test('exécuter une liste de textes SQL différents n\'est pas un N+1', () => {
    const code = [
      'class A { void f() throws Exception {',
      '  for (String sql : statements) {',
      '    stmt.execute(sql);',
      '  }',
      '  for (String id : ids) {',
      '    ps.execute(); ',
      '  }',
      '}}',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'java'), [6]);
  });
});

describe('query-in-loop — JavaScript / TypeScript', () => {
  test('for…of : le corps oui, la collection non', () => {
    const code = 'for (const r of await db.query(q)) {\n  await pool.query(q2);\n}';
    assert.deepStrictEqual(lines(code, 'typescript'), [2]);
  });

  test('les appels HTTP ne sont pas couverts', () => {
    const code = [
      'for (const u of urls) {',
      '  fetch(u);',
      '  axios.get(u);',
      '  https.get(u);',
      '}',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'typescript'), []);
  });

  test('exécuter une liste de textes SQL différents n\'est pas un N+1', () => {
    const code = [
      'for (const sql of statements) {',
      '  await db.query(sql);',
      '}',
      'for (const { text, values } of queries) {',
      '  await db.query(text, values);',
      '}',
      'for (const id of ids) {',
      "  await db.query('SELECT * FROM t WHERE id = $1', [id]);",
      '}',
    ].join('\n');
    assert.deepStrictEqual(lines(code, 'typescript'), [8]);
  });

  test('this.client.query compte, cache.get non', () => {
    const code = 'while (more) {\n  this.client.query(q);\n  cache.get(k);\n}';
    assert.deepStrictEqual(lines(code, 'typescript'), [2]);
  });

  test('une callback de map n\'est pas une boucle', () => {
    assert.deepStrictEqual(lines('ids.map(id => db.query(id));', 'typescript'), []);
  });

  test('s\'applique aussi côté navigateur', () => {
    const code = "'use client';\nfor (const id of ids) {\n  db.query('SELECT 1', [id]);\n}";
    assert.deepStrictEqual(lines(code, 'typescriptreact', 'client'), [3]);
  });
});
