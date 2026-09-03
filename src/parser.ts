import Parser from 'web-tree-sitter';
import * as fs from 'fs';
import * as path from 'path';

let _parser: Parser | null = null;

/**
 * Initialise web-tree-sitter avec la grammaire Java (WASM).
 * Doit être appelé une seule fois dans activate().
 */
export async function initParser(): Promise<void> {
  if (_parser) return; // déjà initialisé

  // Localiser le tree-sitter.wasm runtime dans web-tree-sitter
  await Parser.init({
    locateFile(scriptName: string): string {
      return path.join(
        path.dirname(require.resolve('web-tree-sitter')),
        scriptName
      );
    }
  });

  // Charger la grammaire Java pré-compilée en WASM depuis tree-sitter-wasms
  const javaWasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-java.wasm');
  const javaWasmBuffer = fs.readFileSync(javaWasmPath);
  const Java = await Parser.Language.load(javaWasmBuffer);

  _parser = new Parser();
  _parser.setLanguage(Java);
}

/**
 * Parse le code source Java et retourne l'arbre syntaxique.
 * Nécessite que initParser() ait été appelé au préalable.
 */
export function parse(code: string): Parser.Tree {
  if (!_parser) {
    throw new Error('Parser non initialisé. Appeler initParser() d\'abord.');
  }
  return _parser.parse(code);
}
