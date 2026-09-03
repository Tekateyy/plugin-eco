import { Finding, Score } from './types';

// Seuils de lettres (ordre décroissant — premier match gagne)
const THRESHOLDS: { min: number; letter: Score['letter'] }[] = [
  { min: 90, letter: 'A' },
  { min: 75, letter: 'B' },
  { min: 55, letter: 'C' },
  { min: 35, letter: 'D' },
  { min: 0,  letter: 'E' },
];

/** Convertit une valeur numérique (0–100) en lettre A–E. */
export function letterFor(value: number): Score['letter'] {
  return THRESHOLDS.find(t => value >= t.min)!.letter;
}

/**
 * Calcule le score énergétique (0–100) et la lettre A–E à partir des findings d'un fichier.
 */
export function computeScore(findings: Finding[]): Score {
  let penalty = 0;
  const count = { high: 0, medium: 0, low: 0 };

  for (const f of findings) {
    penalty += f.weight;
    count[f.severity]++;
  }

  const value = Math.max(0, 100 - penalty);
  return { letter: letterFor(value), value, findingCount: count };
}

/** Étiquette textuelle du score pour les tooltips et le rapport. */
export function scoreSummary(score: Score): string {
  const labels: Record<Score['letter'], string> = {
    A: 'Excellent — code très sobre',
    B: 'Bon — quelques optimisations possibles',
    C: 'Moyen — des patterns énergivores détectés',
    D: 'Faible — restructuration recommandée',
    E: 'Critique — consommation élevée',
  };
  return labels[score.letter];
}
