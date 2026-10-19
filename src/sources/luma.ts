import type { Fuente, Consulta, Evento } from "../types.ts";
import { getText, getJson, nextData, buscar } from "../http.ts";

// Luma no necesita login ni API key para leer lo público. Endpoints usados (host api.lu.ma, el mismo
// que usa el sitio):
//   GET /discover/bootstrap-page?slug=<ciudad>                  -> id del "place" (discplace-...)
//   GET /discover/get-paginated-events?discover_place_api_id=.. -> eventos del place
//   GET /user/profile/events?username=tsj                       -> eventos que organiza The Startup Journal
//
// Ojo: get-paginated-events SIN `query` devuelve solo ~9 destacados. CON `query` busca en todos los
// eventos del place, pero devuelve como mucho 50 por consulta, ordenados por relevancia (no por fecha),
// sin cursor (has_more siempre false). La única forma de cubrir todo es repetir con varias consultas
// distintas y unir. Además el endpoint tiene rate limit por IP (HTTP 429), así que son pocas consultas,
// en serie, con pausa, y con caché en memoria.

const API = "https://api.lu.ma";
const TOPE = 300; // eventos únicos máximos por barrido
const PAUSA_MS = 400; // entre requests, para no disparar el rate limit
const CACHE_MS = 10 * 60 * 1000;
const TSJ_USUARIO = "tsj"; // luma.com/user/tsj, The Startup Journal (no tiene calendario propio, es un perfil)
// Consultas del barrido general. "" = los destacados sin query.
const SEMILLAS = ["", "a", "e", "o", "ai", "meetup", "buenos aires", "event", "en", "de", "the", "b", "s", "y", "workshop", "club"];

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mapear(e: any, entry: any): Evento {
  const geo = e.geo_address_info?.localized?.es ?? e.geo_address_info ?? {};
  const ticket = entry?.ticket_info;
  return {
    fuente: "luma",
    id: e.api_id,
    titulo: e.name,
    inicio: e.start_at,
    fin: e.end_at,
    lugar: [geo.address, geo.short_address].filter(Boolean).join(", ") || undefined,
    barrio: geo.sublocality ?? undefined,
    // location_type: "offline" | "online" | "meet" | "zoom" | ...; todo lo que no es presencial es online
    online: !!e.location_type && e.location_type !== "offline",
    gratis: ticket ? (typeof ticket.is_free === "boolean" ? ticket.is_free : !ticket.price) : null,
    organizador: entry?.hosts?.map((h: any) => h.name).join(", "),
    url: `https://luma.com/${e.url}`,
  };
}

function validarEntradas(j: any, donde: string): any[] {
  if (!j || !Array.isArray(j.entries)) {
    throw new Error(`Luma ${donde}: la respuesta no trae "entries" (¿cambió la API? claves: ${Object.keys(j ?? {}).join(",") || "ninguna"})`);
  }
  return j.entries;
}

async function resolverPlace(slug: string): Promise<string> {
  const j = await getJson(`${API}/discover/bootstrap-page?slug=${encodeURIComponent(slug)}`);
  if (!Array.isArray(j?.places)) throw new Error(`Luma bootstrap-page: la respuesta no trae "places" (¿cambió la API?)`);
  const p = j.places.map((x: any) => x?.place).find((x: any) => x?.slug === slug);
  if (!p?.api_id) throw new Error(`Luma: no hay un place con slug "${slug}" en bootstrap-page`);
  return p.api_id;
}

// Una consulta, siguiendo cursor si lo hubiera (sin query puede haber más de una página).
async function consultaPlace(placeId: string, query: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let pag = 0; pag < 6; pag++) {
    const p = new URLSearchParams({ discover_place_api_id: placeId, pagination_limit: "50", period: "future" });
    if (query) p.set("query", query);
    if (cursor) p.set("pagination_cursor", cursor);
    const j = await getJson(`${API}/discover/get-paginated-events?${p}`);
    out.push(...validarEntradas(j, "get-paginated-events"));
    if (!j.has_more || !j.next_cursor) break;
    cursor = j.next_cursor;
    await pausa(PAUSA_MS);
  }
  return out;
}

function consultasPara(texto?: string): string[] {
  if (!texto?.trim()) return SEMILLAS;
  // Con texto no hace falta barrer: la búsqueda de Luma ya filtra en el servidor. Frase entera primero,
  // después cada palabra (motor.ts exige que estén todas, así que unir es un superconjunto seguro).
  const t = texto.trim();
  const palabras = t.split(/\s+/).filter((w) => w.length >= 2);
  const lista = [t, ...palabras];
  for (const w of [t, ...palabras]) if (norm(w) !== w.toLowerCase()) lista.push(norm(w));
  return [...new Set(lista.map((s) => s.toLowerCase()))].slice(0, 8);
}

