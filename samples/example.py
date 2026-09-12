# Fichier de démonstration Python.
#
# Quatre règles s'appliquent : boucle imbriquée, re.compile() en boucle,
# requête SQL sans LIMIT, et await en boucle (asyncio). Python n'a pas de
# `new` (object-creation-in-loop n'a rien à lire) et `+=` en boucle est
# volontairement exclu — voir plus bas.

import re


def total_per_matrix(matrix, rates):
    """Boucle imbriquée : signalée."""
    totals = []
    for row in matrix:
        total = 0
        for value in row:
            total += value * rates[value % len(rates)]
        totals.append(total)
    return totals


def validate_emails(emails):
    """re.compile() en boucle : signalée."""
    results = []
    for email in emails:
        pattern = re.compile(r"^[\w.-]+@[\w.-]+\.[a-z]{2,}$")
        results.append(pattern.match(email) is not None)
    return results


EMAIL_PATTERN = re.compile(r"^[\w.-]+@[\w.-]+\.[a-z]{2,}$")


def validate_email(email):
    """re.compile() hors boucle : rien à signaler."""
    return EMAIL_PATTERN.match(email) is not None


ALL_USERS = "SELECT id, name FROM users"
"""Requête sans pagination : signalée."""

RECENT_USERS = "SELECT id, name FROM users ORDER BY created_at DESC LIMIT 50"
"""Requête paginée : rien à signaler."""


async def fetch_all(ids, db):
    """await en boucle : signalée — les appels s'enchaînent."""
    rows = []
    for id_ in ids:
        rows.append(await db.get(id_))
    return rows


async def fetch_all_concurrent(ids, db):
    """Attentes concurrentes : rien à signaler, ce n'est pas une boucle séquentielle."""
    import asyncio
    return await asyncio.gather(*(db.get(id_) for id_ in ids))


def build_report(items):
    """
    Concaténation `+=` en boucle : volontairement NON signalée. CPython
    réalloue `s += t` sur place quand la chaîne n'a qu'une référence, et
    `total += 1` en boucle est un idiome courant — la règle produirait du
    bruit sur du code sain. Même choix que pour JS/TS, pour une raison
    différente.
    """
    report = ""
    for item in items:
        report += item + "\n"
    return report
