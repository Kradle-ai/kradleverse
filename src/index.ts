#!/usr/bin/env node
/**
 * KradleVerse CLI
 *
 * Subcommands:
 *   mcp — Start the MCP channel server that pushes live game events into
 *         a Claude Code session (replaces poll loops with real-time notifications).
 *
 * MCP channel details (mcp subcommand):
 *
 * Two subscription types:
 *
 * 1. Queue subscription (subscribeQueue):
 *    Polls GET /api/v1/queue on KradleVerse and pushes status changes
 *    (waiting → matched → connected). Auto-subscribes to observations
 *    once a runId is available.
 *
 * 2. Observation subscription (subscribeObservations):
 *    Connects to the Kradle backend SSE stream and pushes each observation
 *    as a <channel> event. Ends automatically on game_over.
 *
 * Works alongside the remote KradleVerse MCP (for act, joinQueue, etc.).
 */

// ---------------------------------------------------------------------------
// Subcommand routing — must run before MCP imports to allow clean exit
// ---------------------------------------------------------------------------

const _args = process.argv.slice(2);
const _command = _args.find((a) => !a.startsWith("-"));

if (_command !== "mcp") {
  const bin = "kradleverse";
  console.log(`${bin} — AI agents playing Minecraft\n`);
  console.log(`Usage: ${bin} <command>\n`);
  console.log("Commands:");
  console.log("  mcp    Start the KradleVerse MCP channel server\n");
  console.log("Options (mcp):");
  console.log("  --log  Enable debug logging\n");
  console.log(`Example: npx -y ${bin}@latest mcp`);
  process.exit(_command ? 1 : 0);
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Logging (opt-in via --log flag)
// ---------------------------------------------------------------------------

const LOG_ENABLED = process.argv.includes("--log");

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = resolve(__dirname, "..", "kradleverse.log");

if (LOG_ENABLED) {
  writeFileSync(LOG_FILE, `[${new Date().toISOString()}] KradleVerse channel started\n`);
}

function log(level: "INFO" | "WARN" | "ERROR", msg: string, data?: unknown): void {
  if (!LOG_ENABLED) return;
  const ts = new Date().toISOString();
  let line = `[${ts}] ${level}: ${msg}`;
  if (data !== undefined) {
    try {
      const s = JSON.stringify(data);
      line += ` ${s.length > 2000 ? s.slice(0, 2000) + "...(truncated)" : s}`;
    } catch {
      line += ` [unserializable]`;
    }
  }
  line += "\n";
  try { appendFileSync(LOG_FILE, line); } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Kradle backend API — used for observation SSE streaming. */
const KRADLE_API_URL =
  process.env.KRADLE_API_URL || "https://api.kradle.ai/v0";

/** KradleVerse frontend API — used for queue status polling. */
const KRADLEVERSE_API_URL =
  process.env.KRADLEVERSE_API_URL || "https://kradleverse.com/api/v1";

/** How often to poll queue status (ms). */
const QUEUE_POLL_INTERVAL = 1_000;

log("INFO", "Config", { KRADLE_API_URL, KRADLEVERSE_API_URL, QUEUE_POLL_INTERVAL });

// ---------------------------------------------------------------------------
// Channel notification helper
// ---------------------------------------------------------------------------

/** Late-bound — set after Server is created. */
let mcpServer: Server;

/**
 * Send a channel notification. Automatically injects `received_at` into meta
 * and logs the event to the debug log file.
 */
async function notify(
  content: string,
  meta: Record<string, string>,
): Promise<void> {
  const receivedAt = new Date().toISOString();
  const enrichedMeta = { ...meta, received_at: receivedAt };
  log("INFO", `→ channel event=${meta.event ?? "?"}`, { meta: enrichedMeta, contentLength: content.length });
  await mcpServer.notification({
    method: "notifications/claude/channel",
    params: { content, meta: enrichedMeta },
  });
}

// ---------------------------------------------------------------------------
// Observation pruning (mirrors KradleVerse-frontend logic, simplified)
// ---------------------------------------------------------------------------

const STATE_KEYS = new Set([
  "runStatus", "winner", "score", "position", "health", "lives", "hunger",
  "executing", "biome", "weather", "timeOfDay", "players", "inventory",
  "armor", "heldItem", "contactBlocks", "blocks", "entities", "craftable",
]);

const KEEP_STATE_EVENTS = new Set(["initial_state", "game_over"]);

const STRIP_KEYS = new Set([
  "name", "depthActionCounter", "participantId", "runId", "time",
]);

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(CONTROL_CHAR_RE, (c) =>
      `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v);
    return out;
  }
  return value;
}

interface ObservationData {
  event?: string;
  [key: string]: unknown;
}

function pruneObservation(
  data: ObservationData,
  runningState: Record<string, unknown>,
): ObservationData {
  const isInitCall = !("event" in data) || data.event === undefined;
  const keepState = isInitCall || KEEP_STATE_EVENTS.has(data.event as string);

  for (const key of STATE_KEYS) {
    if (key in data) runningState[key] = sanitize(data[key]);
  }

  const pruned: ObservationData = {};
  for (const [key, value] of Object.entries(data)) {
    if (STRIP_KEYS.has(key)) continue;
    if (!keepState && STATE_KEYS.has(key)) continue;
    pruned[key] = sanitize(value);
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// Queue subscription (polls KradleVerse API, pushes status changes)
// ---------------------------------------------------------------------------

interface QueueEntry {
  id: string;
  status: string;
  run?: { runId?: string } | null;
  [key: string]: unknown;
}

interface QueueResponse {
  inQueue: boolean;
  entries: QueueEntry[];
  hint?: string;
  capacity?: unknown;
  pendingLobbies?: unknown[];
}

interface QueueSubscription {
  apiKey: string;
  abort: AbortController;
  lastStatus: Map<string, string>;
  autoSubscribedRuns: Set<string>;
}

const queueSubscription: { current: QueueSubscription | null } = { current: null };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

async function startQueuePolling(
  apiKey: string,
  autoSubscribeObservations: boolean,
): Promise<void> {
  const abort = new AbortController();

  if (queueSubscription.current) queueSubscription.current.abort.abort();

  const sub: QueueSubscription = {
    apiKey, abort,
    lastStatus: new Map(),
    autoSubscribedRuns: new Set(),
  };
  queueSubscription.current = sub;

  log("INFO", "Queue subscription started", { autoSubscribeObservations });

  try {
    await notify(
      "Subscribed to queue status. Updates will arrive as <channel> events when status changes.",
      { event: "queue_subscribed" },
    );

    while (!abort.signal.aborted) {
      try {
        const response = await fetch(`${KRADLEVERSE_API_URL}/queue`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: abort.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          log("WARN", `Queue poll failed: ${response.status}`, body);
          await notify(
            JSON.stringify({ error: `Queue poll failed: ${response.status} ${body}` }),
            { event: "queue_error" },
          );
        } else {
          const data = (await response.json()) as QueueResponse;
          log("INFO", "Queue poll", { entries: data.entries?.length ?? 0, hint: data.hint });
          await processQueueUpdate(sub, data, apiKey, autoSubscribeObservations);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        log("WARN", "Queue poll network error", { error: err instanceof Error ? err.message : String(err) });
      }

      await sleep(QUEUE_POLL_INTERVAL, abort.signal);
    }
  } catch (err: unknown) {
    if (!(err instanceof Error && err.name === "AbortError")) {
      log("ERROR", "Queue subscription error", { error: err instanceof Error ? err.message : String(err) });
      await notify(
        JSON.stringify({ error: `Queue subscription error: ${err instanceof Error ? err.message : String(err)}` }),
        { event: "queue_error" },
      );
    }
  } finally {
    log("INFO", "Queue subscription ended");
    if (queueSubscription.current === sub) queueSubscription.current = null;
  }
}

function entryTrackingKey(entry: QueueEntry): string {
  return `${entry.status}:${entry.run?.runId ?? ""}`;
}

async function processQueueUpdate(
  sub: QueueSubscription,
  data: QueueResponse,
  apiKey: string,
  autoSubscribeObservations: boolean,
): Promise<void> {
  if (!data.entries || data.entries.length === 0) {
    if (sub.lastStatus.size > 0) {
      sub.lastStatus.clear();
      log("INFO", "Queue empty — entries cleared");
      await notify(
        JSON.stringify({ inQueue: false, hint: data.hint || "Not in queue." }),
        { event: "queue_empty" },
      );
    }
    return;
  }

  for (const entry of data.entries) {
    const key = entryTrackingKey(entry);
    const prevKey = sub.lastStatus.get(entry.id);

    if (prevKey === key) continue;

    sub.lastStatus.set(entry.id, key);
    log("INFO", `Queue status change: ${prevKey ?? "(new)"} → ${key}`, { entryId: entry.id });

    await notify(
      JSON.stringify(entry),
      {
        event: `queue_${entry.status}`,
        entry_id: entry.id,
        ...(entry.run?.runId ? { run_id: entry.run.runId } : {}),
      },
    );

    // Auto-subscribe to observations as soon as we have a runId
    if (
      autoSubscribeObservations &&
      entry.run?.runId &&
      !sub.autoSubscribedRuns.has(entry.run.runId)
    ) {
      log("INFO", `Auto-subscribing observations for run ${entry.run.runId}`);
      sub.autoSubscribedRuns.add(entry.run.runId);
      startStreaming(entry.run.runId, apiKey).catch((err) => {
        log("ERROR", `Auto-subscribe stream error for run ${entry.run!.runId}`, { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Observation streaming (SSE from Kradle backend)
// ---------------------------------------------------------------------------

interface ObsSubscription {
  runId: string;
  abort: AbortController;
}

const subscriptions = new Map<string, ObsSubscription>();

/**
 * Connect to the Kradle backend SSE endpoint and push observations.
 * init_call is buffered and merged with initial_state into a single "game_start" event.
 */
async function startStreaming(
  runId: string,
  apiKey: string,
  cursor?: string,
): Promise<void> {
  const abort = new AbortController();

  const existing = subscriptions.get(runId);
  if (existing) existing.abort.abort();
  subscriptions.set(runId, { runId, abort });

  const url = new URL(`${KRADLE_API_URL}/runs/${runId}/observations/stream`);
  if (cursor) url.searchParams.set("cursor", cursor);

  const runningState: Record<string, unknown> = {};
  let lastEventId: string | undefined;
  let pendingInitCall: { pruned: ObservationData; eventId: string } | null = null;

  log("INFO", `Observation stream connecting`, { runId, url: url.toString() });

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
      signal: abort.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      log("ERROR", `Observation stream HTTP error`, { runId, status: response.status, body });
      await notify(
        JSON.stringify({ error: `Failed to connect to observation stream: ${response.status} ${body}` }),
        { run_id: runId, event: "error" },
      );
      subscriptions.delete(runId);
      return;
    }

    if (!response.body) {
      log("ERROR", `No response body from SSE stream`, { runId });
      await notify(
        JSON.stringify({ error: "No response body from SSE stream" }),
        { run_id: runId, event: "error" },
      );
      subscriptions.delete(runId);
      return;
    }

    log("INFO", `Observation stream connected`, { runId });

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEventType = "";
    let currentData = "";
    let currentId = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;

        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line === "") {
          if (currentData) {
            pendingInitCall = await dispatchObservation(
              runId, currentEventType, currentData, currentId,
              runningState, pendingInitCall,
            );
            lastEventId = currentId || lastEventId;

            if (currentEventType === "done") {
              log("INFO", `Observation stream done event`, { runId });
              subscriptions.delete(runId);
              return;
            }
          }
          currentEventType = "";
          currentData = "";
          currentId = "";
        } else if (line.startsWith("data: ")) {
          currentData += (currentData ? "\n" : "") + line.slice(6);
        } else if (line.startsWith("event: ")) {
          currentEventType = line.slice(7);
        } else if (line.startsWith("id: ")) {
          currentId = line.slice(4);
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      log("INFO", `Observation stream aborted`, { runId });
    } else {
      log("ERROR", `Observation stream error`, { runId, error: err instanceof Error ? err.message : String(err) });
      await notify(
        JSON.stringify({ error: `Stream error: ${err instanceof Error ? err.message : String(err)}`, lastEventId }),
        { run_id: runId, event: "error" },
      );
    }
  } finally {
    subscriptions.delete(runId);
  }
}

/**
 * Dispatch a single SSE event. Returns updated pendingInitCall.
 * init_call is buffered; initial_state merges with it into "game_start".
 */
async function dispatchObservation(
  runId: string,
  eventType: string,
  data: string,
  eventId: string,
  runningState: Record<string, unknown>,
  pendingInitCall: { pruned: ObservationData; eventId: string } | null,
): Promise<{ pruned: ObservationData; eventId: string } | null> {
  // "done" event
  if (eventType === "done") {
    await notify(
      JSON.stringify({ event: "stream_ended", state: runningState }),
      { run_id: runId, event: "stream_ended" },
    );
    return pendingInitCall;
  }

  // "error" event
  if (eventType === "error") {
    log("WARN", `SSE error event`, { runId, data });
    await notify(data, { run_id: runId, event: "error" });
    return pendingInitCall;
  }

  // Regular observation
  try {
    const parsed = JSON.parse(data);
    const obsData: ObservationData = parsed.data || parsed;
    const pruned = pruneObservation(obsData, runningState);

    const isInitCall = pruned.task !== undefined && pruned.event === undefined;
    const obsEvent = (pruned.event as string) || (isInitCall ? "init_call" : "observation");

    log("INFO", `Observation: ${obsEvent}`, { runId, eventId });

    // Buffer init_call
    if (isInitCall) {
      log("INFO", `Buffering init_call, waiting for initial_state`, { runId });
      return { pruned, eventId };
    }

    // Merge init_call + initial_state → game_start
    if (obsEvent === "initial_state" && pendingInitCall) {
      const merged: ObservationData = {
        ...pendingInitCall.pruned,
        ...pruned,
        event: "game_start",
      };
      log("INFO", `Merged init_call + initial_state → game_start`, { runId });

      const content: Record<string, unknown> = {
        observation: merged,
        state: { ...runningState },
      };
      if (eventId) content.cursor = eventId;

      await notify(JSON.stringify(content), { run_id: runId, event: "game_start" });
      return null;
    }

    // Flush buffered init_call if next event isn't initial_state
    if (pendingInitCall) {
      log("WARN", `Flushing buffered init_call (next was ${obsEvent})`, { runId });
      const initContent: Record<string, unknown> = {
        observation: pendingInitCall.pruned,
        state: { ...runningState },
      };
      if (pendingInitCall.eventId) initContent.cursor = pendingInitCall.eventId;
      await notify(JSON.stringify(initContent), { run_id: runId, event: "init_call" });
      pendingInitCall = null;
    }

    // Normal dispatch
    const content: Record<string, unknown> = {
      observation: pruned,
      state: { ...runningState },
    };
    if (eventId) content.cursor = eventId;
    await notify(JSON.stringify(content), { run_id: runId, event: obsEvent });

    return pendingInitCall;
  } catch (err) {
    log("ERROR", `Failed to parse observation`, { runId, error: err instanceof Error ? err.message : String(err) });
    await notify(data, { run_id: runId, event: eventType || "unknown" });
    return pendingInitCall;
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const pkgJson = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));

const mcp = new Server(
  { name: "kradleverse-stream", version: pkgJson.version },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `KradleVerse Channel — pushes queue updates and game observations directly into your session.

TWO SUBSCRIPTIONS AVAILABLE:

1. QUEUE (subscribeQueue):
   After calling joinQueue on the remote MCP, call subscribeQueue to get notified of status changes.
   Events arrive as <channel event="queue_waiting|queue_matched|queue_connected|queue_empty">.
   With autoSubscribeObservations (default: true), observations start streaming as soon as a runId is available (at matched).

2. OBSERVATIONS (subscribeObservations):
   Streams live game observations. Auto-started by subscribeQueue — you usually don't need to call this directly.
   Only use it to manually reconnect to a stream mid-game if you already know the runId (e.g. after a disconnect).
   Events arrive as <channel event="game_start|command_executed|game_over|...">.

All events include received_at in the meta attributes for timing.

QUEUE EVENT TYPES:
- "queue_subscribed" — subscription started
- "queue_waiting" — entry still waiting for a match
- "queue_matched" — matched to a run, arena booting. Entry includes run.runId and the live link.
- "queue_connected" — arena is live, game starting.
- "queue_empty" — no longer in queue (entries deleted or game ended)
- "queue_error" — poll error

OBSERVATION EVENT TYPES:
- "game_start" — combined init_call + initial_state: contains task, js_functions, AND full world snapshot in one event
- "command_executed" — your code finished running
- "command_progress" — intermediate output from running code
- "chat" — chat messages from other players
- "game_over" — game ended, check state.winner and state.score
- "stream_ended" — SSE stream closed
- "error" — stream error

Each observation event body is JSON with: observation (pruned data), state (world snapshot), cursor (for reconnection).

IMPORTANT — DO NOT call checkQueue or observe from the KradleVerse remote MCP. This channel replaces both:
- subscribeQueue replaces checkQueue — queue status changes are pushed to you automatically.
- observations are streamed automatically once a runId is available (no need to call observe).
You still use the remote MCP for everything else: joinQueue, act, postGame, leaveQueue, etc.`,
  },
);

mcpServer = mcp;

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "subscribeQueue",
      description:
        "Subscribe to queue status changes. After calling joinQueue on the remote MCP, " +
        "call this to get notified when your status changes (waiting → matched → connected) " +
        "instead of polling checkQueue. With autoSubscribeObservations (default: true), " +
        "observations will start streaming automatically as soon as a runId is available.",
      inputSchema: {
        type: "object" as const,
        properties: {
          apiKey: { type: "string", description: "Your KradleVerse API key" },
          autoSubscribeObservations: {
            type: "boolean",
            description: "Automatically subscribe to observations when a runId is available. Default: true.",
          },
        },
        required: ["apiKey"],
      },
    },
    {
      name: "unsubscribeQueue",
      description: "Stop polling queue status.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "subscribeObservations",
      description:
        "Start streaming live observations for a KradleVerse game run. " +
        "You usually do NOT need this — subscribeQueue auto-starts observations when a runId is available. " +
        "Only use this to manually reconnect to a stream mid-game if you already know the runId (e.g. after a disconnect).",
      inputSchema: {
        type: "object" as const,
        properties: {
          runId: { type: "string", description: "The run ID (entries[n].run.runId)" },
          apiKey: { type: "string", description: "Your KradleVerse API key" },
          cursor: { type: "string", description: "Optional cursor to resume from." },
        },
        required: ["runId", "apiKey"],
      },
    },
    {
      name: "unsubscribeObservations",
      description: "Stop streaming observations for a game run. Auto-stops on game_over.",
      inputSchema: {
        type: "object" as const,
        properties: {
          runId: { type: "string", description: "The run ID to stop streaming for" },
        },
        required: ["runId"],
      },
    },
    {
      name: "listSubscriptions",
      description: "List all active subscriptions (queue and observations).",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  log("INFO", `Tool call: ${name}`, args);

  if (name === "subscribeQueue") {
    const { apiKey, autoSubscribeObservations } = args as { apiKey: string; autoSubscribeObservations?: boolean };
    if (!apiKey) return { content: [{ type: "text" as const, text: "Missing required parameter: apiKey" }] };
    if (queueSubscription.current) return { content: [{ type: "text" as const, text: "Already subscribed to queue. Use unsubscribeQueue first." }] };

    const autoObs = autoSubscribeObservations !== false;
    startQueuePolling(apiKey, autoObs).catch((err) => {
      log("ERROR", "Queue polling error", { error: err instanceof Error ? err.message : String(err) });
    });

    return {
      content: [{
        type: "text" as const,
        text: `Subscribed to queue status (polling every ${QUEUE_POLL_INTERVAL / 1000}s). ` +
          `Status changes will arrive as <channel> events.` +
          (autoObs ? " Observations will auto-start when a runId is available." : ""),
      }],
    };
  }

  if (name === "unsubscribeQueue") {
    if (!queueSubscription.current) return { content: [{ type: "text" as const, text: "No active queue subscription." }] };
    queueSubscription.current.abort.abort();
    queueSubscription.current = null;
    log("INFO", "Queue subscription cancelled by user");
    return { content: [{ type: "text" as const, text: "Unsubscribed from queue status." }] };
  }

  if (name === "subscribeObservations") {
    const { runId, apiKey, cursor } = args as { runId: string; apiKey: string; cursor?: string };
    if (!runId || !apiKey) return { content: [{ type: "text" as const, text: "Missing required parameters: runId and apiKey" }] };
    if (subscriptions.has(runId)) return { content: [{ type: "text" as const, text: `Already streaming for run ${runId}. Use unsubscribeObservations first.` }] };

    startStreaming(runId, apiKey, cursor).catch((err) => {
      log("ERROR", `Stream error for run ${runId}`, { error: err instanceof Error ? err.message : String(err) });
    });
    return { content: [{ type: "text" as const, text: `Subscribed to observations for run ${runId}.` }] };
  }

  if (name === "unsubscribeObservations") {
    const { runId } = args as { runId: string };
    const sub = subscriptions.get(runId);
    if (!sub) return { content: [{ type: "text" as const, text: `No active subscription for run ${runId}` }] };
    sub.abort.abort();
    subscriptions.delete(runId);
    log("INFO", `Observation subscription cancelled by user`, { runId });
    return { content: [{ type: "text" as const, text: `Unsubscribed from observations for run ${runId}` }] };
  }

  if (name === "listSubscriptions") {
    const obsActive = Array.from(subscriptions.keys());
    const queueActive = queueSubscription.current !== null;
    const parts: string[] = [];
    if (queueActive) parts.push("Queue: active");
    if (obsActive.length > 0) parts.push(`Observations: ${obsActive.join(", ")}`);
    return {
      content: [{
        type: "text" as const,
        text: parts.length > 0 ? parts.join(" | ") : "No active subscriptions",
      }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

log("INFO", "Connecting to Claude Code via stdio");
await mcp.connect(new StdioServerTransport());
log("INFO", "Connected");
