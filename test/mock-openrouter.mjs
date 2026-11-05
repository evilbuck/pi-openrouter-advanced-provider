/**
 * Mock OpenRouter service for the containerized test harness.
 *
 * Bun/Node http server emulating every endpoint the extension touches
 * (pi/api.ts), with deterministic fixtures from ./fixtures/openrouter.mjs.
 *
 *   const { baseUrl, close } = await startMockOpenRouter({ logPath });
 *   // baseUrl: http://127.0.0.1:<port>/api/v1 — set OPENROUTER_BASE_URL to it
 *   //   (the harness owner also aims the frontend-stats base and the pi
 *   //   router-cost interception at this origin).
 *   await close();
 *
 * Endpoints served (all under this origin; unknown paths -> 404):
 *   GET  /api/v1/models                          public catalog (no auth; distinct ids from the account list)
 *   GET  /api/v1/models/user                     account catalog, auth required
 *   POST /api/v1/chat/completions                SSE stream + final usage chunk with cost, auth required
 *   GET  /api/v1/key                             key info, auth required
 *   GET  /api/v1/credits                         account balance, auth required
 *   GET  /api/v1/models/:author/:slug/endpoints  per-model endpoints, auth required
 *   GET  /api/frontend/v1/catalog/models         slug -> permaslug map (unauthenticated website API)
 *   GET  /api/frontend/v1/stats/endpoint         StatEndpoint[] rows, ?permaslug=...
 *   GET  /api/frontend/v1/stats/tool-call-error-rate
 *
 * Keyed endpoints reject anything but `expectedKey` with 401; when omitted,
 * any Bearer key is accepted (standalone/local smoke use). The frontend
 * routes under /api/frontend/v1 are the public website API: the real
 * service serves them WITHOUT authentication (pi/api.ts calls them
 * unauthenticated), so the mock must too — a 401 there silently disables
 * just-in-time provider selection.
 *
 * Option `frontendStatsUnavailable: true` makes the two stats endpoints
 * answer 404 (the catalog still answers 200). It mutates the MOCK side of
 * the contract only, so a scenario can prove the selection path is skipped
 * when the stats are unavailable.
 *
 * Every request is appended to `logPath` as one NDJSON row:
 *   { method, path, authorization, title, body?, status }
 * `authorization` is the raw Bearer value, `title` the x-title header,
 * `body` is the parsed JSON payload on POSTs, and `status` is the HTTP
 * response status. The row is written once, after the response status is
 * known. This log is the primary assertion surface for key resolution, the
 * public-vs-account masquerade guard, X-Title propagation, and the
 * frontend-stats calls behind just-in-time selection.
 *
 * Smoke (from repo root, bun or node):
 *   node -e 'import("./test/mock-openrouter.mjs").then(async (m) =>
 *     { const s = await m.startMockOpenRouter({ logPath: "/tmp/m.ndjson" });
 *       console.log(s.baseUrl); })'
 *   curl -H "Authorization: Bearer sk-or-test-container" <baseUrl>/models/user
 */

import http from "node:http";
import { appendFile } from "node:fs/promises";
import {
  COST,
  MODEL_ID,
  RESPONSE_TEXT,
  ACCOUNT_MODELS,
  PUBLIC_MODELS,
  PERMASLUGS,
  endpointStatsFor,
  toolCallErrorRateFor,
  modelEndpointsFor,
} from "./fixtures/openrouter.mjs";

/** One chat.completion.chunk object; deterministic ids and timestamps. */
function chunk(model, delta, extra = {}) {
  return {
    id: "chatcmpl-container-mock",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  };
}

function sseBody(model) {
  const lines = [
    `data: ${JSON.stringify(chunk(model, { role: "assistant", content: "" }))}`,
    "",
    `data: ${JSON.stringify(chunk(model, { content: RESPONSE_TEXT }))}`,
    "",
    `data: ${JSON.stringify(chunk(model, {}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))}`,
    "",
    `data: ${JSON.stringify(
      chunk(model, {}, {
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cost: COST },
      }),
    )}`,
    "",
    "data: [DONE]",
    "",
  ];
  return lines.join("\n");
}

/** Non-streaming completion body (stream=false smoke path). */
function completionBody(model) {
  return {
    id: "chatcmpl-container-mock",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: RESPONSE_TEXT }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cost: COST },
  };
}

function authErrorBody() {
  return JSON.stringify({ error: { message: "Invalid or missing credentials", code: 401 } });
}

function notFoundBody() {
  return JSON.stringify({ error: { message: "Not found", code: 404 } });
}

/** Frontend website API routes: served without a bearer token, like the real service. */
const FRONTEND_PATHS = new Set([
  "/api/frontend/v1/catalog/models",
  "/api/frontend/v1/stats/endpoint",
  "/api/frontend/v1/stats/tool-call-error-rate",
]);

const FRONTEND_STATS_PATHS = new Set([
  "/api/frontend/v1/stats/endpoint",
  "/api/frontend/v1/stats/tool-call-error-rate",
]);

