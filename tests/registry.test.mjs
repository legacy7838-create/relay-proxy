import assert from "node:assert/strict";
import test from "node:test";
import {
  GithubIssueRegistry,
  RegistryError,
  formatRegistryComment,
  normalizeEntry,
  parseRegistryComment,
  prepareRegistry,
} from "../src/registry.mjs";
import { jsonResponse } from "./helpers.mjs";

const REPO = "owner/repo";
const ISSUE = 42;

function validEntry(overrides = {}) {
  const now = Date.now();
  return {
    kind: "relay",
    id: "relay-1",
    url: "https://happy-cat.trycloudflare.com",
    expiresAt: new Date(now + 60_000).toISOString(),
    lastHeartbeatAt: new Date(now).toISOString(),
    ...overrides,
  };
}

function botComment(id, entry) {
  return { id, body: formatRegistryComment(entry), user: { login: "github-actions[bot]" } };
}

function createFakeGithub({ comments = [], issues = [], failWith = null } = {}) {
  let nextCommentId = 1_000;
  let nextIssueNumber = 10;
  const calls = [];

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: parsed.pathname, search: parsed.search, headers: init.headers, body });

    if (failWith) return new Response("failure", { status: failWith });

    if (method === "GET" && parsed.pathname === `/repos/${REPO}/issues`) {
      return jsonResponse(issues);
    }
    if (method === "POST" && parsed.pathname === `/repos/${REPO}/issues`) {
      const issue = {
        number: nextIssueNumber,
        title: body.title,
        html_url: `https://github.com/${REPO}/issues/${nextIssueNumber}`,
        user: { login: "github-actions[bot]" },
      };
      nextIssueNumber += 1;
      issues.push(issue);
      return jsonResponse(issue, 201);
    }

    const commentsMatch = /^\/repos\/owner\/repo\/issues\/(\d+)\/comments$/.exec(parsed.pathname);
    if (commentsMatch) {
      const page = Number(parsed.searchParams.get("page") || "1");
      if (method === "GET") return jsonResponse(page === 1 ? comments : []);
      if (method === "POST") {
        const comment = {
          id: nextCommentId,
          body: body.body,
          user: { login: "github-actions[bot]" },
        };
        nextCommentId += 1;
        comments.push(comment);
        return jsonResponse(comment, 201);
      }
    }

    const commentMatch = /^\/repos\/owner\/repo\/issues\/comments\/(\d+)$/.exec(parsed.pathname);
    if (commentMatch) {
      const id = Number(commentMatch[1]);
      const index = comments.findIndex((comment) => comment.id === id);
      if (index === -1) return new Response("not found", { status: 404 });
      if (method === "PATCH") {
        comments[index] = { ...comments[index], body: body.body };
        return jsonResponse(comments[index]);
      }
      if (method === "DELETE") {
        comments.splice(index, 1);
        return new Response(null, { status: 204 });
      }
    }

    return new Response("unexpected", { status: 500 });
  };

  return { fetchImpl, calls, comments, issues };
}

function makeRegistry(fake, overrides = {}) {
  return new GithubIssueRegistry({
    repo: REPO,
    issueNumber: ISSUE,
    token: "super-secret-token",
    apiUrl: "https://api.github.test",
    fetchImpl: fake.fetchImpl,
    ...overrides,
  });
}

test("registry comment format round-trips and rejects malformed entries", () => {
  const entry = validEntry();
  const parsed = parseRegistryComment(formatRegistryComment(entry));
  assert.deepEqual(parsed, entry);
  assert.equal(parseRegistryComment("plain comment"), null);
  assert.equal(parseRegistryComment("<!-- relay-pool-registry:v1 -->\n{bad json"), null);
  assert.equal(
    parseRegistryComment(
      `<!-- relay-pool-registry:v1 -->\n${JSON.stringify(entry)}\ntrailing text`,
    ),
    null,
  );
  assert.equal(normalizeEntry({ ...entry, extra: true }), null);
  assert.equal(normalizeEntry({ ...entry, id: "relay-9" }), null);
  assert.equal(normalizeEntry({ ...entry, kind: "gateway" }), null);
  assert.equal(normalizeEntry({ ...entry, url: "https://happy-cat.trycloudflare.com/path" }), null);
  assert.equal(normalizeEntry({ ...entry, expiresAt: "not-a-date" }), null);
});

