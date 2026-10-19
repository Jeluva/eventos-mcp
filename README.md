# eventos-mcp

MCP personal para buscar eventos en Buenos Aires sin pagar nada. Corre en tu PC con Node 24 (ejecuta TypeScript directo).

| Fuente | Estrategia principal | Respaldo | Eventos en 14 días (oct 2026) |
|---|---|---|---|
| Luma (cubre también a The Startup Journal, perfil `tsj`) | `api.lu.ma/discover/get-paginated-events` barriendo varias consultas | `__NEXT_DATA__` de luma.com/buenos-aires | ~50 |
| Meetup | GraphQL `POST /gql2` (`recommendedEvents` / `eventSearch`) por ventanas de días | `__APOLLO_STATE__` de la página de búsqueda | ~110 |
| otraplanes | `/api/plans` con cursor, `q` para texto | sin respaldo HTML (la web es una SPA vacía) | ~1500 |
| whatido | Supabase con la clave anónima leída del bundle JS | la misma clave cacheada en el código | ~180 |

Cada fuente es una lista de estrategias que se prueban en orden. Si una falla o viene vacía se pasa a la siguiente,
y el resultado queda en `data/health.json` (tool `estado_fuentes`). Para sumar un respaldo, agregá otra
estrategia al array de `src/sources/<fuente>.ts`. El motor saca repetidos entre fuentes (por URL o título y día),
filtra por texto (palabras cortas exactas, largas por prefijo y sin plural), fechas, gratis y barrio.

- `npm run check`: prueba todas las fuentes, sale con código 1 si alguna falla.
- Ciudad: variable `EVENTOS_CIUDAD` (por defecto Buenos Aires).
- Tools: `buscar_eventos(texto, desde, hasta, gratis, barrio, fuentes, max, solo_nuevos)` y `estado_fuentes()`.
- `solo_nuevos` (por defecto `false`): con `true` devuelve solo los eventos que no devolvió una búsqueda anterior,
  así cada día ves lo nuevo sin releer todo. Cada evento trae `nuevo: true|false`. Se marca como visto lo que se
  devuelve, no lo que quedó afuera por `max`. Los ids viven en un JSON fuera del repo (`%LOCALAPPDATA%/eventos-mcp/vistos.json`
  en Windows, `~/.eventos-mcp/vistos.json` en el resto; variable `EVENTOS_ESTADO` para cambiar la ruta). Se escribe
  de forma atómica, si falta o está roto se arranca de cero, y se borran los eventos que ya pasaron o con más de 60 días.
- `npm test`: prueba el estado y `solo_nuevos` con un archivo temporal (hace una búsqueda real, dos veces).
- Sin `texto` la primera llamada tarda unos 12 s por el barrido de Luma (después queda en caché 10 min) y el
  cupo de resultados se reparte entre fuentes para que otraplanes no tape a las demás.
- Luma y otraplanes devuelven 429 si se las golpea en ráfaga; uso personal y a baja frecuencia.

## Instalación

Necesita Node 24 o más nuevo (corre el `.ts` sin compilar).

    git clone https://github.com/Jeluva/eventos-mcp.git
    cd eventos-mcp
    npm install
    npm run check

Registro en Claude Code (cambiá la ruta por donde lo clonaste):

    claude mcp add eventos -s user -e EVENTOS_CIUDAD="Buenos Aires" -- node /ruta/a/eventos-mcp/src/server.ts

Después abrí una sesión nueva y pedí, por ejemplo, "eventos de startups esta semana" o "planes gratis en Palermo el sábado".

Mantenimiento: la tarea programada de Claude `eventos-mcp-check` (lunes 9:30) corre el check y repara la fuente que
se haya roto agregando una estrategia de respaldo.
