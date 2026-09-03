import * as vscode from 'vscode';
import { initParser, parse } from './parser';
import { collectFindings } from './rules';
import { computeScore, scoreSummary } from './scoring';
import { buildWebviewHtml, buildWorkspaceHtml } from './webview';
import { analyzeWorkspace } from './workspace';
import { isSupported, specFor } from './languages';
import { inferContext } from './context';
import { ExecutionContext, Finding, Score } from './types';

let diagnosticCollection: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;
let panel: vscode.WebviewPanel | undefined;

/** 'file' = rapport du fichier actif / 'workspace' = rapport global. */
let panelMode: 'file' | 'workspace' = 'file';

/** Timers de debounce par URI de document. */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Dernier résultat d'analyse mono-fichier. */
let lastFindings: Finding[] = [];
let lastScore: Score = { letter: 'A', value: 100, findingCount: { high: 0, medium: 0, low: 0 } };
let lastFileName = '';

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    await initParser(context.extensionUri.fsPath);
  } catch (err) {
    vscode.window.showErrorMessage(`Plugin Eco : erreur d'initialisation — ${err}`);
    return;
  }

  diagnosticCollection = vscode.languages.createDiagnosticCollection('greencoding');
  context.subscriptions.push(diagnosticCollection);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'greencoding.showPanel';
  context.subscriptions.push(statusBarItem);

  // Commande : re-analyser le fichier actif
  context.subscriptions.push(
    vscode.commands.registerCommand('greencoding.analyze', () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc && isSupported(doc.languageId)) analyzeDocument(doc);
    })
  );

  // Commande : ouvrir / révéler le panneau (mode fichier)
  context.subscriptions.push(
    vscode.commands.registerCommand('greencoding.showPanel', () => {
      panelMode = 'file';
      openOrRevealPanel(context);
    })
  );

  // Commande : analyser tout le workspace
  context.subscriptions.push(
    vscode.commands.registerCommand('greencoding.analyzeWorkspace', async () => {
      const report = await analyzeWorkspace(diagnosticCollection);
      if (!report) return;

      panelMode = 'workspace';
      openOrRevealPanel(context);
      if (panel) {
        panel.title = '⚡ Rapport Éco — Workspace';
        panel.webview.html = buildWorkspaceHtml(report, getNonce());
      }
    })
  );

  // Événements document
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (isSupported(doc.languageId)) analyzeDocument(doc);
    }),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (isSupported(doc.languageId)) analyzeDocument(doc);
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (!isSupported(event.document.languageId)) return;
      scheduleAnalysis(event.document);
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && isSupported(editor.document.languageId)) {
        analyzeDocument(editor.document);
      } else {
        statusBarItem.hide();
      }
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      diagnosticCollection.delete(doc.uri);
      const key = doc.uri.toString();
      const timer = debounceTimers.get(key);
      if (timer) { clearTimeout(timer); debounceTimers.delete(key); }
    })
  );

  // Analyser le fichier actif au démarrage
  const activeDoc = vscode.window.activeTextEditor?.document;
  if (activeDoc && isSupported(activeDoc.languageId)) analyzeDocument(activeDoc);
}

export function deactivate(): void {
  diagnosticCollection?.clear();
  diagnosticCollection?.dispose();
  statusBarItem?.dispose();
  panel?.dispose();
  debounceTimers.forEach(t => clearTimeout(t));
  debounceTimers.clear();
}

// ---------------------------------------------------------------------------
// Analyse mono-fichier
// ---------------------------------------------------------------------------

function scheduleAnalysis(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  debounceTimers.set(key, setTimeout(() => {
    analyzeDocument(document);
    debounceTimers.delete(key);
  }, 400));
}

