// Sonde Java chargée dans la JVM mesurée (`java -javaagent:probe.jar -jar app.jar`).
//
// Même patron que probe.js et probe.py : aucune instrumentation du code de
// l'utilisateur, aucune sortie sur stdout/stderr (condition de `--format json`),
// un seul effet de bord — le fichier JSON désigné par PLUGIN_ECO_PROBE_OUT.
// Les compteurs sont relus une fois, dans un shutdown hook, à l'arrêt de la JVM.
//
// Limites connues, héritées du mécanisme (comme `process.on('exit')` côté Node) :
// le hook ne tourne pas sur `Runtime.halt()` ni sur un kill dur, et il n'existe
// pas de RSS de pointe portable via les MXBeans — le pic de tas en est
// l'équivalent le plus honnête. La durée est prise côté `measure.ts`.
//
// Compilée par scripts/build-java-probe.js en out/probe.jar (si un JDK est là).

import java.lang.instrument.Instrumentation;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
import java.lang.management.MemoryUsage;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

public final class Probe {
    private Probe() {}

    public static void premain(String args, Instrumentation inst) {
        final String outPath = System.getenv("PLUGIN_ECO_PROBE_OUT");
        if (outPath == null || outPath.isEmpty()) {
            return;
        }
        Runtime.getRuntime().addShutdownHook(new Thread(new Runnable() {
            @Override
            public void run() {
                write(outPath);
            }
        }));
    }

    private static void write(String outPath) {
        try {
            // Couvre tout le process, démarrage de la JVM compris.
            com.sun.management.OperatingSystemMXBean os =
                (com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
            long cpuNs = os.getProcessCpuTime();

            // Cumul de tous les threads, y compris ceux déjà terminés (le thread
            // `main` l'est au moment du hook).
            com.sun.management.ThreadMXBean threads =
                (com.sun.management.ThreadMXBean) ManagementFactory.getThreadMXBean();
            long allocatedBytes = threads.getTotalThreadAllocatedBytes();

            // Somme des pics de chaque pool de tas : majorant du pic global, car
            // les pools ne culminent pas forcément au même instant.
            long peakHeapBytes = 0;
            for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
                if (pool.getType() == MemoryType.HEAP) {
                    MemoryUsage peak = pool.getPeakUsage();
                    if (peak != null) {
                        peakHeapBytes += peak.getUsed();
                    }
                }
            }

            String json = "{\"cpuTotalNs\":" + cpuNs
                + ",\"allocatedBytes\":" + allocatedBytes
                + ",\"peakHeapBytes\":" + peakHeapBytes + "}";
            Files.write(Paths.get(outPath), json.getBytes(StandardCharsets.UTF_8));
        } catch (Throwable ignored) {
            // Rien à faire depuis un shutdown hook : le parent constatera
            // l'absence du fichier et le signalera lui-même.
        }
    }
}
