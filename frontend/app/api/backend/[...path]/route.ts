const DEFAULT_BACKEND_URL = "http://127.0.0.1:4317";

type RouteContext = {
  params: {
    path?: string[];
  };
};

export async function GET(request: Request, context: RouteContext) {
  return proxy(request, context);
}

export async function POST(request: Request, context: RouteContext) {
  return proxy(request, context);
}

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const backendUrl = normalizeBackendUrl(process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || DEFAULT_BACKEND_URL);
  const backendUrls = backendUrlCandidates(backendUrl);
  const incomingUrl = new URL(request.url);
  const path = context.params.path?.join("/") ?? "";
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  const attempted: string[] = [];
  let lastError = "";

  for (const candidateUrl of backendUrls) {
    const targetUrl = `${candidateUrl}/${path}${incomingUrl.search}`;
    attempted.push(targetUrl);
    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: pickForwardHeaders(request.headers),
        body,
        cache: "no-store"
      });
      const contentType = response.headers.get("content-type") ?? "application/json";
      if (contentType.includes("text/event-stream")) {
        return new Response(response.body, {
          status: response.status,
          headers: {
            "content-type": contentType,
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive"
          }
        });
      }
      const responseBody = await response.text();
      return new Response(responseBody, {
        status: response.status,
        headers: {
          "content-type": contentType
        }
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return Response.json(
    {
      error: "backend_unavailable",
      backendUrl,
      attempted,
      message: `Backend request failed for /${path || "health"}: ${lastError || "connection failed"}. Tried ${attempted.join(", ")}. Make sure the Voices backend is running on port 4317.`
    },
    { status: 502 }
  );
}

function pickForwardHeaders(headers: Headers): Headers {
  const forwarded = new Headers();
  const contentType = headers.get("content-type");
  const accept = headers.get("accept");
  if (contentType) {
    forwarded.set("content-type", contentType);
  }
  if (accept) {
    forwarded.set("accept", accept);
  }
  return forwarded;
}

function normalizeBackendUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function backendUrlCandidates(value: string): string[] {
  const candidates = [value];
  try {
    const parsed = new URL(value);
    if (parsed.hostname === "localhost") {
      parsed.hostname = "127.0.0.1";
      candidates.push(parsed.toString().replace(/\/$/, ""));
    } else if (parsed.hostname === "127.0.0.1") {
      parsed.hostname = "localhost";
      candidates.push(parsed.toString().replace(/\/$/, ""));
    }
  } catch {
    return candidates;
  }
  return [...new Set(candidates)];
}
