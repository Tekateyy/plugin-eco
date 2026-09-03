import Parser from 'web-tree-sitter';
import * as fs from 'fs';
import * as path from 'path';
import { LanguageSpec, grammarFiles, specFor } from './languages';

let _parser: Parser | null = null;

/** Grammaires chargées, indexées par nom de fichier WASM. */
const _grammars = new Map<string, Parser.Language>();

/**
 * Initialise web-tree-sitter et charge toutes les grammaires déclarées.
 * Doit être appelé une seule fois dans activate().
 *
 * Les .wasm sont lus dans out/wasm/, où le script de build les a copiés :
 * node_modules n'est pas présent dans un .vsix installé.
 *
 * Le chargement est immédiat plutôt que paresseux : une grammaire coûte
 * quelques millisecondes (mesuré : 5 ms pour tsx, 2 ms pour java), ce qui ne
 * justifie pas la complexité d'un chargement à la demande.
 *
 * @param extensionPath racine de l'extension (context.extensionUri.fsPath).
 *   Par défaut, la racine du paquet installé : un consommateur npm ne peut pas
 *   deviner ce chemin, VSCode le fournit explicitement.
 */
export async function initParser(
  extensionPath: string = path.join(__dirname, '..')
): Promise<void> {
  if (_parser) return; // déjà initialisé

  const wasmDir = path.join(extensionPath, 'out', 'wasm');

  // Le runtime emscripten réclame tree-sitter.wasm par son nom de fichier
  await Parser.init({
    locateFile(scriptName: string): string {
      return path.join(wasmDir, scriptName);
    }
  });

  for (const file of grammarFiles()) {
    const buffer = fs.readFileSync(path.join(wasmDir, file));
    _grammars.set(file, await Parser.Language.load(buffer));
  }

  _parser = new Parser();
}

/**
 * Parse du code source avec la grammaire du langage indiqué.
 *
 * @param code source à analyser
 * @param languageId `languageId` VSCode ('java', 'typescriptreact'…)
 * @throws si le parser n'est pas initialisé ou le langage non supporté
 */
export function parse(code: string, languageId: string): Parser.Tree {
  const spec = specFor(languageId);
  if (!spec) {
    throw new Error(`Langage non supporté : ${languageId}`);
  }
  return parseWith(code, spec);
}

/** Variante prenant directement un descripteur, pour le scan workspace. */
export function parseWith(code: string, spec: LanguageSpec): Parser.Tree {
  if (!_parser) {
    throw new Error('Parser non initialisé. Appeler initParser() d\'abord.');
  }
  const grammar = _grammars.get(spec.grammarFile);
  if (!grammar) {
    throw new Error(`Grammaire non chargée : ${spec.grammarFile}`);
  }
  _parser.setLanguage(grammar);
  return _parser.parse(code);
}
