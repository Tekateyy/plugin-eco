// Copie les fichiers WASM nécessaires au parsing dans out/wasm/.
//
// À l'exécution, l'extension les résout depuis context.extensionUri : node_modules
// n'est pas fiable dans un .vsix installé, out/ l'est. tree-sitter-wasms embarque
// une quarantaine de grammaires, on ne prend que Java.

const fs = require('fs');
const path = require('path');

// tsx couvre .js/.jsx/.tsx ; typescript est indispensable pour .ts, où tsx lit
// l'assertion `<T>valeur` comme une ouverture JSX et perd le reste du fichier.
// La grammaire javascript, elle, est inutile : tsx en est un sur-ensemble.
const SOURCES = [
  require.resolve('web-tree-sitter/tree-sitter.wasm'),
  require.resolve('tree-sitter-wasms/out/tree-sitter-java.wasm'),
  require.resolve('tree-sitter-wasms/out/tree-sitter-tsx.wasm'),
  require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm'),
];

const destDir = path.join(__dirname, '..', 'out', 'wasm');
fs.mkdirSync(destDir, { recursive: true });

for (const source of SOURCES) {
  const dest = path.join(destDir, path.basename(source));
  fs.copyFileSync(source, dest);
  console.log(`copié ${path.basename(source)} → out/wasm/`);
}
