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
  const backendUrl = (process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || DEFAULT_BACKEND_URL).replace(
    /\/$/,
    ""
  );
  const incomingUrl = new URL(request.url);
  const path = context.params.path?.join("/") ?? "";
  const targetUrl = `${backendUrl}/${path}${incomingUrl.search}`;

  try {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
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
    return Response.json(
      {
        error: "backend_unavailable",
        backendUrl,
        message: error instanceof Error ? error.message : String(error)
      },
      { status: 502 }
    );
  }
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
