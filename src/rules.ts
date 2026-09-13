import Parser from 'web-tree-sitter';
import { ExecutionContext, Finding, RuleId } from './types';
import { LanguageSpec, NodeNames, ruleAppliesIn } from './languages';

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

/**
 * Couples (objet, méthode) qui compilent une regex — coûteux si répété en boucle.
 * `Pattern.compile` en Java, `re.compile` en Python.
 */
const REGEX_COMPILE_CALLS: Record<string, string> = { Pattern: 'compile', re: 'compile' };

/** En dessous, un timer permanent maintient le processeur éveillé en continu. */
const FREQUENT_INTERVAL_MS = 1000;

/** Un gestionnaire passé par `debounce()` ou `throttle()` est déjà maîtrisé. */
const THROTTLE_PATTERN = /debounce|throttle|raf|requestAnimationFrame/i;

/**
 * Une vraie requête, pas une chaîne qui contient les mots.
 *
 * Deux faux positifs successifs ont façonné ces critères :
 *  - `includes('SELECT')` classait `"selection"` et `"onSelect"` comme des
 *    requêtes — 34 alertes sur le seul compilateur TypeScript ;
 *  - exiger seulement `SELECT` puis `FROM` en délimiteurs de mot ne suffisait
 *    pas non plus : un bloc CSS-in-JS contenant `input, select, textarea {…}`
 *    et `@keyframes spin { from {…} }` déclenchait la règle.
 *
 * Une requête *commence* par `SELECT`, éventuellement précédé d'un `WITH`, et
 * contient les deux mots-clés.
 *
 * **Trois motifs sans quantificateur imbriqué plutôt qu'un seul.** La version
 * combinée `/^\s*(WITH\b[\s\S]*?)?SELECT\b[\s\S]*\bFROM\b/` était quadratique :
 * sur une chaîne commençant par `WITH` et enchaînant des `SELECT` sans jamais
 * de `FROM`, le temps quadruplait à chaque doublement de taille — 63 ms pour
 * 36 Ko, plusieurs secondes pour quelques centaines de Ko. Un littéral forgé
 * suffisait à faire traîner une analyse, ce qui compte quand la CI examine le
 * code d'une contribution extérieure. Chacun de ces trois motifs est linéaire.
 */
const SQL_STARTS = /^\s*(SELECT|WITH)\b/;
const HAS_SELECT = /\bSELECT\b/;
const HAS_FROM = /\bFROM\b/;

function looksLikeQuery(upper: string): boolean {
  return SQL_STARTS.test(upper) && HAS_SELECT.test(upper) && HAS_FROM.test(upper);
}

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

/**
 * Retire les findings dont la règle est désactivée.
 *
 * Point de passage unique pour l'extension, le scan workspace et le CLI :
 * filtrer chacun à sa façon aurait pu faire diverger le verdict entre l'IDE et
 * la pipeline, ce que le CLI existe justement pour empêcher.
 */
export function filterDisabled(findings: Finding[], disabledRules: readonly RuleId[]): Finding[] {
  return disabledRules.length === 0
    ? findings
    : findings.filter(f => !disabledRules.includes(f.ruleId));
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
      ruleId: 'nested-loops',
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
        ruleId: 'string-concat-in-loop',
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
      ruleId: 'object-creation-in-loop',
    });
  }

  // ── Règles 4 et 5 : appels de méthodes détectables en boucle ─────────────
  // `calleeParts` lit la structure d'appel de chaque grammaire : `object`/
  // `name` directs sur `method_invocation` en Java, `function` en attribut
  // (`member_expression`/`attribute`) sur `call_expression`/`call` en JS/Python.
  if (nextInLoop && ctx.nodes.call.includes(node.type)) {
    const { object: objectName, name: methodName } = calleeParts(node);

    // Règle 4 : compilation de regex en boucle (Pattern.compile, re.compile)
    if (ctx.active('regex-compile-in-loop') && REGEX_COMPILE_CALLS[objectName] === methodName) {
      findings.push({
        startLine: node.startPosition.row,
        startChar: node.startPosition.column,
        endLine: node.endPosition.row,
        endChar: node.endPosition.column,
        message:
          `${objectName}.${methodName}() appelé en boucle — compiler la regex ` +
          'une seule fois en dehors de la boucle.',
        severity: 'high',
        weight: 12,
        ruleId: 'regex-compile-in-loop',
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
        ruleId: 'blocking-io-in-loop',
      });
    }
  }

  // ── Règle 6 : requête SQL sans pagination (partout, pas seulement en boucle) ──
  if (ctx.active('sql-without-limit') && ctx.nodes.stringLiteral.includes(node.type)) {
    // Sans retirer les guillemets, l'ancrage en tête ne peut pas s'appliquer.
    const upper = unquote(node.text).toUpperCase();
    if (looksLikeQuery(upper) && !upper.includes('LIMIT') && !upper.includes('ROWNUM')) {
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
        ruleId: 'sql-without-limit',
      });
    }
  }

  // ── Attente enchaînée dans une boucle (JS/TS et Python) ──────────────────
  // Repose sur `ctx.nodes.await`, vide en Java (pas d'async/await).
  if (ctx.active('await-in-loop') && scope.inLoopHere && ctx.nodes.await.includes(node.type)) {
    findings.push({
      ...span(node),
      message:
        'Attente (`await`) dans une boucle — les appels s\'enchaînent au lieu de ' +
        'se recouvrir. Collecter les tâches et les attendre ensemble ' +
        '(`Promise.all` en JS, `asyncio.gather` en Python), sauf si l\'ordre est ' +
        'réellement nécessaire.',
      severity: 'high',
      weight: 12,
      ruleId: 'await-in-loop',
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
        ruleId: 'sync-io-in-function',
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
        ruleId: 'polling-interval',
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
          ruleId: 'unthrottled-event-listener',
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
      ruleId: 'regex-compile-in-loop',
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
          ruleId: 'unthrottled-event-listener',
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
    ruleId: 'whole-library-import',
  };
}

/**
 * Objet et méthode d'un appel, quelle que soit la forme du nœud d'appel.
 *
 * Java (`method_invocation`) porte `object` et `name` directement. JS
 * (`call_expression`) et Python (`call`) portent un champ `function` qui,
 * pour un appel de méthode, est lui-même un `member_expression` (objet +
 * `property`) ou un `attribute` (objet + `attribute`).
 */
function calleeParts(node: Parser.SyntaxNode): { object: string; name: string } {
  const directName = node.childForFieldName('name');
  if (directName) {
    return { object: node.childForFieldName('object')?.text ?? '', name: directName.text };
  }
  const callee = node.childForFieldName('function');
  if (callee?.type === 'member_expression') {
    return {
      object: callee.childForFieldName('object')?.text ?? '',
      name: callee.childForFieldName('property')?.text ?? '',
    };
  }
  if (callee?.type === 'attribute') {
    return {
      object: callee.childForFieldName('object')?.text ?? '',
      name: callee.childForFieldName('attribute')?.text ?? '',
    };
  }
  return { object: '', name: callee?.text ?? '' };
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

/**
 * Retire les délimiteurs d'un littéral de chaîne, préfixe compris — Python
 * autorise jusqu'à deux lettres (`f"..."`, `rb"..."`) et des guillemets triples
 * (`"""..."""`), absents des autres grammaires supportées.
 */
function unquote(text: string): string {
  return text
    .replace(/^[a-zA-Z]{0,2}['"`]{1,3}/, '')
    .replace(/['"`]{1,3}$/, '');
}
