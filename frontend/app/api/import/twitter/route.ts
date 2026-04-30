type XUser = {
  id?: string;
  name?: string;
  username?: string;
  profile_image_url?: string;
  verified?: boolean;
  public_metrics?: {
    followers_count?: number;
    tweet_count?: number;
  };
};

type XTweet = {
  id?: string;
  text?: string;
  created_at?: string;
  referenced_tweets?: Array<{
    id?: string;
    type?: "retweeted" | "quoted" | "replied_to" | string;
  }>;
  public_metrics?: {
    retweet_count?: number;
    reply_count?: number;
    like_count?: number;
    quote_count?: number;
    impression_count?: number;
  };
};

const X_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const handle = normalizeXHandle(url.searchParams.get("username") ?? "");
  const bearerToken = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN;

  if (!handle || !X_HANDLE_PATTERN.test(handle)) {
    return Response.json(
      {
        error: "invalid_x_username",
        message: "Enter a valid X username, @handle, or profile URL.",
      },
      { status: 400 },
    );
  }

  if (!bearerToken) {
    return Response.json(
      {
        error: "missing_x_bearer_token",
        message: "Set X_BEARER_TOKEN or TWITTER_BEARER_TOKEN in the frontend environment, then restart the frontend server.",
      },
      { status: 501 },
    );
  }

  const userLookupUrl = new URL(`https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}`);
  userLookupUrl.searchParams.set(
    "user.fields",
    "created_at,description,profile_image_url,public_metrics,verified",
  );

  const userResponse = await fetch(userLookupUrl, {
    headers: xHeaders(bearerToken),
    cache: "no-store",
  });
  const userPayload = (await userResponse.json().catch(() => null)) as { data?: XUser; detail?: string; title?: string } | null;

  if (!userResponse.ok || !userPayload?.data?.id) {
    return Response.json(
      {
        error: "x_user_lookup_failed",
        message: readXMessage(userPayload) || `X user lookup failed with ${userResponse.status}`,
      },
      { status: userResponse.status || 502 },
    );
  }

  const tweetsUrl = new URL(`https://api.x.com/2/users/${encodeURIComponent(userPayload.data.id)}/tweets`);
  tweetsUrl.searchParams.set("max_results", "50");
  tweetsUrl.searchParams.set("exclude", "replies,retweets");
  tweetsUrl.searchParams.set("tweet.fields", "created_at,lang,public_metrics,referenced_tweets,source,text");

  const tweetsResponse = await fetch(tweetsUrl, {
    headers: xHeaders(bearerToken),
    cache: "no-store",
  });
  const tweetsPayload = (await tweetsResponse.json().catch(() => null)) as
    | { data?: XTweet[]; meta?: Record<string, unknown>; detail?: string; title?: string }
    | null;

  if (!tweetsResponse.ok) {
    return Response.json(
      {
        error: "x_tweets_failed",
        message: readXMessage(tweetsPayload) || `X posts request failed with ${tweetsResponse.status}`,
      },
      { status: tweetsResponse.status || 502 },
    );
  }

  const tweets = Array.isArray(tweetsPayload?.data)
    ? tweetsPayload.data
        .filter((tweet) => {
          const text = tweet.text?.trim() ?? "";
          const isRepost =
            /^RT\s+@/i.test(text) ||
            tweet.referenced_tweets?.some((ref) => ref.type === "retweeted");
          return text.length > 0 && !isRepost;
        })
        .map((tweet) => ({
          id: tweet.id ?? "",
          text: tweet.text ?? "",
          createdAt: tweet.created_at ?? "",
          metrics: tweet.public_metrics ?? {},
        }))
    : [];

  return Response.json({
    username: userPayload.data.username ?? handle,
    displayName: userPayload.data.name ?? handle,
    avatarUrl: userPayload.data.profile_image_url ?? "",
    verified: Boolean(userPayload.data.verified),
    metrics: userPayload.data.public_metrics ?? {},
    tweets,
    meta: tweetsPayload?.meta ?? {},
  });
}

function normalizeXHandle(value: string) {
  let raw = value.trim();
  if (!raw) return "";
  if (raw.startsWith("@")) raw = raw.slice(1);

  if (raw.includes("://") || raw.startsWith("x.com/") || raw.startsWith("twitter.com/")) {
    try {
      const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
      raw = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    } catch {
      raw = raw.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "");
    }
  }

  return raw.split("?")[0].split("/")[0].replace(/^@/, "").trim();
}

function xHeaders(bearerToken: string) {
  return {
    Authorization: `Bearer ${bearerToken}`,
    "User-Agent": "voices-upload-importer",
  };
}

function readXMessage(data: unknown) {
  if (!data || typeof data !== "object") return "";
  const record = data as { detail?: unknown; title?: unknown; errors?: unknown };
  if (typeof record.detail === "string") return record.detail;
  if (typeof record.title === "string") return record.title;
  if (Array.isArray(record.errors)) {
    const first = record.errors.find((item) => item && typeof item === "object") as
      | { detail?: unknown; title?: unknown }
      | undefined;
    if (typeof first?.detail === "string") return first.detail;
    if (typeof first?.title === "string") return first.title;
  }
  return "";
}
