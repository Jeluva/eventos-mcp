import type { Fuente, Consulta, Evento } from "../types.ts";
import { getText } from "../http.ts";

// whatido carga los eventos desde el navegador con la clave pública (anon) de Supabase
// que va dentro de su propio JS. Se hace lo mismo que un visitante anónimo, leyendo
// la clave del bundle en cada corrida para no depender de un valor fijo.
async function credenciales() {
  const page = await getText("https://whatido.tech/events.html");
  const ev = page.match(/src="(\/assets\/events-[^"]+\.js)"/)?.[1];
  if (!ev) throw new Error("no encontré el bundle de eventos");
  const js = await getText("https://whatido.tech" + ev, "*/*");
  const cfg = js.match(/from"\.\/(config-[^"]+\.js)"/)?.[1];
  if (!cfg) throw new Error("no encontré el bundle de config");
  const c = await getText("https://whatido.tech/assets/" + cfg, "*/*");
  const url = c.match(/https:\/\/[a-z0-9]+\.supabase\.co/)?.[0];
  const key = c.match(/eyJ[\w-]{30,}\.[\w-]{10,}\.[\w-]{10,}/)?.[0];
  if (!url || !key) throw new Error("no encontré la URL/clave de Supabase en el bundle");
  return { url, key };
}

// Respaldo: URL y clave anon de Supabase copiadas del bundle el 2026-10-16. Puede quedar vieja
// (si whatido rota la clave o migra el proyecto de Supabase, esta estrategia empieza a dar 401/404 y
// hay que volver a copiar los valores de https://whatido.tech/assets/config-*.js). La clave es la
// pública (role "anon", vence en 2036) que el sitio le manda a cualquier visitante.
const SUPABASE_CACHEADO = {
  url: "https://hcstszqwsgiiwrpfhjfa.supabase.co",
  key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhjc3RzenF3c2dpaXdycGZoamZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5NzE0MDIsImV4cCI6MjA4ODU0NzQwMn0.PcMebVO_SgS_-ceS9QTpolcq-GTsgfMG4Tc-qco0lUA",
};

// Sobre el filtro geográfico (revisado el 2026-10-16 con un distinct de `pais` sobre todos los eventos futuros):
// `pais` viene sucio. Valores: Argentina, null, "Online", España/Spain, USA/United States/Estados Unidos,
// México/Mexico, Brasil/Brazil, etc. El filtro viejo `pais.eq.Argentina OR es_online` dejaba afuera:
//   - eventos con pais "Online" pero es_online=false (15 en las próximas dos semanas, son virtuales);
//   - eventos con pais null y es_online=false (ubicacion también null, no se sabe dónde son);
//   - cualquier evento con la ubicación escrita como Buenos Aires/CABA pero el país mal cargado.
// Hoy no hay ningún evento de Buenos Aires con pais distinto de Argentina (se buscó en `ubicacion` por
// buenos aires, caba, capital federal, argentin, barrios), pero sí había ruido al revés: pais Argentina
// con ubicación en Santiago de Chile o sin ubicación. Esos se dejan: no perder lugares > filtrar de más.
// Los eventos con país extranjero y sin es_online siguen afuera (~85 en las próximas dos semanas).
const FILTRO_GEO = [
  "pais.eq.Argentina",
  "pais.ilike.*argentin*",
  "pais.is.null",
  "pais.eq.Online",
  "es_online.is.true",
  "ubicacion.ilike.*buenos aires*",
  "ubicacion.ilike.*capital federal*",
  "ubicacion.ilike.*argentin*",
  "ubicacion.ilike.*caba",
].join(",");

// `texto` no se manda al servidor: skills_tags es text[] y solo admite `cs.{Valor}` (match exacto y
// sensible a mayúsculas) o `ilike` con cast, y ilike sobre titulo/descripcion dejaría afuera los matches
// por tag que el motor sí encuentra (categoria incluye los tags). Son ~250 eventos por quincena,
// así que se trae todo el rango y el motor filtra en memoria.
const POR_PAGINA = 1000; // tope de filas por request de Supabase (max-rows por defecto)
const MAX_PAGINAS = 3;

async function consultar(cred: { url: string; key: string }, c: Consulta): Promise<Evento[]> {
  const filas: any[] = [];
  for (let p = 0; p < MAX_PAGINAS; p++) {
    const q = new URLSearchParams({
      select: "id,titulo,descripcion,skills_tags,fecha,hora_fin,ubicacion,es_online,es_gratuito,tipo,link,pais,cancelado",
      "parent_event_id": "is.null",
      cancelado: "is.false",
      order: "fecha.asc,id.asc",
      limit: String(POR_PAGINA),
      offset: String(p * POR_PAGINA),
    });
    q.append("fecha", `gte.${c.desde.toISOString()}`);
    q.append("fecha", `lte.${c.hasta.toISOString()}`);
    q.set("or", `(${FILTRO_GEO})`);
    const r = await fetch(`${cred.url}/rest/v1/eventos?${q}`, {
      headers: { apikey: cred.key, authorization: `Bearer ${cred.key}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`Supabase HTTP ${r.status}`);
    const pagina: any[] = await r.json();
    filas.push(...pagina);
    if (pagina.length < POR_PAGINA) break;
  }
  return filas.map<Evento>((e) => ({
    fuente: "whatido",
    id: e.id,
    titulo: e.titulo,
    inicio: e.fecha,
    fin: e.hora_fin ?? undefined,
    lugar: e.ubicacion ?? undefined,
    online: !!e.es_online || e.pais === "Online",
    gratis: e.es_gratuito,
    categoria: [e.tipo, ...(e.skills_tags ?? [])].filter(Boolean).join(", "),
    url: e.link ?? `https://whatido.tech/events.html`,
    descripcion: e.descripcion?.slice(0, 400),
  }));
}

const supabase: Fuente["estrategias"][number] = {
  nombre: "supabase-anon",
  async correr(c: Consulta) {
    return consultar(await credenciales(), c);
  },
};

const supabaseCacheado: Fuente["estrategias"][number] = {
  nombre: "supabase-cacheado",
  correr: (c: Consulta) => consultar(SUPABASE_CACHEADO, c),
};

export const whatido: Fuente = { nombre: "whatido", estrategias: [supabase, supabaseCacheado] };
