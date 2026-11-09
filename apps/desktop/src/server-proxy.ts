/**
 * viewer-server:// (WP 5.4): the page reaches the library server only through this scheme,
 * which the main process forwards to the one configured address. The page then needs no
 * cross-origin permissions from the server, its security policy names no network address, and
 * the air gap stays closed to everything else. Requests keep their method, body and headers
 * (ranges, tus upload offsets, the admin's token), and answers stream back unbuffered.
 */
export const SERVER_SCHEME = "viewer-server";
/** The base URL the page uses for the server. */
export const SERVER_BASE = `${SERVER_SCHEME}://library`;

// Set by the browser or meaningless across the hop.
const DROP_REQUEST = new Set(["host", "origin", "referer", "cookie", "connection", "content-length", "accept-encoding"]);
const DROP_RESPONSE = new Set(["set-cookie", "connection", "transfer-encoding", "content-encoding", "content-length", "strict-transport-security", "alt-svc"]);

type Fetch = (url: string, init: RequestInit & { duplex?: "half" }) => Promise<Response>;

const METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";

/**
 * Forwards one viewer-server:// request to the server at `base`. The page (at `pageOrigin`) is
 * on another scheme, so this bridge answers the browser's cross-origin checks itself: the
 * server stays same-origin only and never needs to know about the app.
 */
export async function proxyServer(base: string, req: Request, fetchImpl: Fetch, pageOrigin = "viewer-app://app"): Promise<Response> {
  const url = new URL(req.url);
  const cors = { "Access-Control-Allow-Origin": pageOrigin, Vary: "Origin" };
  if (url.hostname !== "library") return new Response("Not found", { status: 404, headers: cors });
  // A preflight: answered here, never sent on.
  if (req.method === "OPTIONS" && req.headers.has("access-control-request-method")) {
    return new Response(null, {
      status: 204,
      headers: { ...cors, "Access-Control-Allow-Methods": METHODS, "Access-Control-Allow-Headers": req.headers.get("access-control-request-headers") ?? "", "Access-Control-Max-Age": "600" },
    });
  }
  const target = `${base}${url.pathname}${url.search}`;
  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!DROP_REQUEST.has(k.toLowerCase())) headers.set(k, v);
  });
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
  let res: Response;
  try {
    res = await fetchImpl(target, { method: req.method, headers, body: hasBody ? req.body : undefined, duplex: hasBody ? "half" : undefined, redirect: "manual", signal: req.signal });
  } catch {
    // The app treats this like a server that does not answer: it goes to local mode.
    return new Response(null, { status: 502, statusText: "Server unreachable", headers: cors });
  }
  const out = new Headers();
  res.headers.forEach((v, k) => {
    if (!DROP_RESPONSE.has(k.toLowerCase())) out.set(k, v);
  });
  // The page may read every header the server sent (tus needs Location and Upload-Offset).
  const names = [...out.keys()];
  for (const [k, v] of Object.entries(cors)) out.set(k, v);
  if (names.length) out.set("Access-Control-Expose-Headers", names.join(", "));
  // A redirect may only stay on the same server: its path is kept, the host is not followed.
  const loc = out.get("location");
  if (loc) {
    const to = new URL(loc, target);
    const b = new URL(base);
    const prefix = b.pathname.replace(/\/$/, "");
    if (to.origin === b.origin && to.pathname.startsWith(prefix)) out.set("location", `${SERVER_BASE}${to.pathname.slice(prefix.length) || "/"}${to.search}`);
    else out.delete("location");
  }
  return new Response(res.status === 204 || res.status === 304 || req.method === "HEAD" ? null : res.body, { status: res.status, statusText: res.statusText, headers: out });
}
