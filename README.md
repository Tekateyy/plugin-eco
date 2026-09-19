# plugin-eco

Extension VSCode qui note la sobriété énergétique du code **Java, JavaScript,
TypeScript et Python**, avec une étiquette **A → E** empruntée au DPE des
logements.

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

Ouvrir un fichier `.java`, `.js`, `.ts` ou `.py` : l'analyse démarre seule.
Trois commandes dans la palette (`Ctrl+Shift+P`) :

| Commande | Effet |
|---|---|
| `Greencoding: Analyser le fichier` | relance l'analyse du fichier actif |
| `Greencoding: Ouvrir le rapport détaillé` | ouvre le panneau, score + détail par ligne |
| `Greencoding: Analyser tout le workspace` | scanne tous les fichiers supportés, classe les fichiers du pire au meilleur |

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
| I/O synchrone dans une fonction (`readFileSync`, `execSync`…) *(JS/TS)* | haute | 12 |
| I/O bloquant en boucle *(Java)* | haute | 12 |

**Côté navigateur** — le coût est payé par l'appareil de chaque visiteur :

| Pattern | Sévérité | Pénalité |
|---|---|---|
| `setInterval` de moins d'une seconde | haute | 12 |
| `setInterval` plus espacé | moyenne | 7 |
| Gestionnaire `scroll`/`resize`/`mousemove` sans limitation de débit | moyenne | 7 |
| Import global d'une bibliothèque lourde (`lodash`, `moment`…) | moyenne | 7 |

**Java seulement** : concaténation `+=` en boucle et `new` en boucle (moyenne, 7
chacune). Ces deux règles ne s'appliquent **pas** à JavaScript ni à Python, et
c'est délibéré : V8 représente les concaténations par des *ropes* et son
ramasse-miettes générationnel rend l'allocation à courte durée de vie bon
marché ; CPython, lui, réalloue `s += t` sur place quand la chaîne n'a qu'une
référence, et `total += 1` en boucle est un idiome trop courant pour être
signalé. Les deux langages arrivent à la même exclusion par des chemins
différents.

Une règle restreinte à un côté ne se déclenche **jamais** sur un fichier dont le
contexte est indéterminé : sans certitude, le plugin se tait.

### Désactiver une règle

Chaque règle a un identifiant stable (`nested-loops`, `sql-without-limit`…),
listé par `plugin-eco --list-rules`. Une règle qui ne convient pas à un projet
se désactive sans y toucher :

- **Dans l'éditeur**, via le réglage `plugin-eco.disabledRules` (liste
  d'identifiants) dans les paramètres VSCode.
- **En CI**, via `--ignore-rule <id>` sur le CLI, répétable.

Les deux mécanismes filtrent après coup, sur le même résultat que la règle
active aurait produit ailleurs : le score et l'étendue affichés tiennent compte
de la désactivation, dans l'éditeur comme en pipeline.

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
navigateur, `example.py` déclenche les quatre règles portées à Python.

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
| `--format <text\|json\|github>` | sortie lisible, exploitable par un script, ou annotations GitHub |
| `--min <A..E>` | note minimale acceptée |
| `--ignore-rule <id>` | ignore cette règle, répétable — voir `--list-rules` |
| code de sortie | `0` conforme · `1` sous le seuil · `2` erreur d'utilisation |

Les positions sont rendues au format `fichier:ligne:colonne`, reconnu par la
plupart des annotateurs de CI et cliquable dans un terminal.

```yaml
- name: Green check
  run: npx plugin-eco --min C src/
```

### Sur GitHub Actions : `--format github`

Un `--min C` qui échoue en `text` fait un step rouge, mais il faut ouvrir le log
pour savoir pourquoi. `--format github` rend le même verdict visible sans cette
étape :

```yaml
- name: Green check
  run: npx plugin-eco --min C --format github src/
```

- Chaque alerte devient une annotation ancrée sur sa ligne — visible directement
  dans l'onglet *Files changed* de la PR et dans *Checks*. La sévérité fixe le
  niveau (`::error` haute, `::warning` moyenne, `::notice` faible) ; GitHub
  n'en affiche que 10 par niveau et par step, les suivantes sont tronquées —
  les pires fichiers passent donc en premier, comme dans les autres formats.
- Un résumé Markdown — étiquette, tableau des fichiers concernés, détail replié
  par alerte — est écrit sur la page du run (`$GITHUB_STEP_SUMMARY`), sans
  cette limite.
