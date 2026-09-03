/**
 * Point d'entrée bibliothèque du paquet npm.
 *
 * Ce fichier expose le moteur d'analyse — parseur, règles, contexte, score —
 * et **rien de l'intégration VSCode** : ni `extension.ts`, ni `webview.ts`, ni
 * `workspace.ts`, qui importent `vscode` et ne se chargent pas hors éditeur.
 * C'est la même frontière que celle tenue par `cli.ts`.
 *
 * Le manifeste garde `main` vers `out/extension.js` pour VSCode, qui charge ce
 * chemin en absolu et ignore `exports` ; `require('plugin-eco')` passe ici.
 *
 * ```js
 * const { initParser, parse, collectFindings, computeScore } = require('plugin-eco');
 *
 * await initParser();
 * const tree = parse(source, 'java');
 * const findings = collectFindings(tree.rootNode, specFor('java'));
 * console.log(computeScore(findings).letter); // 'A' … 'E'
 * ```
 */

export { initParser, parse, parseWith } from './parser';
export { collectFindings } from './rules';
export { letterFor, computeScore, aggregateScore, scoreSummary } from './scoring';
export { inferContext } from './context';
export type { ContextResult } from './context';
export {
  LANGUAGES,
  RULE_CONTEXTS,
  ruleAppliesIn,
  specFor,
  specForPath,
  isSupported,
} from './languages';
export type { LanguageSpec, RuleId } from './languages';
export type {
  ExecutionContext,
  Finding,
  FileResult,
  Score,
  Severity,
  WorkspaceReport,
} from './types';
