// Le jar de la sonde Java est produit par `npm run compile` (scripts/build-java-probe.js)
// quand un JDK est disponible. Sans `javac` ni `jar` sur le PATH, le build n'en
// produit pas et ces tests sont ignorés — même principe que les tests Python.
// La CI (ubuntu-latest) a un JDK : c'est elle qui les exécute pour de bon.
// Son exécution réelle est couverte par test/measure.test.js (describe « Java »).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const JAR = path.join(__dirname, '..', 'out', 'probe.jar');

const hasTool = name => !(spawnSync(name, ['-version']).error);
const skip = !(hasTool('javac') && hasTool('jar'))
  ? 'JDK absent (javac/jar introuvables)' : false;

describe('sonde Java', { skip }, () => {
  test('le build produit out/probe.jar', () => {
    assert.ok(fs.existsSync(JAR), 'out/probe.jar manque : npm run compile ne l\'a pas produit');
  });

  test('le jar contient la classe Probe et son manifeste', () => {
    const r = spawnSync('jar', ['tf', JAR], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const entries = r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    assert.ok(entries.includes('Probe.class'), `Probe.class absent : ${entries.join(', ')}`);
    assert.ok(entries.includes('META-INF/MANIFEST.MF'), 'manifeste absent');
    // La classe anonyme du shutdown hook doit y être aussi, sinon l'agent ne se charge pas.
    assert.ok(entries.includes('Probe$1.class'), `Probe$1.class absent : ${entries.join(', ')}`);
  });
});
