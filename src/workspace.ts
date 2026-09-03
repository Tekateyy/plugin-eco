import * as vscode from 'vscode';
import * as path from 'path';
import { parseWith } from './parser';
import { collectFindings } from './rules';
import { computeScore, letterFor } from './scoring';
import { LANGUAGES, LanguageSpec } from './languages';
import { FileResult, WorkspaceReport, Score } from './types';

const EXCLUDE = '**/{node_modules,target,build,dist,bin,out,.git,.gradle,.idea,.next,coverage}/**';

/**
 * Scanne tous les fichiers analysables du workspace, calcule un score par
 * fichier, et retourne un rapport global (score moyen + liste triée par score
 * croissant).
 *
 * Les diagnostics de chaque fichier sont posés dans la collection partagée.
 */
export async function analyzeWorkspace(
  diagnosticCollection: vscode.DiagnosticCollection
): Promise<WorkspaceReport | null> {

  // Un passage par langage : chaque fichier garde le descripteur qui le décrit,
  // faute de quoi on ne saurait plus quelle grammaire lui appliquer.
  const targets: { uri: vscode.Uri; spec: LanguageSpec }[] = [];
  for (const spec of LANGUAGES) {
    const found = await vscode.workspace.findFiles(spec.glob, EXCLUDE);
    for (const uri of found) targets.push({ uri, spec });
  }

  if (targets.length === 0) {
    vscode.window.showInformationMessage(
      'Plugin Eco : aucun fichier analysable trouvé dans le workspace ' +
      `(${LANGUAGES.map(l => l.label).join(', ')}).`
    );
    return null;
  }

  const results: FileResult[] = [];

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: '⚡ Plugin Eco — Analyse du workspace',
    cancellable: true,
  }, async (progress, token) => {

    const total = targets.length;

    for (let i = 0; i < total; i++) {
      if (token.isCancellationRequested) break;

      const { uri, spec } = targets[i];
      const baseName = path.basename(uri.fsPath);

      progress.report({
        message: `${baseName} (${i + 1}/${total})`,
        increment: (1 / total) * 100,
      });

      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const code = Buffer.from(bytes).toString('utf-8');
        const tree = parseWith(code, spec);
        const findings = collectFindings(tree.rootNode, spec);
        const score = computeScore(findings);

        // Poser les diagnostics inline pour ce fichier
        diagnosticCollection.set(uri, findings.map(f => {
          const range = new vscode.Range(f.startLine, f.startChar, f.endLine, f.endChar);
          const severity = f.severity === 'high'
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information;
          const diag = new vscode.Diagnostic(range, `⚡ ${f.message}`, severity);
          diag.source = 'Plugin Eco';
          return diag;
        }));

        // Nom d'affichage : chemin relatif au workspace si possible
        const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
        const displayName = wsFolder
          ? path.relative(wsFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/')
          : baseName;

        results.push({ uri: uri.toString(), fileName: displayName, score, findings });

      } catch {
        // Fichier illisible ou non parsable → ignoré silencieusement
      }
    }
  });

  if (results.length === 0) return null;

  // Score global = moyenne arrondie des scores fichiers
  const avgValue = Math.round(
    results.reduce((sum, r) => sum + r.score.value, 0) / results.length
  );
  const globalCount = results.reduce(
    (acc, r) => ({
      high:   acc.high   + r.score.findingCount.high,
      medium: acc.medium + r.score.findingCount.medium,
      low:    acc.low    + r.score.findingCount.low,
    }),
    { high: 0, medium: 0, low: 0 }
  );
  const global: Score = {
    letter: letterFor(avgValue),
    value: avgValue,
    findingCount: globalCount,
  };

  // Trier : pires fichiers en premier
  results.sort((a, b) => a.score.value - b.score.value);

  return {
    files: results,
    global,
    scannedAt: new Date().toLocaleString('fr-CA'),
  };
}
