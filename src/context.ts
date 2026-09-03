import Parser from 'web-tree-sitter';
import { ExecutionContext } from './types';
import { LanguageSpec } from './languages';

/**
 * Inférence du contexte d'exécution d'un fichier JavaScript / TypeScript.
 *
 * Le code se dénonce lui-même : un fichier qui importe `fs` tourne sur un
 * serveur, un fichier qui touche `document` tourne dans un navigateur. On lit
 * ces indices dans l'arbre déjà parsé — pas de convention de chemins, pas de
 * configuration, pas de second moteur d'analyse.
 *
 * Deux principes :
 *
 *  - **Seuls les indices francs comptent.** `process.env` est injecté par les
 *    bundlers côté client, `Buffer` est polyfillé : ils ne prouvent rien et sont
 *    ignorés. Mieux vaut répondre « je ne sais pas » que se tromper.
 *  - **Un conflit donne `unknown`.** Un composant qui lit `fs` *et* rend du JSX
 *    tourne des deux côtés (rendu côté serveur). C'est un fait, pas une
 *    ambiguïté à trancher au hasard.
 */

export interface ContextResult {
  context: ExecutionContext;
  /** Indices relevés, pour les tests et l'affichage. */
  clientSignals: string[];
  serverSignals: string[];
}

// --- Indices --------------------------------------------------------------

/** Modules du cœur de Node. Tout `node:*` est de toute façon serveur. */
const NODE_BUILTINS = new Set([
  'fs', 'path', 'http', 'https', 'net', 'tls', 'dns', 'os', 'crypto',
  'child_process', 'cluster', 'worker_threads', 'stream', 'zlib', 'readline',
  'buffer', 'querystring', 'url', 'util', 'v8', 'vm', 'perf_hooks',
]);

/** Frameworks serveur, clients de bases de données et outillage backend. */
const SERVER_MODULES = new Set([
  'express', 'fastify', 'koa', 'hapi', 'connect', 'body-parser',
  '@nestjs/core', '@nestjs/common', 'next/server',
  'pg', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'redis', 'ioredis',
  'prisma', '@prisma/client', 'sequelize', 'typeorm', 'knex',
  'sqlite3', 'better-sqlite3', 'nodemailer', 'dotenv',
]);

/**
 * Bibliothèques dont le coût de rendu est payé par le navigateur.
 * `react` en fait partie même en rendu côté serveur : ce qui est produit ici
 * sera hydraté et animé sur l'appareil du visiteur.
 */
const CLIENT_MODULES = new Set([
  'react', 'react-dom', 'preact', 'vue', 'svelte', 'solid-js', 'lit',
  '@angular/core', 'jquery', 'react-router-dom', 'framer-motion',
]);

/** Globales que seul un navigateur fournit. */
const CLIENT_GLOBALS = new Set([
  'document', 'window', 'navigator', 'localStorage', 'sessionStorage',
  'history', 'XMLHttpRequest',
]);

/** Globales que seul Node fournit (CommonJS). */
const SERVER_GLOBALS = new Set(['__dirname', '__filename']);

// --- Inférence ------------------------------------------------------------

/**
 * @param root racine de l'arbre syntaxique
 * @param spec descripteur du langage ; un `fixedContext` court-circuite l'analyse
 */
export function inferContext(root: Parser.SyntaxNode, spec: LanguageSpec): ContextResult {
  if (spec.fixedContext) {
    return { context: spec.fixedContext, clientSignals: [], serverSignals: [] };
  }

  // Une directive 'use client' / 'use server' est une déclaration explicite
  // du développeur : elle prime sur tout ce qu'on pourrait déduire.
  const directive = leadingDirective(root);
  if (directive === 'use client') {
    return { context: 'client', clientSignals: ["directive 'use client'"], serverSignals: [] };
  }
  if (directive === 'use server') {
    return { context: 'server', clientSignals: [], serverSignals: ["directive 'use server'"] };
  }

  const found: Evidence = {
    client: new Set(),
    server: new Set(),
    globals: new Map(),
    declared: new Set(),
  };
  collect(root, found);

  // Une globale qui porte le même nom qu'une variable locale n'en est pas une.
  // `document` est un nom de paramètre courant — le premier essai classait
  // `src/extension.ts` de ce projet comme du code navigateur.
  for (const [name, side] of found.globals) {
    if (found.declared.has(name)) continue;
    (side === 'client' ? found.client : found.server).add(name);
  }

  const clientSignals = [...found.client].sort();
  const serverSignals = [...found.server].sort();

  let context: ExecutionContext = 'unknown';
  if (serverSignals.length > 0 && clientSignals.length === 0) context = 'server';
  else if (clientSignals.length > 0 && serverSignals.length === 0) context = 'client';

  return { context, clientSignals, serverSignals };
}

