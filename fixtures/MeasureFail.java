// Fixture pour test/measure.test.js : pendant Java de measure-fail.js. Sort en
// échec pour vérifier que runMeasured remonte quand même une mesure — le
// shutdown hook de la sonde tourne aussi après System.exit().
public class MeasureFail {
    public static void main(String[] args) {
        System.exit(3);
    }
}