- Si le seuil `--min` n'est pas atteint, le verdict lui-même devient une
  annotation d'erreur, en plus du message habituel sur stderr et du code de
  sortie 1.

Hors GitHub Actions (`$GITHUB_STEP_SUMMARY` absent), seules les commandes et le
Markdown partent sur stdout — pratique pour vérifier le rendu en local avant de
le pousser.

L'analyse est strictement la même que dans l'éditeur, quel que soit le format :
le CLI et l'extension partagent le parseur, les règles, l'inférence de contexte
et le calcul de score. Un verdict qui différerait entre l'IDE et la pipeline
ruinerait la confiance dans les deux.

Le moteur s'utilise aussi comme bibliothèque, pour bâtir un rapport sur mesure :

```js
const { initParser, parse, collectFindings, computeScore, specFor } = require('plugin-eco');

await initParser();
const findings = collectFindings(parse(source, 'java').rootNode, specFor('java'));
console.log(computeScore(findings).letter); // 'A' … 'E'
```

Ce point d'entrée n'expose que le moteur : le code d'intégration VSCode en est
absent, et rien n'y importe `vscode`.

## Mesure à l'exécution (prototype)

L'étiquette A–E est une estimation statique. `plugin-eco measure` mesure pour
de vrai, sur un script Node ou Python qui se termine de lui-même — pas un
serveur — en l'exécutant réellement, langage détecté par l'extension du
fichier :

```bash
npx plugin-eco measure script.js
```

```
Mesure de script.js
  CPU        1.84 s (user 1.71 · system 0.13)
  Durée      2.02 s
  Mémoire    max 58 Mo
  Énergie    ≈ 0.0041 Wh      ≈ 0.21 mg CO₂
  Hypothèses 8.1 W/cœur (TDP 65 W / 8 cœurs), 0.392 W/Go, 52 gCO₂/kWh
```

Le CPU et la RAM réels se convertissent en Wh via des coefficients standards
(modèle Cloud Carbon Footprint), affichés en clair avec le résultat — ce sont
des hypothèses, pas des mesures, et `--tdp`, `--cores` et `--carbon` les
ajustent. `--format json` rend la même mesure exploitable par un script.

`--runs <n>` répète l'exécution et retient la médiane de chaque grandeur
(CPU, RAM, durée), avec l'étendue observée affichée à côté — utile si une
seule exécution semble bruitée :

```bash
npx plugin-eco measure --runs 5 script.js
```

```
Mesure de script.js — médiane de 5 exécutions
  CPU        1.79 s (user 1.68 · system 0.11)
  Durée      1.94 s
  Mémoire    max 58 Mo
  Étendue    CPU 1.71–1.98 s · durée 1.85–2.10 s
  Énergie    ≈ 0.0040 Wh      ≈ 0.21 mg CO₂
  Hypothèses 8.1 W/cœur (TDP 65 W / 8 cœurs), 0.392 W/Go, 52 gCO₂/kWh
```

Une exécution en échec arrête la série : son code de sortie est rendu tel
quel, avec la médiane des exécutions déjà faites.

Pour un script `.py`, `--python <exécutable>` cible un interpréteur précis
(un venv, une version donnée) ; par défaut, `python` sous Windows, `python3`
ailleurs :

```bash
npx plugin-eco measure script.py
npx plugin-eco measure --python .venv/bin/python script.py
```

Prototype volontairement limité à Node et Python. Étape suivante si le modèle
tient : Java, selon le même principe (une sonde exécutée à la place du
programme mesuré).

## Choix techniques

**Analyse statique d'abord, mesure à l'exécution ensuite.** Un profileur donne
des watts réels mais impose de compiler et d'exécuter le code ; l'analyse
statique tient sous la seconde et tourne pendant la frappe. C'est la condition
pour que l'information arrive au moment où le développeur peut encore agir.

**Une lettre plutôt que des watt-heures.** Une estimation en Wh sur du code non
exécuté serait une fausse précision. La lettre assume ce qu'elle est — un
classement relatif, comparable entre fichiers — et parle immédiatement. Les Wh
et le CO₂ que rend `plugin-eco measure` sont un axe séparé, mesuré plutôt que
deviné, et n'entrent délibérément pas dans le calcul de la lettre : les
mélanger casserait la comparabilité qui fait la valeur de l'étiquette.

