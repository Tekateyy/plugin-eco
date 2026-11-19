// Fichier de démonstration TypeScript.
//
// Deux règles seulement s'appliquent aujourd'hui à JS/TS : boucle imbriquée et
// requête SQL sans LIMIT. Les règles propres au web — await en boucle, I/O
// synchrones, polling, imports massifs — restent à écrire.

interface Order {
  id: string;
  lines: readonly number[];
}

/** Boucle imbriquée : signalée. */
export function totalPerOrder(orders: readonly Order[], rates: readonly number[]): number[] {
  const totals: number[] = [];
  for (const order of orders) {
    let sum = 0;
    for (const line of order.lines) {
      sum += line * rates[line % rates.length];
    }
    totals.push(sum);
  }
  return totals;
}

/** Requête sans pagination : signalée. */
export const ALL_ORDERS = 'SELECT id, total, created_at FROM orders';

/** Requête paginée : rien à signaler. */
export const RECENT_ORDERS = 'SELECT id, total FROM orders ORDER BY created_at DESC LIMIT 50';

/**
 * Concaténation en boucle et instanciation en boucle : volontairement NON
 * signalées en JS/TS. V8 représente les concaténations par des ropes, et son
 * GC générationnel rend l'allocation à courte durée de vie bon marché — les
 * signaler produirait du bruit sur du code sain. En Java, les deux restent
 * des règles actives.
 */
export function describe(orders: readonly Order[]): string {
  let out = '';
  for (const order of orders) {
    out += `${order.id}\n`;
    void new Date();
  }
  return out;
}

interface Db {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
}

/**
 * Une requête par commande (N+1) : signalée. Attendue dans la boucle, elle
 * l'est aussi par la règle « await en boucle ».
 */
export async function loadLines(db: Db, orderIds: readonly string[]): Promise<unknown[][]> {
  const all: unknown[][] = [];
  for (const id of orderIds) {
    all.push(await db.query('SELECT * FROM lines WHERE order_id = $1 LIMIT 100', [id]));
  }
  return all;
}

/** Une seule requête, dont on parcourt le résultat : rien à signaler. */
export async function countLines(db: Db): Promise<number> {
  const rows = await db.query('SELECT order_id FROM lines LIMIT 1000');
  let n = 0;
  for (const row of rows) {
    if (row) n++;
  }
  return n;
}
