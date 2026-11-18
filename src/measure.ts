/**
 * Mesure à l'exécution (Phase 2 de la roadmap) — prototype Node.js.
 *
 * Comme `cli.ts`, ce module n'importe jamais `vscode` : c'est un chantier
 * séparé de l'analyse statique, pas une extension de `rules.ts`. La lettre
 * A–E reste une estimation statique, comparable entre fichiers ; la mesure
 * ici produite est un axe à part, avec ses propres hypothèses affichées.
 *
 * Mécanisme, par langage : Node précharge `probe.js` via `node --require` ;
 * Python exécute `probe.py <script>`, qui s'installe puis lance le script via
 * `runpy` — un wrapper plutôt qu'un `sitecustomize.py` posé sur un
 * `PYTHONPATH` dédié, pour ne rien avoir à fusionner avec celui de
 * l'utilisateur ni masquer le sien s'il en a un. PHP charge `probe.php` via
 * `php -d auto_prepend_file=…`, exécuté avant le script dans le même processus.
 * Java charge `probe.jar` via `java -javaagent:…` (`-jar` pour un `.jar`, lancement
 * direct du source pour un `.java`).
 * Dans tous les cas, la sonde écrit sa mesure en JSON dans un fichier temporaire à la
 * sortie du processus ; ce module le lit et le convertit en Wh/CO₂ via des
 * coefficients standards, explicitement affichés en résultat. Seule la sonde Java
 * écrit un autre format (`JavaProbeOutput`), normalisé ici en `RawMeasurement`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

/** Ce que la sonde a mesuré, brut, sans conversion. */
export interface RawMeasurement {
  cpuUserUs: number;
  cpuSystemUs: number;
  wallMs: number;
  maxRssBytes: number | null;
}

export type Language = 'node' | 'python' | 'php' | 'java';

/** Langage déduit de l'extension ; tout ce qui n'est ni `.py`, `.php`, `.jar` ni `.java` est traité comme Node. */
export function languageFor(script: string): Language {
  const ext = path.extname(script).toLowerCase();
  if (ext === '.py') return 'python';
  if (ext === '.php') return 'php';
  if (ext === '.jar' || ext === '.java') return 'java';
  return 'node';
}

/** `php` partout : l'exécutable porte ce nom sous Windows comme ailleurs. */
export function defaultPhpInterpreter(): string {
  return 'php';
}

/** `java` partout, résolu par le PATH. */
export function defaultJavaInterpreter(): string {
  return 'java';
}

