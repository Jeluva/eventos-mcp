// Prueba de solo_nuevos con un estado temporal (nunca toca el real). Uso: npm test
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "eventos-"));
process.env.EVENTOS_ESTADO = join(dir, "sub", "vistos.json");
const { leerVistos, guardarVistos, podar } = await import("./estado.ts");
const { buscarEventos } = await import("./busqueda.ts");

try {
  // archivo corrupto o inexistente
  assert.deepEqual(leerVistos(), {});
  guardarVistos({});
  writeFileSync(process.env.EVENTOS_ESTADO, "{roto");
  assert.deepEqual(leerVistos(), {});

  // poda: pasado y viejo salen, futuro reciente queda
  const ahora = new Date("2026-10-19T12:00:00Z");
  const p = podar({
    pasado: { visto: "2026-10-10T00:00:00Z", inicio: "2026-10-18T00:00:00-03:00" },
    viejo: { visto: "2026-07-01T00:00:00Z", inicio: "2026-11-01T00:00:00-03:00" },
    ok: { visto: "2026-10-10T00:00:00Z", inicio: "2026-10-25T00:00:00-03:00" },
  }, ahora);
  assert.deepEqual(Object.keys(p), ["ok"]);

  // búsqueda real dos veces
  const args = { solo_nuevos: true, texto: "ia", max: 200 };
  const a = await buscarEventos(args, "Buenos Aires");
  const b = await buscarEventos(args, "Buenos Aires");
  console.log(`primera: ${a.mostrando.length} nuevos, segunda: ${b.mostrando.length}`);
  assert.ok(a.mostrando.every((e) => e.nuevo));
  assert.equal(b.mostrando.length, 0);
  const c = await buscarEventos({ texto: "ia", max: 200 }, "Buenos Aires");
  assert.ok(c.mostrando.every((e) => !e.nuevo));
  console.log("OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