function catalogResponse(models) {
  return JSON.stringify({ data: models });
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Resolve one request to its response: { status, headers, body }. Kept
 * separate from the server callback so the NDJSON log row can be written
 * once, after the status is known.
 */
function resolveResponse({ req, path, url, body, bearer, expectedKey, frontendStatsUnavailable }) {
  const method = req.method;

  const authorized =
    method === "GET" && path === "/api/v1/models"
      ? true // public catalog: no auth required
      : method === "GET" && FRONTEND_PATHS.has(path)
        ? true // frontend website API: the real service serves it unauthenticated
        : bearer !== null && (expectedKey === undefined || bearer === expectedKey);
  if (!authorized) {
    return { status: 401, headers: JSON_HEADERS, body: authErrorBody() };
  }

  // The frontend-stats outage simulation: the catalog still answers, the
  // stats endpoints do not — the extension must then skip provider selection.
  if (frontendStatsUnavailable && FRONTEND_STATS_PATHS.has(path)) {
    return { status: 404, headers: JSON_HEADERS, body: notFoundBody() };
  }

  if (method === "GET") {
    if (path === "/api/v1/models") {
      return { status: 200, headers: JSON_HEADERS, body: catalogResponse(PUBLIC_MODELS) };
    }
    if (path === "/api/v1/models/user") {
      return { status: 200, headers: JSON_HEADERS, body: catalogResponse(ACCOUNT_MODELS) };
    }
    if (path === "/api/v1/key") {
      return {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          data: {
            label: "container-fixture",
            limit: null,
            limit_remaining: null,
            usage: COST,
            usage_daily: 0,
            is_free_tier: false,
          },
        }),
      };
    }
    if (path === "/api/v1/credits") {
      return {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ data: { total_credits: 25, total_usage: COST } }),
      };
    }
    const endpointsMatch = /^\/api\/v1\/models\/([^/]+)\/([^/]+)\/endpoints$/.exec(path);
    if (endpointsMatch) {
      const rows = modelEndpointsFor(`${endpointsMatch[1]}/${endpointsMatch[2]}`);
      if (rows === null) {
        return { status: 404, headers: JSON_HEADERS, body: notFoundBody() };
      }
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ data: { endpoints: rows } }) };
    }
    if (path === "/api/frontend/v1/catalog/models") {
      return {
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          data: [...PERMASLUGS.entries()].map(([slug, permaslug]) => ({ slug, permaslug })),
        }),
      };
    }
    if (path === "/api/frontend/v1/stats/endpoint") {
      const rows = endpointStatsFor(url.searchParams.get("permaslug") ?? "");
      if (rows === null) {
        return { status: 404, headers: JSON_HEADERS, body: notFoundBody() };
      }
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ data: rows }) };
    }
    if (path === "/api/frontend/v1/stats/tool-call-error-rate") {
      const series = toolCallErrorRateFor(url.searchParams.get("permaslug") ?? "");
      if (series === null) {
        return { status: 404, headers: JSON_HEADERS, body: notFoundBody() };
      }
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(series) };
    }
  }

  if (method === "POST" && (path === "/api/v1/chat/completions" || path === "/chat/completions")) {
    const model = typeof body?.model === "string" ? body.model : MODEL_ID;
    if (body?.stream === false) {
      return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(completionBody(model)) };
    }
    return {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: sseBody(model),
    };
  }

  return { status: 404, headers: JSON_HEADERS, body: notFoundBody() };
}

export async function startMockOpenRouter(options = {}) {
  const { logPath, expectedKey, port = 0, frontendStatsUnavailable = false } = options;
  if (!logPath) throw new Error("startMockOpenRouter: logPath is required");

  const log = (row) => appendFile(logPath, `${JSON.stringify(row)}\n`);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Normalize a trailing slash; the logged/compared form has none.
      let path = url.pathname.replace(/\/+$/, "");
      const bearer = /^Bearer\s+(.*)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
      const title = req.headers["x-title"] ?? null;
      let body;
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = undefined;
        }
      }

      void (async () => {
        // Resolve the response first, then log it once with its status: the
        // log row must describe the answer the client actually received.
        const response = resolveResponse({ req, path, url, body, bearer, expectedKey, frontendStatsUnavailable });

        try {
          await log({
            method: req.method,
            path,
            authorization: bearer,
            title,
            body,
            status: response.status,
          });
        } catch {
          // Logging must never take the mock down mid-scenario.
        }

        res.writeHead(response.status, response.headers);
        res.end(response.body);
      })();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("startMockOpenRouter: failed to bind 127.0.0.1");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

  const close = async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };

  return { baseUrl, close };
}

/** Re-exports so a single import of this module covers the whole contract. */
export {
  APP_TITLE,
  COST,
  FIXTURE_KEY,
  MODEL_ID,
  RESPONSE_TEXT,
  ROUTER_ID,
} from "./fixtures/openrouter.mjs";
