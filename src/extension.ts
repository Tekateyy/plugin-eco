import * as vscode from 'vscode';
import * as path from 'path';
import { initParser, parse } from './parser';
import { defaultCoefficients, estimate, runMeasured } from './measure';
import { collectFindings, filterDisabled } from './rules';
import { computeScore, scoreSummary } from './scoring';
import {
  buildMeasureHtml, buildTooLargeHtml, buildWebviewHtml, buildWorkspaceHtml, tooLargeMessage,
} from './webview';
import { analyzeWorkspace } from './workspace';
import { MAX_EDITOR_FILE_BYTES, isSupported, specFor } from './languages';
import { inferContext } from './context';
import { ExecutionContext, Finding, RuleId, Score } from './types';

/** Règles désactivées par l'utilisateur (`plugin-eco.disabledRules`). */
function disabledRules(): RuleId[] {
  return vscode.workspace.getConfiguration('plugin-eco').get<RuleId[]>('disabledRules', []);
}

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
let lastPartial = false;
/** Le dernier fichier actif dépassait MAX_EDITOR_FILE_BYTES : rien n'a été analysé. */
let lastTooLarge = false;

/** Panneau de la mesure à l'exécution, distinct du rapport. */
let measurePanel: vscode.WebviewPanel | undefined;
/** Sortie des scripts mesurés : l'extension n'a pas de terminal à leur prêter. */
let measureOutput: vscode.OutputChannel | undefined;

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

  // Commande : mesurer le fichier actif à l'exécution (exécute son code)
  context.subscriptions.push(
    vscode.commands.registerCommand('greencoding.measure', () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || !isSupported(doc.languageId)) {
        vscode.window.showWarningMessage(
          'Plugin Eco : ouvrez un fichier JavaScript, TypeScript, Python, PHP ou Java à mesurer.'
        );
        return;
      }
      measureFile(doc.uri.fsPath, context);
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
  measurePanel?.dispose();
  measureOutput?.dispose();
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

  // Fichier généré ou bundlé : l'analyser gèlerait l'éditeur (voir MAX_EDITOR_FILE_BYTES).
  if (document.getText().length > MAX_EDITOR_FILE_BYTES) {
    diagnosticCollection.delete(document.uri);
    statusBarItem.text = '⚡ Éco: fichier trop volumineux';
    statusBarItem.tooltip = tooLargeMessage().join('\n');
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();

    // Le panneau suit le fichier actif : il ne doit pas garder le rapport du précédent.
    lastFileName = document.fileName;
    lastTooLarge = true;
    if (panel && panelMode === 'file') {
      panel.title = '⚡ Rapport Éco';
      panel.webview.html = fileReportHtml();
    }
    return;
  }

  try {
    const tree = parse(document.getText(), document.languageId);
    const { context, clientSignals, serverSignals } = inferContext(tree.rootNode, spec);
    const findings = filterDisabled(collectFindings(tree.rootNode, spec, context), disabledRules());
    const score = computeScore(findings);

    // Un arbre incomplet donne une analyse incomplète : sans ce signal, un
    // fichier illisible sortirait en A 100/100, ce qui est pire qu'aucun
    // résultat. Fréquent pendant la frappe, d'où un simple avertissement
    // plutôt qu'un blocage.
    const partial = tree.rootNode.hasError;

    lastFindings = findings;
    lastScore = score;
    lastFileName = document.fileName;
    lastPartial = partial;
    lastTooLarge = false;

    // Diagnostics inline
    diagnosticCollection.set(document.uri, findings.map(f => {
      const range = new vscode.Range(f.startLine, f.startChar, f.endLine, f.endChar);
      const severity = f.severity === 'high'
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Information;
      const diag = new vscode.Diagnostic(range, `⚡ ${f.message}`, severity);
      diag.source = 'Plugin Eco';
      diag.code = f.ruleId;
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
      panel.webview.html = fileReportHtml();
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
      panel.webview.html = fileReportHtml();
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

  panel.webview.html = fileReportHtml();

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
    // Bouton « Mesurer » du rapport fichier : mesure le fichier affiché.
    if (message.command === 'measure' && panelMode === 'file' && lastFileName) {
      measureFile(lastFileName, context);
    }
  }, null, context.subscriptions);

  panel.onDidDispose(() => {
    panel = undefined;
    panelMode = 'file';
  }, null, context.subscriptions);
}

// ---------------------------------------------------------------------------
// Mesure à l'exécution
// ---------------------------------------------------------------------------

/**
 * Exécute le fichier sous la sonde et affiche la mesure dans son propre panneau.
 * Uniquement sur action explicite (commande ou bouton), jamais à la sauvegarde.
 */
async function measureFile(fsPath: string, context: vscode.ExtensionContext): Promise<void> {
  // La mesure exécute le fichier sur disque : des modifications non
  // enregistrées ne seraient pas mesurées, sans que rien ne le signale.
  const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === fsPath);
  if (doc && (doc.isUntitled || doc.isDirty)) {
    vscode.window.showWarningMessage('Plugin Eco : enregistrez le fichier avant de le mesurer.');
    return;
  }

  const fileName = path.basename(fsPath);
  // Racine du workspace, comme quand on lance le script depuis le projet ;
  // à défaut, le dossier du fichier.
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
  const cwd = folder ? folder.uri.fsPath : path.dirname(fsPath);

  measureOutput ??= vscode.window.createOutputChannel('Plugin Eco — Mesure');
  const output = measureOutput;
  output.show(true);
  output.appendLine(`▶ ${fsPath}`);

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `⚡ Plugin Eco — Mesure de ${fileName}`,
    cancellable: true,
  }, async (_progress, token) => {
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());

    try {
      const result = await runMeasured(fsPath, {
        cwd, signal: controller.signal, onOutput: chunk => output.append(chunk),
      });
      output.appendLine(`■ code de sortie ${result.exitCode ?? '?'}`);
      showMeasurePanel(fileName, buildMeasureHtml(fsPath, result, estimate(result.raw, defaultCoefficients()), getNonce()), context);
    } catch (err) {
      const message = (err as Error).message;
      output.appendLine(`■ ${message}`);
      if (controller.signal.aborted) {
        vscode.window.showInformationMessage('Plugin Eco : mesure annulée.');
      } else {
        vscode.window.showErrorMessage(`Plugin Eco : échec de la mesure — ${message}`);
      }
    }
  });
}

function showMeasurePanel(fileName: string, html: string, context: vscode.ExtensionContext): void {
  if (!measurePanel) {
    measurePanel = vscode.window.createWebviewPanel(
      'greencoding.measure', '⚡ Mesure', vscode.ViewColumn.Beside, { enableScripts: false }
    );
    measurePanel.onDidDispose(() => { measurePanel = undefined; }, null, context.subscriptions);
  } else {
    measurePanel.reveal(vscode.ViewColumn.Beside);
  }
  measurePanel.title = `⚡ Mesure — ${fileName}`;
  measurePanel.webview.html = html;
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

/** Rapport du dernier fichier actif : analysé, ou signalé trop volumineux. */
function fileReportHtml(): string {
  return lastTooLarge
    ? buildTooLargeHtml(lastFileName, getNonce())
    : buildWebviewHtml(lastFindings, lastScore, lastFileName, getNonce(), lastPartial);
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length))
  ).join('');
}