function analyzeDocument(document: vscode.TextDocument): void {
  const spec = specFor(document.languageId);
  if (!spec) return;

  try {
    const tree = parse(document.getText(), document.languageId);
    const { context, clientSignals, serverSignals } = inferContext(tree.rootNode, spec);
    const findings = collectFindings(tree.rootNode, spec, context);
    const score = computeScore(findings);

    // Un arbre incomplet donne une analyse incomplète : sans ce signal, un
    // fichier illisible sortirait en A 100/100, ce qui est pire qu'aucun
    // résultat. Fréquent pendant la frappe, d'où un simple avertissement
    // plutôt qu'un blocage.
    const partial = tree.rootNode.hasError;

    lastFindings = findings;
    lastScore = score;
    lastFileName = document.fileName;

    // Diagnostics inline
    diagnosticCollection.set(document.uri, findings.map(f => {
      const range = new vscode.Range(f.startLine, f.startChar, f.endLine, f.endChar);
      const severity = f.severity === 'high'
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Information;
      const diag = new vscode.Diagnostic(range, `⚡ ${f.message}`, severity);
      diag.source = 'Plugin Eco';
      return diag;
    }));

    // Barre de statut
    statusBarItem.text = `⚡ Éco: ${score.letter}${partial ? ' ⚠' : ''}`;
    statusBarItem.tooltip = [
      `${spec.label} — score : ${score.value}/100 — ${scoreSummary(score)}`,
      `Alertes : ${score.findingCount.high} haute(s), ${score.findingCount.medium} moyenne(s)`,
      `Exécution : ${contextLabel(context)}${contextEvidence(clientSignals, serverSignals)}`,
      ...(partial
        ? ['', '⚠ Analyse partielle : le fichier n\'a pas pu être parsé entièrement.',
           'Le score est à prendre avec réserve.']
        : []),
      '',
      'Cliquer pour ouvrir le rapport détaillé',
    ].join('\n');
    statusBarItem.backgroundColor =
      score.letter === 'D' || score.letter === 'E'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    statusBarItem.show();

    // Mettre à jour le panneau uniquement si on est en mode fichier
    if (panel && panelMode === 'file') {
      panel.title = '⚡ Rapport Éco';
      panel.webview.html = buildWebviewHtml(findings, score, document.fileName, getNonce());
    }
  } catch {
    // Silencieux (fichier incomplet en cours de frappe)
  }
}

// ---------------------------------------------------------------------------
// Panneau WebView
// ---------------------------------------------------------------------------

function openOrRevealPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    // Rafraîchir si on repasse en mode fichier
    if (panelMode === 'file') {
      panel.title = '⚡ Rapport Éco';
      panel.webview.html = buildWebviewHtml(lastFindings, lastScore, lastFileName, getNonce());
    }
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'greencoding.report',
    '⚡ Rapport Éco',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  panel.webview.html = buildWebviewHtml(lastFindings, lastScore, lastFileName, getNonce());

  // Handler : clic sur un fichier dans le rapport workspace → ouvrir dans l'éditeur
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === 'open' && typeof message.file === 'string') {
      try {
        const uri = vscode.Uri.parse(message.file);
        const doc = await vscode.workspace.openTextDocument(uri);
        const line = Math.max(0, (message.line || 1) - 1);
        await vscode.window.showTextDocument(doc, {
          selection: new vscode.Range(line, 0, line, 0),
          viewColumn: vscode.ViewColumn.One,
        });
      } catch {
        // URI invalide ou fichier supprimé
      }
    }
  }, null, context.subscriptions);

  panel.onDidDispose(() => {
    panel = undefined;
    panelMode = 'file';
  }, null, context.subscriptions);
}

// ---------------------------------------------------------------------------
// Utilitaire
// ---------------------------------------------------------------------------

const CONTEXT_LABELS: Record<ExecutionContext, string> = {
  client: 'navigateur — le coût est payé par chaque visiteur',
  server: 'serveur',
  unknown: 'indéterminée',
};

function contextLabel(context: ExecutionContext): string {
  return CONTEXT_LABELS[context];
}

/** Indices ayant conduit au verdict, tronqués pour rester lisibles. */
function contextEvidence(clientSignals: string[], serverSignals: string[]): string {
  const all = [...serverSignals, ...clientSignals];
  if (all.length === 0) return '';
  const shown = all.slice(0, 4).join(', ');
  return ` (${shown}${all.length > 4 ? '…' : ''})`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length))
  ).join('');
}
