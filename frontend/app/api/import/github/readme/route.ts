type GitHubReadme = {
  name?: string;
  path?: string;
  encoding?: string;
  content?: string;
  html_url?: string;
  download_url?: string;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const owner = normalizePathPart(url.searchParams.get("owner") ?? "");
  const repo = normalizePathPart(url.searchParams.get("repo") ?? "");

  if (!owner || !repo) {
    return Response.json(
      { error: "missing_repository", message: "Choose a GitHub repository first." },
      { status: 400 },
    );
  }

  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
    {
      headers: githubHeaders(),
      cache: "no-store",
    },
  );
  const data = (await response.json().catch(() => null)) as GitHubReadme | { message?: string } | null;

  if (!response.ok) {
    return Response.json(
      {
        error: "github_readme_failed",
        message: readGitHubMessage(data) || `GitHub README request failed with ${response.status}`,
      },
      { status: response.status },
    );
  }

  const readme = data as GitHubReadme;
  const text = decodeGitHubReadme(readme);

  if (!text.trim()) {
    return Response.json(
      { error: "empty_readme", message: "GitHub returned an empty README for this repository." },
      { status: 404 },
    );
  }

  return Response.json({
    owner,
    repo,
    name: readme.name ?? "README",
    path: readme.path ?? "README",
    url: readme.html_url ?? `https://github.com/${owner}/${repo}`,
    text,
  });
}

function normalizePathPart(value: string) {
  return value.trim().replace(/^@/, "").split("/")[0];
}

function githubHeaders() {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "voices-upload-importer",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function decodeGitHubReadme(readme: GitHubReadme) {
  if (readme.encoding === "base64" && typeof readme.content === "string") {
    return Buffer.from(readme.content.replace(/\n/g, ""), "base64").toString("utf8");
  }
  if (typeof readme.content === "string") return readme.content;
  return "";
}

function readGitHubMessage(data: unknown) {
  if (!data || typeof data !== "object") return "";
  const message = (data as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}
