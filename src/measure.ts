/**
 * Mesure à l'exécution (Phase 2 de la roadmap) — prototype Node.js.
 *
 * Comme `cli.ts`, ce module n'importe jamais `vscode` : c'est un chantier
 * séparé de l'analyse statique, pas une extension de `rules.ts`. La lettre
 * A–E reste une estimation statique, comparable entre fichiers ; la mesure
 * ici produite est un axe à part, avec ses propres hypothèses affichées.
 *
 * Mécanisme : on précharge `probe.js` dans le processus du script mesuré via
 * `node --require`. La sonde écrit `RawMeasurement` en JSON dans un fichier
 * temporaire à la sortie du processus ; ce module le lit et le convertit en
 * Wh/CO₂ via des coefficients standards, explicitement affichés en résultat.
 *
 * Écrit pour se transposer à Python (sitecustomize + resource.getrusage) et
 * Java (-javaagent ou JFR) sans changer cette frontière.
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

export interface MeasureOptions {
  /** Chemin de la sonde à précharger ; défaut : `probe.js` à côté de ce module compilé. */
  probePath?: string;
  args?: string[];
}

export interface MeasureResult {
  raw: RawMeasurement;
  /** Code de sortie du programme mesuré (pas celui du CLI). */
  exitCode: number | null;
}

/**
 * Exécute `script` sous la sonde et retourne sa mesure brute.
 *
 * stdout/stderr du programme mesuré sont hérités (`inherit`) : l'utilisateur
 * le voit tourner normalement, aucune sortie de mesure ne s'y mélange.
 */
export function runMeasured(script: string, opts: MeasureOptions = {}): MeasureResult {
  const probePath = opts.probePath ?? path.join(__dirname, 'probe.js');
  // Répertoire privé (0700, nom aléatoire) plutôt qu'un fichier au nom
  // prévisible dans le tmpdir partagé : sur une machine multi-utilisateurs,
  // personne ne peut y déposer d'avance un lien symbolique que la sonde
  // suivrait en écrivant.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-eco-'));
  const outPath = path.join(outDir, 'probe.json');

  const result = spawnSync(
    process.execPath,
    ['--require', probePath, script, ...(opts.args ?? [])],
    { stdio: 'inherit', env: { ...process.env, PLUGIN_ECO_PROBE_OUT: outPath } }
  );

  let raw: RawMeasurement | null = null;
  try {
    raw = JSON.parse(fs.readFileSync(outPath, 'utf8')) as RawMeasurement;
  } catch {
    raw = null;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  if (!raw) {
    throw new Error(
      `le programme n'a produit aucune mesure (code de sortie ${result.status ?? result.signal ?? '?'}).`
    );
  }

  return { raw, exitCode: result.status };
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
