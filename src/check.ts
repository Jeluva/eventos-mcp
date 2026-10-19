// Prueba cada fuente y sale con código 1 si alguna falla. Sirve para una tarea programada.
import { FUENTES, correrFuente } from "./motor.ts";

const c = { desde: new Date(), hasta: new Date(Date.now() + 14 * 864e5), ciudad: "Buenos Aires" };
let fallo = false;
for (const f of FUENTES) {
  const { salud } = await correrFuente(f, c);
  console.log(`${salud.ok ? "OK  " : "FALLA"} ${f.nombre}: ${salud.cantidad} eventos`, JSON.stringify(salud.intentos));
  if (!salud.ok) fallo = true;
}
process.exit(fallo ? 1 : 0);
