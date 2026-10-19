import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Consulta, Evento, Fuente } from "./types.ts";
import { luma } from "./sources/luma.ts";
import { meetup } from "./sources/meetup.ts";
import { otraplanes } from "./sources/otraplanes.ts";
import { whatido } from "./sources/whatido.ts";

export const FUENTES: Fuente[] = [luma, meetup, otraplanes, whatido];

const HEALTH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "health.json");

export interface Salud {
  fuente: string;
  ok: boolean;
  estrategia?: string;
  cantidad: number;
  cuando: string;
  intentos: { estrategia: string; error?: string; cantidad?: number }[];
}

function guardarSalud(s: Salud) {
  let todo: Record<string, Salud> = {};
  try { todo = JSON.parse(readFileSync(HEALTH, "utf8")); } catch {}
  todo[s.fuente] = s;
  mkdirSync(dirname(HEALTH), { recursive: true });
  writeFileSync(HEALTH, JSON.stringify(todo, null, 2));
}

export function leerSalud(): Record<string, Salud> {
  try { return JSON.parse(readFileSync(HEALTH, "utf8")); } catch { return {}; }
}

export async function correrFuente(f: Fuente, c: Consulta): Promise<{ eventos: Evento[]; salud: Salud }> {
  const intentos: Salud["intentos"] = [];
  for (const e of f.estrategias) {
    try {
      const eventos = await e.correr(c);
      intentos.push({ estrategia: e.nombre, cantidad: eventos.length });
      if (eventos.length > 0) {
        const salud = { fuente: f.nombre, ok: true, estrategia: e.nombre, cantidad: eventos.length, cuando: new Date().toISOString(), intentos };
        guardarSalud(salud);
        return { eventos, salud };
      }
    } catch (err: any) {
      intentos.push({ estrategia: e.nombre, error: String(err?.message ?? err) });
    }
  }
  const salud = { fuente: f.nombre, ok: false, cantidad: 0, cuando: new Date().toISOString(), intentos };
  guardarSalud(salud);
  return { eventos: [], salud };
}

// Las fuentes mezclan UTC (Luma, whatido) y -03:00 (Meetup). Todo se muestra y se ordena en hora de Buenos Aires.
const AR = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "medium" });
function aHoraAR(iso?: string): string | undefined {
  const t = iso ? new Date(iso) : undefined;
  if (!t || isNaN(t.getTime())) return iso;
  return AR.format(t).replace(" ", "T") + "-03:00";
}

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export async function buscar(c: Consulta, fuentes?: string[], filtros: { gratis?: boolean; barrio?: string } = {}) {
  const elegidas = FUENTES.filter((f) => !fuentes?.length || fuentes.includes(f.nombre));
  const res = await Promise.all(elegidas.map((f) => correrFuente(f, c)));
  const vistos = new Set<string>();
  let eventos = res.flatMap((r) => r.eventos).map((e) => ({ ...e, inicio: aHoraAR(e.inicio)!, fin: aHoraAR(e.fin) })).filter((e) => {
    const t = new Date(e.inicio).getTime();
    if (isNaN(t) || t < c.desde.getTime() || t > c.hasta.getTime()) return false;
    // mismo evento en dos fuentes (whatido republica Luma y Meetup): se queda la primera por URL o por título+día
    const claves = [norm(e.titulo) + "|" + e.inicio.slice(0, 10), e.url.replace(/[?#].*$/, "").replace(/\/$/, "")];
    if (claves.some((k) => vistos.has(k))) return false;
    claves.forEach((k) => vistos.add(k));
    return true;
  });
  if (c.texto) {
    // palabras cortas (ia, ai, ux) solo como palabra completa; las largas como prefijo
    const B = String.raw`\b`;
    const re = c.texto.split(" ").filter(Boolean).map((p) => {
      let t = norm(p).replace(/[^a-z0-9ñ]/g, "");
      if (t.length > 4 && t.endsWith("s")) t = t.slice(0, -1); // startups encuentra startup
      return new RegExp(t.length <= 3 ? `${B}${t}${B}` : `${B}${t}`);
    });
    eventos = eventos.filter((e) => {
      const h = norm([e.titulo, e.descripcion, e.categoria, e.organizador, e.lugar].filter(Boolean).join(" "));
      return re.every((r) => r.test(h));
    });
  }
  if (filtros.gratis) eventos = eventos.filter((e) => e.gratis === true);
  if (filtros.barrio) eventos = eventos.filter((e) => norm(`${e.barrio ?? ""} ${e.lugar ?? ""}`).includes(norm(filtros.barrio!)));
  eventos.sort((a, b) => a.inicio.localeCompare(b.inicio));
  return { eventos, salud: res.map((r) => r.salud) };
}
