// Fichier de démonstration — composant React.
//
// L'inférence classe ce fichier « client » (import de react, JSX), ce qui
// active les règles dont le coût est payé par l'appareil de chaque visiteur.

import _ from 'lodash';
import { useEffect, useState } from 'react';

type Row = { id: string; label: string };

export function Dashboard({ rows }: { rows: Row[] }) {
  const [tick, setTick] = useState(0);

  // Timer court : signalé en sévérité haute. Il empêche l'appareil de se
  // mettre au repos tant que la page est ouverte.
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 200);
    return () => clearInterval(t);
  }, []);

  // Gestionnaire de défilement sans limitation de débit : signalé.
  useEffect(() => {
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Attentes enchaînées : signalé. Un Promise.all recouvrirait les appels.
  async function refresh(ids: string[]) {
    const out = [];
    for (const id of ids) {
      out.push(await fetch(`/api/rows/${id}`));
    }
    return out;
  }

  // Boucle imbriquée : signalée, comme en Java.
  const pairs = [];
  for (const a of rows) {
    for (const b of rows) {
      if (a.id !== b.id) pairs.push([a, b]);
    }
  }

  return (
    <ul onScroll={handleScroll}>
      {_.uniqBy(rows, 'id').map(r => (
        <li key={r.id}>{r.label} — {tick}</li>
      ))}
    </ul>
  );
}

function handleScroll() {
  document.body.dataset.scrolled = String(window.scrollY > 0);
}
