import Parser from 'web-tree-sitter';
import { ExecutionContext, Finding } from './types';
import { LanguageSpec, NodeNames, RuleId, ruleAppliesIn } from './languages';

/** Méthodes d'I/O bloquantes à détecter lorsqu'elles sont appelées en boucle. */
const IO_METHOD_NAMES = new Set([
  'readLine', 'readAllBytes', 'readString', 'readAllLines',
  'readNBytes', 'readFully', 'read', 'nextLine',
]);

/** API synchrones de Node : elles bloquent la boucle d'événements. */
const SYNC_NODE_METHODS = new Set([
  'readFileSync', 'writeFileSync', 'appendFileSync', 'existsSync',
  'readdirSync', 'statSync', 'lstatSync', 'mkdirSync', 'rmSync',
  'unlinkSync', 'copyFileSync', 'readlinkSync', 'execSync', 'spawnSync',
  'execFileSync',
]);

/** Événements tirés en rafale pendant l'interaction. */
const HIGH_FREQUENCY_EVENTS = new Set([
  'scroll', 'resize', 'mousemove', 'wheel', 'touchmove', 'pointermove', 'drag',
]);

/** Leurs équivalents en attributs JSX. */
const HIGH_FREQUENCY_JSX_PROPS = new Set([
  'onScroll', 'onMouseMove', 'onWheel', 'onTouchMove', 'onPointerMove', 'onDrag',
]);

/**
 * Bibliothèques dont l'import par défaut embarque tout le paquet, là où un
 * import nommé ou un sous-chemin ne prendrait que le nécessaire.
 */
const HEAVY_MODULES = new Set([
  'lodash', 'underscore', 'moment', 'rxjs', 'jquery',
]);

/** En dessous, un timer permanent maintient le processeur éveillé en continu. */
const FREQUENT_INTERVAL_MS = 1000;

/** Un gestionnaire passé par `debounce()` ou `throttle()` est déjà maîtrisé. */
const THROTTLE_PATTERN = /debounce|throttle|raf|requestAnimationFrame/i;

/**
 * Une vraie requête, pas un mot qui contient « select ».
 *
 * Un simple `includes('SELECT')` classait `"selection"`, `"selected"` et
 * `"onSelect"` comme des requêtes SQL : 34 fausses alertes sur le seul
 * compilateur TypeScript. Les délimiteurs de mot et la présence de `FROM`
 * suppriment le bruit.
 */
const SELECT_FROM = /\bSELECT\b[\s\S]*\bFROM\b/;

/**
 * Parcourt l'AST et collecte les findings énergivores applicables au langage.
 *
 * Les règles évaluées, comme les noms de nœuds, viennent du descripteur : ce
 * module ne connaît aucun langage en particulier.
 *
 * Règles implémentées :
 *  1. nested-loops             Boucle imbriquée               (haute,   poids 15)
 *  2. string-concat-in-loop    Concaténation `+=` en boucle   (moyenne, poids  7)
 *  3. object-creation-in-loop  Instanciation en boucle        (moyenne, poids  7)
 *  4. regex-compile-in-loop    Pattern.compile() en boucle    (haute,   poids 12)
 *  5. blocking-io-in-loop      I/O bloquant en boucle         (haute,   poids 12)
 *  6. sql-without-limit        Requête SQL sans LIMIT         (haute,   poids 12)
 */
export function collectFindings(
  root: Parser.SyntaxNode,
  spec: LanguageSpec,
  context: ExecutionContext = 'unknown'
): Finding[] {
  const findings: Finding[] = [];
  const ctx: Ctx = {
    nodes: spec.nodes,
    active: (rule: RuleId) => spec.rules.includes(rule) && ruleAppliesIn(rule, context),
  };
  traverse(root, { loopDepth: 0, inLoop: false, inLoopHere: false, inFunction: false }, findings, ctx);
  return findings;
}

interface Ctx {
  nodes: NodeNames;
  active: (rule: RuleId) => boolean;
}

