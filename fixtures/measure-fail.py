# Fixture pour test/measure.test.js : pendant Python de measure-fail.js. Sort
# en échec pour vérifier que runMeasured remonte quand même une mesure — le
# callback atexit de la sonde tourne avant que l'interpréteur ne se termine.
raise SystemExit(3)
