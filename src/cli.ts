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
import * as path from 'path';
import { initParser, parseWith } from './parser';
import { collectFindings } from './rules';
import { computeScore, aggregateScore } from './scoring';
import { inferContext } from './context';
import { EXCLUDED_DIRS, specForPath } from './languages';
import { FileResult, Score, WorkspaceReport } from './types';

const LETTERS: Score['letter'][] = ['A', 'B', 'C', 'D', 'E'];

export interface CliOptions {
  paths: string[];
  format: 'text' | 'json';
  /** Note minimale acceptée ; en dessous, le processus sort en échec. */
  min?: Score['letter'];
  help: boolean;
}

export const USAGE = `Usage : plugin-eco [options] [chemins...]

Analyse la consommation énergétique estimée du code Java, JavaScript et
TypeScript, et rend une étiquette A–E inspirée du DPE.

Options
  --format <text|json>   Format de sortie (défaut : text)
  --min <A|B|C|D|E>      Note minimale acceptée ; en dessous, sortie en échec
  -h, --help             Affiche cette aide

Chemins
  Fichiers ou dossiers à analyser. Défaut : le dossier courant.
  Ignorés : ${EXCLUDED_DIRS.join(', ')}

Codes de sortie
  0  analyse effectuée, note au-dessus du seuil (ou aucun seuil demandé)
  1  note en dessous du seuil passé à --min
  2  erreur d'utilisation ou d'exécution

Exemple
  plugin-eco --min C --format json src/ > rapport.json`;

// ---------------------------------------------------------------------------
// Analyse des arguments
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { paths: [], format: 'text', help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--format') {
      const value = argv[++i];
      if (value !== 'text' && value !== 'json') {
        throw new Error(`Format inconnu : ${value ?? '(manquant)'}. Attendu : text ou json.`);
      }
      options.format = value;
    } else if (arg === '--min') {
      const value = (argv[++i] ?? '').toUpperCase() as Score['letter'];
      if (!LETTERS.includes(value)) {
        throw new Error(`Note minimale invalide : ${argv[i] ?? '(manquante)'}. Attendu : A, B, C, D ou E.`);
      }
      options.min = value;
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

export async function analyze(files: string[], baseDir: string): Promise<WorkspaceReport> {
  // La racine de l'extension contient out/wasm/, où vivent les grammaires.
  await initParser(path.join(__dirname, '..'));

  const results: FileResult[] = [];

  for (const file of files) {
    const spec = specForPath(file);
    if (!spec) continue;

    const code = fs.readFileSync(file, 'utf8');
    const tree = parseWith(code, spec);
    const { context } = inferContext(tree.rootNode, spec);
    const findings = collectFindings(tree.rootNode, spec, context);

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
        `[${finding.severity}] ${finding.message.split(' — ')[0]}`
      );
    }
  }

  return lines.join('\n');
}

export function renderJson(report: WorkspaceReport): string {
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
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
    report = await analyze(files, process.cwd());
  } catch (err) {
    process.stderr.write(`Échec de l'analyse : ${(err as Error).message}\n`);
    return 2;
  }

  process.stdout.write(
    (options.format === 'json' ? renderJson(report) : renderText(report)) + '\n'
  );

  if (options.min && !meetsThreshold(report.global.letter, options.min)) {
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
