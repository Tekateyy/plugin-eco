import java.io.BufferedReader;
import java.util.regex.Pattern;

/**
 * Fichier de démonstration Plugin Eco — 6 patterns énergivores.
 *
 * Findings attendus :
 *  R1 - Boucle imbriquée        → ⚠ sur la boucle interne de sumMatrix()
 *  R2 - Concat += en boucle     → ℹ sur buildReport()
 *  R3 - new X() en boucle       → ℹ sur processItems()
 *  R4 - Pattern.compile boucle  → ⚠ sur validateEmails()
 *  R5 - I/O bloquant en boucle  → ⚠ sur readLines()
 *  R6 - SQL sans LIMIT          → ⚠ sur fetchUsers()
 */
public class Example {

    // ── R1 : Boucle imbriquée ────────────────────────────────────────────────
    public int sumMatrix(int[][] matrix) {
        int total = 0;
        for (int i = 0; i < matrix.length; i++) {
            for (int j = 0; j < matrix[i].length; j++) {   // ← R1 : boucle imbriquée
                total += matrix[i][j];
            }
        }
        return total;
    }

    // ── R2 : Concaténation String += en boucle ───────────────────────────────
    public String buildReport(String[] items) {
        String report = "";
        for (String item : items) {
            report += item + "\n";                          // ← R2 : += en boucle
        }
        return report;
    }

    // ── R3 : Création d'objet en boucle ─────────────────────────────────────
    public void processItems(String[] items) {
        for (String item : items) {
            StringBuilder sb = new StringBuilder();        // ← R3 : new en boucle
            sb.append("[").append(item).append("]");
            System.out.println(sb);
        }
    }

    // ── R4 : Pattern.compile() en boucle ────────────────────────────────────
    public boolean[] validateEmails(String[] emails) {
        boolean[] results = new boolean[emails.length];
        for (int i = 0; i < emails.length; i++) {
            Pattern p = Pattern.compile("^[\\w.-]+@[\\w.-]+\\.[a-z]{2,}$"); // ← R4
            results[i] = p.matcher(emails[i]).matches();
        }
        return results;
    }

    // ── R5 : I/O bloquant en boucle ─────────────────────────────────────────
    public void readLines(BufferedReader reader, int count) throws Exception {
        for (int i = 0; i < count; i++) {
            String line = reader.readLine();               // ← R5 : I/O en boucle
            System.out.println(line);
        }
    }

    // ── R6 : SQL sans LIMIT ──────────────────────────────────────────────────
    public void fetchUsers() {
        String query = "SELECT * FROM users WHERE active = true"; // ← R6 : pas de LIMIT
        System.out.println("Requête : " + query);
    }

    // ── Code propre (aucun finding attendu) ─────────────────────────────────
    public String buildReportOptimized(String[] items) {
        StringBuilder sb = new StringBuilder();           // new hors de la boucle ✓
        for (String item : items) {
            sb.append(item).append('\n');
        }
        return sb.toString();
    }

    private static final Pattern EMAIL_PATTERN =
        Pattern.compile("^[\\w.-]+@[\\w.-]+\\.[a-z]{2,}$"); // compile hors boucle ✓

    public boolean validateEmail(String email) {
        return EMAIL_PATTERN.matcher(email).matches();
    }

    public void fetchUsersLimited() {
        String query = "SELECT * FROM users WHERE active = true LIMIT 50"; // paginé ✓
        System.out.println("Requête : " + query);
    }
}