// Lista fija de entradas crudas por (ciudad, texto), cacheada. Se cachea la promesa para que dos
// llamadas simultáneas no dupliquen requests, y se descarta si falla.
const cache = new Map<string, { t: number; p: Promise<{ placeId: string; entradas: any[] }> }>();

async function barrer(c: Consulta, slug: string): Promise<{ placeId: string; entradas: any[] }> {
  const placeId = await resolverPlace(slug);
  const unicas = new Map<string, any>();
  const consultas = consultasPara(c.texto);
  for (let i = 0; i < consultas.length && unicas.size < TOPE; i++) {
    if (i > 0) await pausa(PAUSA_MS);
    try {
      for (const x of await consultaPlace(placeId, consultas[i])) {
        if (x?.event?.start_at && x.event.name) unicas.set(x.api_id ?? x.event.api_id, x);
      }
    } catch (err: any) {
      // Con algo ya juntado devolvemos lo parcial (típico: 429 a mitad de barrido); sin nada, que lo vea el motor.
      if (unicas.size === 0) throw err;
      console.error(`[luma] barrido cortado en la consulta ${JSON.stringify(consultas[i])}: ${err?.message ?? err}`);
      break;
    }
  }
  return { placeId, entradas: [...unicas.values()] };
}

function barridoCacheado(c: Consulta, slug: string) {
  const clave = `${slug}|${norm(c.texto ?? "").trim()}`;
  const hit = cache.get(clave);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.p;
  const p = barrer(c, slug);
  cache.set(clave, { t: Date.now(), p });
  p.catch(() => cache.delete(clave));
  return p;
}

// Eventos próximos de The Startup Journal (los suyos no siempre están en el feed de la ciudad).
async function eventosTsj(c: Consulta): Promise<any[]> {
  const j = await getJson(`${API}/user/profile/events?username=${TSJ_USUARIO}`);
  if (!Array.isArray(j?.events_hosting)) {
    throw new Error(`Luma user/profile/events: la respuesta no trae "events_hosting" (¿cambió la API? claves: ${Object.keys(j ?? {}).join(",") || "ninguna"})`);
  }
  const ciudad = norm(c.ciudad);
  // TSJ también organiza en Punta del Este, México, etc.: solo online o de la ciudad consultada.
  return j.events_hosting.filter((x: any) => {
    const g = x?.event?.geo_address_info;
    const presencial = x?.event?.location_type === "offline";
    return !presencial || [g?.city, g?.city_state, g?.region].some((s) => s && norm(String(s)).includes(ciudad));
  });
}

const feedCiudad: Fuente["estrategias"][number] = {
  nombre: "api-place",
  async correr(c: Consulta) {
    const slug = c.ciudad.toLowerCase().replace(/\s+/g, "-");
    const { entradas } = await barridoCacheado(c, slug);

    let tsj: any[] = [];
    try {
      tsj = await eventosTsj(c);
    } catch (err: any) {
      // No tumba la fuente (el feed de la ciudad ya anduvo), pero queda a la vista en stderr.
      console.error(`[luma] TSJ falló: ${err?.message ?? err}`);
    }

    const desde = c.desde.getTime();
    const hasta = c.hasta.getTime();
    const vistos = new Set<string>();
    const out: Evento[] = [];
    for (const x of [...entradas, ...tsj]) {
      const ev = x.event;
      const t = new Date(ev?.start_at).getTime();
      if (isNaN(t) || t < desde || t > hasta || vistos.has(ev.api_id)) continue;
      vistos.add(ev.api_id);
      out.push(mapear(ev, x));
    }
    return out;
  },
};

// Respaldo: la página de la ciudad trae solo los destacados (~9) embebidos en __NEXT_DATA__.
const porPagina: Fuente["estrategias"][number] = {
  nombre: "json-embebido",
  async correr(c: Consulta) {
    const slug = c.ciudad.toLowerCase().replace(/\s+/g, "-");
    const html = await getText(`https://luma.com/${slug}`);
    const data = nextData(html);
    const entradas = buscar(data, (x) => x.event?.start_at && x.event?.name);
    return entradas.map((x) => mapear(x.event, x));
  },
};

export const luma: Fuente = { nombre: "luma", estrategias: [feedCiudad, porPagina] };