interface Scope {
  loopDepth: number;
  /** Dans une boucle, même à travers une frontière de fonction. */
  inLoop: boolean;
  /** Dans une boucle **de la fonction courante** : une callback n'en est pas. */
  inLoopHere: boolean;
  inFunction: boolean;
}

// ---------------------------------------------------------------------------
// Traversée récursive
// ---------------------------------------------------------------------------

function traverse(
  node: Parser.SyntaxNode,
  scope: Scope,
  findings: Finding[],
  ctx: Ctx
): void {
  const { loopDepth, inLoop } = scope;
  const isLoop = ctx.nodes.loops.includes(node.type);
  const isFunction = ctx.nodes.functions.includes(node.type);

  // Une fonction imbriquée dans une boucle s'exécute dans son propre flot :
  // `items.map(async x => await f(x))` lance des attentes concurrentes, pas
  // séquentielles. La profondeur de boucle « locale » repart donc à zéro.
  const next: Scope = {
    loopDepth: isLoop ? loopDepth + 1 : loopDepth,
    inLoop: inLoop || isLoop,
    inLoopHere: isFunction ? false : (scope.inLoopHere || isLoop),
    inFunction: scope.inFunction || isFunction,
  };
  const nextInLoop = next.inLoop;

  // ── Règle 1 : boucle imbriquée ───────────────────────────────────────────
  if (ctx.active('nested-loops') && isLoop && loopDepth >= 1) {
    findings.push({
      startLine: node.startPosition.row,
      startChar: node.startPosition.column,
      endLine: node.startPosition.row,
      endChar: 9999,
      message:
        'Boucle imbriquée — complexité ≥ O(n²), forte consommation énergétique. ' +
        'Envisager une restructuration algorithmique ou une mise en cache.',
      severity: 'high',
      weight: 15,
    });
  }

  // ── Règle 2 : concaténation String avec += en boucle ─────────────────────
  if (ctx.active('string-concat-in-loop') && nextInLoop &&
      ctx.nodes.compoundAssignment.includes(node.type)) {
    if (node.children.some(c => c.text === '+=')) {
      findings.push({
        startLine: node.startPosition.row,
        startChar: node.startPosition.column,
        endLine: node.endPosition.row,
        endChar: node.endPosition.column,
        message:
          'Concaténation potentielle via `+=` en boucle — ' +
          "préférer StringBuilder pour éviter la création d'objets String répétés.",
        severity: 'medium',
        weight: 7,
      });
    }
  }

  // ── Règle 3 : création d'objet en boucle ─────────────────────────────────
  if (ctx.active('object-creation-in-loop') && nextInLoop &&
      ctx.nodes.objectCreation.includes(node.type)) {
    findings.push({
      startLine: node.startPosition.row,
      startChar: node.startPosition.column,
      endLine: node.endPosition.row,
      endChar: node.endPosition.column,
      message:
        "Création d'objet (`new`) en boucle — envisager de déplacer l'instanciation " +
        'hors de la boucle ou de réutiliser l\'instance existante.',
      severity: 'medium',
      weight: 7,
    });
  }

  // ── Règles 4 et 5 : appels de méthodes détectables en boucle ─────────────
  // Ces deux règles lisent les champs `name` et `object`, propres à la
  // structure d'appel de Java. Elles ne sont pour l'instant déclarées que
  // pour ce langage ; l'équivalent JS/TS relève du jeu de règles web.
  if (nextInLoop && ctx.nodes.call.includes(node.type)) {
    const methodName = node.childForFieldName('name')?.text ?? '';
    const objectName = node.childForFieldName('object')?.text ?? '';

    // Règle 4 : Pattern.compile() en boucle
    if (ctx.active('regex-compile-in-loop') && objectName === 'Pattern' && methodName === 'compile') {
      findings.push({
        startLine: node.startPosition.row,
        startChar: node.startPosition.column,
        endLine: node.endPosition.row,
        endChar: node.endPosition.column,
        message:
          'Pattern.compile() appelé en boucle — compiler la regex une seule fois ' +
          'en dehors de la boucle (constante statique ou champ de classe).',
        severity: 'high',
        weight: 12,
      });
    }

    // Règle 5 : I/O bloquant en boucle
    if (ctx.active('blocking-io-in-loop') && IO_METHOD_NAMES.has(methodName)) {
      findings.push({
        startLine: node.startPosition.row,
        startChar: node.startPosition.column,
        endLine: node.endPosition.row,
        endChar: node.endPosition.column,
        message:
          `Appel I/O bloquant \`${methodName}()\` en boucle — ` +
          'charger les données hors de la boucle ou traiter en batch.',
        severity: 'high',
        weight: 12,
      });
    }
  }

  // ── Règle 6 : requête SQL sans pagination (partout, pas seulement en boucle) ──
  if (ctx.active('sql-without-limit') && ctx.nodes.stringLiteral.includes(node.type)) {
    const upper = node.text.toUpperCase();
    if (SELECT_FROM.test(upper) && !upper.includes('LIMIT') && !upper.includes('ROWNUM')) {
      findings.push({
        startLine: node.startPosition.row,
        startChar: node.startPosition.column,
        endLine: node.endPosition.row,
        endChar: node.endPosition.column,
        message:
          'Requête SQL sans clause LIMIT détectée — ajouter une pagination ' +
          'pour éviter de charger un volume non borné de données.',
        severity: 'high',
        weight: 12,
      });
    }
  }

  // ── Règles web ───────────────────────────────────────────────────────────
  // Les cinq suivantes sont propres à JS/TS : elles lisent des formes d'arbre
  // et des API qui n'existent que là, et ne sont déclarées que pour ces
  // langages. Même convention que les règles 4 et 5 pour Java.

  // Attente enchaînée dans une boucle
  if (ctx.active('await-in-loop') && scope.inLoopHere && node.type === 'await_expression') {
    findings.push({
      ...span(node),
      message:
        'Attente (`await`) dans une boucle — les appels s\'enchaînent au lieu de ' +
        'se recouvrir. Collecter les promesses et les attendre ensemble ' +
        '(`Promise.all`), sauf si l\'ordre est réellement nécessaire.',
      severity: 'high',
      weight: 12,
    });
  }

  if (ctx.nodes.call.includes(node.type)) {
    const callee = node.childForFieldName('function');
    const calleeName = callee?.type === 'member_expression'
      ? callee.childForFieldName('property')?.text ?? ''
      : callee?.text ?? '';
    const args = node.childForFieldName('arguments')?.namedChildren ?? [];

    // I/O synchrone dans une fonction : au démarrage c'est acceptable, dans
    // une fonction ça se répète et bloque la boucle d'événements.
    if (ctx.active('sync-io-in-function') && scope.inFunction && SYNC_NODE_METHODS.has(calleeName)) {
      findings.push({
        ...span(node),
        message:
          `Appel synchrone \`${calleeName}()\` dans une fonction — il bloque la ` +
          'boucle d\'événements et donc toutes les requêtes en cours. Préférer ' +
          'la variante asynchrone (`fs/promises`).',
        severity: 'high',
        weight: 12,
      });
    }

    // Polling : un timer permanent empêche l'appareil de se mettre au repos.
    if (ctx.active('polling-interval') && calleeName === 'setInterval') {
      const delay = numericValue(args[1]);
      const frequent = delay !== null && delay < FREQUENT_INTERVAL_MS;
      findings.push({
        ...span(node),
        message:
          `Timer périodique${delay !== null ? ` toutes les ${delay} ms` : ''} — ` +
          'il empêche le processeur de se mettre au repos, sur chaque appareil ' +
          'qui affiche la page. Préférer un événement, une requête à la demande ' +
          'ou un intervalle plus long.',
        severity: frequent ? 'high' : 'medium',
        weight: frequent ? 12 : 7,
      });
    }

    // Gestionnaire d'événement à haute fréquence sans limitation de débit
    if (ctx.active('unthrottled-event-listener') && calleeName === 'addEventListener') {
      const event = args[0] && isStringNode(args[0], ctx) ? unquote(args[0].text) : '';
      if (HIGH_FREQUENCY_EVENTS.has(event) && !isThrottled(args[1])) {
        findings.push({
          ...span(node),
          message:
            `Gestionnaire \`${event}\` sans limitation de débit — cet événement est ` +
            'tiré en rafale. Passer par `debounce()`, `throttle()` ou ' +
            '`requestAnimationFrame()`.',
          severity: 'medium',
          weight: 7,
        });
      }
    }

    // require() d'une bibliothèque entière
    if (ctx.active('whole-library-import') && calleeName === 'require') {
      const source = args[0] && isStringNode(args[0], ctx) ? unquote(args[0].text) : '';
      if (HEAVY_MODULES.has(source)) findings.push(heavyImportFinding(node, source));
    }
  }

  // Version JS de la règle 4 : `new RegExp(...)` recompile à chaque tour,
  // là où un littéral /.../ est compilé une seule fois.
  if (ctx.active('regex-compile-in-loop') && nextInLoop &&
      ctx.nodes.objectCreation.includes(node.type) &&
      node.childForFieldName('constructor')?.text === 'RegExp') {
    findings.push({
      ...span(node),
      message:
        '`new RegExp()` en boucle — la regex est recompilée à chaque tour. ' +
        'La construire une seule fois hors de la boucle, ou utiliser un ' +
        'littéral `/.../`.',
      severity: 'high',
      weight: 12,
    });
  }

  // Import par défaut ou global d'une bibliothèque lourde
  if (ctx.active('whole-library-import') && node.type === 'import_statement') {
    const source = unquote(node.childForFieldName('source')?.text ?? '');
    const clause = node.namedChildren.find(c => c.type === 'import_clause');
    const wholePackage = clause?.namedChildren.some(
      c => c.type === 'identifier' || c.type === 'namespace_import'
    );
    if (HEAVY_MODULES.has(source) && wholePackage) {
      findings.push(heavyImportFinding(node, source));
    }
  }

  // Gestionnaire JSX à haute fréquence — le cas courant en React
  if (ctx.active('unthrottled-event-listener') && node.type === 'jsx_attribute') {
    const name = node.namedChildren[0]?.text ?? '';
    if (HIGH_FREQUENCY_JSX_PROPS.has(name)) {
      const value = node.namedChildren[1];
      const expr = value?.type === 'jsx_expression' ? value.namedChildren[0] : value;
      if (!isThrottled(expr)) {
        findings.push({
          ...span(node),
          message:
            `Gestionnaire \`${name}\` sans limitation de débit — cet événement est ` +
            'tiré en rafale. Passer par `debounce()`, `throttle()` ou ' +
            '`requestAnimationFrame()`.',
          severity: 'medium',
          weight: 7,
        });
      }
    }
  }

  // Récursion sur les enfants nommés
  for (const child of node.namedChildren) {
    traverse(child, next, findings, ctx);
  }
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function span(node: Parser.SyntaxNode) {
  return {
    startLine: node.startPosition.row,
    startChar: node.startPosition.column,
    endLine: node.endPosition.row,
    endChar: node.endPosition.column,
  };
}

function heavyImportFinding(node: Parser.SyntaxNode, source: string): Finding {
  return {
    ...span(node),
    message:
      `Import global de \`${source}\` — tout le paquet part dans le bundle, donc ` +
      'sur le réseau vers chaque visiteur. Importer seulement ce qui sert ' +
      `(\`import { x } from '${source}/x'\`).`,
    severity: 'medium',
    weight: 7,
  };
}

function isStringNode(node: Parser.SyntaxNode, ctx: Ctx): boolean {
  return ctx.nodes.stringLiteral.includes(node.type);
}

/** Valeur d'un littéral numérique, ou null si l'argument n'en est pas un. */
function numericValue(node: Parser.SyntaxNode | undefined): number | null {
  if (!node || node.type !== 'number') return null;
  const value = Number(node.text);
  return Number.isFinite(value) ? value : null;
}

/** Le gestionnaire passe-t-il visiblement par un limiteur de débit ? */
function isThrottled(node: Parser.SyntaxNode | undefined): boolean {
  if (!node) return false;
  return THROTTLE_PATTERN.test(node.text);
}

function unquote(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}
