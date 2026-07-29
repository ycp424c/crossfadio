/** Cloudflare Worker entry point for the Crossfadio Sites adapter. */

interface Env {
  ASSETS: Fetcher;
  CROSSFADIO_UPSTREAM_BASE_URL?: string;
}

const UPSTREAM_PATH_PREFIXES = ["/api/", "/ws"];
const GENERATED_ASSET_PREFIX = "/crossfadio";

function isUpstreamRequest(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname === "/ws" ||
    UPSTREAM_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

function toAssetPath(pathname: string): string {
  if (pathname === "/") return `${GENERATED_ASSET_PREFIX}/index.html`;
  if (pathname.startsWith("/assets/")) {
    return `${GENERATED_ASSET_PREFIX}${pathname}`;
  }
  return pathname;
}

function buildUpstreamRequest(request: Request, upstreamBaseUrl: string): Request {
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, upstreamBaseUrl);
  const headers = new Headers(request.headers);

  // The browser talks to Sites on the same origin. The upstream service does
  // not need to evaluate the Sites origin through its browser CORS allowlist.
  headers.delete("origin");
  headers.delete("referer");
  headers.set("x-forwarded-host", incomingUrl.host);
  headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));

  return new Request(targetUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
}

async function proxyToAliyun(request: Request, env: Env): Promise<Response> {
  const upstreamBaseUrl = env.CROSSFADIO_UPSTREAM_BASE_URL?.trim();
  if (!upstreamBaseUrl) {
    return Response.json(
      { ok: false, error: "upstream_not_configured" },
      { status: 503 },
    );
  }

  try {
    return await fetch(buildUpstreamRequest(request, upstreamBaseUrl));
  } catch {
    return Response.json(
      { ok: false, error: "upstream_unavailable" },
      { status: 502 },
    );
  }
}

async function serveCrossfadio(request: Request, env: Env): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const assetUrl = new URL(toAssetPath(incomingUrl.pathname), request.url);
  const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, request));

  if (assetResponse.status !== 404 || request.method !== "GET") {
    return assetResponse;
  }

  const acceptsHtml = request.headers.get("accept")?.includes("text/html");
  if (!acceptsHtml) return assetResponse;

  const fallbackUrl = new URL(`${GENERATED_ASSET_PREFIX}/index.html`, request.url);
  return env.ASSETS.fetch(new Request(fallbackUrl, request));
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (isUpstreamRequest(pathname)) {
      return proxyToAliyun(request, env);
    }
    return serveCrossfadio(request, env);
  },
};

export default worker;
