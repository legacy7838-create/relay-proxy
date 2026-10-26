const MARKER = "<!-- relay-pool-registry:v1 -->";
const MAX_COMMENT_LENGTH = 65_536;
const MAX_LIST_PAGES = 10;

export class RegistryError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RegistryError";
    if (status !== undefined) this.status = status;
  }
}

function parseIso(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const allowedKeys = new Set(["kind", "id", "url", "expiresAt", "lastHeartbeatAt"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) return null;
  }

  if (raw.kind !== "relay" && raw.kind !== "gateway") return null;
  if (typeof raw.id !== "string") return null;
  if (raw.kind === "relay" && !/^relay-[1-4]$/.test(raw.id)) return null;
  if (raw.kind === "gateway" && raw.id !== "gateway") return null;
  if (typeof raw.url !== "string" || raw.url.length === 0 || raw.url.length > 512) return null;

  let url;
  try {
    url = new URL(raw.url);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }

  const expiresAt = parseIso(raw.expiresAt);
  const lastHeartbeatAt = parseIso(raw.lastHeartbeatAt);
  if (!expiresAt || !lastHeartbeatAt) return null;

  return {
    kind: raw.kind,
    id: raw.id,
    url: url.origin,
    expiresAt,
    lastHeartbeatAt,
  };
}

export function formatRegistryComment(entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized) throw new Error("Invalid registry entry");
  return `${MARKER}\n${JSON.stringify(normalized)}`;
}

export function parseRegistryComment(body) {
  if (typeof body !== "string" || body.length > MAX_COMMENT_LENGTH) return null;
  const trimmed = body.trimStart();
  if (!trimmed.startsWith(MARKER)) return null;
  const payload = trimmed.slice(MARKER.length).trim();
  if (payload === "" || payload.includes("\n")) return null;
  try {
    return normalizeEntry(JSON.parse(payload));
  } catch {
    return null;
  }
}

function registryKey(kind, id) {
  return `${kind}:${id}`;
}

