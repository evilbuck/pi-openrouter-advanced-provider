#!/usr/bin/env bun
/**
 * Per-host container scenario for the dual-host test harness.
 *
 * Runs INSIDE the container (no network; the mock comes up here). The
 * container runner invokes it as:
 *
 *   bun "$SCENARIO_REPO_DIR/test/container-scenario.mjs"
 *
 * Contract (set by scripts/container-test.mjs / Dockerfile entrypoint):
 *   SCENARIO_HOSTS         comma-separated subset of "pi,omp"
 *   SCENARIO_REPO_DIR      repo root in the container (pi/, test/, scripts/)
 *   SCENARIO_FIXTURE_KEY   the fixture bearer key (sk-or-test-container)
 *   SCENARIO_HOME          writable isolated HOME (tmpfs)
 *   SCENARIO_ARTIFACTS_DIR writable dir inside SCENARIO_HOME for artifacts
 *
 * pi/omp binaries are on PATH. For each requested host this script:
 *
 *   1. keyed case — isolated temp home + agent dir, seeded credential store
 *      (pi: agent/auth.json; omp: scripts/seed-omp-db.mjs), two one-shot
 *      turns through the host binary:
 *        a. the fixture glm model  -> catalog key resolution, wrapper
 *           engagement (X-Title), registered row set + registry api identity,
 *           JIT selection observable (frontend stats fetched, provider pick
 *           on the wire), streamed response text;
 *        b. the router slug        -> usage.cost lands in session accounting
 *           (pi: message_end restore; omp: native wire stamp).
 *   2. no-key case — fresh unseeded home; /openrouter-sync must exit 0 with
 *      zero requests to the mock and no extension-registered rows.
 *
 * Assertion surfaces: the mock's NDJSON request log (per-run slices), the
 * probe extension artifact (test/fixtures/probe-extension.mjs), host exit
 * codes and print output. Nothing here touches real credentials; the only
 * key ever used is the fixture key. Diagnostics name the failing assertion
 * and include output tails; exit code is nonzero on any failure.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  APP_TITLE,
  COST,
  MODEL_ID,
  RESPONSE_TEXT,
  ROUTER_ID,
  startMockOpenRouter,
} from "./mock-openrouter.mjs";
import { ACCOUNT_MODELS, PUBLIC_MODELS } from "./fixtures/openrouter.mjs";
import { seedOmpDb } from "../scripts/seed-omp-db.mjs";

/**
 * The unique api id the provider extension registers under omp
 * (pi/stream.ts OPENROUTER_RECOVERY_API). Kept as a literal so the scenario
 * stays import-light; a drift fails the registry-api assertion below with
 * the mismatch spelled out.
 */
const OPENROUTER_RECOVERY_API = "openrouter-recovery-completions";

// ---------------------------------------------------------------------------
// Environment contract
// ---------------------------------------------------------------------------

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probePath = path.join(repoDir, "test", "fixtures", "probe-extension.mjs");
const HOSTS = ["pi", "omp"];
const SPAWN_TIMEOUT_MS = 240_000;
const PROMPT = "Reply with exactly one short sentence.";
const JIT_PICK = "lambda"; // test/fixtures/openrouter.mjs statsRows: row 1 wins deterministically.

function fail(message) {
  console.error(`container-scenario: ${message}`);
  process.exit(2);
}

const scenarioHome = process.env.SCENARIO_HOME;
if (!scenarioHome) fail("SCENARIO_HOME is not set — the runner must provide the writable isolated HOME");
if (!fs.existsSync(scenarioHome)) fail(`SCENARIO_HOME does not exist: ${scenarioHome}`);

const artifactsDir = process.env.SCENARIO_ARTIFACTS_DIR ?? path.join(scenarioHome, "artifacts");
fs.mkdirSync(artifactsDir, { recursive: true });

const fixtureKey = process.env.SCENARIO_FIXTURE_KEY;
if (!fixtureKey) fail("SCENARIO_FIXTURE_KEY is not set — the runner must provide the fixture bearer key");