**La mesure runtime encadre le script mesuré, elle ne l'instrumente pas.**
`node --require probe.js script.js` précharge la sonde dans le processus
mesuré ; `python probe.py script.py` l'exécute à la place du script, qu'elle
relance elle-même via `runpy`. Les deux mesurent le processus réel (CPU, RAM,
durée) sans transformer le script mesuré ni ajouter de dépendance d'exécution,
et écrivent le même résultat en JSON. Java (prochaine étape) suivra le même
principe, adapté à son propre mécanisme de lancement.

**Python n'a pas d'équivalent à `node --require <chemin arbitraire>`.**
`sitecustomize.py` — l'option envisagée d'abord — impose un nom de fichier
fixe posé sur un `PYTHONPATH` dédié : il faudrait le fusionner avec celui de
l'utilisateur sans l'écraser, et il masquerait un `sitecustomize.py` que son
environnement aurait déjà. Le wrapper (même principe que `python -m
cProfile`) évite les deux : un chemin de fichier libre, comme `probe.js`.

**RSS Python : la bibliothèque standard par plateforme, pas `psutil`.**
`resource.getrusage()` n'existe pas sous Windows. Plutôt qu'une dépendance
unifiée — qui s'installerait dans l'environnement de *l'utilisateur final*,
puisque la sonde tourne dans son processus, pas dans celui du plugin —
`probe.py` utilise `ctypes` + `GetProcessMemoryInfo` (psapi.dll) sous Windows
et `resource.getrusage().ru_maxrss` sous Linux/macOS.

**Seul `measure` exécute du code, et seulement sur commande.** L'analyse
statique ne fait que lire : elle tourne à la frappe, à la sauvegarde, sur tout
un workspace, sans jamais lancer de processus. `plugin-eco measure` est
l'unique exception, réservée au CLI : l'extension VSCode et le point d'entrée
`require('plugin-eco')` ne peuvent pas y mener, et un test le vérifie sur le
code packagé. Les sondes elles-mêmes n'écrivent que leur mesure, dans un
répertoire temporaire privé, et ne dépendent que de leur bibliothèque
standard respective.

**tree-sitter plutôt qu'une analyse par expressions régulières.** Distinguer une
boucle imbriquée d'une boucle voisine, ou un `new` dans une boucle d'un `new`
juste après, demande un arbre syntaxique. tree-sitter le fournit pour de
nombreux langages avec un seul parseur.

**Un descripteur de langage, pas des conditions dispersées.** Tout ce qui varie
d'un langage à l'autre — grammaire, noms de nœuds tree-sitter, règles
applicables — est déclaré dans `src/languages.ts`. Les autres modules n'y font
aucune référence : ajouter Python s'est fait sans toucher au moteur de règles,
seulement à ce descripteur et aux quelques endroits qui lisaient une structure
d'appel propre à Java (`object`/`name`) plutôt que la forme générique
`function` → `member_expression`/`attribute` partagée par JS et Python.

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

**Désactiver une règle est un réglage, pas un commentaire dans le code ni une
quick fix.** Une entrée dans `disabledRules` (éditeur) ou `--ignore-rule` (CLI)
suffit à documenter et à appliquer le choix sans toucher aux fichiers analysés.
Un commentaire d'échappement (`// eco-ignore`) ou une quick fix qui l'insère
automatiquement demanderaient un mécanisme par ligne, pas seulement par règle —
à envisager si la désactivation par projet entier se révèle trop grossière.

**Des workflow commands GitHub, pas du SARIF.** L'onglet *Security / Code
scanning* attend un upload SARIF, gratuit seulement sur dépôt public et qui
demande une action dédiée (`upload-sarif`) en plus du CLI. Les *workflow
commands* (`::error file=…`) tiennent en une ligne par alerte sur stdout, ne
demandent aucune action tierce, et couvrent le besoin réel — voir l'annotation
sur la ligne fautive. À reconsidérer si le suivi dans le temps (alertes
ouvertes/résolues d'un run à l'autre) devient un besoin démontré.

**Les grammaires WASM sont copiées dans `out/` au build.** Une extension
installée n'a pas les `node_modules` de développement sous la main : le script
`scripts/copy-wasm.js` place le runtime tree-sitter et la grammaire Java dans
`out/wasm/`, que l'extension résout depuis sa propre racine.

## État

Analyse statique de Java, JavaScript, TypeScript et Python, avec un jeu de
règles web qui distingue le code serveur du code navigateur. Mesure à
l'exécution (Wh et CO₂) en prototype, pour Node et Python. Java et le portage
IntelliJ sont les étapes suivantes.

Le détail des changements par version est dans [CHANGELOG.md](CHANGELOG.md).

## Licence

MIT — voir [LICENSE](LICENSE).
