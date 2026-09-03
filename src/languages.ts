import { ExecutionContext } from './types';

/**
 * Descripteurs de langage.
 *
 * Tout ce qui varie d'un langage à l'autre est décrit ici : la grammaire à
 * charger, les noms de nœuds tree-sitter, et les règles applicables. Les autres
 * modules ne connaissent que ce descripteur — ils n'ont plus de `if (java)`.
 */

/** Identifiant d'une règle de détection. */
export type RuleId =
  | 'nested-loops'
  | 'string-concat-in-loop'
  | 'object-creation-in-loop'
  | 'regex-compile-in-loop'
  | 'blocking-io-in-loop'
  | 'sql-without-limit';

/**
 * Noms des nœuds tree-sitter, qui diffèrent d'une grammaire à l'autre.
 * Exemple : une instanciation est `object_creation_expression` en Java,
 * `new_expression` en JS.
 */
export interface NodeNames {
  loops: string[];
  objectCreation: string[];
  call: string[];
  stringLiteral: string[];
  /** Nœud portant `+=` — un opérateur composé a son propre type de nœud en JS. */
  compoundAssignment: string[];
}

export interface LanguageSpec {
  /** Nom lisible, pour les messages. */
  label: string;
  /** Fichier WASM dans out/wasm/. */
  grammarFile: string;
  /** `languageId` VSCode couverts par ce descripteur. */
  vscodeLanguageIds: string[];
  /** Motif de recherche pour le scan workspace. */
  glob: string;
  nodes: NodeNames;
  /** Règles applicables. Une règle absente n'est jamais évaluée. */
  rules: RuleId[];
  /**
   * Contexte d'exécution connu d'avance, qui dispense de l'inférence.
   * Java n'a pas de moitié navigateur : c'est du serveur par construction.
   * Absent pour JS/TS, où le contexte se déduit du code.
   */
  fixedContext?: ExecutionContext;
}

// --- Noms de nœuds --------------------------------------------------------

const JAVA_NODES: NodeNames = {
  loops: ['for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement'],
  objectCreation: ['object_creation_expression'],
  call: ['method_invocation'],
  stringLiteral: ['string_literal'],
  compoundAssignment: ['assignment_expression'],
};

// Les grammaires typescript et tsx étendent toutes deux javascript :
// les noms de nœuds sont identiques pour les trois.
const JS_NODES: NodeNames = {
  loops: ['for_statement', 'for_in_statement', 'while_statement', 'do_statement'],
  objectCreation: ['new_expression'],
  call: ['call_expression'],
  stringLiteral: ['string', 'template_string'],
  compoundAssignment: ['augmented_assignment_expression'],
};

// --- Règles ---------------------------------------------------------------

const JAVA_RULES: RuleId[] = [
  'nested-loops',
  'string-concat-in-loop',
  'object-creation-in-loop',
  'regex-compile-in-loop',
  'blocking-io-in-loop',
  'sql-without-limit',
];

/**
 * JS/TS n'hérite que des règles réellement pertinentes.
 *
 * `string-concat-in-loop` et `object-creation-in-loop` sont volontairement
 * absentes : V8 représente les concaténations par des ropes et son GC
 * générationnel rend l'allocation à courte durée de vie bon marché. Les porter
 * produirait du bruit sur du code sain. Les règles propres au web
 * (await en boucle, I/O synchrones, polling, imports massifs) viendront ensuite.
 */
const JS_RULES: RuleId[] = ['nested-loops', 'sql-without-limit'];

// --- Descripteurs ---------------------------------------------------------

export const LANGUAGES: LanguageSpec[] = [
  {
    label: 'Java',
    grammarFile: 'tree-sitter-java.wasm',
    vscodeLanguageIds: ['java'],
    glob: '**/*.java',
    nodes: JAVA_NODES,
    rules: JAVA_RULES,
    fixedContext: 'server',
  },
  {
    // tsx couvre .js et .jsx : c'est un sur-ensemble de la grammaire javascript,
    // qui devient inutile à embarquer.
    label: 'JavaScript',
    grammarFile: 'tree-sitter-tsx.wasm',
    vscodeLanguageIds: ['javascript', 'javascriptreact'],
    glob: '**/*.{js,jsx,mjs,cjs}',
    nodes: JS_NODES,
    rules: JS_RULES,
  },
  {
    // .ts exige la grammaire typescript : tsx lit `<T>valeur` comme une
    // ouverture JSX et perd le reste du fichier (mesuré le 3 sept. 2026).
    label: 'TypeScript',
    grammarFile: 'tree-sitter-typescript.wasm',
    vscodeLanguageIds: ['typescript'],
    glob: '**/*.ts',
    nodes: JS_NODES,
    rules: JS_RULES,
  },
  {
    label: 'TypeScript React',
    grammarFile: 'tree-sitter-tsx.wasm',
    vscodeLanguageIds: ['typescriptreact'],
    glob: '**/*.tsx',
    nodes: JS_NODES,
    rules: JS_RULES,
  },
];

/** Descripteur correspondant à un `languageId` VSCode, ou undefined. */
export function specFor(languageId: string): LanguageSpec | undefined {
  return LANGUAGES.find(l => l.vscodeLanguageIds.includes(languageId));
}

/** Le langage est-il analysable ? */
export function isSupported(languageId: string): boolean {
  return specFor(languageId) !== undefined;
}

/** Fichiers WASM à charger, sans doublon (tsx sert deux descripteurs). */
export function grammarFiles(): string[] {
  return [...new Set(LANGUAGES.map(l => l.grammarFile))];
}
