#!/usr/bin/env node
/**
 * Point d'entrée en ligne de commande — le « green-check » de pipeline.
 *
 * Ce module n'importe **jamais** `vscode`, ni `extension.ts`, ni `webview.ts` :
 * il partage avec l'extension le parseur, les règles, l'inférence de contexte
 * et le calcul de score, rien d'autre. C'est cette frontière qui garantit que
 * l'IDE et la CI rendent le même verdict sur le même fichier — deux moteurs
 * divergents seraient pires que pas de CI du tout.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initParser, parseWith } from './parser';
import { collectFindings, filterDisabled } from './rules';
import { computeScore, aggregateScore, scoreSummary } from './scoring';
import { inferContext } from './context';
import { ALL_RULE_IDS, EXCLUDED_DIRS, RULE_CONTEXTS, specForPath } from './languages';
import { FileResult, Finding, RuleId, Score, WorkspaceReport } from './types';
import {
  runMeasured, estimate, DEFAULT_TDP_WATTS, DEFAULT_WATTS_PER_GB, DEFAULT_GCO2_PER_KWH,
  EnergyEstimate, MeasureResult,
} from './measure';

const LETTERS: Score['letter'][] = ['A', 'B', 'C', 'D', 'E'];
const FORMATS = ['text', 'json', 'github'] as const;

export interface CliOptions {
  paths: string[];
  /** `github` : annotations de PR (workflow commands) + résumé Markdown du job. */
  format: (typeof FORMATS)[number];
  /** Note minimale acceptée ; en dessous, le processus sort en échec. */
  min?: Score['letter'];
  /** Règles à ne jamais signaler (`--ignore-rule`, répétable). */
  ignoreRules: RuleId[];
  /** `--list-rules` : affiche les règles disponibles et quitte sans analyser. */
  listRules: boolean;
  help: boolean;
}

export const USAGE = `Usage : plugin-eco [options] [chemins...]

Analyse la consommation énergétique estimée du code Java, JavaScript,
TypeScript et Python, et rend une étiquette A–E inspirée du DPE.

Options
  --format <text|json|github>
                           Format de sortie (défaut : text). github : annotations
                           inline dans la PR et résumé Markdown sur la page du job
  --min <A|B|C|D|E>        Note minimale acceptée ; en dessous, sortie en échec
  --ignore-rule <id>       Ignore cette règle (répétable) ; voir --list-rules
  --list-rules             Liste les identifiants de règle disponibles et quitte
  -h, --help               Affiche cette aide

Chemins
  Fichiers ou dossiers à analyser. Défaut : le dossier courant.
  Ignorés : ${EXCLUDED_DIRS.join(', ')}

Codes de sortie
  0  analyse effectuée, note au-dessus du seuil (ou aucun seuil demandé)
  1  note en dessous du seuil passé à --min
  2  erreur d'utilisation ou d'exécution

Exemple
  plugin-eco --min C --ignore-rule sql-without-limit --format json src/ > rapport.json

Sous-commande
  plugin-eco measure <script>
                           Exécute un script Node et mesure sa consommation
                           réelle (CPU, RAM, durée) au lieu de l'estimer.
                           Voir : plugin-eco measure --help`;

/** Rendu de `--list-rules` : un identifiant par ligne, avec son contexte d'application. */
export function renderRuleList(): string {
  const lines = ['Règles disponibles :', ''];
  for (const id of ALL_RULE_IDS) {
    const scope = RULE_CONTEXTS[id];
    const label = scope === 'any' ? 'partout' : scope.join('/');
    lines.push(`  ${id.padEnd(28)} ${label}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Analyse des arguments
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { paths: [], format: 'text', ignoreRules: [], listRules: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--list-rules') {
      options.listRules = true;
    } else if (arg === '--format') {
      const value = argv[++i] as CliOptions['format'] | undefined;
      if (!value || !FORMATS.includes(value)) {
        throw new Error(`Format inconnu : ${value ?? '(manquant)'}. Attendu : ${FORMATS.join(', ')}.`);
      }
      options.format = value;
    } else if (arg === '--min') {
      const value = (argv[++i] ?? '').toUpperCase() as Score['letter'];
      if (!LETTERS.includes(value)) {
        throw new Error(`Note minimale invalide : ${argv[i] ?? '(manquante)'}. Attendu : A, B, C, D ou E.`);
      }
      options.min = value;
    } else if (arg === '--ignore-rule') {
      const value = argv[++i] as RuleId | undefined;
      if (!value || !ALL_RULE_IDS.includes(value)) {
        throw new Error(
          `Règle inconnue : ${value ?? '(manquante)'}. Attendu l'un de : ${ALL_RULE_IDS.join(', ')}.`
        );
      }
      options.ignoreRules.push(value);
    } else if (arg.startsWith('-')) {
      throw new Error(`Option inconnue : ${arg}`);
    } else {
      options.paths.push(arg);
    }
  }

  if (options.paths.length === 0) options.paths.push('.');
  return options;
}

