import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FUENTES, leerSalud } from "./motor.ts";
import { buscarEventos } from "./busqueda.ts";

const CIUDAD = process.env.EVENTOS_CIUDAD ?? "Buenos Aires";
const server = new McpServer({ name: "eventos", version: "0.1.0" });

server.tool(
  "buscar_eventos",
  `Busca eventos en ${CIUDAD} en Luma, Meetup, otraplanes y whatido. Devuelve ordenados por fecha, sin repetidos, cada uno con nuevo: true|false.`,
  {
    texto: z.string().optional().describe("palabra clave, ej: ia, startups, surf"),
    desde: z.string().optional().describe("YYYY-MM-DD, por defecto hoy"),
    hasta: z.string().optional().describe("YYYY-MM-DD, por defecto 14 días"),
    gratis: z.boolean().optional(),
    barrio: z.string().optional(),
    fuentes: z.array(z.enum(FUENTES.map((f) => f.nombre) as [string, ...string[]])).optional(),
    max: z.number().optional().describe("máximo de resultados, por defecto 40"),
    solo_nuevos: z.boolean().optional().describe("true: solo eventos que no devolvió una búsqueda anterior (por defecto false)"),
  },
  async (a) => {
    const payload = await buscarEventos(a, CIUDAD);
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 1) }] };
  },
);

server.tool("estado_fuentes", "Última salud conocida de cada fuente y qué estrategia funcionó.", {}, async () => ({
  content: [{ type: "text", text: JSON.stringify(leerSalud(), null, 1) }],
}));

await server.connect(new StdioServerTransport());
