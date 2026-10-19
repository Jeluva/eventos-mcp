import type { Fuente, Consulta, Evento } from "../types.ts";
import { getText, nextData } from "../http.ts";

const TOPE = 200; // máximo de eventos por consulta
const GQL = "https://www.meetup.com/gql2";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

// ---------- GraphQL (gql2 acepta queries completas, sin login ni hash persistido) ----------

async function gql(query: string, variables: Record<string, unknown>): Promise<any> {
  const r = await fetch(GQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": UA,
      "accept-language": "es-AR,es;q=0.9",
      origin: "https://www.meetup.com",
      referer: "https://www.meetup.com/find/",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${GQL}`);
  let j: any;
  try { j = await r.json(); } catch { throw new Error("gql2 no devolvió JSON (¿cambió el endpoint?)"); }
  if (j?.errors?.length) throw new Error(`gql2 devolvió errores: ${String(j.errors[0]?.message ?? "").slice(0, 200)}`);
  if (!j?.data) throw new Error("gql2 respondió sin `data` (¿cambió el esquema?)");
  return j.data;
}

const CAMPOS = `id title dateTime endTime eventUrl description eventType isOnline
  feeSettings { amount currency }
  venue { name address city }
  group { name }`;

// Sin palabra clave: recommendedEvents (es la query que usa /find). Con palabra clave: eventSearch.
const Q_RECOMENDADOS = `query($f: RecommendedEventsFilter!, $s: RecommendedEventsSort, $n: Int, $a: String) {
  r: recommendedEvents(filter: $f, sort: $s, first: $n, after: $a) {
    pageInfo { hasNextPage endCursor }
    edges { node { ${CAMPOS} } }
  }
}`;
const Q_BUSQUEDA = `query($f: EventSearchFilter!, $s: KeywordSort, $n: Int, $a: String) {
  r: eventSearch(filter: $f, sort: $s, first: $n, after: $a) {
    pageInfo { hasNextPage endCursor }
    edges { node { ${CAMPOS} } }
  }
}`;

// ---------- ubicación ----------

async function coordenadas(ciudad: string): Promise<{ lat: number; lon: number }> {
  if (["buenos aires", "caba", "capital federal", "ciudad autonoma de buenos aires"].includes(norm(ciudad)))
    return { lat: -34.6037, lon: -58.3816 };
  const d = await gql(`query($q: String!) { locationSearch(query: $q) { city country lat lon } }`, { q: `${ciudad} ar` });
  const l = (d.locationSearch ?? []).find((x: any) => x?.country === "ar" && typeof x.lat === "number");
  if (!l) throw new Error(`no encontré coordenadas de "${ciudad}" en Argentina`);
  return { lat: l.lat, lon: l.lon };
}

// Argentina no tiene horario de verano: offset fijo -03:00.
const fmt = (t: number) => new Date(t - 3 * 3600e3).toISOString().slice(0, 19) + "-03:00";

// El backend recorta cada consulta a unos ~100 resultados: se parte el rango en ventanas de
// pocos días (como mucho 10) para traer más. El rango entero en una sola ventana da ~97 eventos,
// ventanas diarias dan ~150 para 30 días.
function ventanas(desde: Date, hasta: Date): { desde: number; hasta: number }[] {
  const dia = 864e5;
  const ini = desde.getTime();
  const fin = hasta.getTime();
  if (!(fin > ini)) throw new Error("rango de fechas vacío o invertido");
  const dias = Math.ceil((fin - ini) / dia);
  const paso = Math.max(1, Math.ceil(dias / 10)) * dia;
  const out: { desde: number; hasta: number }[] = [];
  for (let t = ini; t < fin; t += paso) out.push({ desde: t, hasta: Math.min(t + paso - 1000, fin) });
  return out;
}

function aEvento(e: any): Evento {
  if (!e || typeof e !== "object" || !e.id || !e.title || !e.dateTime || !e.eventUrl)
    throw new Error("un evento de gql2 no tiene la forma esperada (id/title/dateTime/eventUrl)");
  const online = e.isOnline === true || e.eventType === "ONLINE";
  const v = e.venue;
  const partes = [v?.name, v?.address].filter((x, i, a) => x && a.indexOf(x) === i); // name y address suelen venir repetidos
  const lugar = online && !v?.address ? undefined : partes.join(", ") || undefined;
  const monto = typeof e.feeSettings?.amount === "number" ? e.feeSettings.amount : 0;
  return {
    fuente: "meetup",
    id: String(e.id),
    titulo: e.title,
    inicio: e.dateTime,
    fin: e.endTime || undefined,
    lugar,
    online,
    gratis: !(e.feeSettings && monto > 0),
    precio: monto > 0 ? `${monto} ${e.feeSettings.currency ?? ""}`.trim() : undefined,
    organizador: e.group?.name,
    url: e.eventUrl,
    descripcion: typeof e.description === "string" ? e.description.slice(0, 400) : undefined,
  };
}

const graphql: Fuente["estrategias"][number] = {
  nombre: "gql2",
  async correr(c: Consulta) {
    const { lat, lon } = await coordenadas(c.ciudad);
    const texto = c.texto?.trim();
    const wins = ventanas(c.desde, c.hasta);
    const porVentana = Math.min(TOPE, Math.max(30, Math.ceil(TOPE / wins.length) * 2));
    const porPagina = Math.min(porVentana, 50);

    const traerVentana = async (w: { desde: number; hasta: number }) => {
      const base = { lat, lon, radius: 50, startDateRange: fmt(w.desde), endDateRange: fmt(w.hasta) };
      const query = texto ? Q_BUSQUEDA : Q_RECOMENDADOS;
      const filtro = texto ? { ...base, query: texto } : base;
      const sort = texto ? { sortField: "RELEVANCE", sortOrder: "DESC" } : { sortField: "RELEVANCE" };
      const nodos: any[] = [];
      let after: string | null = null;
      for (let i = 0; i < 6 && nodos.length < porVentana; i++) {
        const d = await gql(query, { f: filtro, s: sort, n: porPagina, a: after });
        const con = d.r;
        if (!con || !Array.isArray(con.edges) || !con.pageInfo)
          throw new Error(`gql2 no devolvió la conexión de ${texto ? "eventSearch" : "recommendedEvents"} (¿cambió el esquema?)`);
        for (const edge of con.edges) nodos.push(edge?.node);
        if (!con.pageInfo.hasNextPage || !con.edges.length || !con.pageInfo.endCursor) break;
        after = con.pageInfo.endCursor;
      }
      return nodos;
    };

    // de a 4 ventanas en paralelo
    const nodos: any[] = [];
    for (let i = 0; i < wins.length; i += 4)
      for (const r of await Promise.all(wins.slice(i, i + 4).map(traerVentana))) nodos.push(...r);

    const vistos = new Map<string, Evento>();
    for (const n of nodos) {
      const e = aEvento(n);
      if (!vistos.has(e.id)) vistos.set(e.id, e);
    }
    return [...vistos.values()].sort((a, b) => a.inicio.localeCompare(b.inicio)).slice(0, TOPE);
  },
};

// ---------- respaldo: HTML de /find (solo la primera página, ~10 eventos) ----------

const embebido: Fuente["estrategias"][number] = {
  nombre: "apollo-state",
  async correr(c: Consulta) {
    const q = new URLSearchParams({
      source: "EVENTS",
      location: `ar--${c.ciudad}`,
      ...(c.texto ? { keywords: c.texto } : {}),
    });
    const html = await getText(`https://www.meetup.com/find/?${q}`);
    const apollo = nextData(html).props?.pageProps?.__APOLLO_STATE__;
    if (!apollo) throw new Error("no hay __APOLLO_STATE__ (¿cambió el sitio?)");
    const ref = (r: any) => (r?.__ref ? apollo[r.__ref] : r);
    const out: Evento[] = [];
    for (const [k, e] of Object.entries<any>(apollo)) {
      if (!k.startsWith("Event:") || !e.dateTime || !e.title) continue;
      const venue = ref(e.venue);
      out.push({
        fuente: "meetup",
        id: e.id,
        titulo: e.title,
        inicio: e.dateTime,
        lugar: [venue?.name, venue?.address].filter(Boolean).join(", ") || undefined,
        online: e.eventType === "ONLINE",
        gratis: e.feeSettings ? false : true,
        organizador: ref(e.group)?.name,
        url: e.eventUrl,
        descripcion: e.description?.slice(0, 400),
      });
    }
    return out;
  },
};

export const meetup: Fuente = { nombre: "meetup", estrategias: [graphql, embebido] };