test("registry lists only valid comments authored by the trusted workflow actor", async () => {
  const fake = createFakeGithub({
    comments: [
      botComment(1, validEntry()),
      {
        id: 2,
        body: formatRegistryComment(validEntry({ id: "relay-2" })),
        user: { login: "attacker" },
      },
      { id: 3, body: "ordinary comment", user: { login: "github-actions[bot]" } },
      {
        id: 4,
        body: "<!-- relay-pool-registry:v1 -->\n{broken",
        user: { login: "github-actions[bot]" },
      },
      botComment(5, validEntry({ kind: "gateway", id: "gateway" })),
    ],
  });
  const registry = makeRegistry(fake);

  const entries = await registry.listEntries();
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["relay-1", "gateway"],
  );
  assert.equal(entries[0].commentId, 1);

  assert.equal(fake.calls[0].headers.authorization, "Bearer super-secret-token");
  assert.equal(fake.calls[0].headers["x-github-api-version"], "2022-11-28");
});

test("registry creates a comment and updates it in place on heartbeat", async () => {
  const fake = createFakeGithub();
  const registry = makeRegistry(fake);

  const first = await registry.register(validEntry());
  assert.equal(fake.comments.length, 1);
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);

  const second = await registry.register(
    validEntry({ expiresAt: new Date(Date.now() + 120_000).toISOString() }),
  );
  assert.equal(first, second);
  assert.equal(fake.comments.length, 1);
  assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, 1);

  const parsed = parseRegistryComment(fake.comments[0].body);
  assert.equal(parsed.id, "relay-1");
});

test("registry removes only the matching registration", async () => {
  const fake = createFakeGithub({
    comments: [
      botComment(11, validEntry()),
      botComment(12, validEntry({ id: "relay-2" })),
    ],
  });
  const registry = makeRegistry(fake);

  assert.equal(await registry.remove("relay", "relay-1"), true);
  assert.deepEqual(
    fake.comments.map((comment) => comment.id),
    [12],
  );
  assert.equal(await registry.remove("relay", "relay-3"), false);
});

test("registry clearAll deletes marked comments from the bot only", async () => {
  const fake = createFakeGithub({
    comments: [
      botComment(21, validEntry()),
      {
        id: 22,
        body: formatRegistryComment(validEntry({ id: "relay-2" })),
        user: { login: "attacker" },
      },
      {
        id: 23,
        body: "<!-- relay-pool-registry:v1 -->\n{bad",
        user: { login: "github-actions[bot]" },
      },
    ],
  });
  const registry = makeRegistry(fake);

  assert.equal(await registry.clearAll(), 2);
  assert.deepEqual(
    fake.comments.map((comment) => comment.id),
    [22],
  );
});

test("prepareRegistry creates the registry issue and clears stale entries", async () => {
  const fake = createFakeGithub({
    comments: [botComment(31, validEntry({ id: "relay-2" }))],
  });
  const result = await prepareRegistry({
    repo: REPO,
    token: "super-secret-token",
    apiUrl: "https://api.github.test",
    fetchImpl: fake.fetchImpl,
  });

  assert.equal(result.issueNumber, 10);
  assert.equal(result.cleared, 1);
  assert.equal(fake.issues.length, 1);
  assert.equal(fake.comments.length, 0);
  assert.ok(fake.calls.some((call) => call.method === "POST" && call.path === `/repos/${REPO}/issues`));
});

test("prepareRegistry reuses an existing registry issue created by the workflow bot", async () => {
  const fake = createFakeGithub({
    issues: [
      {
        number: ISSUE,
        title: "relay-pool registry (automated)",
        html_url: `https://github.com/${REPO}/issues/${ISSUE}`,
        user: { login: "github-actions[bot]" },
      },
    ],
    comments: [botComment(41, validEntry())],
  });
  const result = await prepareRegistry({
    repo: REPO,
    token: "super-secret-token",
    apiUrl: "https://api.github.test",
    fetchImpl: fake.fetchImpl,
  });

  assert.equal(result.issueNumber, ISSUE);
  assert.equal(result.cleared, 1);
  assert.equal(fake.comments.length, 0);
  assert.equal(
    fake.calls.filter((call) => call.method === "POST" && call.path === `/repos/${REPO}/issues`)
      .length,
    0,
  );
});

test("prepareRegistry ignores lookalike issues from other authors", async () => {
  const fake = createFakeGithub({
    issues: [
      {
        number: 99,
        title: "relay-pool registry (automated)",
        html_url: `https://github.com/${REPO}/issues/99`,
        user: { login: "someone-else" },
      },
    ],
  });
  const result = await prepareRegistry({
    repo: REPO,
    token: "super-secret-token",
    apiUrl: "https://api.github.test",
    fetchImpl: fake.fetchImpl,
  });

  assert.notEqual(result.issueNumber, 99);
  assert.ok(result.issueNumber >= 10);
});

test("registry errors are sanitized and expose only the status", async () => {
  const fake = createFakeGithub({ failWith: 500 });
  const registry = makeRegistry(fake);

  let error;
  try {
    await registry.listEntries();
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof RegistryError);
  assert.equal(error.status, 500);
  assert.doesNotMatch(error.message, /super-secret-token/);
});
