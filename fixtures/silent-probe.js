// Sonde de substitution pour test/measure.test.js : contrairement à
// src/probe.js, elle ne s'accroche à aucun événement et n'écrit jamais de
// fichier de mesure. Sert à déclencher le chemin défensif de runMeasured()
// (aucune mesure produite) sans avoir à provoquer une vraie panne d'E/S.
