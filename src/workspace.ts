import * as vscode from 'vscode';
import * as path from 'path';
import { parse } from './parser';
import { collectFindings } from './rules';
import { computeScore, letterFor } from './scoring';
import { FileResult, WorkspaceReport, Score } from './types';

/**
 * Scanne tous les fichiers Java du workspace, calcule un score par fichier,
 * et retourne un rapport global (score moyen + liste triée par score croissant).
 *
 * Les diagnostics de chaque fichier sont posés dans la collection partagée.
 */
export async function analyzeWorkspace(
  diagnosticCollection: vscode.DiagnosticCollection
): Promise<WorkspaceReport | null> {

  const javaFiles = await vscode.workspace.findFiles(
    '**/*.java',
    '**/{node_modules,target,build,bin,out,.git,.gradle,.idea}/**'
  );

  if (javaFiles.length === 0) {
    vscode.window.showInformationMessage('Plugin Eco : aucun fichier .java trouvé dans le workspace.');
    return null;
  }

  const results: FileResult[] = [];

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: '⚡ Plugin Eco — Analyse du workspace',
    cancellable: true,
  }, async (progress, token) => {

    const total = javaFiles.length;

    for (let i = 0; i < total; i++) {
      if (token.isCancellationRequested) break;

      const uri = javaFiles[i];
      const baseName = path.basename(uri.fsPath);

      progress.report({
        message: `${baseName} (${i + 1}/${total})`,
        increment: (1 / total) * 100,
      });

      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const code = Buffer.from(bytes).toString('utf-8');
        const tree = parse(code);
        const findings = collectFindings(tree.rootNode);
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