/** Directive en tête de fichier, si présente. */
function leadingDirective(root: Parser.SyntaxNode): string | null {
  for (const stmt of root.namedChildren) {
    if (stmt.type !== 'expression_statement') return null;
    const expr = stmt.namedChildren[0];
    if (!expr || expr.type !== 'string') return null;
    const value = unquote(expr.text);
    if (value === 'use client' || value === 'use server') return value;
    // Une autre directive ('use strict') n'interrompt pas la recherche.
  }
  return null;
}

interface Evidence {
  client: Set<string>;
  server: Set<string>;
  /** Globales rencontrées, à confronter aux noms déclarés localement. */
  globals: Map<string, 'client' | 'server'>;
  /** Noms liés dans le fichier : paramètres, variables, imports, fonctions. */
  declared: Set<string>;
}

/** Nœuds dont les identifiants descendants sont des liaisons, pas des usages. */
const BINDING_PARENTS = new Set(['formal_parameters', 'import_clause']);

function collect(node: Parser.SyntaxNode, found: Evidence): void {
  switch (node.type) {
    case 'import_statement':
    case 'export_statement': {
      const source = node.childForFieldName('source');
      if (source) classifyModule(unquote(source.text), found);
      break;
    }

    case 'call_expression': {
      const callee = node.childForFieldName('function');
      // require('x') et import('x') portent tous deux leur cible en argument.
      if (callee && (callee.text === 'require' || callee.type === 'import')) {
        const arg = node.childForFieldName('arguments')?.namedChildren[0];
        if (arg?.type === 'string') classifyModule(unquote(arg.text), found);
      }
      break;
    }

    case 'variable_declarator':
    case 'function_declaration':
    case 'class_declaration': {
      const name = node.childForFieldName('name');
      if (name?.type === 'identifier') found.declared.add(name.text);
      break;
    }

    case 'identifier': {
      if (CLIENT_GLOBALS.has(node.text)) found.globals.set(node.text, 'client');
      else if (SERVER_GLOBALS.has(node.text)) found.globals.set(node.text, 'server');
      break;
    }

    default:
      // Du JSX signifie un rendu, donc un coût payé par le navigateur.
      if (node.type.startsWith('jsx_element') || node.type.startsWith('jsx_self_closing')) {
        found.client.add('JSX');
      }
  }

  if (BINDING_PARENTS.has(node.type)) declareAll(node, found.declared);

  for (const child of node.namedChildren) collect(child, found);
}

/** Enregistre tous les identifiants d'un sous-arbre comme noms liés. */
function declareAll(node: Parser.SyntaxNode, declared: Set<string>): void {
  if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
    declared.add(node.text);
  }
  for (const child of node.namedChildren) declareAll(child, declared);
}

function classifyModule(source: string, found: Evidence): void {
  const client = found.client;
  const server = found.server;
  if (source.startsWith('.') || source.startsWith('/')) return; // module local

  if (source.startsWith('node:')) {
    server.add(source);
    return;
  }

  const root = moduleRoot(source);
  if (NODE_BUILTINS.has(root) || SERVER_MODULES.has(root) || SERVER_MODULES.has(source)) {
    server.add(root);
  } else if (CLIENT_MODULES.has(root) || CLIENT_MODULES.has(source)) {
    client.add(root);
  }
  // Un module inconnu ne prouve rien : on ne l'utilise pas comme indice.
}

/** 'express/lib/router' → 'express' ; '@nestjs/core/x' → '@nestjs/core'. */
function moduleRoot(source: string): string {
  const parts = source.split('/');
  return source.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function unquote(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}