/** La note atteint-elle le seuil ? 'A' est la meilleure. */
export function meetsThreshold(letter: Score['letter'], min: Score['letter']): boolean {
  return LETTERS.indexOf(letter) <= LETTERS.indexOf(min);
}

// ---------------------------------------------------------------------------
// Découverte des fichiers
// ---------------------------------------------------------------------------

/** Parcourt récursivement un chemin et retourne les fichiers analysables. */
export function collectPaths(target: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`Chemin introuvable : ${target}`);
  }

  if (stat.isFile()) return specForPath(target) ? [target] : [];

  return fs.readdirSync(target, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) {
      return EXCLUDED_DIRS.includes(entry.name)
        ? []
        : collectPaths(path.join(target, entry.name));
    }
    const full = path.join(target, entry.name);
    return specForPath(full) ? [full] : [];
  });
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

export async function analyze(
  files: string[],
  baseDir: string,
  ignoreRules: RuleId[] = []
): Promise<WorkspaceReport> {
  // La racine de l'extension contient out/wasm/, où vivent les grammaires.
  await initParser(path.join(__dirname, '..'));

  const results: FileResult[] = [];

  for (const file of files) {
    const spec = specForPath(file);
    if (!spec) continue;

    const code = fs.readFileSync(file, 'utf8');
    const tree = parseWith(code, spec);
    const { context } = inferContext(tree.rootNode, spec);
    const findings = filterDisabled(collectFindings(tree.rootNode, spec, context), ignoreRules);

    results.push({
      uri: file,
      fileName: path.relative(baseDir, file).split(path.sep).join('/') || path.basename(file),
      score: computeScore(findings),
      findings,
    });
  }

  results.sort((a, b) => a.score.value - b.score.value);

  return {
    files: results,
    global: aggregateScore(results.map(r => r.score)),
    filesWithFindings: results.filter(r => r.findings.length > 0).length,
    scannedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

export function renderText(report: WorkspaceReport): string {
  const { global, files, filesWithFindings } = report;
  const lines: string[] = [];

  lines.push(`Éco : ${global.letter} ${global.value}/100`);
  lines.push(
    `${global.findingCount.high} alerte(s) haute(s), ${global.findingCount.medium} moyenne(s) — ` +
    `${filesWithFindings} fichier(s) concerné(s) sur ${files.length} analysé(s)`
  );

  const concerned = files.filter(f => f.findings.length > 0);
  if (concerned.length === 0) {
    lines.push('\nAucune alerte.');
    return lines.join('\n');
  }

  lines.push('\nFichiers, du pire au meilleur :');
  for (const file of concerned) {
    lines.push(`\n  ${file.score.letter} ${String(file.score.value).padStart(3)}  ${file.fileName}`);
    for (const finding of file.findings) {
      // Format « fichier:ligne:colonne », cliquable dans la plupart des terminaux
      // et reconnu par les annotateurs de CI.
      lines.push(
        `        ${file.fileName}:${finding.startLine + 1}:${finding.startChar + 1}  ` +
        `[${finding.severity}] (${finding.ruleId}) ${finding.message.split(' — ')[0]}`
      );
    }
  }

  return lines.join('\n');
}

export function renderJson(report: WorkspaceReport): string {
  return JSON.stringify(report, null, 2);
}

// --- Format github ---------------------------------------------------------
//
// Deux sorties complémentaires, parce que GitHub ne montre le log d'un job
// qu'à qui va l'ouvrir :
//  - des *workflow commands* (`::error file=…,line=…::message`), que le runner
//    transforme en annotations sur les lignes du diff de la PR et dans
//    l'onglet Checks. Limite GitHub : 10 par niveau et par step, les suivantes
//    sont ignorées — d'où l'ordre « pires fichiers d'abord », déjà celui du
//    rapport ;
//  - un résumé Markdown, ajouté à `$GITHUB_STEP_SUMMARY` quand la variable
//    existe, qui porte l'étiquette et la liste complète sans cette limite.

const GITHUB_LEVELS: Record<Finding['severity'], 'error' | 'warning' | 'notice'> = {
  high: 'error',
  medium: 'warning',
  low: 'notice',
};

const LETTER_ICONS: Record<Score['letter'], string> = {
  A: '🟩', B: '🟩', C: '🟨', D: '🟧', E: '🟥',
};

/** Échappement imposé par les workflow commands, pour le message. */
function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Idem pour une valeur de propriété, où `:` et `,` sont aussi des délimiteurs. */
function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** Une commande par alerte, plus une pour le verdict quand le seuil n'est pas atteint. */
export function renderGithubCommands(report: WorkspaceReport, failedMin?: Score['letter']): string {
  const lines: string[] = [];
  if (failedMin) {
    lines.push(`::error title=Plugin Eco::Note ${report.global.letter} en dessous du seuil ${failedMin}.`);
  }
  for (const file of report.files) {
    for (const f of file.findings) {
      // `file` doit être relatif à la racine du dépôt pour que l'annotation
      // s'accroche au diff : lancer le CLI depuis cette racine.
      const props = [
        `file=${escapeProperty(file.fileName)}`,
        `line=${f.startLine + 1}`,
        `col=${f.startChar + 1}`,
        `title=${escapeProperty(f.ruleId)}`,
      ].join(',');
      lines.push(`::${GITHUB_LEVELS[f.severity]} ${props}::${escapeData(f.message)}`);
    }
  }
  return lines.join('\n');
}

/** Contenu d'une cellule de tableau Markdown : `|` est le seul caractère qui casse la ligne. */
function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Rend un tableau Markdown avec les `|` alignés en colonnes.
 *
 * Purement cosmétique côté rendu — GitHub l'affiche à l'identique quelle que
 * soit la largeur des cellules — mais le résultat part aussi tel quel sur
 * stdout, dans le log brut du job, où l'alignement fait toute la lisibilité.
 */
function mdTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, col) =>
    Math.max(3, h.length, ...rows.map(r => r[col].length))
  );
  const pad = (s: string, w: number) => s + ' '.repeat(w - s.length);
  const line = (cells: string[]) => `| ${cells.map((c, i) => pad(c, widths[i])).join(' | ')} |`;

  return [
    line(headers),
    `|${widths.map(w => '-'.repeat(w + 2)).join('|')}|`,
    ...rows.map(line),
  ];
}

