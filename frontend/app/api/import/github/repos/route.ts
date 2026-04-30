type GitHubRepo = {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  fork: boolean;
  stargazers_count: number;
  updated_at: string;
  default_branch: string;
  html_url: string;
};

type SimplifiedGitHubRepo = {
  id?: number;
  name: string;
  fullName: string;
  description: string;
  fork: boolean;
  stars: number;
  updatedAt: string;
  defaultBranch: string;
  url: string;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const username = normalizeGitHubUser(url.searchParams.get("username") ?? "");

  if (!username) {
    return Response.json({ error: "missing_username", message: "Enter a GitHub username." }, { status: 400 });
  }

  const response = await fetch(
    `https://api.github.com/users/${encodeURIComponent(username)}/repos?type=owner&sort=updated&direction=desc&per_page=50`,
    {
      headers: githubHeaders(),
      cache: "no-store",
    },
  );
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    return Response.json(
      {
        error: "github_repos_failed",
        message: readGitHubMessage(data) || `GitHub request failed with ${response.status}`,
      },
      { status: response.status },
    );
  }

  const repos = Array.isArray(data)
    ? data.map((repo) => simplifyRepo(repo)).filter((repo): repo is SimplifiedGitHubRepo => Boolean(repo))
    : [];

  return Response.json({ username, repos });
}

function normalizeGitHubUser(value: string) {
  let raw = value.trim();
  if (!raw) return "";
  if (raw.includes("://") || raw.startsWith("github.com/")) {
    try {
      const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
      raw = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    } catch {
      raw = raw.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
    }
  }
  return raw.split("/")[0].replace(/^@/, "").trim();
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

function simplifyRepo(repo: Partial<GitHubRepo> | null | undefined): SimplifiedGitHubRepo | null {
  if (!repo || !repo.name || !repo.full_name) return null;
  return {
    id: repo.id ?? undefined,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description ?? "",
    fork: Boolean(repo.fork),
    stars: Number(repo.stargazers_count ?? 0),
    updatedAt: repo.updated_at ?? "",
    defaultBranch: repo.default_branch ?? "main",
    url: repo.html_url ?? `https://github.com/${repo.full_name}`,
  };
}

function readGitHubMessage(data: unknown) {
  if (!data || typeof data !== "object") return "";
  const message = (data as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}
