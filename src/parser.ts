import Parser from 'web-tree-sitter';
import * as fs from 'fs';
import * as path from 'path';

let _parser: Parser | null = null;

/**
 * Initialise web-tree-sitter avec la grammaire Java (WASM).
 * Doit être appelé une seule fois dans activate().
 *
 * Les .wasm sont lus dans out/wasm/, où le script de build les a copiés :
 * node_modules n'est pas présent dans un .vsix installé.
 *
 * @param extensionPath racine de l'extension (context.extensionUri.fsPath)
 */
export async function initParser(extensionPath: string): Promise<void> {
  if (_parser) return; // déjà initialisé

  const wasmDir = path.join(extensionPath, 'out', 'wasm');

  // Le runtime emscripten réclame tree-sitter.wasm par son nom de fichier
  await Parser.init({
    locateFile(scriptName: string): string {
      return path.join(wasmDir, scriptName);
    }
  });

  const javaWasmBuffer = fs.readFileSync(path.join(wasmDir, 'tree-sitter-java.wasm'));
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