export function renderMarkdown(report: WorkspaceReport): string {
  const { global, files, filesWithFindings } = report;
  const { high, medium } = global.findingCount;
  const md: string[] = [];

  md.push(`## ${LETTER_ICONS[global.letter]} Éco : ${global.letter} ${global.value}/100 — ${scoreSummary(global)}`);
  md.push('');
  md.push(
    `${high} alerte(s) haute(s), ${medium} moyenne(s) — ` +
    `${filesWithFindings} fichier(s) concerné(s) sur ${files.length} analysé(s).`
  );

  const concerned = files.filter(f => f.findings.length > 0);
  if (concerned.length === 0) {
    md.push('', 'Aucune alerte.');
    return md.join('\n');
  }

  md.push('', ...mdTable(
    ['Fichier', 'Score', 'Alertes'],
    concerned.map(file => [
      `\`${mdCell(file.fileName)}\``,
      `${LETTER_ICONS[file.score.letter]} ${file.score.letter} ${file.score.value}`,
      `${file.findings.length}`,
    ])
  ));

  md.push('', '<details><summary>Détail des alertes</summary>', '');
  md.push(...mdTable(
    ['Fichier', 'Ligne', 'Sévérité', 'Règle', 'Message'],
    concerned.flatMap(file => file.findings.map(f => [
      `\`${mdCell(file.fileName)}\``,
      `${f.startLine + 1}`,
      f.severity,
      `\`${f.ruleId}\``,
      mdCell(f.message.split(' — ')[0]),
    ]))
  ));
  md.push('', '</details>');

  return md.join('\n');
}

