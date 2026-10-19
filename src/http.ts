const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export async function getText(url: string, accept = "text/html"): Promise<string> {
  const r = await fetch(url, {
    headers: { "user-agent": UA, accept, "accept-language": "es-AR,es;q=0.9" },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.text();
}

export async function getJson<T = any>(url: string): Promise<T> {
  return JSON.parse(await getText(url, "application/json"));
}

export function nextData(html: string): any {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no hay __NEXT_DATA__ (¿cambió el sitio?)");
  return JSON.parse(m[1]);
}

// Busca objetos que cumplan un predicado sin depender de la ruta exacta del JSON.
export function buscar(o: any, pred: (x: any) => boolean, out: any[] = []): any[] {
  if (o && typeof o === "object") {
    if (!Array.isArray(o) && pred(o)) {
      out.push(o);
      return out;
    }
    for (const k in o) buscar(o[k], pred, out);
  }
  return out;
}
