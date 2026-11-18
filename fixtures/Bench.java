// Fixture pour `plugin-eco measure` — pendant Java de bench.js. Brûle un peu de
// CPU et alloue un peu de mémoire, se termine de lui-même.
//
// Silencieux volontairement (pas de System.out) : mêmes raisons que bench.js, voir
// son commentaire — `measure` hérite le stdout du programme mesuré.
import java.util.ArrayList;
import java.util.List;

public class Bench {
    public static void main(String[] args) {
        double total = 0;
        List<byte[]> data = new ArrayList<>();
        for (int i = 0; i < 20_000_000; i++) {
            total += Math.sqrt(i);
            if (i % 500 == 0) {
                data.add(new byte[1024]);
            }
        }
        if (total < 0 || data.isEmpty()) {
            System.exit(1);
        }
    }
}
