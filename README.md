# plugin-eco

Extension VSCode qui note la sobriété énergétique du code Java, avec une
étiquette **A → E** empruntée au DPE des logements.

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

| Pattern | Sévérité | Pénalité |
|---|---|---|
| Boucle imbriquée (complexité ≥ O(n²)) | haute | 15 |
| `Pattern.compile()` en boucle | haute | 12 |
| I/O bloquant en boucle (`readLine`, `read`, `nextLine`…) | haute | 12 |
| Requête SQL sans `LIMIT` | haute | 12 |
| Concaténation `+=` en boucle | moyenne | 7 |
| `new` en boucle | moyenne | 7 |

Le score part de 100, chaque détection retranche sa pénalité, et le reste donne
la lettre : **A** ≥ 90, **B** ≥ 75, **C** ≥ 55, **D** ≥ 35, **E** en dessous.

## Développement

```bash
npm install
npm run compile
```

Puis `F5` dans VSCode pour lancer une fenêtre de test, et ouvrir
`samples/Example.java` — il déclenche les six règles.

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
juste après, demande un arbre syntaxique. tree-sitter le fournit pour Java,
Python et JS avec un seul parseur — les deux autres langages sont prévus.

**Les grammaires WASM sont copiées dans `out/` au build.** Une extension
installée n'a pas les `node_modules` de développement sous la main : le script
`scripts/copy-wasm.js` place le runtime tree-sitter et la grammaire Java dans
`out/wasm/`, que l'extension résout depuis sa propre racine.

## État

Java uniquement, analyse statique. Python et Node.js, la mesure à l'exécution
(Wh et CO₂) et un portage IntelliJ sont les étapes suivantes.

## Licence

MIT — voir [LICENSE](LICENSE).