/** En CI GitHub, le Markdown est ajouté au résumé du job ; ailleurs, il n'existe que sur stdout. */
function appendStepSummary(markdown: string): void {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    fs.appendFileSync(target, `${markdown}\n`);
  } catch (err) {
    process.stderr.write(`Résumé de job non écrit (${target}) : ${(err as Error).message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Sous-commande « measure » — mesure runtime (Phase 2, prototype Node.js)
// ---------------------------------------------------------------------------
//
// Chantier séparé de l'analyse statique ci-dessus : celle-ci ne lit jamais le
// code, celle-là l'exécute — sur commande explicite uniquement, jamais à la
// sauvegarde. Un programme qui ne se termine pas de lui-même (serveur,
// watcher) n'entre pas dans ce prototype.

const MEASURE_FORMATS = ['text', 'json'] as const;

export interface MeasureCliOptions {
  script?: string;
  /** Arguments passés tels quels au script mesuré. */
  scriptArgs: string[];
  format: (typeof MEASURE_FORMATS)[number];
  tdpWatts: number;
  cores: number;
  gCO2PerKWh: number;
  help: boolean;
}

export const MEASURE_USAGE = `Usage : plugin-eco measure <script> [-- arguments-du-script...]

Exécute <script> sous Node et mesure sa consommation réelle — CPU, RAM,
durée — puis l'estime en Wh et gCO₂. Complète l'estimation statique : celle-ci
reste l'étiquette A–E comparable entre fichiers, la mesure est un axe à part,
avec ses hypothèses de conversion affichées à côté du résultat.

Options
  --tdp <watts>            TDP du processeur (défaut : ${DEFAULT_TDP_WATTS} W)
  --cores <n>              Cœurs sur lesquels le TDP se répartit (défaut : détecté)
  --carbon <gCO2/kWh>      Intensité carbone du réseau (défaut : ${DEFAULT_GCO2_PER_KWH}, France)
  --format <text|json>     Format de sortie (défaut : text)
  -h, --help               Affiche cette aide

Le script mesuré doit se terminer de lui-même ; un serveur ou un watcher n'entre
pas dans ce prototype. Sa sortie standard est héritée telle quelle, et le
rapport de mesure s'y ajoute ensuite : avec --format json, un script qui écrit
lui-même sur stdout casse le JSON produit.

Exemple
  plugin-eco measure mon-script.js -- --iterations 100000`;

export function parseMeasureArgs(argv: string[]): MeasureCliOptions {
  const options: MeasureCliOptions = {
    scriptArgs: [],
    format: 'text',
    tdpWatts: DEFAULT_TDP_WATTS,
    cores: os.cpus().length || 1,
    gCO2PerKWh: DEFAULT_GCO2_PER_KWH,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--format') {
      const value = argv[++i] as MeasureCliOptions['format'] | undefined;
      if (!value || !MEASURE_FORMATS.includes(value)) {
        throw new Error(`Format inconnu : ${value ?? '(manquant)'}. Attendu : ${MEASURE_FORMATS.join(', ')}.`);
      }
      options.format = value;
    } else if (arg === '--tdp') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`TDP invalide : ${argv[i] ?? '(manquant)'}. Attendu un nombre positif.`);
      }
      options.tdpWatts = value;
    } else if (arg === '--cores') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Nombre de cœurs invalide : ${argv[i] ?? '(manquant)'}. Attendu un nombre positif.`);
      }
      options.cores = value;
    } else if (arg === '--carbon') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Intensité carbone invalide : ${argv[i] ?? '(manquante)'}. Attendu un nombre positif ou nul.`);
      }
      options.gCO2PerKWh = value;
    } else if (arg === '--') {
      options.scriptArgs.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith('-')) {
      throw new Error(`Option inconnue : ${arg}`);
    } else if (options.script === undefined) {
      options.script = arg;
    } else {
      options.scriptArgs.push(arg);
    }
  }

  return options;
}

export function renderMeasureText(script: string, result: MeasureResult, est: EnergyEstimate): string {
  const { raw, exitCode } = result;
  const cpuUserS = raw.cpuUserUs / 1e6;
  const cpuSystemS = raw.cpuSystemUs / 1e6;
  const maxRssMo = raw.maxRssBytes !== null ? (raw.maxRssBytes / 1024 ** 2).toFixed(0) : '?';

  return [
    `Mesure de ${script}`,
    `  Sortie     code ${exitCode ?? '?'}`,
    `  CPU        ${(cpuUserS + cpuSystemS).toFixed(2)} s (user ${cpuUserS.toFixed(2)} · system ${cpuSystemS.toFixed(2)})`,
    `  Durée      ${(raw.wallMs / 1000).toFixed(2)} s`,
    `  Mémoire    max ${maxRssMo} Mo`,
    `  Énergie    ≈ ${est.wh.toFixed(4)} Wh      ≈ ${(est.gCO2 * 1000).toFixed(2)} mg CO₂`,
    `  Hypothèses ${est.hypotheses}`,
  ].join('\n');
}

export function renderMeasureJson(script: string, result: MeasureResult, est: EnergyEstimate): string {
  return JSON.stringify({ script, ...result, ...est }, null, 2);
}

export async function runMeasureCommand(argv: string[]): Promise<number> {
  let options: MeasureCliOptions;
  try {
    options = parseMeasureArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${MEASURE_USAGE}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${MEASURE_USAGE}\n`);
    return 0;
  }

  if (!options.script) {
    process.stderr.write(`Chemin de script manquant.\n\n${MEASURE_USAGE}\n`);
    return 2;
  }

  let result: MeasureResult;
  try {
    result = runMeasured(options.script, { args: options.scriptArgs });
  } catch (err) {
    process.stderr.write(`Échec de la mesure : ${(err as Error).message}\n`);
    return 2;
  }

  const est = estimate(result.raw, {
    tdpWatts: options.tdpWatts,
    cores: options.cores,
    wattsPerGB: DEFAULT_WATTS_PER_GB,
    gCO2PerKWh: options.gCO2PerKWh,
  });

  process.stdout.write(
    (options.format === 'json'
      ? renderMeasureJson(options.script, result, est)
      : renderMeasureText(options.script, result, est)) + '\n'
  );

  // Le code de sortie reflète celui du script mesuré, pas la réussite de la
  // mesure elle-même (déjà actée ci-dessus) : un script en échec doit rester
  // détectable par qui enchaîne `plugin-eco measure` dans un pipeline.
  return result.exitCode ?? 2;
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'measure') {
    return runMeasureCommand(argv.slice(1));
  }

  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (options.listRules) {
    process.stdout.write(`${renderRuleList()}\n`);
    return 0;
  }

  let files: string[];
  try {
    files = options.paths.flatMap(collectPaths);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }

  if (files.length === 0) {
    // Sortie en succès : il n'y a rien à reprocher. Mais l'avertissement part
    // sur stderr, car en CI c'est presque toujours une erreur de configuration.
    process.stderr.write('Aucun fichier analysable trouvé.\n');
    return 0;
  }

  let report: WorkspaceReport;
  try {
    report = await analyze(files, process.cwd(), options.ignoreRules);
  } catch (err) {
    process.stderr.write(`Échec de l'analyse : ${(err as Error).message}\n`);
    return 2;
  }

  const belowMin = options.min !== undefined && !meetsThreshold(report.global.letter, options.min);

  if (options.format === 'github') {
    const markdown = renderMarkdown(report);
    const commands = renderGithubCommands(report, belowMin ? options.min : undefined);
    process.stdout.write([commands, markdown].filter(Boolean).join('\n\n') + '\n');
    appendStepSummary(markdown);
  } else {
    process.stdout.write(
      (options.format === 'json' ? renderJson(report) : renderText(report)) + '\n'
    );
  }

  if (belowMin) {
    process.stderr.write(
      `\nNote ${report.global.letter} en dessous du seuil ${options.min}.\n`
    );
    return 1;
  }

  return 0;
}

// Exécution directe uniquement : l'import depuis les tests ne déclenche rien.
if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    err => { process.stderr.write(`Erreur inattendue : ${err}\n`); process.exitCode = 2; }
  );
}
