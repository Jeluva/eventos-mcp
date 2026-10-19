import { buscar } from "./motor.ts";
import { claveEvento, guardarVistos, leerVistos, podar } from "./estado.ts";

export interface Args {
  texto?: string; desde?: string; hasta?: string; gratis?: boolean; barrio?: string;
  fuentes?: string[]; max?: number; solo_nuevos?: boolean;
}

export async function buscarEventos(a: Args, ciudad: string) {
  const desde = a.desde ? new Date(a.desde + "T00:00:00-03:00") : new Date();
  const hasta = a.hasta ? new Date(a.hasta + "T23:59:59-03:00") : new Date(Date.now() + 14 * 864e5);
  const r = await buscar({ texto: a.texto, desde, hasta, ciudad }, a.fuentes, { gratis: a.gratis, barrio: a.barrio });
  const fallas = r.salud.filter((s) => !s.ok).map((s) => `${s.fuente}: ${s.intentos.map((i) => i.error ?? "sin resultados").join(" | ") || "sin estrategias implementadas"}`);
  const max = a.max ?? 40;
  const vistos = leerVistos();
  const marcados = r.eventos.map((e) => ({ ...e, nuevo: !vistos[claveEvento(e)] }));
  const candidatos = a.solo_nuevos ? marcados.filter((e) => e.nuevo) : marcados;
  const porFuente: Record<string, number> = {};
  for (const e of candidatos) porFuente[e.fuente] = (porFuente[e.fuente] ?? 0) + 1;
  // otraplanes trae cientos por día: sin palabra clave se reparte el cupo entre fuentes para que se vean todas
  let mostrando = candidatos;
  if (!a.texto && Object.keys(porFuente).length > 1) {
    const cupo = Math.ceil(max / Object.keys(porFuente).length);
    const usado: Record<string, number> = {};
    mostrando = candidatos.filter((e) => (usado[e.fuente] = (usado[e.fuente] ?? 0) + 1) <= cupo);
  }
  mostrando = mostrando.slice(0, max);
  // solo se marca como visto lo que se devolvió: lo que quedó afuera por el cupo sigue siendo nuevo
  const ahora = new Date();
  const hoy = podar(vistos, ahora);
  for (const e of mostrando) hoy[claveEvento(e)] ??= { visto: ahora.toISOString(), inicio: e.inicio };
  try { guardarVistos(hoy); } catch (err: any) { fallas.push(`estado local: no se pudo guardar (${err?.message ?? err})`); }
  return {
    total: candidatos.length,
    por_fuente: porFuente,
    nota: !a.texto && candidatos.length > max ? `Sin texto se muestran hasta ${max} repartidos entre fuentes; pasá texto, gratis, barrio o fuentes para afinar.` : undefined,
    mostrando,
    fuentes_con_problemas: fallas,
  };
}
