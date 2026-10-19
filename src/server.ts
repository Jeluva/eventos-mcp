import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buscar, FUENTES, leerSalud } from "./motor.ts";

const CIUDAD = process.env.EVENTOS_CIUDAD ?? "Buenos Aires";
const server = new McpServer({ name: "eventos", version: "0.1.0" });

server.tool(
  "buscar_eventos",
  `Busca eventos en ${CIUDAD} en Luma, Meetup, otraplanes y whatido. Devuelve ordenados por fecha, sin repetidos.`,
  {
    texto: z.string().optional().describe("palabra clave, ej: ia, startups, surf"),
    desde: z.string().optional().describe("YYYY-MM-DD, por defecto hoy"),
    hasta: z.string().optional().describe("YYYY-MM-DD, por defecto 14 días"),
    gratis: z.boolean().optional(),
    barrio: z.string().optional(),
    fuentes: z.array(z.enum(FUENTES.map((f) => f.nombre) as [string, ...string[]])).optional(),
    max: z.number().optional().describe("máximo de resultados, por defecto 40"),
  },
  async (a) => {
    const desde = a.desde ? new Date(a.desde + "T00:00:00-03:00") : new Date();
    const hasta = a.hasta ? new Date(a.hasta + "T23:59:59-03:00") : new Date(Date.now() + 14 * 864e5);
    const r = await buscar({ texto: a.texto, desde, hasta, ciudad: CIUDAD }, a.fuentes, { gratis: a.gratis, barrio: a.barrio });
    const fallas = r.salud.filter((s) => !s.ok).map((s) => `${s.fuente}: ${s.intentos.map((i) => i.error ?? "sin resultados").join(" | ") || "sin estrategias implementadas"}`);
    const max = a.max ?? 40;
    const porFuente: Record<string, number> = {};
    for (const e of r.eventos) porFuente[e.fuente] = (porFuente[e.fuente] ?? 0) + 1;
    // otraplanes trae cientos por día: sin palabra clave se reparte el cupo entre fuentes para que se vean todas
    let mostrando = r.eventos;
    if (!a.texto && Object.keys(porFuente).length > 1) {
      const cupo = Math.ceil(max / Object.keys(porFuente).length);
      const usado: Record<string, number> = {};
      mostrando = r.eventos.filter((e) => (usado[e.fuente] = (usado[e.fuente] ?? 0) + 1) <= cupo);
    }
    const payload = {
      total: r.eventos.length,
      por_fuente: porFuente,
      nota: !a.texto && r.eventos.length > max ? `Sin texto se muestran hasta ${max} repartidos entre fuentes; pasá texto, gratis, barrio o fuentes para afinar.` : undefined,
      mostrando: mostrando.slice(0, max),
      fuentes_con_problemas: fallas,
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 1) }] };
  },
);

server.tool("estado_fuentes", "Última salud conocida de cada fuente y qué estrategia funcionó.", {}, async () => ({
  content: [{ type: "text", text: JSON.stringify(leerSalud(), null, 1) }],
}));

await server.connect(new StdioServerTransport());
