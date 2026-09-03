import Parser from 'web-tree-sitter';
import { Finding } from './types';
import { LanguageSpec, NodeNames, RuleId } from './languages';

/** Méthodes d'I/O bloquantes à détecter lorsqu'elles sont appelées en boucle. */
const IO_METHOD_NAMES = new Set([
  'readLine', 'readAllBytes', 'readString', 'readAllLines',
  'readNBytes', 'readFully', 'read', 'nextLine',
]);

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
export function collectFindings(root: Parser.SyntaxNode, spec: LanguageSpec): Finding[] {
  const findings: Finding[] = [];
  const ctx = {
    nodes: spec.nodes,
    active: (rule: RuleId) => spec.rules.includes(rule),
  };
  traverse(root, 0, false, findings, ctx);
  return findings;
}

interface Ctx {
  nodes: NodeNames;
  active: (rule: RuleId) => boolean;
}

// ---------------------------------------------------------------------------
// Traversée récursive
// ---------------------------------------------------------------------------

function traverse(
  node: Parser.SyntaxNode,
  loopDepth: number,
  inLoop: boolean,
  findings: Finding[],
  ctx: Ctx
): void {
  const isLoop = ctx.nodes.loops.includes(node.type);
  const nextDepth = isLoop ? loopDepth + 1 : loopDepth;
  const nextInLoop = inLoop || isLoop;

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
    if (upper.includes('SELECT') && !upper.includes('LIMIT') && !upper.includes('ROWNUM')) {
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

  // Récursion sur les enfants nommés
  for (const child of node.namedChildren) {
    traverse(child, nextDepth, nextInLoop, findings, ctx);
  }
}
