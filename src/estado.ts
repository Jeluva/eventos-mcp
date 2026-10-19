import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Ids de eventos ya mostrados, para que `solo_nuevos` devuelva solo lo que no viste.
// Vive fuera del repo: EVENTOS_ESTADO, o %LOCALAPPDATA%/eventos-mcp/vistos.json en Windows y ~/.eventos-mcp/vistos.json en el resto.
export interface Visto { visto: string; inicio: string } // visto = primera vez (ISO), inicio = fecha del evento
export type Vistos = Record<string, Visto>;

const DIAS_MAX = 60;

export function rutaEstado(): string {
  if (process.env.EVENTOS_ESTADO) return process.env.EVENTOS_ESTADO;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "eventos-mcp", "vistos.json");
  return join(homedir(), ".eventos-mcp", "vistos.json");
}

export const claveEvento = (e: { fuente: string; id: string }) => `${e.fuente}:${e.id}`;

export function leerVistos(ruta = rutaEstado()): Vistos {
  try {
    const d = JSON.parse(readFileSync(ruta, "utf8"));
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch { return {}; } // falta o está corrupto: se arranca de cero
}

// Escritura atómica: archivo temporal y rename, así un corte a la mitad no deja el JSON roto.
export function guardarVistos(v: Vistos, ruta = rutaEstado()) {
  mkdirSync(dirname(ruta), { recursive: true });
  const tmp = `${ruta}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(v, null, 1));
    renameSync(tmp, ruta);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// Saca los eventos que ya pasaron o que se vieron hace más de 60 días.
export function podar(v: Vistos, ahora = new Date()): Vistos {
  const limite = ahora.getTime() - DIAS_MAX * 864e5;
  const sal: Vistos = {};
  for (const [k, x] of Object.entries(v)) {
    const ini = new Date(x?.inicio).getTime();
    const vis = new Date(x?.visto).getTime();
    if (isNaN(ini) || isNaN(vis) || ini < ahora.getTime() || vis < limite) continue;
    sal[k] = x;
  }
  return sal;
}
