# Journal des modifications

Ce format s'inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Le projet suit [SemVer](https://semver.org/lang/fr/) ; la version publiée est
celle du champ `version` de `package.json`.

## [Non publié]

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
