# Journal des modifications

Ce format s'inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Le projet suit [SemVer](https://semver.org/lang/fr/) ; la version publiée est
celle du champ `version` de `package.json`.

## [Non publié]

### Ajouté
- Mesure à l'exécution dans VSCode : commande « Greencoding: Mesurer le fichier
  actif » et bouton « Mesurer » du rapport. Résultat dans un panneau à part,
  sortie du script dans l'onglet Sortie, mesure annulable.
- `plugin-eco measure` mesure aussi un `.jar` exécutable ou un fichier `.java`,
  avec `--java <exécutable>` pour choisir la JVM (21 ou plus).
- Un fichier de plus de 1 Mo n'est plus analysé dans l'éditeur : la barre d'état
  affiche « fichier trop volumineux ». Le CLI l'analyse toujours et prévient que
  cela peut prendre plusieurs secondes.

### Corrigé
- Une phrase du type « Select a file from the list » n'est plus prise pour une
  requête SQL sans `LIMIT`.

## [0.5.0] — 2026-11-17

### Ajouté
- Analyse statique du PHP (`.php`) : boucle imbriquée et requête SQL sans
  `LIMIT`, chaînes interpolées, heredoc et nowdoc compris.
- `plugin-eco measure` mesure aussi un script PHP, avec `--php <exécutable>`
  pour choisir l'interpréteur.

## [0.4.0] — 2026-10-12

### Ajouté
- Publication sur le Marketplace VSCode, sous l'éditeur `tekateyy`
  (ID de l'extension : `tekateyy.plugin-eco`). Jusqu'ici, seul le paquet npm
  était publié.

### Corrigé
- Les notes de travail locales ne sont plus incluses dans les paquets npm et
  `.vsix`.

## [0.3.0] — 2026-09-18

### Ajouté
- Nouvelle sous-commande `plugin-eco measure <script>` : exécute le script pour
  de vrai et mesure sa consommation réelle (CPU, RAM, durée), convertie en Wh
  et gCO₂ via des coefficients affichés en clair (`--tdp`, `--cores`,
  `--carbon` pour les ajuster). Complète l'étiquette A–E, qui reste une
  estimation statique.
- Support Python pour `plugin-eco measure script.py`, en plus de Node.
  `--python <exécutable>` cible un interpréteur précis (venv, version) ; par
  défaut, `python` sous Windows, `python3` ailleurs.
- `--runs <n>` sur `plugin-eco measure` : répète l'exécution et retient la
  médiane de chaque grandeur (CPU, RAM, durée), avec l'étendue observée
  affichée à côté du résultat.

### Sécurité
- La sonde de `plugin-eco measure` écrit sa mesure dans un répertoire
  temporaire privé plutôt qu'un fichier au nom prévisible.
