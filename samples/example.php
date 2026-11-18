<?php
// Fichier de démonstration PHP.
//
// Deux règles s'appliquent : boucle imbriquée et requête SQL sans LIMIT.
// Les autres règles sont volontairement absentes de PHP — voir les cas
// « NON signalés » plus bas.

function totalPerMatrix(array $matrix, array $rates): array
{
    // Boucle imbriquée : signalée.
    $totals = [];
    foreach ($matrix as $row) {
        $total = 0;
        foreach ($row as $value) {
            $total += $value * $rates[$value % count($rates)];
        }
        $totals[] = $total;
    }
    return $totals;
}

function sumSuccessive(array $xs, array $ys): int
{
    // Boucles successives : rien à signaler.
    $total = 0;
    foreach ($xs as $x) {
        $total += $x;
    }
    foreach ($ys as $y) {
        $total += $y;
    }
    return $total;
}

// Requête sans pagination : signalée.
const ALL_USERS = "SELECT id, name FROM users";

// Requête paginée : rien à signaler.
const RECENT_USERS = "SELECT id, name FROM users ORDER BY created_at DESC LIMIT 50";

function allOrders(PDO $db, string $table)
{
    // Interpolation : signalée aussi, la requête reste une requête.
    return $db->query("SELECT * FROM $table");
}

function allInvoices(PDO $db)
{
    // Heredoc sans pagination : signalé.
    $sql = <<<SQL
        SELECT id, total FROM invoices
        SQL;
    return $db->query($sql);
}

function buildReport(array $items): string
{
    // `.=` en boucle : volontairement NON signalé. PHP étend la chaîne sur
    // place quand elle n'a qu'une référence, et `$out .= …` en boucle est la
    // façon normale de construire une sortie.
    $report = '';
    foreach ($items as $item) {
        $report .= $item . "\n";
    }
    return $report;
}

function validateEmails(array $emails): array
{
    // `preg_match()` en boucle : volontairement NON signalé. PHP met les motifs
    // compilés en cache, il n'y a rien à sortir de la boucle.
    $results = [];
    foreach ($emails as $email) {
        $results[] = preg_match('/^[\w.-]+@[\w.-]+\.[a-z]{2,}$/', $email) === 1;
    }
    return $results;
}
