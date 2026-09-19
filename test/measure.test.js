const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { runMeasured, estimate, defaultCoefficients, DEFAULT_GCO2_PER_KWH } = require('../out/measure');

const ROOT = path.join(__dirname, '..');
const BENCH = path.join(ROOT, 'fixtures', 'bench.js');

// --- estimate() : fonction pure, aucune exécution -------------------------

describe('estimate', () => {
  const coeffs = { tdpWatts: 65, cores: 8, wattsPerGB: 0.392, gCO2PerKWh: 52 };

  test('zéro CPU et zéro mémoire donnent zéro Wh', () => {
    const est = estimate({ cpuUserUs: 0, cpuSystemUs: 0, wallMs: 0, maxRssBytes: 0 }, coeffs);
    assert.strictEqual(est.wh, 0);
    assert.strictEqual(est.gCO2, 0);
  });

  test('1 heure CPU pleine sur un cœur à 8 W/cœur donne 8 Wh', () => {
    // 8 cœurs, TDP 65 W → 8,125 W/cœur ; on isole le calcul CPU en mettant la
    // mémoire à zéro pour ne pas mélanger les deux termes.
    const est = estimate(
      { cpuUserUs: 3600 * 1e6, cpuSystemUs: 0, wallMs: 3600 * 1000, maxRssBytes: 0 },
      coeffs
    );
    const wattsPerCore = coeffs.tdpWatts / coeffs.cores;
    assert.ok(Math.abs(est.wh - wattsPerCore) < 1e-9);
  });

  test('la mémoire ne compte que pondérée par la durée réelle', () => {
    const oneGbOneHour = estimate(
      { cpuUserUs: 0, cpuSystemUs: 0, wallMs: 3600 * 1000, maxRssBytes: 1024 ** 3 },
      coeffs
    );
    assert.ok(Math.abs(oneGbOneHour.wh - coeffs.wattsPerGB) < 1e-9);

    const oneGbHalfHour = estimate(
      { cpuUserUs: 0, cpuSystemUs: 0, wallMs: 1800 * 1000, maxRssBytes: 1024 ** 3 },
      coeffs
    );
    assert.ok(Math.abs(oneGbHalfHour.wh - coeffs.wattsPerGB / 2) < 1e-9);
  });

  test('gCO2 dérive de wh via le coefficient carbone', () => {
    const est = estimate(
      { cpuUserUs: 3600 * 1e6, cpuSystemUs: 0, wallMs: 3600 * 1000, maxRssBytes: 0 },
      coeffs
    );
    assert.ok(Math.abs(est.gCO2 - (est.wh / 1000) * coeffs.gCO2PerKWh) < 1e-9);
  });

  test('les hypothèses retenues sont lisibles dans le résultat', () => {
    const est = estimate({ cpuUserUs: 0, cpuSystemUs: 0, wallMs: 0, maxRssBytes: 0 }, coeffs);
    assert.match(est.hypotheses, /8,1 W\/cœur|8\.1 W\/cœur/);
    assert.match(est.hypotheses, /52 gCO₂\/kWh/);
  });
});

describe('defaultCoefficients', () => {
  test('détecte le nombre de cœurs et retient le carbone France par défaut', () => {
    const coeffs = defaultCoefficients();
    assert.ok(coeffs.cores >= 1);
    assert.strictEqual(coeffs.gCO2PerKWh, DEFAULT_GCO2_PER_KWH);
  });
});

// --- runMeasured() : exécution réelle sous la sonde ------------------------

describe('runMeasured', () => {
  test('mesure un vrai script Node qui se termine de lui-même', () => {
    const { raw, exitCode } = runMeasured(BENCH);
    assert.strictEqual(exitCode, 0);
    assert.ok(raw.cpuUserUs > 0, 'du temps CPU user doit avoir été consommé');
    // Pas de comparaison stricte au temps mur : cpuUsage() cumule tous les
    // threads (GC, compilation JIT en tâche de fond…), qui peuvent tourner en
    // parallèle du thread principal et dépasser le temps mur sur une machine
    // multicœur.
    assert.ok(raw.wallMs > 0, 'un temps mur positif est attendu');
    assert.ok(raw.maxRssBytes > 0, 'une mémoire résidente positive est attendue');
  });

  test('ne laisse aucun répertoire temporaire derrière elle', () => {
    const tmp = require('node:os').tmpdir();
    const ours = () => fs.readdirSync(tmp).filter(f => f.startsWith('plugin-eco-'));
    const before = ours();
    runMeasured(BENCH);
    assert.deepStrictEqual(ours(), before);
    // Y compris quand la sonde n'a rien écrit : le nettoyage ne dépend pas de
    // la présence du fichier de mesure.
    assert.throws(() => runMeasured(BENCH, { probePath: path.join(ROOT, 'fixtures', 'silent-probe.js') }));
    assert.deepStrictEqual(ours(), before);
  });

  test('remonte le code de sortie du script mesuré', () => {
    const failing = path.join(ROOT, 'fixtures', 'measure-fail.js');
    const { exitCode } = runMeasured(failing);
    assert.strictEqual(exitCode, 3);
  });

  test('un script introuvable produit quand même une mesure (quasi nulle) et un code d\'échec', () => {
    // Node échoue à résoudre le module avant d'exécuter la moindre ligne du
    // script, mais la sonde préchargée par --require a déjà tourné : son
    // handler `exit` s'exécute tout de même, d'où une mesure proche de zéro
    // plutôt qu'une absence de mesure.
    const { raw, exitCode } = runMeasured(path.join(ROOT, 'fixtures', 'inexistant.js'));
    assert.notStrictEqual(exitCode, 0);
    assert.ok(raw.cpuUserUs >= 0);
  });

  test('sans sortie produite du tout, runMeasured lève une erreur exploitable', () => {
    // Sonde de substitution qui ne s'accroche à aucun événement : aucun
    // fichier de mesure n'est jamais écrit, ce qui déclenche le chemin
    // défensif de runMeasured plutôt que le cas normal ci-dessus.
    const silentProbe = path.join(ROOT, 'fixtures', 'silent-probe.js');
    assert.throws(() => runMeasured(BENCH, { probePath: silentProbe }), /aucune mesure/);
  });
});
