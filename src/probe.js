// Sonde préchargée dans le processus mesuré (`node --require probe.js script.js`).
//
// Volontairement en JS pur, pas TypeScript : elle tourne dans le processus de
// l'utilisateur, pas dans celui du CLI — aucune sortie sur stdout/stderr, aucun
// effet de bord hors du fichier qu'elle écrit. `measure.ts` en est le seul
// lecteur, via la variable d'environnement PLUGIN_ECO_PROBE_OUT.
//
// Ce mécanisme (sonde préchargée → JSON) est écrit pour se transposer tel quel
// à Python et Java quand leur tour viendra.

'use strict';

const fs = require('fs');

const outPath = process.env.PLUGIN_ECO_PROBE_OUT;
const startedAt = process.hrtime.bigint();

if (outPath) {
  process.on('exit', () => {
    const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const cpu = process.cpuUsage();

    // resourceUsage().maxRSS est en kilo-octets sur toutes les plateformes
    // (Node le normalise, contrairement à getrusage() en C) ; memoryUsage().rss
    // n'est qu'un repli si resourceUsage() n'existe pas (Node < 12.10).
    let maxRssBytes;
    try {
      maxRssBytes = process.resourceUsage().maxRSS * 1024;
    } catch {
      maxRssBytes = process.memoryUsage().rss;
    }

    const result = {
      cpuUserUs: cpu.user,
      cpuSystemUs: cpu.system,
      wallMs,
      maxRssBytes,
    };

    try {
      fs.writeFileSync(outPath, JSON.stringify(result));
    } catch {
      // Rien à faire depuis un handler `exit` : le parent constatera l'absence
      // du fichier et le signalera lui-même.
    }
  });
}