const hosts = (process.env.SCENARIO_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
if (hosts.length === 0) fail("SCENARIO_HOSTS is empty — expected a comma-separated subset of \"pi,omp\"");
for (const host of hosts) {
  if (!HOSTS.includes(host)) fail(`SCENARIO_HOSTS contains unknown host "${host}" — expected one of: ${HOSTS.join(", ")}`);
}

/**
 * The corrected fixture (test/fixtures/openrouter.mjs) carries ten account
 * rows — every non-router row advertises both "tools" and "reasoning_effort",
 * which is what pi/state.ts requires for catalog registration, so all ten
 * must survive, not just the router. Pinned here so a fixture shrink fails
 * the scenario instead of quietly narrowing these assertions.
 */
const EXPECTED_ACCOUNT_COUNT = 10;
const accountIds = ACCOUNT_MODELS.map((m) => m.id);
if (accountIds.length !== EXPECTED_ACCOUNT_COUNT) {
  fail(`account fixture drifted: expected ${EXPECTED_ACCOUNT_COUNT} account rows, got ${accountIds.length} (${accountIds.join(", ")})`);
}
if (!accountIds.includes(MODEL_ID)) {
  fail(`account fixture is missing the fixture GLM model "${MODEL_ID}"`);
}
if (!accountIds.includes(ROUTER_ID)) {
  fail(`account fixture is missing the router slug "${ROUTER_ID}"`);
}
if (PUBLIC_MODELS.some((m) => accountIds.includes(m.id))) {
  fail("account fixture leaks a public-catalog model id");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Collect named assertions for one case; failures print immediately. */
class Checks {
  constructor(prefix) {
    this.prefix = prefix;
    this.passed = 0;
    this.failures = [];
  }

  check = (name, ok, detail = "") => {
    if (ok) {
      this.passed += 1;
      return true;
    }
    this.failures.push({ name, detail });
    console.error(`FAIL [${this.prefix}] ${name}${detail ? `\n  ${detail}` : ""}`);
    return false;
  };
}

function clip(text, max = 1600) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…[clipped]` : s;
}

/** Isolated temp home under SCENARIO_HOME; agent dir honors PI_CODING_AGENT_DIR on both hosts. */
function makeCaseHome(host, mode) {
  const caseDir = fs.mkdtempSync(path.join(scenarioHome, `${host}-${mode}-`));
  const agentDir = path.join(caseDir, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  return { caseDir, agentDir };
}

/**
 * Seed the fixture key into the host's own credential store — never a real
 * credential, never the user's home. pi reads agent/auth.json
 * ({ "<provider>": { type: "api_key", key } }); omp reads agent.db
 * (scripts/seed-omp-db.mjs, pinned 18.16 auth schema).
 */
async function seedCredentials(host, agentDir, key) {
  if (host === "pi") {
    fs.writeFileSync(
      path.join(agentDir, "auth.json"),
      `${JSON.stringify({ openrouter: { type: "api_key", key } }, null, 2)}\n`,
    );
    return;
  }
  await runHost("omp", ["--no-extensions", "--print", "initialize"], hostEnv({
    caseDir: path.dirname(agentDir), agentDir, probeArtifact: "", label: "init", baseUrl: "http://127.0.0.1:9/api/v1",
  }), path.dirname(agentDir));
  seedOmpDb(agentDir, key);
}

function hostEnv({ caseDir, agentDir, probeArtifact, label, baseUrl }) {
  const env = { ...process.env };
  // The hosts must resolve the key from the seeded store, never from env,
  // and the runtime-override test seam must stay off.
  delete env.OPENROUTER_API_KEY;
  delete env.OPENROUTER_ADVANCED_RUNTIME;
  env.HOME = caseDir;
  env.PI_CODING_AGENT_DIR = agentDir; // honored by both hosts
  env.OMP_CODING_AGENT_DIR = agentDir;
  env.OPENROUTER_BASE_URL = baseUrl; // aims catalog, frontend stats, and completions at the mock
  env.OPENROUTER_PROBE_ARTIFACT = probeArtifact;
  env.OPENROUTER_PROBE_LABEL = label;
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  env.TERM = "dumb";
  return env;
}

/** Spawn a host one-shot; resolves { code, stdout, stderr, timedOut, missing }. */
function runHost(bin, args, env, cwd) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: `spawn failed: ${error?.message}`, timedOut: false, missing: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    let timedOut = false;
    let settled = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
    }, SPAWN_TIMEOUT_MS);
    killer.unref?.();
    const done = (code, missing = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({ code, stdout, stderr, timedOut, missing });
    };
    child.on("error", (error) => {
      stderr += `\nspawn error: ${error?.message ?? error}`;
      done(null, error?.code === "ENOENT");
    });
    child.on("close", (code) => done(code));
  });
}

// Mock NDJSON log slicing: one independent slice per spawn so assertions and
// diagnostics never mix two runs.
function logSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function readLogSlice(file, since) {
  const size = logSize(file);
  if (size <= since) return [];
  const buffer = Buffer.alloc(size - since);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, since);
  } finally {
    fs.closeSync(fd);
  }
  return buffer
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readNdjson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const isPublicCatalog = (row) => row.method === "GET" && row.path === "/api/v1/models";
const isAccountCatalog = (row) => row.method === "GET" && row.path === "/api/v1/models/user";
const isCompletion = (row) => row.method === "POST" && row.path.endsWith("/chat/completions");
const isFrontend = (row) => row.path.startsWith("/api/frontend/");

function completionSummary(rows) {
  return JSON.stringify(rows.map((r) => ({ model: r.body?.model, title: r.title, auth: r.authorization })));
}

// ---------------------------------------------------------------------------
// Registry/session assertions (probe artifact)
// ---------------------------------------------------------------------------

function registryRecords(records) {
  return records.filter((r) => r.type === "registry" && Array.isArray(r.rows));
}

function assistantMessages(records) {
  return records.filter((r) => r.type === "message_end").map((r) => r.message ?? {});
}

/**
 * Registry assertions per source:
 *   - snapshot (both hosts): the extension's committed catalog — exactly the
 *     account fixture set (public rows would prove the masquerade guard broke).
 *   - provider-config (pi): registered ProviderConfig — exactly the account
 *     set, no per-row api override (a per-row api would bypass the wrapper),
 *     provider-level wrapper api + streamSimple attached.
 *   - host-registry (omp): live registry rows for the provider — omp's merge
 *     keeps its native non-completions rows, so assert on the account-id
 *     subset: exactly the account set, each carrying the recovery api id.
 */
function assertRegistry(check, host, records) {
  const regs = registryRecords(records);
  check.check("probe captured registry state", regs.length > 0, "no registry records in the probe artifact");
  if (host === "pi") {
    for (const reg of regs.filter((record) => record.source === "snapshot")) {
      const ids = [...new Set(reg.rows.map((row) => row.id).filter(Boolean))];
      check.check("snapshot rows == account fixture catalog", reg.rows.length === accountIds.length && ids.length === accountIds.length && ids.every((id) => accountIds.includes(id)), `snapshot has ${reg.rows.length} rows`);
    }
    const configs = regs.filter((record) => record.source === "provider-config");
    check.check("pi registered the account catalog through the wrapper config", configs.length > 0 && configs.every((record) => record.rows.length === accountIds.length && record.providerApi === "openai-completions" && record.hasStreamSimple === true), "provider-config records missing or incomplete");
    return;
  }
  const registries = regs.filter((record) => record.source === "host-registry");
  check.check("omp registered account rows carry the recovery api", registries.length > 0 && registries.every((record) => {
    const mine = record.rows.filter((row) => accountIds.includes(row.id));
    return mine.length === accountIds.length && new Set(mine.map((row) => row.api)).size === 1 && mine[0]?.api === OPENROUTER_RECOVERY_API;
  }), "host-registry records missing or incomplete");
}

// ---------------------------------------------------------------------------
// Per-host cases
// ---------------------------------------------------------------------------

/** One one-shot turn; returns { result, logSlice, probeRecords, probeArtifact }. */
async function runTurn({ host, bin, caseDir, agentDir, mode, modelArg, prompt, baseUrl, logPath }) {
  const turnLabel = `${host}/${mode}${modelArg ? `:${modelArg}` : ""}`;
  const probeArtifact = path.join(artifactsDir, `${host}-${mode}${modelArg ? `-${san(modelArg)}` : ""}-probe.ndjson`);
  fs.rmSync(probeArtifact, { force: true });
  const env = hostEnv({ caseDir, agentDir, probeArtifact, label: turnLabel, baseUrl });
  const args = [
    "--no-extensions",
    "-e", path.join(repoDir, "pi/index.ts"),
    "-e", probePath,
    ...(modelArg ? ["--model", modelArg] : []),
    "-p", prompt,
  ];
  const stdoutArtifact = path.join(artifactsDir, `${host}-${mode}${modelArg ? `-${san(modelArg)}` : ""}.out`);
  const stderrArtifact = stdoutArtifact.replace(/\.out$/, ".err");

  const since = logSize(logPath);
  const result = await runHost(bin, args, env, caseDir);
  const logSlice = readLogSlice(logPath, since);
  const probeRecords = readNdjson(probeArtifact);

  // Artifacts of record for offline debugging.
  fs.writeFileSync(stdoutArtifact, result.stdout);
  fs.writeFileSync(stderrArtifact, result.stderr);

  return { result, logSlice, probeRecords, probeArtifact, args, stdoutArtifact, stderrArtifact };
}

function san(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function exitCheck(check, turn, what) {
  const { result } = turn;
  const detail = [
    `exit=${result.code} timedOut=${result.timedOut}`,
    `args: ${JSON.stringify(turn.args)}`,
    `stdout tail: ${clip(result.stdout)}`,
    `stderr tail: ${clip(result.stderr)}`,
    `artifacts: ${turn.stdoutArtifact} / ${turn.stderrArtifact} / ${turn.probeArtifact}`,
  ].join("\n  ");
  return check.check(
    `${what} exited 0`,
    result.code === 0 && !result.timedOut && !result.missing,
    result.missing ? `host binary "${hostBin}" not found on PATH\n  ${detail}` : detail,
  );
}

let hostBin; // module-level for exitCheck diagnostics

async function runKeyedCase(host, bin, baseUrl, logPath) {
  const check = new Checks(`${host}/keyed`);
  const { caseDir, agentDir } = makeCaseHome(host, "keyed");
  await seedCredentials(host, agentDir, fixtureKey);
  const modelArg = `openrouter/${MODEL_ID}`;
  const prewarm = await runTurn({ host, bin, caseDir, agentDir, mode: "keyed", modelArg, prompt: "Warm the selected model.", baseUrl, logPath });
  exitCheck(check, prewarm, `${host} JIT prewarm`);
  const turn1 = await runTurn({ host, bin, caseDir, agentDir, mode: "keyed", modelArg, prompt: PROMPT, baseUrl, logPath });
  const ok1 = exitCheck(check, turn1, `${host} fixture-model turn`);
  if (ok1) {
    check.check(
      `${host} fixture-model turn printed the fixture response`,
      turn1.result.stdout.includes(RESPONSE_TEXT),
      `stdout tail: ${clip(turn1.result.stdout)}`,
    );

    const slice = turn1.logSlice;
    const account = slice.filter(isAccountCatalog);
    check.check(
      "account catalog fetched with the fixture key",
      account.length >= 1 && account.every((r) => r.authorization === fixtureKey),
      account.length === 0
        ? "GET /api/v1/models/user never hit the mock — key resolution failed"
        : `authorizations seen: ${JSON.stringify(account.map((r) => r.authorization))}`,
    );
    check.check(
      "public catalog never requested while keyed",
      !slice.some(isPublicCatalog),
      `public-catalog requests: ${JSON.stringify(slice.filter(isPublicCatalog).map((r) => r.path))}`,
    );

    const glmPosts = slice.filter((r) => isCompletion(r) && r.body?.model === MODEL_ID);
    check.check(
      "fixture-model completion reached the mock",
      glmPosts.length >= 1,
      `completion POSTs: ${completionSummary(slice.filter(isCompletion))}`,
    );
    if (glmPosts.length >= 1) {
      const post = glmPosts[glmPosts.length - 1];
      check.check(
        "X-Title wrapper header on completion",
        post.title === APP_TITLE,
        `x-title=${JSON.stringify(post.title)} expected ${JSON.stringify(APP_TITLE)}`,
      );
      check.check("fixture key used on completion", post.authorization === fixtureKey, `authorization=${JSON.stringify(post.authorization)}`);
      check.check(
        "JIT fetched the frontend catalog before completion",
        slice.some((r) => r.path === "/api/frontend/v1/catalog/models"),
        "GET /api/frontend/v1/catalog/models missing — selection never ran",
      );
    }

    const glmMessages = assistantMessages(turn1.probeRecords).filter((m) => String(m.model ?? "").endsWith(MODEL_ID));
    check.check("probe saw the fixture-model assistant message", glmMessages.length >= 1,
      `probe artifact: ${turn1.probeArtifact}; message_end records: ${JSON.stringify(assistantMessages(turn1.probeRecords).map((m) => ({ model: m.model, stopReason: m.stopReason, error: m.errorMessage })))}`);
    if (glmMessages.length >= 1) {
      const message = glmMessages[glmMessages.length - 1];
      check.check("fixture-model response text streamed", String(message.text ?? "").includes(RESPONSE_TEXT),
        `text=${JSON.stringify(clip(message.text, 200))} stopReason=${JSON.stringify(message.stopReason)} errorMessage=${JSON.stringify(message.errorMessage)}`);
      check.check("fixture-model assistant carried the openrouter provider", message.provider === "openrouter",
        `provider=${JSON.stringify(message.provider)}`);
    }
  }

  // --- Turn 2: router slug — cost accounting (both hosts) ---
  // Model-string matching differs per host: omp matches bare registry ids
  // (live-verified), pi splits provider/id — so the id-qualified form
  // "openrouter/openrouter/auto" is the canonical pin and the bare slug is
  // the omp fallback. First candidate that posts the router completion wins.
  const routerCandidates = host === "omp" ? [ROUTER_ID, `openrouter/${ROUTER_ID}`] : [`openrouter/${ROUTER_ID}`, ROUTER_ID];
  let turn2 = null;
  for (const candidate of routerCandidates) {
    const attempt = await runTurn({ host, bin, caseDir, agentDir, mode: "keyed-router", modelArg: candidate, prompt: PROMPT, baseUrl, logPath });
    const posted = attempt.logSlice.some((r) => isCompletion(r) && r.body?.model === ROUTER_ID);
    if (attempt.result.code === 0 && posted) {
      turn2 = attempt;
      break;
    }
    turn2 = attempt; // keep the latest attempt for diagnostics when all fail
  }
  const ok2 = turn2 !== null && exitCheck(check, turn2, `${host} router-slug turn`);
  if (ok2) {
    const slice = turn2.logSlice;
    check.check("public catalog never requested while keyed (router turn)", !slice.some(isPublicCatalog),
      `public-catalog requests: ${JSON.stringify(slice.filter(isPublicCatalog).map((r) => r.path))}`);
    const routerPosts = slice.filter((r) => isCompletion(r) && r.body?.model === ROUTER_ID);
    check.check("router-slug completion reached the mock", routerPosts.length >= 1,
      `completion POSTs: ${completionSummary(slice.filter(isCompletion))}`);
    if (routerPosts.length >= 1) {
      const post = routerPosts[routerPosts.length - 1];
      check.check("X-Title wrapper header on router completion", post.title === APP_TITLE,
        `x-title=${JSON.stringify(post.title)}`);
      check.check("fixture key used on router completion", post.authorization === fixtureKey,
        `authorization=${JSON.stringify(post.authorization)}`);
      check.check(
        "router slug carried no JIT provider order",
        post.body?.provider?.order === undefined,
        `wire provider=${JSON.stringify(post.body?.provider)} — JIT must skip openrouter/ slugs`,
      );
    }
    check.check(
      "router slug made no JIT stats calls",
      !slice.some(isFrontend),
      `frontend requests on the router turn: ${JSON.stringify(slice.filter(isFrontend).map((r) => r.path))}`,
    );

    const routerMessages = assistantMessages(turn2.probeRecords).filter((m) => String(m.model ?? "").endsWith(ROUTER_ID));
    check.check("probe saw the router-slug assistant message", routerMessages.length >= 1,
      `probe artifact: ${turn2.probeArtifact}; message_end records: ${JSON.stringify(assistantMessages(turn2.probeRecords).map((m) => ({ model: m.model, stopReason: m.stopReason, error: m.errorMessage })))}`);
    if (routerMessages.length >= 1) {
      const message = routerMessages[routerMessages.length - 1];
      const billed = message.usage?.cost?.total;
      check.check(
        "router usage.cost landed in session accounting",
        typeof billed === "number" && Math.abs(billed - COST) < 1e-9,
        `usage.cost.total=${JSON.stringify(billed)} expected ${COST} (stopReason=${JSON.stringify(message.stopReason)} errorMessage=${JSON.stringify(message.errorMessage)})`,
      );
    }
  }

  // --- Registry identity (turn-1 probe artifact holds the catalog) ---
  if (ok1) {
    assertRegistry(check, host, turn1.probeRecords);
  }

  return check;
}

async function runNoKeyCase(host, bin, baseUrl, logPath) {
  const check = new Checks(`${host}/no-key`);
  const { caseDir, agentDir } = makeCaseHome(host, "nokey");
  // Deliberately unseeded: a fresh home must yield no key, no catalog fetch,
  // no registration, and still a clean exit (masquerade guard).

  const turn = await runTurn({ host, bin, caseDir, agentDir, mode: "nokey", modelArg: "openrouter/auto", prompt: "/openrouter-sync", baseUrl, logPath });
  const ok = exitCheck(check, turn, `${host} no-key run`);
  if (ok) {
    check.check(
      "no-key run made zero requests to the mock",
      turn.logSlice.length === 0,
      `requests seen: ${JSON.stringify(turn.logSlice.map((r) => `${r.method} ${r.path}`))}`,
    );
    const regs = registryRecords(turn.probeRecords);
    check.check("no-key probe loaded", turn.probeRecords.some((record) => record.type === "start"),
      `probe artifact: ${turn.probeArtifact} (${turn.probeRecords.length} records) — probe did not load`);
    const offenders = regs.flatMap((r) => r.rows).filter((row) => accountIds.includes(row.id));
    check.check(
      "no-key run registered no extension rows",
      offenders.length === 0,
      `extension rows present without a key: ${JSON.stringify(offenders.map((r) => r.id))}`,
    );

  }
  return check;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const logPath = path.join(artifactsDir, "mock-openrouter.ndjson");
  fs.rmSync(logPath, { force: true });

  const mock = await startMockOpenRouter({ logPath, expectedKey: fixtureKey });
  const allChecks = [];
  try {
    for (const host of hosts) {
      const bin = host;
      hostBin = bin;
      allChecks.push(await runKeyedCase(host, bin, mock.baseUrl, logPath));
      allChecks.push(await runNoKeyCase(host, bin, mock.baseUrl, logPath));
    }
  } finally {
    await mock.close();
  }

  const passed = allChecks.reduce((n, c) => n + c.passed, 0);
  const failed = allChecks.reduce((n, c) => n + c.failures.length, 0);
  const summary = {
    hosts,
    checksPassed: passed,
    checksFailed: failed,
    failures: allChecks.flatMap((c) => c.failures.map((f) => ({ case: c.prefix, ...f }))),
  };
  fs.writeFileSync(path.join(artifactsDir, "scenario-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  if (failed > 0) {
    console.error(`container-scenario: ${failed} assertion(s) failed, ${passed} passed — details above; artifacts in ${artifactsDir}`);
    process.exitCode = 1;
  } else {
    console.log(`container-scenario: all ${passed} assertion(s) passed for hosts ${hosts.join(", ")}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`container-scenario: crashed: ${error?.stack ?? error}`);
  process.exit(2);
}
