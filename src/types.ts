/** Sévérité d'un pattern énergivore détecté. */
export type Severity = 'high' | 'medium' | 'low';

/**
 * Identifiant d'une règle de détection.
 *
 * Défini ici plutôt que dans `languages.ts` pour que `Finding` puisse le
 * porter sans créer de cycle d'import (`languages.ts` importe déjà
 * `ExecutionContext` depuis ce module).
 */
export type RuleId =
  | 'nested-loops'
  | 'string-concat-in-loop'
  | 'object-creation-in-loop'
  | 'regex-compile-in-loop'
  | 'blocking-io-in-loop'
  | 'sql-without-limit'
  | 'await-in-loop'
  | 'sync-io-in-function'
  | 'polling-interval'
  | 'unthrottled-event-listener'
  | 'whole-library-import';

/**
 * Où s'exécute le code analysé.
 *
 * L'enjeu énergétique n'est pas le même : un `setInterval` de polling coûte une
 * fois sur un serveur, et autant de fois qu'il y a d'utilisateurs sur le client.
 * `unknown` est un état légitime, pas un échec — en rendu côté serveur, un même
 * fichier tourne réellement des deux côtés.
 */
export type ExecutionContext = 'client' | 'server' | 'unknown';

/** Un pattern énergivore détecté dans le code, avec sa position et son poids de pénalité. */
export interface Finding {
  startLine: number;  // 0-indexed (row dans tree-sitter)
  startChar: number;  // 0-indexed (column)
  endLine: number;
  endChar: number;
  message: string;
  severity: Severity;
  weight: number;     // pénalité sur le score de 0 à 100
  /** Règle à l'origine du finding — permet de la désactiver individuellement. */
  ruleId: RuleId;
}

/** Score énergétique agrégé pour un fichier. */
export interface Score {
  letter: 'A' | 'B' | 'C' | 'D' | 'E';
  value: number;   // 0–100
  findingCount: { high: number; medium: number; low: number };
}

/** Résultat d'analyse d'un fichier Java unique (utilisé dans le rapport workspace). */
export interface FileResult {
  uri: string;        // URI VSCode sérialisé (pour le message passing WebView)
  fileName: string;   // Chemin relatif au workspace (pour l'affichage)
  score: Score;
  findings: Finding[];
}

/** Rapport global d'un scan workspace. */
export interface WorkspaceReport {
  files: FileResult[];
  /** Moyenne des seuls fichiers présentant au moins une alerte. */
  global: Score;
  /** Étendue : combien de fichiers sont concernés, sur combien d'analysés. */
  filesWithFindings: number;
  scannedAt: string;  // Date/heure lisible
}
