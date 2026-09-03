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

/**
 * Score global d'un ensemble de fichiers.
 *
 * **Les fichiers sans aucune alerte sont exclus du calcul.** Une moyenne sur
 * tous les fichiers diluait tout : baby-tracker sortait en A 99/100 alors que
 * son unique fichier volumineux était en C 72, noyé par 22 modules utilitaires
 * sans le moindre finding. Le score annonçait surtout combien le projet compte
 * de petits fichiers anodins.
 *
 * Restreindre la moyenne aux fichiers réellement concernés répond à la question
 * utile — « à quel point ce qui pose problème pose problème » — et empêche
 * d'améliorer sa note en ajoutant du code sain.
 *
 * Le compte d'alertes, lui, reste calculé sur l'ensemble : c'est la mesure de
 * l'étendue, que le panneau affiche à côté de la lettre.
 */
export function aggregateScore(scores: Score[]): Score {
  const total = scores.reduce(
    (acc, s) => ({
      high: acc.high + s.findingCount.high,
      medium: acc.medium + s.findingCount.medium,
      low: acc.low + s.findingCount.low,
    }),
    { high: 0, medium: 0, low: 0 }
  );

  const concerned = scores.filter(
    s => s.findingCount.high + s.findingCount.medium + s.findingCount.low > 0
  );

  const value = concerned.length === 0
    ? 100
    : Math.round(concerned.reduce((sum, s) => sum + s.value, 0) / concerned.length);

  return { letter: letterFor(value), value, findingCount: total };
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
