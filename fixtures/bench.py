# Fixture pour `plugin-eco measure` — pendant Python de bench.js. Brûle un peu
# de CPU et alloue un peu de mémoire, se termine de lui-même.
#
# Silencieux volontairement (pas de print) : mêmes raisons que bench.js, voir
# son commentaire — `measure` hérite le stdout du script mesuré.
total = 0.0
data = []
for i in range(20_000_000):
    total += i ** 0.5
    if i % 500 == 0:
        data.append(bytearray(1024))

if total < 0:
    raise SystemExit(1)