/** `python` sous Windows (où `python3` n'existe généralement pas), `python3` ailleurs. */
export function defaultPythonInterpreter(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

export interface MeasureOptions {
  /** Chemin de la sonde à précharger/exécuter ; défaut : `probe.js`/`probe.py` selon le langage. */
  probePath?: string;
  args?: string[];
  /** Nombre d'exécutions ; au-delà de 1, `raw` est la médiane des mesures. Défaut : 1. */
  runs?: number;
  /** Exécutable Python à lancer pour un script `.py` ; défaut : `defaultPythonInterpreter()`. */
  pythonInterpreter?: string;
  /** Exécutable PHP à lancer pour un script `.php` ; défaut : `defaultPhpInterpreter()`. */
  phpInterpreter?: string;
  /** Exécutable Java à lancer pour un `.jar` ou un `.java` ; défaut : `defaultJavaInterpreter()`. */
  javaInterpreter?: string;
}

/**
 * Ce qu'écrit la sonde Java : des compteurs de JVM, pas ceux des autres sondes.
 * `allocatedBytes` n'entre pas dans l'estimation (le modèle ne le pondère pas) ;
 * il est lu pour rester fidèle au format mais n'est pas conservé.
 */
interface JavaProbeOutput {
  cpuTotalNs: number;
  allocatedBytes: number;
  peakHeapBytes: number;
}

export interface MeasureResult {
  /** Mesure retenue : celle de l'exécution unique, ou la médiane de `samples`. */
  raw: RawMeasurement;
  /** Code de sortie du programme mesuré (pas celui du CLI). */
  exitCode: number | null;
  /** Mesure brute de chaque exécution, dans l'ordre. */
  samples: RawMeasurement[];
}

/**
 * Exécute `script` sous la sonde, une ou plusieurs fois, et retourne sa mesure.
 *
 * stdout/stderr du programme mesuré sont hérités (`inherit`) : l'utilisateur
 * le voit tourner normalement, aucune sortie de mesure ne s'y mélange.
 *
 * Avec `runs > 1`, les exécutions s'arrêtent à la première qui échoue : un
 * script en erreur n'a pas de consommation représentative à moyenner, et son
 * code de sortie doit remonter tel quel.
 */
export function runMeasured(script: string, opts: MeasureOptions = {}): MeasureResult {
  const runs = opts.runs ?? 1;
  const samples: RawMeasurement[] = [];
  let exitCode: number | null = null;

  for (let i = 0; i < runs; i++) {
    const once = runOnce(script, opts);
    samples.push(once.raw);
    exitCode = once.exitCode;
    if (exitCode !== 0) break;
  }

  return { raw: medianMeasurement(samples), exitCode, samples };
}

/** Médiane d'une liste non vide ; moyenne des deux valeurs centrales si paire. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Médiane champ par champ — comme le font les outils de benchmark, plutôt que
 * de retenir « l'exécution médiane » : chaque grandeur est bruitée par sa
 * propre cause (CPU par l'ordonnanceur, RAM par le GC), et l'exécution la plus
 * typique sur l'une ne l'est pas forcément sur l'autre.
 */
export function medianMeasurement(samples: RawMeasurement[]): RawMeasurement {
  if (samples.length === 0) {
    throw new Error('aucune mesure à agréger.');
  }
  const rss = samples.map(s => s.maxRssBytes).filter((v): v is number => v !== null);
  return {
    cpuUserUs: median(samples.map(s => s.cpuUserUs)),
    cpuSystemUs: median(samples.map(s => s.cpuSystemUs)),
    wallMs: median(samples.map(s => s.wallMs)),
    maxRssBytes: rss.length ? median(rss) : null,
  };
}

/** Sonde et commande à lancer pour mesurer `script`, selon son langage détecté. */
function commandFor(script: string, opts: MeasureOptions): { command: string; args: string[] } {
  const lang = languageFor(script);
  const scriptArgs = opts.args ?? [];

  if (lang === 'python') {
    const probePath = opts.probePath ?? path.join(__dirname, 'probe.py');
    const python = opts.pythonInterpreter ?? defaultPythonInterpreter();
    return { command: python, args: [probePath, script, ...scriptArgs] };
  }

  if (lang === 'php') {
    const probePath = opts.probePath ?? path.join(__dirname, 'probe.php');
    const php = opts.phpInterpreter ?? defaultPhpInterpreter();
    return { command: php, args: ['-d', `auto_prepend_file=${probePath}`, script, ...scriptArgs] };
  }

  if (lang === 'java') {
    const probePath = opts.probePath ?? path.join(__dirname, 'probe.jar');
    if (!fs.existsSync(probePath)) {
      throw new Error(
        `sonde Java absente (${probePath}) : elle est produite au build, qui exige un JDK 21+ ` +
        `(javac et jar sur le PATH).`
      );
    }
    const java = opts.javaInterpreter ?? defaultJavaInterpreter();
    const jar = path.extname(script).toLowerCase() === '.jar';
    return {
      command: java,
      args: [`-javaagent:${probePath}`, ...(jar ? ['-jar'] : []), script, ...scriptArgs],
    };
  }

  const probePath = opts.probePath ?? path.join(__dirname, 'probe.js');
  return { command: process.execPath, args: ['--require', probePath, script, ...scriptArgs] };
}

function runOnce(script: string, opts: MeasureOptions): { raw: RawMeasurement; exitCode: number | null } {
  // Répertoire privé (0700, nom aléatoire) plutôt qu'un fichier au nom
  // prévisible dans le tmpdir partagé : sur une machine multi-utilisateurs,
  // personne ne peut y déposer d'avance un lien symbolique que la sonde
  // suivrait en écrivant.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-eco-'));
  const outPath = path.join(outDir, 'probe.json');

  const { command, args } = commandFor(script, opts);
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    stdio: 'inherit', env: { ...process.env, PLUGIN_ECO_PROBE_OUT: outPath },
  });
  const wallMs = performance.now() - startedAt;

  let raw: RawMeasurement | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    raw = languageFor(script) === 'java'
      ? fromJavaProbe(parsed as JavaProbeOutput, wallMs)
      : parsed as RawMeasurement;
  } catch {
    raw = null;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  if (!raw) {
    if (result.error) {
      // Cas typique : interpréteur absent du PATH (ex. `python3` sous Windows).
      throw new Error(`interpréteur « ${command} » introuvable : ${result.error.message}`);
    }
    const hint = languageFor(script) === 'java' ? ' Une JVM 21 ou plus est requise par la sonde.' : '';
    throw new Error(
      `le programme n'a produit aucune mesure (code de sortie ${result.status ?? result.signal ?? '?'}).${hint}`
    );
  }

  return { raw, exitCode: result.status };
}

