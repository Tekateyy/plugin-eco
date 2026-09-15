// Fixture pour test/measure.test.js : un script qui sort en échec, pour
// vérifier que `runMeasured` remonte quand même une mesure (le handler `exit`
// de la sonde tourne avant que le processus ne se termine réellement).
process.exit(3);
