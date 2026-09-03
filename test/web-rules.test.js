const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { initParser, parse } = require('../out/parser');
const { collectFindings } = require('../out/rules');
const { specFor, ruleAppliesIn } = require('../out/languages');

const ROOT = path.join(__dirname, '..');

before(async () => {
  await initParser(ROOT);
});

/**
 * Analyse un extrait en forçant le contexte d'exécution, pour tester les règles
 * indépendamment de l'inférence (qui a sa propre suite).
 */
const analyze = (code, context, languageId = 'typescript') =>
  collectFindings(parse(code, languageId).rootNode, specFor(languageId), context);

const messages = (findings) => findings.map(f => f.message);
const matching = (findings, needle) => findings.filter(f => f.message.includes(needle));

// --- await en boucle ------------------------------------------------------

describe('await en boucle', () => {
  test('déclenché dans un for-of', () => {
    const f = matching(analyze(`
      export async function load(ids: string[]) {
        const out = [];
        for (const id of ids) { out.push(await db.get(id)); }
        return out;
      }`, 'server'), 'await');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'high');
  });

  test('un await hors boucle ne déclenche rien', () => {
    const f = analyze(`
      export async function load(id: string) { return await db.get(id); }`, 'server');
    assert.deepStrictEqual(f, []);
  });

  test('une fonction imbriquée dans la boucle lance des attentes concurrentes', () => {
    // Ici il y a bien une boucle, mais l'`await` vit dans une fonction qui est
    // seulement *lancée* à chaque tour : les attentes se recouvrent. C'est la
    // bonne pratique, la signaler serait un contresens.
    const f = analyze(`
      export async function load(ids: string[]) {
        const tasks = [];
        for (const id of ids) { tasks.push((async () => await db.get(id))()); }
        return Promise.all(tasks);
      }`, 'server');
    assert.deepStrictEqual(messages(f), []);
  });

  test('mais un await direct dans la même boucle est bien signalé', () => {
    // Contre-épreuve : seule la frontière de fonction change entre les deux.
    const f = matching(analyze(`
      export async function load(ids: string[]) {
        const tasks = [];
        for (const id of ids) { tasks.push(await db.get(id)); }
        return tasks;
      }`, 'server'), 'await');
    assert.strictEqual(f.length, 1);
  });

  test('un forEach asynchrone dans une boucle ne compte pas non plus', () => {
    const f = analyze(`
      export async function load(groups) {
        for (const g of groups) { g.items.forEach(async (i) => { await save(i); }); }
      }`, 'server');
    assert.deepStrictEqual(messages(f), []);
  });

  test('s\'applique aussi côté client — un enchaînement coûte partout', () => {
    const f = matching(analyze(`
      export async function load(ids: string[]) {
        for (const id of ids) { await fetch('/api/' + id); }
      }`, 'client'), 'await');
    assert.strictEqual(f.length, 1);
  });

  test('et même quand le contexte est indéterminé', () => {
    const f = matching(analyze(`
      export async function load(ids: string[]) {
        for (const id of ids) { await go(id); }
      }`, 'unknown'), 'await');
    assert.strictEqual(f.length, 1);
  });
});

// --- I/O synchrones -------------------------------------------------------

describe('I/O synchrone côté serveur', () => {
  test('déclenché dans une fonction', () => {
    const f = matching(analyze(`
      import fs from 'fs';
      export function handler() { return fs.readFileSync('./data.json', 'utf8'); }`, 'server'), 'synchrone');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'high');
    assert.match(f[0].message, /readFileSync/);
  });

  test('au niveau du module, rien — le démarrage n\'a lieu qu\'une fois', () => {
    const f = analyze(`
      import fs from 'fs';
      export const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));`, 'server');
    assert.deepStrictEqual(messages(f), []);
  });

  test('execSync compte aussi', () => {
    const f = matching(analyze(`
      export function version() { return execSync('git rev-parse HEAD'); }`, 'server'), 'synchrone');
    assert.strictEqual(f.length, 1);
  });

  test('ne se déclenche pas côté client', () => {
    const f = analyze(`
      export function handler() { return fs.readFileSync('./a'); }`, 'client');
    assert.deepStrictEqual(messages(f), []);
  });

  test('ni quand le contexte est indéterminé', () => {
    const f = analyze(`
      export function handler() { return fs.readFileSync('./a'); }`, 'unknown');
    assert.deepStrictEqual(messages(f), []);
  });
});

// --- Timers ---------------------------------------------------------------

describe('timer périodique côté client', () => {
  test('un intervalle court est de sévérité haute', () => {
    const f = matching(analyze(`export const t = setInterval(poll, 100);`, 'client'), 'Timer');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'high');
    assert.match(f[0].message, /100 ms/);
  });

  test('un intervalle long est de sévérité moyenne', () => {
    const f = matching(analyze(`export const t = setInterval(sync, 60000);`, 'client'), 'Timer');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'medium');
  });

  test('un délai non littéral reste signalé, sans le chiffrer', () => {
    const f = matching(analyze(`export const t = setInterval(poll, delay);`, 'client'), 'Timer');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'medium');
    assert.doesNotMatch(f[0].message, /ms/);
  });

  test('setTimeout n\'est pas concerné — il ne se répète pas', () => {
    const f = analyze(`export const t = setTimeout(run, 100);`, 'client');
    assert.deepStrictEqual(messages(f), []);
  });

  test('rien côté serveur', () => {
    const f = analyze(`export const t = setInterval(poll, 100);`, 'server');
    assert.deepStrictEqual(messages(f), []);
  });
});