/**
 * Java : le temps CPU est celui du processus entier, démarrage de la JVM compris,
 * sans distinction utilisateur/système (donc tout en « utilisateur »). La RAM est le
 * pic de tas, et non un RSS de pointe — aucune lecture portable via les MXBeans.
 * La durée est prise par le parent, la sonde ne la mesure pas : elle englobe donc
 * aussi le lancement de la JVM.
 */
export function fromJavaProbe(out: JavaProbeOutput, wallMs: number): RawMeasurement {
  return {
    cpuUserUs: out.cpuTotalNs / 1000,
    cpuSystemUs: 0,
    wallMs,
    maxRssBytes: out.peakHeapBytes,
  };
}

// ---------------------------------------------------------------------------
// Conversion en énergie
// ---------------------------------------------------------------------------

/**
 * Coefficients de conversion — modèle Cloud Carbon Footprint / Green Metrics Tool.
 * Aucun n'est mesurable par le plugin : ce sont des hypothèses, pas des faits,
 * d'où leur présence explicite dans `EnergyEstimate.hypotheses`.
 */
export interface EnergyCoefficients {
  /** TDP du processeur, en watts (défaut : poste de travail courant). */
  tdpWatts: number;
  /** Nombre de cœurs sur lesquels le TDP se répartit. */
  cores: number;
  /** Coefficient RAM, W par Go — défaut Cloud Carbon Footprint. */
  wattsPerGB: number;
  /** Intensité carbone du réseau électrique, en gCO₂/kWh. */
  gCO2PerKWh: number;
}

export const DEFAULT_TDP_WATTS = 65;
export const DEFAULT_WATTS_PER_GB = 0.392;
/** France, RTE — écarté volontairement de la moyenne mondiale (≈475), voir README. */
export const DEFAULT_GCO2_PER_KWH = 52;

export function defaultCoefficients(): EnergyCoefficients {
  return {
    tdpWatts: DEFAULT_TDP_WATTS,
    cores: os.cpus().length || 1,
    wattsPerGB: DEFAULT_WATTS_PER_GB,
    gCO2PerKWh: DEFAULT_GCO2_PER_KWH,
  };
}

export interface EnergyEstimate {
  wh: number;
  gCO2: number;
  /** Résumé lisible des hypothèses retenues, à afficher à côté du résultat. */
  hypotheses: string;
}

/** Fonction pure : aucune exécution, aucun accès disque. */
export function estimate(raw: RawMeasurement, coeffs: EnergyCoefficients): EnergyEstimate {
  const cpuSeconds = (raw.cpuUserUs + raw.cpuSystemUs) / 1e6;
  const wattsPerCore = coeffs.tdpWatts / coeffs.cores;
  const cpuWh = (cpuSeconds / 3600) * wattsPerCore;

  const wallHours = raw.wallMs / 1000 / 3600;
  const gb = (raw.maxRssBytes ?? 0) / 1024 ** 3;
  const ramWh = gb * coeffs.wattsPerGB * wallHours;

  const wh = cpuWh + ramWh;
  const gCO2 = (wh / 1000) * coeffs.gCO2PerKWh;

  const hypotheses =
    `${wattsPerCore.toFixed(1)} W/cœur (TDP ${coeffs.tdpWatts} W / ${coeffs.cores} cœurs), ` +
    `${coeffs.wattsPerGB} W/Go, ${coeffs.gCO2PerKWh} gCO₂/kWh`;

  return { wh, gCO2, hypotheses };
}
