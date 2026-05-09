import { friendlyErrorMessage } from "../../../../lib/friendlyErrors";

type FirecrawlPayload = {
  success?: boolean;
  data?: {
    markdown?: string;
    content?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
    title?: string;
  };
  markdown?: string;
  content?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  title?: string;
  error?: unknown;
  message?: unknown;
};

const MIN_USABLE_TEXT_CHARS = 200;
const BLOCKED_HOSTS = new Set(["localhost", "0.0.0.0", "127.0.0.1", "::1"]);

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const sourceUrl = normalizeArticleUrl(requestUrl.searchParams.get("url") ?? "");

  if (!sourceUrl) {
    return Response.json(
      { error: "missing_url", message: "Enter a blog or article URL." },
      { status: 400 },
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return Response.json(
      { error: "invalid_url", message: "Enter a valid http or https URL." },
      { status: 400 },
    );
  }

  const blockedReason = getBlockedUrlReason(parsed);
  if (blockedReason) {
    return Response.json(
      { error: "blocked_url", message: blockedReason },
      { status: 400 },
    );
  }

  const firecrawl = await scrapeWithFirecrawl(parsed.toString());
  if (firecrawl.ok) return Response.json(firecrawl.result);

  const direct = await scrapeDirectly(parsed.toString());
  if (direct.ok) {
    return Response.json({
      ...direct.result,
      firecrawlError: firecrawl.message,
    });
  }

  return Response.json(
    {
      error: "blog_import_failed",
      message:
        direct.message ||
        firecrawl.message ||
        "Could not extract readable text from this URL. Try another public blog or article URL.",
    },
    { status: 502 },
  );
}

function normalizeArticleUrl(value: string) {
  const raw = value.trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function getBlockedUrlReason(url: URL) {
  if (!["http:", "https:"].includes(url.protocol)) return "Only http and https URLs can be imported.";

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local")) {
    return "Local and private network URLs cannot be imported from the server.";
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) {
    return "Private network URLs cannot be imported from the server.";
  }
  const private172 = host.match(/^172\.(\d+)\./);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) {
    return "Private network URLs cannot be imported from the server.";
  }
  if (/^169\.254\./.test(host)) return "Link-local URLs cannot be imported from the server.";
  return "";
}

