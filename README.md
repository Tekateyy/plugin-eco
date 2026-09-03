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

| Pattern | Sévérité | Pénalité | Langages |
|---|---|---|---|
| Boucle imbriquée (complexité ≥ O(n²)) | haute | 15 | tous |
| Requête SQL sans `LIMIT` | haute | 12 | tous |
| `Pattern.compile()` en boucle | haute | 12 | Java |
| I/O bloquant en boucle (`readLine`, `read`, `nextLine`…) | haute | 12 | Java |
| Concaténation `+=` en boucle | moyenne | 7 | Java |
| `new` en boucle | moyenne | 7 | Java |

Les deux dernières règles ne s'appliquent **pas** à JavaScript et TypeScript, et
c'est délibéré : V8 représente les concaténations par des *ropes*, et son
ramasse-miettes générationnel rend l'allocation à courte durée de vie bon
marché. Les signaler reviendrait à crier au loup sur du code sain.

Les règles propres au web — `await` en boucle, I/O synchrones côté serveur,
*polling*, handlers non *debouncés*, imports de bibliothèques entières —
restent à écrire.

Le score part de 100, chaque détection retranche sa pénalité, et le reste donne
la lettre : **A** ≥ 90, **B** ≥ 75, **C** ≥ 55, **D** ≥ 35, **E** en dessous.

## Développement

```bash
npm install
npm test
```

Puis `F5` dans VSCode pour lancer une fenêtre de test, et ouvrir
`samples/Example.java` — il déclenche les six règles — ou `samples/example.ts`,
qui montre ce qui s'applique à TypeScript et ce qui n'est volontairement pas
signalé.

Les tests utilisent `node:test`, sans dépendance supplémentaire, et s'exécutent
sur le code compilé — donc sur ce qui part réellement dans l'extension. Ils
couvrent chaque règle (déclenchement et non-déclenchement), les seuils de
l'étiquette, et le résultat attendu sur `samples/Example.java`.

Pour produire l'extension installable :

```bash
npm run package
```

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

Analyse statique de Java, JavaScript et TypeScript. Pour JS/TS, seules les deux
règles indépendantes du langage sont actives à ce stade : le jeu de règles
propre au web est la prochaine étape, suivi de Python, de la mesure à
l'exécution (Wh et CO₂) et d'un portage IntelliJ.

## Licence

MIT — voir [LICENSE](LICENSE).
