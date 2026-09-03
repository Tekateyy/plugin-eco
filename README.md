# plugin-eco

Extension VSCode qui note la sobriété énergétique du code **Java, JavaScript et
TypeScript**, avec une étiquette **A → E** empruntée au DPE des logements.

L'analyse est statique et locale : le fichier est parsé à la frappe, les
patterns énergivores connus sont signalés en annotations inline, et le score du
fichier s'affiche dans la barre de statut.

```
┌─ éditeur ────────────────────────┐   ┌─ panneau ───────────────┐
│ for (int i..) {                  │   │                         │
│   for (int j..) {   <- imbriquée │   │         ┌───┐           │
│     s += row[j];    <- String += │   │         │ E │  28/100   │
│   }                              │   │         └───┘           │
│ }                                │   │  4 hautes, 3 moyennes   │
│                                  │   │  détail par ligne...    │
└──────────────────────────────────┘   └─────────────────────────┘
   barre de statut :  Éco: E
```

## Utilisation

Ouvrir un fichier `.java` : l'analyse démarre seule. Trois commandes dans la
palette (`Ctrl+Shift+P`) :

| Commande | Effet |
|---|---|
| `Greencoding: Analyser le fichier` | relance l'analyse du fichier actif |
| `Greencoding: Ouvrir le rapport détaillé` | ouvre le panneau, score + détail par ligne |
| `Greencoding: Analyser tout le workspace` | scanne tous les `.java`, classe les fichiers du pire au meilleur |

## Ce qui est détecté

**Partout**, quel que soit le langage et l'endroit où le code s'exécute :

| Pattern | Sévérité | Pénalité |
|---|---|---|
| Boucle imbriquée (complexité ≥ O(n²)) | haute | 15 |
| Requête SQL sans `LIMIT` | haute | 12 |
| `await` dans une boucle (appels enchaînés) | haute | 12 |
| Regex recompilée en boucle | haute | 12 |

**Côté serveur** — le coût est payé une fois, par le processus :

| Pattern | Sévérité | Pénalité |
|---|---|---|
| I/O synchrone dans une fonction (`readFileSync`, `execSync`…) | haute | 12 |
| I/O bloquant en boucle *(Java)* | haute | 12 |

**Côté navigateur** — le coût est payé par l'appareil de chaque visiteur :

| Pattern | Sévérité | Pénalité |
|---|---|---|
| `setInterval` de moins d'une seconde | haute | 12 |
| `setInterval` plus espacé | moyenne | 7 |
| Gestionnaire `scroll`/`resize`/`mousemove` sans limitation de débit | moyenne | 7 |
| Import global d'une bibliothèque lourde (`lodash`, `moment`…) | moyenne | 7 |

**Java seulement** : concaténation `+=` en boucle et `new` en boucle (moyenne, 7
chacune). Ces deux règles ne s'appliquent **pas** à JavaScript, et c'est
délibéré : V8 représente les concaténations par des *ropes*, et son
ramasse-miettes générationnel rend l'allocation à courte durée de vie bon
marché. Les signaler reviendrait à crier au loup sur du code sain.

Une règle restreinte à un côté ne se déclenche **jamais** sur un fichier dont le
contexte est indéterminé : sans certitude, le plugin se tait.

Le score part de 100, chaque détection retranche sa pénalité, et le reste donne
la lettre : **A** ≥ 90, **B** ≥ 75, **C** ≥ 55, **D** ≥ 35, **E** en dessous.

Sur un scan de projet, la note globale est la moyenne des **seuls fichiers qui
présentent au moins une alerte**. Les fichiers sains n'y entrent pas : sans
cela, une poignée de modules utilitaires vides suffisait à ramener un projet à
**A** en noyant le fichier qui pose réellement problème. Le nombre de fichiers
concernés est affiché à côté de la lettre, et le pire d'entre eux est mis en
avant — une lettre unique ne peut pas désigner un endroit.

## Développement

```bash
npm install
npm test
```

Puis `F5` dans VSCode pour lancer une fenêtre de test, et ouvrir un des exemples
de `samples/` : `Example.java` déclenche les six règles Java, `example.ts` montre
ce qui s'applique hors contexte connu, `example-web.tsx` déclenche les règles
navigateur.

Les tests utilisent `node:test`, sans dépendance supplémentaire, et s'exécutent
sur le code compilé — donc sur ce qui part réellement dans l'extension. Ils
couvrent chaque règle (déclenchement et non-déclenchement), les seuils de
l'étiquette, et le résultat attendu sur `samples/Example.java`.

