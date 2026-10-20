import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fuente, Consulta, Evento } from "../types.ts";
import { getText } from "../http.ts";

// Fuente opcional y apagada por defecto: lee los links de eventos que se compartieron en tus grupos de WhatsApp.
// No se conecta a WhatsApp: abre en solo lectura la base SQLite de whatsapp-mcp-ts
// (https://github.com/jlucaso1/whatsapp-mcp-ts), que ya guarda los mensajes de los grupos.
// Se prende con EVENTOS_WHATSAPP_DB=<ruta a data/whatsapp.db>. Opcionales:
//   EVENTOS_WHATSAPP_DIAS   cuántos días de mensajes mirar hacia atrás (por defecto 30)
//   EVENTOS_WHATSAPP_GRUPOS nombres de grupo separados por coma; solo esos (por defecto todos)
// De cada link se lee el JSON-LD de tipo Event de la página (Luma y Eventbrite lo traen) para tener
// título, fecha y lugar. Un link sin JSON-LD, o un evento escrito solo en texto, queda afuera.

const DB = process.env.EVENTOS_WHATSAPP_DB;
const DIAS = Number(process.env.EVENTOS_WHATSAPP_DIAS ?? 30);
const GRUPOS = (process.env.EVENTOS_WHATSAPP_GRUPOS ?? "").split(",").map((g) => g.trim().toLowerCase()).filter(Boolean);

const HOSTS = /^(?:www\.)?(?:lu\.ma|luma\.com|meetup\.com|eventbrite\.[a-z.]+|partiful\.com|sympla\.com\.br)$/;
const CACHE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "whatsapp-links.json");
const TTL_OK = 3 * 864e5; // un evento encontrado se vuelve a leer a los 3 días (cambios de fecha o lugar)
const TTL_NADA = 864e5; // una página sin evento se reintenta al día siguiente

type Cacheado = { cuando: string; evento: Omit<Evento, "descripcion"> & { descripcion?: string } | null };

function leerCache(): Record<string, Cacheado> {
  try { return JSON.parse(readFileSync(CACHE, "utf8")); } catch { return {}; }
}

// Saca la query (tk, utm_source, lm_source) para que el mismo evento compartido varias veces sea un solo link.
function normalizar(u: string): string | undefined {
  try {
    const url = new URL(u);
    if (!HOSTS.test(url.hostname)) return;
    const path = url.pathname.replace(/\/$/, "");
    if (path.length < 2) return;
    return `https://${url.hostname.replace(/^www\./, "")}${path}`;
  } catch {}
}

async function linksCompartidos(): Promise<Map<string, Set<string>>> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(DB!, { readOnly: true });
  try {
    const desde = new Date(Date.now() - DIAS * 864e5).toISOString();
    const filas = db.prepare(
      `SELECT m.content AS texto, c.name AS grupo FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
       WHERE m.chat_jid LIKE '%@g.us' AND m.timestamp >= ? AND m.content LIKE '%http%'`,
    ).all(desde) as { texto: string; grupo: string | null }[];
    const links = new Map<string, Set<string>>();
    for (const f of filas) {
      const grupo = f.grupo ?? "grupo sin nombre";
      if (GRUPOS.length && !GRUPOS.some((g) => grupo.toLowerCase().includes(g))) continue;
      // corta en ] y ) para los links en formato markdown que pegan algunos bots
      for (const crudo of f.texto.match(/https?:\/\/[^\s\]()<>"*]+/g) ?? []) {
        const u = normalizar(crudo.replace(/[.,;:!?]+$/, ""));
        if (u) links.set(u, (links.get(u) ?? new Set()).add(grupo));
      }
    }
    return links;
  } finally {
    db.close();
  }
}

function eventosLd(html: string): any[] {
  const out: any[] = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      for (const x of [j, ...(j["@graph"] ?? [])].flat()) {
        if (String(x?.["@type"] ?? "").endsWith("Event") && x.startDate) out.push(x);
      }
    } catch {}
  }
  return out;
}

async function leerEvento(url: string): Promise<Cacheado["evento"]> {
  const ld = eventosLd(await getText(url))[0];
  if (!ld) return null;
  const loc = [ld.location].flat()[0];
  const dir = loc?.address;
  const online = String(ld.eventAttendanceMode ?? "").includes("Online") || loc?.["@type"] === "VirtualLocation";
  const precios = [ld.offers].flat().filter(Boolean).map((o: any) => Number(o.price ?? o.lowPrice)).filter((p) => !isNaN(p));
  return {
    fuente: "whatsapp",
    id: url,
    titulo: String(ld.name).trim(),
    inicio: ld.startDate,
    fin: ld.endDate,
    lugar: [...new Set([loc?.name, typeof dir === "string" ? dir : dir?.streetAddress].filter(Boolean))].join(", ") || undefined,
    barrio: typeof dir === "object" ? dir?.addressLocality : undefined,
    online,
    gratis: precios.length ? precios.every((p) => p === 0) : null,
    organizador: [ld.organizer].flat()[0]?.name,
    url,
    descripcion: typeof ld.description === "string" ? ld.description.slice(0, 300) : undefined,
  };
}

const sqlite: Fuente["estrategias"][number] = {
  nombre: "whatsapp-mcp-sqlite",
  async correr(_c: Consulta) {
    const links = await linksCompartidos();
    const cache = leerCache();
    const ahora = Date.now();
    const pendientes = [...links.keys()].filter((u) => {
      const h = cache[u];
      return !h || ahora - new Date(h.cuando).getTime() > (h.evento ? TTL_OK : TTL_NADA);
    });
    // de a 4 para no comerse un 429 de Luma
    for (let i = 0; i < pendientes.length; i += 4) {
      await Promise.all(pendientes.slice(i, i + 4).map(async (u) => {
        try { cache[u] = { cuando: new Date().toISOString(), evento: await leerEvento(u) }; } catch {}
      }));
    }
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(cache, null, 1));
    return [...links].flatMap(([u, grupos]) => {
      const e = cache[u]?.evento;
      if (!e) return [];
      const donde = `Compartido en WhatsApp: ${[...grupos].join(", ")}.`;
      return [{ ...e, descripcion: [donde, e.descripcion].filter(Boolean).join(" ") }];
    });
  },
};

export const whatsapp: Fuente | undefined = DB ? { nombre: "whatsapp", estrategias: [sqlite] } : undefined;
