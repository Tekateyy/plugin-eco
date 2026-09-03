const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { initParser, parse } = require('../out/parser');
const { inferContext } = require('../out/context');
const { specFor } = require('../out/languages');

const ROOT = path.join(__dirname, '..');

before(async () => {
  await initParser(ROOT);
});

const infer = (code, languageId = 'typescript') =>
  inferContext(parse(code, languageId).rootNode, specFor(languageId));

const contextOf = (code, languageId) => infer(code, languageId).context;

// --- Serveur --------------------------------------------------------------

describe('détection du contexte serveur', () => {
  test('import d\'un module du cœur de Node', () => {
    assert.strictEqual(contextOf("import fs from 'fs';\nexport const x = fs.readFileSync('a');"), 'server');
  });

  test('préfixe node: reconnu', () => {
    assert.strictEqual(contextOf("import { readFile } from 'node:fs/promises';"), 'server');
  });

  test('require CommonJS', () => {
    assert.strictEqual(contextOf("const express = require('express');", 'javascript'), 'server');
  });

  test('import dynamique', () => {
    assert.strictEqual(contextOf("export async function f() { const db = await import('mysql2'); return db; }"), 'server');
  });

  test('client de base de données', () => {
    assert.strictEqual(contextOf("import { PrismaClient } from '@prisma/client';"), 'server');
  });

  test('sous-chemin d\'un module serveur', () => {
    assert.strictEqual(contextOf("import router from 'express/lib/router';"), 'server');
  });

  test('globale __dirname', () => {
    assert.strictEqual(contextOf("export const here = __dirname;"), 'server');
  });
});

// --- Client ---------------------------------------------------------------

describe('détection du contexte client', () => {
  test('globale document', () => {
    assert.strictEqual(contextOf("export function f() { document.title = 'x'; }"), 'client');
  });

  test('globale window', () => {
    assert.strictEqual(contextOf("export const w = window.innerWidth;"), 'client');
  });

  test('localStorage', () => {
    assert.strictEqual(contextOf("export const t = localStorage.getItem('token');"), 'client');
  });

  test('import de react', () => {
    assert.strictEqual(contextOf("import { useState } from 'react';"), 'client');
  });

  test('présence de JSX', () => {
    assert.strictEqual(contextOf('export const A = () => <div>bonjour</div>;', 'typescriptreact'), 'client');
  });
});

// --- Directives, qui priment ---------------------------------------------

describe('directives explicites', () => {
  test("'use client' l'emporte sur des indices serveur", () => {
    const r = infer("'use client';\nimport fs from 'fs';");
    assert.strictEqual(r.context, 'client');
    assert.deepStrictEqual(r.clientSignals, ["directive 'use client'"]);
  });

  test("'use server' l'emporte sur du JSX", () => {
    assert.strictEqual(
      contextOf("'use server';\nexport const A = () => <div />;", 'typescriptreact'),
      'server'
    );
  });

  test("'use strict' ne bloque pas la lecture des directives suivantes", () => {
    assert.strictEqual(contextOf("'use strict';\n'use client';\nexport const a = 1;"), 'client');
  });

  test('une directive au milieu du fichier ne compte pas', () => {
    // Seul l'en-tête fait foi ; ici la chaîne suit du code.
    assert.strictEqual(contextOf("export const a = 1;\n'use client';"), 'unknown');
  });
});

// --- Indéterminé : un état légitime --------------------------------------

describe('contexte indéterminé', () => {
  test('un fichier sans aucun indice', () => {
    assert.strictEqual(contextOf('export const add = (a: number, b: number) => a + b;'), 'unknown');
  });

  test('indices contradictoires — rendu côté serveur', () => {
    const r = infer("import fs from 'fs';\nimport { useState } from 'react';");
    assert.strictEqual(r.context, 'unknown');
    assert.deepStrictEqual(r.serverSignals, ['fs']);
    assert.deepStrictEqual(r.clientSignals, ['react']);
  });

  test('les imports locaux ne prouvent rien', () => {
    assert.strictEqual(contextOf("import { helper } from './utils';\nimport x from '../a/b';"), 'unknown');
  });

  test('un module inconnu ne prouve rien', () => {
    assert.strictEqual(contextOf("import { z } from 'zod';\nimport dayjs from 'dayjs';"), 'unknown');
  });
});

// --- Indices volontairement ignorés --------------------------------------

describe('indices écartés car ambigus', () => {
  test('process.env ne suffit pas — les bundlers l\'injectent côté client', () => {
    assert.strictEqual(contextOf('export const url = process.env.API_URL;'), 'unknown');
  });

  test('fetch ne prouve rien — disponible des deux côtés', () => {
    assert.strictEqual(contextOf("export const f = () => fetch('/api');"), 'unknown');
  });
});

// --- Globales masquées par une déclaration locale ------------------------

describe('une globale masquée localement n\'en est plus une', () => {
  // Trouvé sur du code réel : src/extension.ts de ce projet était classé
  // « client » parce qu'il nomme un paramètre `document` (un TextDocument
  // VSCode). Le nom seul ne prouve rien s'il est lié dans le fichier.
  test('paramètre nommé document', () => {
    assert.strictEqual(contextOf(`
      export function analyze(document: TextDocument): string {
        return document.getText();
      }
    `), 'unknown');
  });

  test('variable nommée window', () => {
    assert.strictEqual(contextOf(`
      export function f() {
        const window = openPane();
        window.reveal();
      }
    `), 'unknown');
  });

  test('import nommé document', () => {
    assert.strictEqual(contextOf(`
      import { document } from './fixtures';
      export const t = document.title;
    `), 'unknown');
  });

  test('paramètre destructuré', () => {
    assert.strictEqual(contextOf(`
      export const render = ({ document }) => document.body;
    `), 'unknown');
  });

  test('mais une vraie globale reste détectée', () => {
    // Contre-épreuve : sans liaison locale, le verdict ne change pas.
    assert.strictEqual(contextOf(`
      export function analyze(doc: TextDocument): string {
        document.title = doc.name;
        return document.title;
      }
    `), 'client');
  });
});

// --- Langages à contexte fixe --------------------------------------------

describe('contexte fixe', () => {
  test('Java est du serveur par construction, sans inférence', () => {
    const r = inferContext(parse('class T {}', 'java').rootNode, specFor('java'));
    assert.strictEqual(r.context, 'server');
    assert.deepStrictEqual(r.serverSignals, []);
    assert.deepStrictEqual(r.clientSignals, []);
  });
});

// --- Cas réalistes --------------------------------------------------------

describe('fichiers réalistes', () => {
  test('route Express', () => {
    assert.strictEqual(contextOf(`
      import express from 'express';
      import { pool } from './db';
      const app = express();
      app.get('/orders', async (req, res) => {
        const rows = await pool.query('SELECT id FROM orders LIMIT 50');
        res.json(rows);
      });
    `), 'server');
  });

  test('composant React', () => {
    assert.strictEqual(contextOf(`
      import { useEffect, useState } from 'react';
      export function Ping() {
        const [n, setN] = useState(0);
        useEffect(() => { const t = setInterval(() => setN(x => x + 1), 100); return () => clearInterval(t); }, []);
        return <span>{n}</span>;
      }
    `, 'typescriptreact'), 'client');
  });

  test('module utilitaire partagé', () => {
    assert.strictEqual(contextOf(`
      export function slugify(s: string): string {
        return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      }
    `), 'unknown');
  });
});
