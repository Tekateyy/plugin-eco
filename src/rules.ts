import Parser from 'web-tree-sitter';
import { ExecutionContext, Finding, RuleId } from './types';
import { LanguageSpec, NodeNames, QueryCalls, ruleAppliesIn } from './languages';

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
const SELECT_WORD = /\bSELECT\b/g;
const HAS_FROM = /\bFROM\b/;

/**
 * Une liste de colonnes plausible : `*`, plusieurs colonnes, un appel ou une
 * colonne qualifiée — ou un seul mot (`SELECT id FROM`), éventuellement après
 * `DISTINCT`/`ALL`. Deux mots nus à la suite sans virgule, comme dans
 * « Select a file from the list », sont de la prose.
 */
const COLUMN_LIST = /[*,(.]|^\s*(?:(?:DISTINCT|ALL)\s+)?\S+\s*$/;

/**
 * Un déterminant juste après `FROM` signe une phrase (« Select one from the
 * list »), jamais un nom de table. `A` est volontairement absent : c'est un alias
 * de table courant (`FROM a`), et « Select one from a list » reste un faux positif.
 */
const PROSE_AFTER_FROM = /^\s*(?:THE|AN|THIS|THAT|THESE|THOSE|YOUR|MY|OUR|THEIR|ITS)\b/;

function looksLikeQuery(upper: string): boolean {
  if (!SQL_STARTS.test(upper)) return false;
  const from = HAS_FROM.exec(upper);
  if (!from) return false;

  // Dernier SELECT avant le premier FROM : le cas `WITH x AS (SELECT …) SELECT … FROM`
  // met un SELECT de sous-requête avant celui qui porte le FROM.
  const head = upper.slice(0, from.index);
  let lastSelectEnd = -1;
  SELECT_WORD.lastIndex = 0;
  for (let m = SELECT_WORD.exec(head); m; m = SELECT_WORD.exec(head)) {
    lastSelectEnd = m.index + m[0].length;
  }
  if (lastSelectEnd < 0) return false;

  if (PROSE_AFTER_FROM.test(upper.slice(from.index + from[0].length))) return false;

  return COLUMN_LIST.test(head.slice(lastSelectEnd));
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
 *  7. query-in-loop            Requête SQL par tour (N+1)     (haute,   poids 12)
 */
export function collectFindings(
  root: Parser.SyntaxNode,
  spec: LanguageSpec,
  context: ExecutionContext = 'unknown'
): Finding[] {
  const findings: Finding[] = [];
  const ctx: Ctx = {
    nodes: spec.nodes,
    queryCalls: spec.queryCalls,
    active: (rule: RuleId) => spec.rules.includes(rule) && ruleAppliesIn(rule, context),
  };
  traverse(root, {
    loopDepth: 0, inLoop: false, inLoopHere: false, inFunction: false, repeatsHere: false,
    loopVars: [],
  }, findings, ctx);
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
  queryCalls: QueryCalls;
  active: (rule: RuleId) => boolean;
}

interface Scope {
  loopDepth: number;
  /** Dans une boucle, même à travers une frontière de fonction. */
  inLoop: boolean;
  /** Dans une boucle **de la fonction courante** : une callback n'en est pas. */
  inLoopHere: boolean;
  inFunction: boolean;
  /**
   * Évalué à chaque tour d'une boucle de la fonction courante. Plus strict que
   * `inLoopHere` : la collection parcourue (`for row in cur.execute(q)`) et
   * l'initialisation d'une boucle ne s'évaluent qu'une fois. Lu par `query-in-loop`,
   * pour qui cet en-tête est justement la bonne façon de faire.
   */
  repeatsHere: boolean;
  /** Variables liées par les boucles et compréhensions de la fonction courante. */
  loopVars: string[];
}

/** Parties d'une boucle réévaluées à chaque tour, mêmes noms de champ dans les quatre grammaires. */
const REPEATED_LOOP_FIELDS = ['body', 'condition', 'update', 'increment'];

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
    repeatsHere: isFunction ? false : scope.repeatsHere,
    loopVars: isFunction
      ? []
      : (isLoop || ctx.nodes.comprehensions.includes(node.type))
        ? [...scope.loopVars, ...loopVariables(node)]
        : scope.loopVars,
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
  // ── Règle 7 : requête SQL à chaque tour de boucle (N+1) ───────────────────
  if (ctx.active('query-in-loop') && scope.repeatsHere && ctx.nodes.call.includes(node.type) &&
      isQueryCall(node, ctx) && !firstArgIsLoopVariable(node, scope.loopVars)) {
    findings.push({
      ...span(node),
      message:
        `Requête \`${calleeParts(node).name}()\` à chaque tour de boucle — une requête par ` +
        'élément (N+1). Charger les données en une seule requête avant la boucle (IN, JOIN) ' +
        'ou exécuter par lot.',
      severity: 'high',
      weight: 12,
      ruleId: 'query-in-loop',
    });
  }

  const repeated = isLoop
    ? new Set(REPEATED_LOOP_FIELDS.map(f => node.childForFieldName(f)?.id))
    : null;
  const isComprehension = ctx.nodes.comprehensions.includes(node.type);
  let forClauses = 0;

  for (const child of node.namedChildren) {
    let repeatsHere = next.repeatsHere;
    if (repeated) {
      repeatsHere = scope.repeatsHere || repeated.has(child.id);
    } else if (isComprehension) {
      // Le corps et les filtres sont répétés ; la collection du premier `for`
      // est évaluée une fois, celle des `for` suivants à chaque tour du précédent.
      repeatsHere = child.type === 'for_in_clause'
        ? scope.repeatsHere || forClauses++ > 0
        : true;
    }
    traverse(child, { ...next, repeatsHere }, findings, ctx);
  }
}

/**
 * Variables qu'une boucle ou une compréhension lie à chaque tour.
 *
 * Les quatre grammaires ne les rangent pas pareil : `left` en Python et JS (un
 * identifiant ou un motif de déstructuration), `name` en Java (`for (T x : xs)`),
 * et en PHP aucun champ — les variables sont les enfants du `foreach` qui suivent
 * la collection, avant le corps. Les boucles à compteur (`for (int i = 0; …)`) et
 * `while` ne lient rien de ce genre.
 */
function loopVariables(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];
  const collect = (n: Parser.SyntaxNode | null) => {
    if (!n) return;
    if (n.type === 'identifier' || n.type === 'variable_name' ||
        n.type === 'shorthand_property_identifier_pattern') names.push(n.text);
    else for (const child of n.namedChildren) collect(child);
  };

  if (node.type === 'foreach_statement') {
    const body = node.childForFieldName('body');
    node.namedChildren.slice(1).filter(ch => !body || ch.id !== body.id).forEach(collect);
  } else if (node.type === 'enhanced_for_statement') {
    collect(node.childForFieldName('name'));
  } else if (node.type.endsWith('comprehension') || node.type === 'generator_expression') {
    node.namedChildren.filter(ch => ch.type === 'for_in_clause')
      .forEach(ch => collect(ch.childForFieldName('left')));
  } else {
    collect(node.childForFieldName('left'));
  }
  return names;
}

