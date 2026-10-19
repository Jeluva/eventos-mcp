import type { Fuente, Consulta, Evento } from "../types.ts";
import { getJson } from "../http.ts";

// Notas de la API (verificadas el 2026-10-16):
// - GET /api/plans devuelve { events, meta }. meta trae { count, has_more, next_cursor, next_offset, from, to }.
//   Se pagina con `cursor=<meta.next_cursor>` (también anda `offset`). El bundle del sitio hace lo mismo.
// - Los eventos vienen ordenados por inicio y cada uno trae una sola instancia, así que se puede cortar
//   apenas el último evento de una página pasa de `c.hasta`.
// - `window_to` NO acota nada: meta.to siempre es null y la API sigue más allá de la fecha. Hay que cortar
//   del lado del cliente. `window_from` sí funciona.
// - `limit` acepta hasta 1000 (con más devuelve 1000). Se usan páginas de 500.
// - Densidad: ~115 eventos por día (14 días son ~1600). Con el tope de 400 una consulta SIN texto solo
//   cubre ~3 a 4 días desde hoy (el motor devuelve todo lo que trae la fuente al cliente MCP, por eso
//   no se sube sin pensarlo). Con texto no importa: `q` achica el resultado y se cubre todo el rango.
//   Con 2000 se cubren dos semanas sin texto en 4 pedidos de 500.
// - `q=<texto>` es búsqueda de texto del servidor. Probado contra el filtro en memoria del motor
//   (título, resumen, categoría, lugar; también se probó con palabras que solo están en el nombre del
//   venue) con varias palabras: el servidor siempre devuelve un superset
//   (ningún evento que el motor aceptaba quedó afuera; también hace match por prefijo y sin tildes).
//   Se manda solo la palabra más larga de `texto` porque no está claro si con varias palabras
//   exige frase exacta o todas; una sola palabra es una condición necesaria de cualquier forma, y
//   el motor después aplica el filtro completo. Con `q` el resultado es chico y cubre todo el rango.
// - Los demás parámetros del bundle (`date`, `facets`, `bbox`, `recital`, `ids`, `category`) no hacen falta:
//   `date` es un solo día, `facets` agrega conteos, `bbox` es del mapa, `recital` es un filtro de música,
//   `ids` trae eventos puntuales.
// - Hay rate limit (HTTP 429, "RATE_LIMITED", retry_after_seconds: 60) si se golpea la API decenas de
//   veces seguidas. Una corrida normal usa 1 a 4 requests. Si una página posterior a la primera falla
//   se devuelve lo ya juntado en vez de tirar todo.
//
// No hay estrategia de respaldo con HTML: https://otraplanes.com/eventos es una SPA y el HTML es solo un
// loader ("Cargando…", ~5 KB, sin eventos ni JSON-LD ni __NEXT_DATA__), los eventos se piden por JS a
// /api/plans. Parsearlo con cheerio no devolvería nada. (La home "/" sí trae un snapshot JSON embebido
// en <script id="otra-home-data"> con un feed destacado del día; no se usa porque no es una lista
// completa del rango y mostraría datos parciales como si la fuente anduviera bien.)

const MAX_EVENTOS = 2000; // tope de eventos pedidos por corrida (unos 115 por día)
const PAGINA = 500;

const fechaBA = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(d); // YYYY-MM-DD

function palabraClave(texto?: string): string | undefined {
  const ps = (texto ?? "")
    .normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .split(/\s+/).map((p) => p.replace(/[^a-z0-9ñ]/g, "")).filter(Boolean);
  return ps.sort((a, b) => b.length - a.length)[0];
}

const api: Fuente["estrategias"][number] = {
  nombre: "api-json-interna",
  async correr(c: Consulta) {
    const base: Record<string, string> = { window_from: fechaBA(c.desde) };
    const q = palabraClave(c.texto);
    if (q) base.q = q;

    const hasta = c.hasta.getTime();
    const crudos: any[] = [];
    let cursor: string | undefined;
    for (;;) {
      const limit = String(Math.min(PAGINA, MAX_EVENTOS - crudos.length));
      const params = new URLSearchParams(cursor ? { ...base, limit, cursor } : { ...base, limit });
      let d: any;
      try {
        d = await getJson(`https://otraplanes.com/api/plans?${params}`);
        if (!Array.isArray(d.events)) throw new Error("respuesta sin 'events' (¿cambió la API?)");
      } catch (err) {
        if (crudos.length === 0) throw err; // en la primera página el error cuenta; después nos quedamos con lo juntado
        break;
      }
      crudos.push(...d.events);
      const ultimo = d.events.at(-1)?.instances?.at(-1)?.start_datetime_iso;
      const pasoElRango = ultimo ? new Date(ultimo).getTime() > hasta : false;
      if (!d.meta?.has_more || !d.meta?.next_cursor || d.events.length === 0 || pasoElRango || crudos.length >= MAX_EVENTOS) break;
      cursor = d.meta.next_cursor;
    }

    // `q` sin resultados es "no hay coincidencias", no una fuente rota. Como el motor marca la fuente
    // como caída cuando devuelve 0 eventos, se hace un pedido chico sin `q` para confirmar que la API
    // responde; esos eventos no coinciden con el texto y el motor los descarta en su filtro en memoria.
    if (crudos.length === 0 && q) {
      const d = await getJson(`https://otraplanes.com/api/plans?${new URLSearchParams({ window_from: base.window_from, limit: "5" })}`);
      if (!Array.isArray(d.events)) throw new Error("respuesta sin 'events' (¿cambió la API?)");
      crudos.push(...d.events);
    }

    const vistos = new Set<string>();
    const out: Evento[] = [];
    for (const e of crudos) {
      for (const i of e.instances ?? []) {
        if (vistos.has(i.id) || new Date(i.start_datetime_iso).getTime() > hasta) continue;
        vistos.add(i.id);
        out.push({
          fuente: "otraplanes",
          id: i.id,
          titulo: e.event_title,
          inicio: i.start_datetime_iso,
          fin: i.end_datetime_iso ?? undefined,
          lugar: e.venue_name ?? undefined,
          barrio: e.neighborhood ?? undefined,
          gratis: e.price?.type === "free" ? true : e.price?.type === "unknown" ? null : false,
          precio: e.price?.text ?? undefined,
          categoria: [e.primary_category, ...(e.secondary_categories ?? [])].filter(Boolean).join(", "),
          url: `https://otraplanes.com${i.public_path ?? e.public_path}`,
          descripcion: e.summary_line,
        });
      }
    }
    return out;
  },
};

export const otraplanes: Fuente = { nombre: "otraplanes", estrategias: [api] };
