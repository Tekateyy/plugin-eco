# Journal des modifications

Ce format s'inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Le projet suit [SemVer](https://semver.org/lang/fr/) ; la version publiée est
celle du champ `version` de `package.json`.

## [Non publié]

### Ajouté
- Mesure runtime pour Python : `plugin-eco measure script.py` mesure CPU, RAM
  et durée réels, comme pour Node. `--python <exécutable>` cible un
  interpréteur précis (venv, version) ; par défaut, `python` sous Windows,
  `python3` ailleurs.
- `--runs <n>` sur `plugin-eco measure` : répète l'exécution et retient la
  médiane de chaque grandeur (CPU, RAM, durée), avec l'étendue observée
  affichée à côté du résultat.

### Sécurité
- La sonde de `plugin-eco measure` écrit sa mesure dans un répertoire
  temporaire privé plutôt qu'un fichier au nom prévisible.
