// Compile src/Probe.java en out/probe.jar (agent Java, voir src/Probe.java).
//
// Un JDK n'est pas requis pour construire le plugin : sans `javac` ou `jar` sur
// le PATH, le script avertit sur stderr et sort en 0 — le jar est alors absent.
// Rien ne le consomme encore (`measure` ne mesure pas Java), donc rien ne casse ;
// quand `measure` l'utilisera, il devra signaler l'absence du jar. Une erreur de
// compilation, elle, est une vraie erreur : le script sort en 1.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const source = path.join(root, 'src', 'Probe.java');
const outJar = path.join(root, 'out', 'probe.jar');

// `getTotalThreadAllocatedBytes()` n'existe qu'à partir de Java 21 : c'est le
// plancher de la sonde, la JVM mesurée doit être en 21 ou plus.
const JAVA_RELEASE = '21';

function run(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') return 'absent';
  if (r.status !== 0) {
    process.stderr.write(`${command} a échoué :\n${r.stdout || ''}${r.stderr || ''}`);
    return 'echec';
  }
  return 'ok';
}

// `process.exit()` ne déclenche pas les `finally` : on renvoie un code, et le
// répertoire temporaire est toujours supprimé.
function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-eco-probe-'));
  try {
    const classes = path.join(work, 'classes');
    fs.mkdirSync(classes);

    const compile = run('javac', ['--release', JAVA_RELEASE, '-d', classes, source]);
    if (compile === 'absent') {
      console.warn('javac introuvable : out/probe.jar non produit (mesure Java indisponible).');
      return 0;
    }
    if (compile === 'echec') return 1;

    const manifest = path.join(work, 'MANIFEST.MF');
    fs.writeFileSync(manifest, 'Premain-Class: Probe\n');

    fs.mkdirSync(path.dirname(outJar), { recursive: true });
    const pack = run('jar', ['cfm', outJar, manifest, '-C', classes, 'Probe.class']);
    if (pack === 'absent') {
      console.warn('jar introuvable : out/probe.jar non produit (mesure Java indisponible).');
      return 0;
    }
    if (pack === 'echec') return 1;

    console.log('compilé Probe.java → out/probe.jar');
    return 0;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

process.exitCode = main();