Pour produire l'extension installable :

```bash
npm run package
```

## En intégration continue

Le même moteur s'utilise en ligne de commande, pour bloquer une pipeline sous un
seuil :

```bash
npx plugin-eco --min C src/
```

| | |
|---|---|
| `--format <text\|json>` | sortie lisible ou exploitable par un script |
| `--min <A..E>` | note minimale acceptée |
| code de sortie | `0` conforme · `1` sous le seuil · `2` erreur d'utilisation |

Les positions sont rendues au format `fichier:ligne:colonne`, reconnu par la
plupart des annotateurs de CI et cliquable dans un terminal.

```yaml
- name: Green check
  run: npx plugin-eco --min C src/
```

L'analyse est strictement la même que dans l'éditeur : le CLI et l'extension
partagent le parseur, les règles, l'inférence de contexte et le calcul de score.
Un verdict qui différerait entre l'IDE et la pipeline ruinerait la confiance dans
les deux.

Le moteur s'utilise aussi comme bibliothèque, pour bâtir un rapport sur mesure :

```js
const { initParser, parse, collectFindings, computeScore, specFor } = require('plugin-eco');

await initParser();
const findings = collectFindings(parse(source, 'java').rootNode, specFor('java'));
console.log(computeScore(findings).letter); // 'A' … 'E'
```

Ce point d'entrée n'expose que le moteur : le code d'intégration VSCode en est
absent, et rien n'y importe `vscode`.

## Choix techniques

**Analyse statique d'abord, mesure à l'exécution ensuite.** Un profileur donne
des watts réels mais impose de compiler et d'exécuter le code ; l'analyse
statique tient sous la seconde et tourne pendant la frappe. C'est la condition
pour que l'information arrive au moment où le développeur peut encore agir.

**Une lettre plutôt que des watt-heures.** Une estimation en Wh sur du code non
exécuté serait une fausse précision. La lettre assume ce qu'elle est — un
classement relatif — et parle immédiatement. Les Wh et le CO₂ viendront avec la
mesure à l'exécution, où ils seront mesurés plutôt que devinés.

**tree-sitter plutôt qu'une analyse par expressions régulières.** Distinguer une
boucle imbriquée d'une boucle voisine, ou un `new` dans une boucle d'un `new`
juste après, demande un arbre syntaxique. tree-sitter le fournit pour de
nombreux langages avec un seul parseur — Python reste à ajouter.

**Un descripteur de langage, pas des conditions dispersées.** Tout ce qui varie
d'un langage à l'autre — grammaire, noms de nœuds tree-sitter, règles
applicables — est déclaré dans `src/languages.ts`. Les autres modules n'y font
aucune référence. Ajouter Python revient à ajouter une entrée.

**Le contexte d'exécution se déduit du code, pas des chemins.** Un `setInterval`
de *polling* coûte une fois sur un serveur et autant de fois qu'il y a de
visiteurs dans un navigateur : le plugin doit savoir où tourne le fichier. Il le
lit dans l'arbre déjà parsé — imports de modules Node d'un côté, globales du
navigateur et JSX de l'autre — plutôt que d'imposer une convention de dossiers,
qui diffère à chaque framework. Seuls les indices francs comptent, et des
indices contradictoires donnent « indéterminé » : en rendu côté serveur, un
fichier tourne réellement des deux côtés.

**Deux grammaires pour JS/TS, pas trois.** `tsx` est un sur-ensemble de
`javascript` et couvre `.js`, `.jsx` et `.tsx`. Mais elle ne peut pas remplacer
`typescript` pour les `.ts` : elle lit l'assertion `<Type>valeur` comme une
ouverture JSX et perd la suite du fichier. Mesuré plutôt que supposé — un `.ts`
contenant une telle assertion voyait ses trois boucles disparaître.

**Les grammaires WASM sont copiées dans `out/` au build.** Une extension
installée n'a pas les `node_modules` de développement sous la main : le script
`scripts/copy-wasm.js` place le runtime tree-sitter et la grammaire Java dans
`out/wasm/`, que l'extension résout depuis sa propre racine.

## État

Analyse statique de Java, JavaScript et TypeScript, avec un jeu de règles web
qui distingue le code serveur du code navigateur. Python, la mesure à
l'exécution (Wh et CO₂) et un portage IntelliJ sont les étapes suivantes.

## Licence

MIT — voir [LICENSE](LICENSE).
