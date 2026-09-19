# Sonde de mesure runtime pour Python — wrapper, pas une instrumentation.
#
# Lancée comme `python probe.py script.py [args...]` : elle s'installe, puis
# exécute script.py à sa place via runpy, comme le fait `python -m cProfile`.
# Aucun PYTHONPATH à manipuler, aucun sitecustomize.py à poser dans un dossier
# temporaire (qui masquerait celui de l'utilisateur s'il en a un) — un chemin
# de fichier arbitraire, comme le `--require probe.js` de Node.
#
# Contrat identique à src/probe.js : aucune sortie sur stdout/stderr, écrit
# uniquement le résultat en JSON dans PLUGIN_ECO_PROBE_OUT à la fin du script
# mesuré (via atexit, qui s'exécute même sur exception ou sys.exit()).
# measure.ts en est le seul lecteur.

import atexit
import json
import os
import runpy
import sys
import time

_started_at = time.perf_counter()


def _max_rss_bytes():
    """Pic de mémoire résidente, en octets. None si indisponible sur cette
    plateforme — measure.ts traite déjà ce cas comme 0 pour le terme RAM
    (voir estimate(), déjà nullable côté Node)."""
    if sys.platform == 'win32':
        return _max_rss_windows()
    try:
        import resource
        maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # ru_maxrss est en Ko sous Linux, déjà en octets sous macOS.
        return maxrss if sys.platform == 'darwin' else maxrss * 1024
    except ImportError:
        return None


def _max_rss_windows():
    """`resource` n'existe pas sous Windows. GetProcessMemoryInfo (psapi.dll)
    donne le pic de working set, sans dépendance ajoutée."""
    try:
        import ctypes
        import ctypes.wintypes as wt

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ('cb', wt.DWORD),
                ('PageFaultCount', wt.DWORD),
                ('PeakWorkingSetSize', ctypes.c_size_t),
                ('WorkingSetSize', ctypes.c_size_t),
                ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
                ('QuotaPagedPoolUsage', ctypes.c_size_t),
                ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                ('PagefileUsage', ctypes.c_size_t),
                ('PeakPagefileUsage', ctypes.c_size_t),
            ]

        psapi = ctypes.WinDLL('psapi.dll')
        kernel32 = ctypes.WinDLL('kernel32.dll')
        # Sans argtypes/restype explicites, l'appel « réussit » (retourne 1)
        # mais rend des champs à zéro sur un interpréteur 64 bits : les
        # pointeurs sont alors tronqués en int 32 bits par défaut.
        psapi.GetProcessMemoryInfo.argtypes = [
            wt.HANDLE, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), wt.DWORD,
        ]
        psapi.GetProcessMemoryInfo.restype = wt.BOOL
        kernel32.GetCurrentProcess.restype = wt.HANDLE

        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        handle = kernel32.GetCurrentProcess()
        if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            return None
        return counters.PeakWorkingSetSize
    except OSError:
        return None


def _write_measurement():
    out_path = os.environ.get('PLUGIN_ECO_PROBE_OUT')
    if not out_path:
        return

    wall_ms = (time.perf_counter() - _started_at) * 1000
    # os.times() : seul chemin de mesure CPU, portable (contrairement à
    # resource.getrusage(), absent sous Windows).
    times = os.times()

    result = {
        'cpuUserUs': times.user * 1e6,
        'cpuSystemUs': times.system * 1e6,
        'wallMs': wall_ms,
        'maxRssBytes': _max_rss_bytes(),
    }

    try:
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(result, f)
    except OSError:
        # Rien à faire depuis atexit : le parent constatera l'absence du
        # fichier et le signalera lui-même (même contrat que probe.js).
        pass


def main():
    if len(sys.argv) < 2:
        # Erreur d'utilisation du wrapper lui-même, jamais du script mesuré :
        # measure.ts contrôle toujours ses arguments, ce chemin ne devrait
        # être atteint que par un appel manuel incorrect.
        sys.stderr.write('usage : probe.py <script.py> [args...]\n')
        sys.exit(2)

    atexit.register(_write_measurement)

    script = sys.argv[1]
    # Le script mesuré doit voir ses propres arguments en sys.argv, et son
    # propre dossier en tête de sys.path — exactement comme `python script.py`.
    sys.argv = sys.argv[1:]
    sys.path[0] = os.path.dirname(os.path.abspath(script))
    runpy.run_path(script, run_name='__main__')


if __name__ == '__main__':
    main()