async function scrapeWithFirecrawl(url: string): Promise<
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; message: string }
> {
  const apiKey = process.env.FIRECRAWL_API_KEY || process.env.BRAINROT_FIRECRAWL_API_KEY;
  if (!apiKey) return { ok: false, message: "Firecrawl API key is not configured." };

  const baseUrl =
    process.env.FIRECRAWL_BASE_URL || process.env.BRAINROT_FIRECRAWL_BASE_URL || "https://api.firecrawl.dev";
  const maxAge = Number(
    process.env.FIRECRAWL_SCRAPE_MAX_AGE_MS ||
      process.env.BRAINROT_FIRECRAWL_SCRAPE_MAX_AGE_MS ||
      0,
  );

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v2/scrape`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "voices-upload-importer",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown", "summary"],
        onlyMainContent: true,
        maxAge,
        removeBase64Images: true,
        blockAds: true,
        timeout: 60000,
      }),
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as FirecrawlPayload | null;
    if (!response.ok) {
      return { ok: false, message: readProviderMessage(payload) || `Firecrawl failed with ${response.status}.` };
    }

    const data = payload?.data ?? payload ?? {};
    const markdown = String(data.markdown || data.content || "");
    const metadata = data.metadata ?? {};
    guardUsableText(markdown, metadata, url);

    return {
      ok: true,
      result: {
        url,
        source: "firecrawl",
        title: getString(metadata.title) || getString(data.title) || new URL(url).hostname,
        text: markdown,
        summary: getString(data.summary),
        siteName: getString(metadata.ogSiteName) || getString(metadata.siteName),
        chars: markdown.length,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: friendlyErrorMessage(error, { fallback: "Firecrawl could not scrape this URL." }),
    };
  }
}

async function scrapeDirectly(url: string): Promise<
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; message: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain,text/markdown,*/*;q=0.7",
        "User-Agent": "voices-upload-importer",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    const contentType = response.headers.get("content-type") ?? "";
    const htmlOrText = await response.text();

    if (!response.ok) {
      return { ok: false, message: `The URL returned HTTP ${response.status}.` };
    }

    const direct = contentType.includes("html")
      ? htmlToReadableMarkdown(htmlOrText, url)
      : {
          title: new URL(url).hostname,
          text: htmlOrText,
        };

    guardUsableText(direct.text, { statusCode: response.status }, url);

    return {
      ok: true,
      result: {
        url,
        source: "direct",
        title: direct.title || new URL(url).hostname,
        text: direct.text,
        summary: "",
        siteName: new URL(url).hostname,
        chars: direct.text.length,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: friendlyErrorMessage(error, { fallback: "Could not fetch this URL directly." }),
    };
  } finally {
    clearTimeout(timer);
  }
}

function htmlToReadableMarkdown(html: string, url: string) {
  const title =
    matchMeta(html, "property", "og:title") ||
    matchMeta(html, "name", "twitter:title") ||
    stripTags(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i)) ||
    new URL(url).hostname;

  const article =
    matchFirst(html, /<article[^>]*>([\s\S]*?)<\/article>/i) ||
    matchFirst(html, /<main[^>]*>([\s\S]*?)<\/main>/i) ||
    matchFirst(html, /<body[^>]*>([\s\S]*?)<\/body>/i) ||
    html;

  const cleaned = article
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(nav|header|footer|aside|form|button)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h([1-6])[^>]*>/gi, "\n\n$&")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "\n\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(div|section|blockquote|ul|ol)>/gi, "\n")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const label = stripTags(String(text)).trim();
      if (!label) return " ";
      return `${label} (${href})`;
    });

  return {
    title: decodeHtmlEntities(title.trim()),
    text: normalizeWhitespace(stripTags(cleaned)),
  };
}

function guardUsableText(text: string, metadata: Record<string, unknown>, url: string) {
  const statusCode = metadata.statusCode ?? metadata.status_code;
  if (typeof statusCode === "number" && statusCode >= 400) {
    throw new Error(`The page returned HTTP ${statusCode}.`);
  }

  const cleaned = text.trim();
  if (!cleaned) throw new Error("The page returned no readable article text.");
  if (cleaned.length < MIN_USABLE_TEXT_CHARS) {
    throw new Error(`Only ${cleaned.length} readable characters were found at ${url}.`);
  }
  if (looksLikeBlockedPage(cleaned)) {
    throw new Error("The page looks like a login wall, bot challenge, or access-denied page.");
  }
}

function looksLikeBlockedPage(text: string) {
  const lower = text.slice(0, 2000).toLowerCase();
  return [
    "just a moment",
    "checking your browser",
    "enable javascript",
    "please enable javascript",
    "verify you are human",
    "captcha",
    "access denied",
    "are you a robot",
    "cloudflare",
    "log in to continue",
    "sign in to continue",
  ].some((sentinel) => lower.includes(sentinel));
}

function matchFirst(input: string, regex: RegExp) {
  return input.match(regex)?.[1] ?? "";
}

function matchMeta(html: string, attr: "name" | "property", value: string) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `<meta[^>]+${attr}=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  return html.match(regex)?.[1] ?? "";
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(value: string) {
  return decodeHtmlEntities(value)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function getString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function readProviderMessage(payload: FirecrawlPayload | null) {
  if (!payload) return "";
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  if (payload.error && typeof payload.error === "object") {
    const message = (payload.error as { message?: unknown; detail?: unknown }).message;
    const detail = (payload.error as { message?: unknown; detail?: unknown }).detail;
    if (typeof message === "string") return message;
    if (typeof detail === "string") return detail;
  }
  return "";
}
