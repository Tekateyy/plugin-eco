import Parser from 'web-tree-sitter';
import { Finding } from './types';

/** Types de nœuds tree-sitter représentant une boucle en Java. */
const LOOP_TYPES = new Set([
  'for_statement',
  'enhanced_for_statement',
  'while_statement',
  'do_statement',
]);

/** Méthodes d'I/O bloquantes à détecter lorsqu'elles sont appelées en boucle. */
const IO_METHOD_NAMES = new Set([
  'readLine', 'readAllBytes', 'readString', 'readAllLines',
  'readNBytes', 'readFully', 'read', 'nextLine',
]);

/**
 * Parcourt l'AST tree-sitter Java et collecte tous les findings énergivores.
 *
 * Règles implémentées :
 *  1. Boucle imbriquée                     (haute,   poids 15)
 *  2. Concaténation String `+=` en boucle  (moyenne, poids  7)
 *  3. Création d'objet `new X()` en boucle (moyenne, poids  7)
 *  4. Pattern.compile() en boucle          (haute,   poids 12)
 *  5. I/O bloquant en boucle               (haute,   poids 12)
 *  6. Requête SQL sans LIMIT               (haute,   poids 12)
 */
export function collectFindings(root: Parser.SyntaxNode): Finding[] {
  const findings: Finding[] = [];
  traverse(root, 0, false, findings);
  return findings;
}

// ---------------------------------------------------------------------------
// Traversée récursive
// ---------------------------------------------------------------------------

function traverse(
  node: Parser.SyntaxNode,
  loopDepth: number,
  inLoop: boolean,
  findings: Finding[]
): void {
  const isLoop = LOOP_TYPES.has(node.type);
  const nextDepth = isLoop ? loopDepth + 1 : loopDepth;
  const nextInLoop = inLoop || isLoop;

  // ── Règle 1 : boucle imbriquée ───────────────────────────────────────────
  if (isLoop && loopDepth >= 1) {
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
  if (nextInLoop && node.type === 'assignment_expression') {
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
  if (nextInLoop && node.type === 'object_creation_expression') {
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
  if (nextInLoop && node.type === 'method_invocation') {
    const methodName = node.childForFieldName('name')?.text ?? '';
    const objectName = node.childForFieldName('object')?.text ?? '';

    // Règle 4 : Pattern.compile() en boucle
    if (objectName === 'Pattern' && methodName === 'compile') {
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
    if (IO_METHOD_NAMES.has(methodName)) {
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
  if (node.type === 'string_literal') {
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
    traverse(child, nextDepth, nextInLoop, findings);
  }
}