export async function githubApiRequest({
  apiUrl,
  token,
  method = "GET",
  path,
  body,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}) {
  if (!token) throw new RegistryError("GitHub token is required");
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new RegistryError("Invalid GitHub API path");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "relay-pool-registry",
  };
  if (body !== undefined) headers["content-type"] = "application/json";

  try {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // The response body is irrelevant on failure.
      }
      throw new RegistryError(`GitHub registry request failed with status ${response.status}`, {
        status: response.status,
      });
    }
    if (response.status === 204) return null;
    return await response.json();
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError("GitHub registry request failed", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export class GithubIssueRegistry {
  constructor({
    repo,
    issueNumber,
    token,
    apiUrl = "https://api.github.com",
    actorLogin = "github-actions[bot]",
    fetchImpl = fetch,
    logger,
    timeoutMs = 15_000,
  }) {
    if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error("repo must be in owner/repo form");
    }
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
      throw new Error("issueNumber must be a positive integer");
    }
    if (!token) throw new Error("token is required");

    this.repo = repo;
    this.issueNumber = issueNumber;
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.actorLogin = actorLogin;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.commentIds = new Map();
  }

  async #request(method, path, body) {
    return githubApiRequest({
      apiUrl: this.apiUrl,
      token: this.token,
      method,
      path,
      body,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
  }

  async #listMarkedComments() {
    const comments = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const batch = await this.#request(
        "GET",
        `/repos/${this.repo}/issues/${this.issueNumber}/comments?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) throw new RegistryError("Invalid registry response");

      for (const comment of batch) {
        if (comment?.user?.login !== this.actorLogin) continue;
        if (typeof comment.body !== "string") continue;
        if (!comment.body.trimStart().startsWith(MARKER)) continue;
        comments.push(comment);
      }

      if (batch.length < 100) break;
    }
    return comments;
  }

  async listEntries() {
    const comments = await this.#listMarkedComments();
    const entries = [];
    const ids = new Map();

    for (const comment of comments) {
      const entry = parseRegistryComment(comment.body);
      if (!entry) continue;
      ids.set(registryKey(entry.kind, entry.id), comment.id);
      entries.push({ ...entry, commentId: comment.id });
    }

    this.commentIds = ids;
    return entries;
  }

  async register(rawEntry) {
    const entry = normalizeEntry(rawEntry);
    if (!entry) throw new Error("Invalid registry entry");

    const key = registryKey(entry.kind, entry.id);
    if (!this.commentIds.has(key)) {
      await this.listEntries();
    }

    const body = formatRegistryComment(entry);
    let commentId = this.commentIds.get(key);

    if (commentId) {
      try {
        await this.#request("PATCH", `/repos/${this.repo}/issues/comments/${commentId}`, { body });
        return commentId;
      } catch (error) {
        if (error.status !== 404) throw error;
        this.commentIds.delete(key);
      }
    }

    const created = await this.#request(
      "POST",
      `/repos/${this.repo}/issues/${this.issueNumber}/comments`,
      { body },
    );
    if (!created || typeof created.id !== "number") {
      throw new RegistryError("Invalid registry response");
    }
    this.commentIds.set(key, created.id);
    return created.id;
  }

  async remove(kind, id) {
    const key = registryKey(kind, id);
    if (!this.commentIds.has(key)) {
      await this.listEntries();
    }

    const commentId = this.commentIds.get(key);
    if (!commentId) return false;

    try {
      await this.#request("DELETE", `/repos/${this.repo}/issues/comments/${commentId}`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    this.commentIds.delete(key);
    return true;
  }

  async clearAll() {
    const comments = await this.#listMarkedComments();
    let deleted = 0;
    for (const comment of comments) {
      try {
        await this.#request("DELETE", `/repos/${this.repo}/issues/comments/${comment.id}`);
        deleted += 1;
      } catch (error) {
        if (error.status !== 404) {
          throw new RegistryError("Failed to clear a stale registry entry", {
            status: error.status,
          });
        }
      }
    }
    this.commentIds.clear();
    return deleted;
  }
}

export async function prepareRegistry({
  repo,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
  title = "relay-pool registry (automated)",
  actorLogin = "github-actions[bot]",
  logger,
}) {
  const base = apiUrl.replace(/\/+$/, "");
  const issues = await githubApiRequest({
    apiUrl: base,
    token,
    path: `/repos/${repo}/issues?state=open&per_page=100&sort=created&direction=desc`,
    fetchImpl,
  });

  let issue = Array.isArray(issues)
    ? issues.find(
        (candidate) =>
          !candidate.pull_request &&
          candidate.title === title &&
          candidate.user?.login === actorLogin,
      )
    : null;

  if (!issue) {
    issue = await githubApiRequest({
      apiUrl: base,
      token,
      method: "POST",
      path: `/repos/${repo}/issues`,
      body: {
        title,
        body: [
          "This issue is the automated live registry for the temporary relay pool.",
          "",
          "Each relay job publishes its Quick Tunnel URL as a comment here with a short TTL.",
          "The gateway reads only comments authored by the repository's GitHub Actions bot.",
          "Tokens are never stored here. URLs are public, like the workflow logs.",
        ].join("\n"),
      },
      fetchImpl,
    });
  }

  if (!issue || typeof issue.number !== "number") {
    throw new RegistryError("Failed to locate or create the registry issue");
  }

  const registry = new GithubIssueRegistry({
    repo,
    issueNumber: issue.number,
    token,
    apiUrl: base,
    actorLogin,
    fetchImpl,
    logger,
  });
  const cleared = await registry.clearAll();

  if (logger) {
    logger.info("registry_prepared", {
      issueNumber: issue.number,
      clearedRegistrations: cleared,
    });
  }

  return {
    issueNumber: issue.number,
    issueUrl: issue.html_url,
    cleared,
  };
}
