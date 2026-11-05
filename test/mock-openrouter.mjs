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
 * any Bearer key is accepted (standalone/local smoke use).
 *
 * Every request is appended to `logPath` as one NDJSON row:
 *   { method, path, authorization, title, body? }
 * `authorization` is the raw Bearer value, `title` the x-title header;
 * `body` is the parsed JSON payload on POSTs. This log is the primary
 * assertion surface for key resolution, the public-vs-account masquerade
 * guard, and X-Title propagation.
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

function authError(res) {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Invalid or missing credentials", code: 401 } }));
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found", code: 404 } }));
}

function catalogResponse(models) {
  return JSON.stringify({ data: models });
}

export async function startMockOpenRouter(options = {}) {
  const { logPath, expectedKey, port = 0 } = options;
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
        try {
          await log({ method: req.method, path, authorization: bearer, title, body });
        } catch {
          // Logging must never take the mock down mid-scenario.
        }

        const authorized =
          req.method === "GET" && path === "/api/v1/models"
            ? true // public catalog: no auth required
            : bearer !== null && (expectedKey === undefined || bearer === expectedKey);
        if (!authorized) {
          authError(res);
          return;
        }

        if (req.method === "GET") {
          if (path === "/api/v1/models") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(catalogResponse(PUBLIC_MODELS));
            return;
          }
          if (path === "/api/v1/models/user") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(catalogResponse(ACCOUNT_MODELS));
            return;
          }
          if (path === "/api/v1/key") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              data: {
                label: "container-fixture",
                limit: null,
                limit_remaining: null,
                usage: COST,
                usage_daily: 0,
                is_free_tier: false,
              },
            }));
            return;
          }
          if (path === "/api/v1/credits") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ data: { total_credits: 25, total_usage: COST } }));
            return;
          }
          const endpointsMatch = /^\/api\/v1\/models\/([^/]+)\/([^/]+)\/endpoints$/.exec(path);
          if (endpointsMatch) {
            const rows = modelEndpointsFor(`${endpointsMatch[1]}/${endpointsMatch[2]}`);
            if (rows === null) {
              notFound(res);
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ data: { endpoints: rows } }));
            return;
          }
          if (path === "/api/frontend/v1/catalog/models") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              data: [...PERMASLUGS.entries()].map(([slug, permaslug]) => ({ slug, permaslug })),
            }));
            return;
          }
          if (path === "/api/frontend/v1/stats/endpoint") {
            const rows = endpointStatsFor(url.searchParams.get("permaslug") ?? "");
            if (rows === null) {
              notFound(res);
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ data: rows }));
            return;
          }
          if (path === "/api/frontend/v1/stats/tool-call-error-rate") {
            const series = toolCallErrorRateFor(url.searchParams.get("permaslug") ?? "");
            if (series === null) {
              notFound(res);
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(series));
            return;
          }
        }

        if (req.method === "POST" && (path === "/api/v1/chat/completions" || path === "/chat/completions")) {
          const model = typeof body?.model === "string" ? body.model : MODEL_ID;
          if (body?.stream === false) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(completionBody(model)));
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.end(sseBody(model));
          return;
        }

        notFound(res);
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
