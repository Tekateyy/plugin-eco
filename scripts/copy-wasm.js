// Copie dans out/ les fichiers que `tsc` ne compile pas mais dont l'extension
// a besoin au runtime : les grammaires WASM du parseur, et les sondes de
// mesure runtime (src/probe.js, src/probe.py — voir measure.ts). Aucune des
// deux ne passe par tsc : la première est du JS pur, la seconde du Python.
//
// À l'exécution, l'extension résout les WASM depuis context.extensionUri :
// node_modules n'est pas fiable dans un .vsix installé, out/ l'est.
// tree-sitter-wasms embarque une quarantaine de grammaires, on ne prend que
// celles déclarées dans src/languages.ts.

const fs = require('fs');
const path = require('path');

// tsx couvre .js/.jsx/.tsx ; typescript est indispensable pour .ts, où tsx lit
// l'assertion `<T>valeur` comme une ouverture JSX et perd le reste du fichier.
// La grammaire javascript, elle, est inutile : tsx en est un sur-ensemble.
const WASM_SOURCES = [
  require.resolve('web-tree-sitter/tree-sitter.wasm'),
  require.resolve('tree-sitter-wasms/out/tree-sitter-java.wasm'),
  require.resolve('tree-sitter-wasms/out/tree-sitter-tsx.wasm'),
  require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm'),
  require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm'),
];

const outDir = path.join(__dirname, '..', 'out');
const wasmDestDir = path.join(outDir, 'wasm');
fs.mkdirSync(wasmDestDir, { recursive: true });

for (const source of WASM_SOURCES) {
  const dest = path.join(wasmDestDir, path.basename(source));
  fs.copyFileSync(source, dest);
  console.log(`copié ${path.basename(source)} → out/wasm/`);
}

for (const probe of ['probe.js', 'probe.py']) {
  fs.copyFileSync(path.join(__dirname, '..', 'src', probe), path.join(outDir, probe));
  console.log(`copié ${probe} → out/`);
}
