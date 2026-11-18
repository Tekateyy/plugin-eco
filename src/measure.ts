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
import { spawn } from 'child_process';

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
  /** Répertoire de travail du programme mesuré ; défaut : celui du processus courant. */
  cwd?: string;
  /**
   * Reçoit la sortie (stdout et stderr) du programme mesuré. Absent : elle est
   * héritée telle quelle (`inherit`), comme dans le CLI. Présent : elle est
   * capturée et transmise ici — l'extension VSCode n'a pas de terminal à hériter.
   */
  onOutput?: (chunk: string) => void;
  /** Interrompt la mesure : le processus en cours est tué, `runMeasured` rejette. */
  signal?: AbortSignal;
  /**
   * Runtime qui exécute un script Node ; défaut : celui du processus courant.
   * Exposé pour les tests, qui simulent l'hôte d'extension VSCode (Electron).
   */
  runtime?: NodeRuntime;
}

/** Ce qui décide comment lancer Node : l'exécutable courant, et s'il est Electron. */
export interface NodeRuntime {
  execPath: string;
  /** Version d'Electron si le processus courant en est un (hôte d'extension VSCode). */
  electron?: string;
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
 * Asynchrone : appelée depuis l'extension VSCode, une exécution synchrone
 * gèlerait l'hôte d'extension — et toutes les extensions avec lui — le temps
 * que le script tourne. Le CLI l'attend simplement.
 *
 * Sans `onOutput`, stdout/stderr du programme mesuré sont hérités (`inherit`) :
 * l'utilisateur le voit tourner normalement, aucune sortie de mesure ne s'y mélange.
 *
 * Avec `runs > 1`, les exécutions s'arrêtent à la première qui échoue : un
 * script en erreur n'a pas de consommation représentative à moyenner, et son
 * code de sortie doit remonter tel quel.
 */
export async function runMeasured(script: string, opts: MeasureOptions = {}): Promise<MeasureResult> {
  const runs = opts.runs ?? 1;
  const samples: RawMeasurement[] = [];
  let exitCode: number | null = null;

  for (let i = 0; i < runs; i++) {
    const once = await runOnce(script, opts);
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

/** Une façon de lancer le programme mesuré. */
export interface Launch {
  command: string;
  args: string[];
  /** Variables d'environnement ajoutées à celles du processus courant. */
  env?: Record<string, string>;
  /** Lancement de repli si celui-ci ne démarre pas du tout. */
  fallback?: Launch;
}

/** Sonde et commande à lancer pour mesurer `script`, selon son langage détecté. */
export function commandFor(script: string, opts: MeasureOptions = {}): Launch {
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
  const args = ['--require', probePath, script, ...scriptArgs];
  const runtime = opts.runtime ?? { execPath: process.execPath, electron: process.versions.electron };

  // Dans l'hôte d'extension VSCode, `execPath` est l'exécutable de VSCode : sans
  // ELECTRON_RUN_AS_NODE, il ouvrirait une fenêtre au lieu d'exécuter le script.
  // Avec, c'est le Node embarqué de VSCode ; s'il ne démarre pas, `node` du PATH.
  if (runtime.electron) {
    return {
      command: runtime.execPath, args, env: { ELECTRON_RUN_AS_NODE: '1' },
      fallback: { command: 'node', args },
    };
  }
  return { command: runtime.execPath, args };
}

interface SpawnOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  /** Le processus n'a pas pu être lancé (exécutable introuvable…). */
  startError?: Error;
  wallMs: number;
}

/** Lance un processus et attend sa fin, sans jamais rejeter. */
function spawnMeasured(launch: Launch, outPath: string, opts: MeasureOptions): Promise<SpawnOutcome> {
  return new Promise(resolve => {
    const startedAt = performance.now();
    const child = spawn(launch.command, launch.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...launch.env, PLUGIN_ECO_PROBE_OUT: outPath },
      stdio: opts.onOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      signal: opts.signal,
    });
    if (opts.onOutput) {
      child.stdout?.setEncoding('utf8').on('data', opts.onOutput);
      child.stderr?.setEncoding('utf8').on('data', opts.onOutput);
    }

    let settled = false;
    const done = (outcome: Omit<SpawnOutcome, 'wallMs'>) => {
      if (settled) return;
      settled = true;
      resolve({ ...outcome, wallMs: performance.now() - startedAt });
    };
    // Sans pid, le processus n'a jamais démarré : 'close' n'est pas garanti.
    // Avec (annulation), on attend 'close' pour que la sortie soit complète.
    child.on('error', err => {
      if (child.pid === undefined) done({ status: null, signal: null, startError: err });
    });
    child.on('close', (status, signal) => done({ status, signal }));
  });
}

async function runOnce(script: string, opts: MeasureOptions): Promise<{ raw: RawMeasurement; exitCode: number | null }> {
  if (opts.signal?.aborted) throw new Error('mesure annulée.');

  // Répertoire privé (0700, nom aléatoire) plutôt qu'un fichier au nom
  // prévisible dans le tmpdir partagé : sur une machine multi-utilisateurs,
  // personne ne peut y déposer d'avance un lien symbolique que la sonde
  // suivrait en écrivant.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-eco-'));
  const outPath = path.join(outDir, 'probe.json');

  let launch: Launch;
  try {
    launch = commandFor(script, opts);
  } catch (err) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw err;
  }
  let result = await spawnMeasured(launch, outPath, opts);
  if (result.startError && launch.fallback) {
    launch = launch.fallback;
    result = await spawnMeasured(launch, outPath, opts);
  }
  const { command } = launch;
  const { wallMs } = result;

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

  if (opts.signal?.aborted) throw new Error('mesure annulée.');

  if (!raw) {
    if (result.startError) {
      // Cas typique : interpréteur absent du PATH (ex. `python3` sous Windows).
      throw new Error(`interpréteur « ${command} » introuvable : ${result.startError.message}`);
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
