/**
 * Platform adapter: lets this single extension codebase run under both the
 * pi coding agent (0.87, @earendil-works scope) and omp (18.x, @oh-my-pi
 * scope). omp shares pi's extension API surface but diverges on credential
 * storage and which pi-ai entry points exist.
 *
 * All imports below are STATIC and use specifiers the omp legacy-compat
 * loader rewrites (it only rewrites string-literal specifiers). Both hosts
 * export every imported name from the shared roots:
 *   - `@earendil-works/pi-coding-agent` resolves to omp's legacy coding-agent
 *     shim, which re-exports `CONFIG_DIR_NAME` and provides
 *     `readStoredCredential` against omp's own credential store.
 *   - `@earendil-works/pi-ai/compat` resolves to omp's pi-ai root, whose
 *     `streamSimple` is the host's normalizing dispatcher; under pi it is
 *     the built-in openai-completions simple transport. Both take
 *     (model, context, SimpleStreamOptions) and apply host-native option
 *     normalization (reasoning effort, toolChoice, maxTokensExplicit) —
 *     never call omp's raw `providers/openai-completions` function, which
 *     skips `mapOptionsForApi`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { streamSimple as hostStreamSimple } from "@earendil-works/pi-ai/compat";

export type Runtime = "omp" | "pi";

/** Env override for tests; takes precedence over host detection. */
const RUNTIME_ENV = "OPENROUTER_ADVANCED_RUNTIME";

/**
 * pi 0.87's agent-dir override (APP_NAME + "_CODING_AGENT_DIR"); omp sets and
 * honors the same variable for its own agent dir, so one name covers both.
 */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

let detectedRuntime: Runtime | undefined;

/**
 * Discriminate the host from the ExtensionAPI handed to the extension
 * factory. `registerComposerShape` and `arktype` exist only on omp's
 * ExtensionAPI (pi 0.87 has neither). When a real host API is supplied the
 * decision is exact — the storage-root probe is NOT consulted, because on a
 * dual-installed machine ~/.omp/agent exists even under pi. Call once at
 * factory start with the factory's `pi` argument; call with no argument only
 * in module-test/plain-node contexts, where the probe is the only signal.
 */
export function initHost(hostApi?: unknown): Runtime {
  const forced = process.env[RUNTIME_ENV];
  if (forced === "omp" || forced === "pi") {
    detectedRuntime = forced;
    return detectedRuntime;
  }
  if (hostApi !== undefined && hostApi !== null) {
    detectedRuntime =
      typeof (hostApi as Record<string, unknown>).registerComposerShape === "function" ||
      typeof (hostApi as Record<string, unknown>).arktype === "function"
        ? "omp"
        : "pi";
    return detectedRuntime;
  }
  if (detectedRuntime === undefined) {
    detectedRuntime = fs.existsSync(path.join(os.homedir(), ".omp", "agent")) ? "omp" : "pi";
  }
  return detectedRuntime;
}

export function detectRuntime(): Runtime {
  return detectedRuntime ?? initHost(undefined);
}

export function isOmp(): boolean {
  return detectRuntime() === "omp";
}

/**
 * Test seam: pin the runtime and clear memoization. Passing undefined
 * removes the override so the normal detection paths apply again.
 */
export function setRuntimeOverride(runtime: Runtime | undefined): void {
  if (runtime === undefined) delete process.env[RUNTIME_ENV];
  else process.env[RUNTIME_ENV] = runtime;
  detectedRuntime = undefined;
}

/** The host agent dir: ~/.omp/agent under omp, ~/.pi/agent under pi. */
export function agentRoot(): string {
  const envDir = process.env[AGENT_DIR_ENV];
  if (envDir) return envDir;
  return path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
}

/** Read one property off an unknown JSON-ish value via `in` narrowing. */
function readField<K extends string>(value: unknown, key: K): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  // Arbitrary JSON object: only keyed existence-checked reads follow.
  const record = value as Record<string, unknown>;
  return key in record ? record[key] : undefined;
}

/** Accepts "sk-or-…" or the stored shapes carrying it ({key}|{api_key}|{apiKey}). */
function extractOpenRouterKey(credential: unknown): string | undefined {
  if (typeof credential === "string") {
    return credential.startsWith("sk-or-") ? credential : undefined;
  }
  for (const field of ["key", "api_key", "apiKey"] as const) {
    const value = readField(credential, field);
    if (typeof value === "string" && value.startsWith("sk-or-")) return value;
  }
  return undefined;
}

/** pi's auth.json entry shape: "sk-or-…" or { key: "sk-or-…" }. */
function readAuthJsonKey(): string | undefined {
  try {
    const authPath = path.join(agentRoot(), "auth.json");
    if (!fs.existsSync(authPath)) return undefined;
    const auth: unknown = JSON.parse(fs.readFileSync(authPath, "utf8"));
    return extractOpenRouterKey(readField(auth, "openrouter"));
  } catch {
    // unreadable auth store — fall through
  }
  return undefined;
}

/**
 * Load-time key resolution, in precedence order:
 *   1. OPENROUTER_API_KEY env (both hosts)
 *   2. the host agent dir's auth.json file (pi's /login store; under omp
 *      this file is typically absent/empty and the check is cheap)
 *   3. the host's own credential store via its exported readStoredCredential
 *      (pi: auth.json; omp: its SQLite credential DB — no direct DB access)
 * Without a key the account catalog is unreachable and the extension skips
 * bootstrap registration; session_start re-syncs via the host registry.
 */
export async function bootstrapApiKey(): Promise<string | undefined> {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const fromAuth = readAuthJsonKey();
  if (fromAuth) return fromAuth;
  try {
    const stored = readStoredCredential("openrouter");
    return extractOpenRouterKey(stored);
  } catch {
    // host store API unavailable — fall through
  }
  return undefined;
}

/**
 * The HOST's openai-completions streamSimple transport, from the shared
 * compat specifier (see module doc): pi's built-in simple transport, or
 * omp's normalizing dispatcher. Callers pass a model whose `api` is
 * "openai-completions" — under omp the dispatcher then runs the built-in
 * path (mapOptionsForApi, cost parsing) natively. Never call it with a
 * model whose `api` is a custom id this extension registered, or the
 * dispatcher re-enters this extension's own wrapper.
 */
export function completionsStreamSimple(): typeof hostStreamSimple {
  return hostStreamSimple;
}