/**
 * Le premier argument est-il la variable de boucle, ou un de ses éléments ?
 *
 * `for sql in statements: cursor.execute(sql)` exécute des textes SQL
 * différents : ce n'est pas un N+1, qui répète la même requête avec des
 * paramètres qui changent. Vaut aussi pour `q["sql"]`, `$q->sql`, `q.sql`.
 */
function firstArgIsLoopVariable(node: Parser.SyntaxNode, loopVars: string[]): boolean {
  let arg: Parser.SyntaxNode | null | undefined = node.childForFieldName('arguments')?.namedChildren[0];
  // PHP enveloppe chaque argument dans un nœud `argument`.
  if (arg?.type === 'argument') arg = arg.namedChildren[0];

  // Remonte jusqu'à la racine : `row["sql"]`, `row.sql`, `$row->sql` → `row`.
  for (let depth = 0; arg && depth < 10; depth++) {
    // PHP n'a pas de champ pour l'objet d'un `$q['sql']` : c'est le premier enfant.
    const inner: Parser.SyntaxNode | null =
      arg.childForFieldName('object') ?? arg.childForFieldName('value') ??
      (arg.type.includes('subscript') ? arg.namedChildren[0] : null);
    if (!inner) break;
    arg = inner;
  }
  return !!arg && loopVars.includes(arg.text);
}

/** L'appel fait-il un aller-retour vers une base de données ? */
function isQueryCall(node: Parser.SyntaxNode, ctx: Ctx): boolean {
  const { name } = calleeParts(node);
  const object = calleeObject(node);
  const calls = ctx.queryCalls;

  if (object) {
    const words = receiverWords(lastSegment(object, ctx));
    return calls.methods.some(m => m.names.includes(name) && m.receivers.some(r => words.has(r)));
  }
  return calls.functions.includes(name);
}

/** Objet appelant d'un appel de méthode, ou null pour une fonction libre. */
function calleeObject(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.childForFieldName('name')) return node.childForFieldName('object');
  const callee = node.childForFieldName('function');
  if (callee?.type === 'member_expression' || callee?.type === 'attribute') {
    return callee.childForFieldName('object');
  }
  return null;
}

/**
 * Nom qui désigne l'objet appelant : le dernier maillon d'une chaîne
 * (`self.db` → `db`, `$this->dbh` → `dbh`), ou la méthode qui l'a produit
 * (`conn.cursor()` → `cursor`).
 */
function lastSegment(object: Parser.SyntaxNode, ctx: Ctx): string {
  if (ctx.nodes.call.includes(object.type)) return calleeParts(object).name;
  for (const field of ['property', 'attribute', 'field', 'name']) {
    const segment = object.childForFieldName(field);
    if (segment) return segment.text;
  }
  return object.text;
}

/**
 * Mots d'un identifiant, plus l'identifiant entier : `order_cursor` → order,
 * cursor, ordercursor ; `httpClient` → http, client, httpclient. `$pdo` → pdo.
 */
function receiverWords(identifier: string): Set<string> {
  const clean = identifier.replace(/[^A-Za-z0-9_]/g, '');
  const words = clean
    .split(/_|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
  return new Set([...words, clean.replace(/_/g, '').toLowerCase()]);
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
 * (`"""..."""`), PHP des heredoc/nowdoc (`<<<SQL` … `SQL`), absents des
 * autres grammaires supportées.
 */
function unquote(text: string): string {
  return text
    .replace(/^<<<['"]?\w+['"]?\r?\n/, '')
    .replace(/\r?\n\s*\w+$/, '')
    .replace(/^[a-zA-Z]{0,2}['"`]{1,3}/, '')
    .replace(/['"`]{1,3}$/, '');
}