// --- Gestionnaires d'événements ------------------------------------------

describe('gestionnaire à haute fréquence', () => {
  test('addEventListener scroll sans limitation', () => {
    const f = matching(analyze(`window.addEventListener('scroll', onScroll);`, 'client'), 'scroll');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'medium');
  });

  test('un throttle explicite désamorce la règle', () => {
    const f = analyze(`window.addEventListener('scroll', throttle(onScroll, 200));`, 'client');
    assert.deepStrictEqual(messages(f), []);
  });

  test('un debounce aussi', () => {
    const f = analyze(`window.addEventListener('resize', debounce(onResize, 150));`, 'client');
    assert.deepStrictEqual(messages(f), []);
  });

  test('un événement peu fréquent n\'est pas concerné', () => {
    const f = analyze(`window.addEventListener('click', onClick);`, 'client');
    assert.deepStrictEqual(messages(f), []);
  });

  test('attribut JSX onScroll — le cas courant en React', () => {
    const f = matching(analyze(
      `export const L = () => <ul onScroll={handleScroll}>{null}</ul>;`,
      'client', 'typescriptreact'), 'onScroll');
    assert.strictEqual(f.length, 1);
  });

  test('attribut JSX déjà throttlé', () => {
    const f = analyze(
      `export const L = () => <ul onScroll={throttle(handleScroll, 100)}>{null}</ul>;`,
      'client', 'typescriptreact');
    assert.deepStrictEqual(messages(f), []);
  });

  test('onClick en JSX n\'est pas concerné', () => {
    const f = analyze(
      `export const B = () => <button onClick={save}>ok</button>;`,
      'client', 'typescriptreact');
    assert.deepStrictEqual(messages(f), []);
  });
});

// --- Imports lourds -------------------------------------------------------

describe('import global d\'une bibliothèque lourde', () => {
  test('import par défaut de lodash', () => {
    const f = matching(analyze(`import _ from 'lodash';`, 'client'), 'lodash');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'medium');
  });

  test('import de l\'espace de noms entier', () => {
    const f = matching(analyze(`import * as moment from 'moment';`, 'client'), 'moment');
    assert.strictEqual(f.length, 1);
  });

  test('un import nommé ne déclenche rien', () => {
    const f = analyze(`import { debounce } from 'lodash';`, 'client');
    assert.deepStrictEqual(messages(f), []);
  });

  test('un sous-chemin ciblé non plus', () => {
    const f = analyze(`import debounce from 'lodash/debounce';`, 'client');
    assert.deepStrictEqual(messages(f), []);
  });

  test('require compte aussi', () => {
    const f = matching(analyze(`const _ = require('lodash');`, 'client', 'javascript'), 'lodash');
    assert.strictEqual(f.length, 1);
  });

  test('une bibliothèque légère n\'est pas concernée', () => {
    const f = analyze(`import z from 'zod';`, 'client');
    assert.deepStrictEqual(messages(f), []);
  });

  test('rien côté serveur — le poids du bundle est un enjeu client', () => {
    const f = analyze(`import _ from 'lodash';`, 'server');
    assert.deepStrictEqual(messages(f), []);
  });
});

// --- new RegExp en boucle -------------------------------------------------

describe('new RegExp en boucle', () => {
  test('déclenché', () => {
    const f = matching(analyze(`
      export function f(rs: string[]) {
        for (const r of rs) { if (new RegExp(r).test(x)) go(); }
      }`, 'unknown'), 'RegExp');
    assert.strictEqual(f.length, 1);
    assert.strictEqual(f[0].severity, 'high');
  });

  test('hors boucle, rien', () => {
    const f = analyze(`export const re = new RegExp('^a');`, 'unknown');
    assert.deepStrictEqual(messages(f), []);
  });

  test('une autre instanciation en boucle ne déclenche pas cette règle', () => {
    // `new` en boucle reste volontairement non signalé en JS.
    const f = analyze(`
      export function f(ps) { for (const p of ps) { out.push(new Point(p)); } }`, 'unknown');
    assert.deepStrictEqual(messages(f), []);
  });
});

// --- Table des contextes --------------------------------------------------

describe('applicabilité par contexte', () => {
  test('les règles serveur et client s\'excluent', () => {
    assert.ok(ruleAppliesIn('sync-io-in-function', 'server'));
    assert.ok(!ruleAppliesIn('sync-io-in-function', 'client'));
    assert.ok(ruleAppliesIn('polling-interval', 'client'));
    assert.ok(!ruleAppliesIn('polling-interval', 'server'));
  });

  test('une règle restreinte ne se déclenche jamais sur un contexte indéterminé', () => {
    for (const rule of ['sync-io-in-function', 'polling-interval',
                        'unthrottled-event-listener', 'whole-library-import']) {
      assert.ok(!ruleAppliesIn(rule, 'unknown'), `${rule} devrait se taire`);
    }
  });

  test('les règles universelles valent dans les trois contextes', () => {
    for (const context of ['client', 'server', 'unknown']) {
      assert.ok(ruleAppliesIn('nested-loops', context));
      assert.ok(ruleAppliesIn('sql-without-limit', context));
    }
  });

  test('Java n\'est pas affecté : ses six règles sont universelles', () => {
    for (const rule of specFor('java').rules) {
      assert.ok(ruleAppliesIn(rule, 'server'));
      assert.ok(ruleAppliesIn(rule, 'unknown'));
    }
  });
});
