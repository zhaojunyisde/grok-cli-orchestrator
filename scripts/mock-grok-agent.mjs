/**
 * In-process stand-in for `grok agent stdio`.
 * Speaks newline-delimited ACP JSON-RPC on stdin/stdout so the orchestrator
 * client is the same object in mock mode and real mode.
 *
 * Persona comes from session/new `_meta.agentProfile` (string) or a
 * `Persona:` line in `_meta.rules`. The coder persona raises
 * session/request_permission unless `_meta.yoloMode` is true.
 */
import readline from "node:readline";
import { writeSync } from "node:fs";

const rl = readline.createInterface({ input: process.stdin });
const pending = new Map();
let nextId = 1;
let sessionSeq = 0;
const sessions = new Map();

function send(message) {
  writeSync(1, `${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function personaOf(meta) {
  if (!meta || typeof meta !== "object") return "general";
  if (typeof meta.agentProfile === "string" && meta.agentProfile.trim() !== "") {
    return meta.agentProfile.trim();
  }
  const rules = typeof meta.rules === "string" ? meta.rules : "";
  const match = rules.match(/^Persona:\s*(\S+)/m);
  return match ? match[1] : "general";
}

function excerptOf(prompt) {
  const marker = "User request:\n";
  const start = prompt.indexOf(marker);
  const body = start >= 0 ? prompt.slice(start + marker.length) : prompt;
  const end = body.indexOf("\n\nNotes from earlier");
  const slice = (end >= 0 ? body.slice(0, end) : body).replace(/\s+/g, " ").trim();
  return slice.slice(0, 180);
}

function researchText(prompt) {
  return [
    "ACP permission flow (MOCK_GROK, not a live model):",
    "The host sends session/prompt. If a tool needs a human, the agent emits session/request_permission with a toolCall and options (allow_once / reject_once). The host answers with outcome selected or cancelled. --always-approve and session _meta.yoloMode skip that ask; deny rules still apply.",
    `Request excerpt: ${excerptOf(prompt)}`,
  ].join("\n");
}

function coderText(decision) {
  if (decision === "allow") {
    return [
      "Approved write of scripts/healthcheck.sh.",
      "",
      "#!/bin/sh",
      "# Mock snippet. Real mode would be written by grok after you allow the tool.",
      "test -f package.json",
    ].join("\n");
  }
  if (decision === "skip") {
    return [
      "Always-approve is on, so no permission prompt was raised.",
      "Sketch for scripts/healthcheck.sh:",
      "",
      "#!/bin/sh",
      "test -f package.json",
    ].join("\n");
  }
  if (decision === "cancel") {
    return "Stopped before writing scripts/healthcheck.sh. The human cancelled the tool call.";
  }
  return "Stopped before writing scripts/healthcheck.sh. The human denied the tool call.";
}

function streamText(sessionId, text) {
  const mid = Math.max(1, Math.ceil(text.length / 2));
  for (const part of [text.slice(0, mid), text.slice(mid)]) {
    if (!part) continue;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: part },
        },
      },
    });
  }
}

function askPermission(session) {
  const id = nextId++;
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId: session.id,
      toolCall: {
        toolCallId: "call-write-healthcheck",
        title: "Write scripts/healthcheck.sh",
        kind: "edit",
        status: "pending",
        rawInput: {
          path: "scripts/healthcheck.sh",
          content: "#!/bin/sh\ntest -f package.json\n",
        },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  });
  return new Promise((resolve) => {
    pending.set(id, resolve);
  }).then((response) => {
    const outcome = response.result?.outcome;
    if (!outcome || outcome.outcome === "cancelled") return "cancel";
    if (outcome.optionId === "allow-once") return "allow";
    return "deny";
  });
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  if (message.method && message.id === undefined) {
    if (message.method === "session/cancel") return;
    return;
  }
  if (message.id === undefined) return;

  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: "cached_token", name: "Cached credentials" }],
      _meta: {
        grokShell: true,
        agentVersion: "mock",
        defaultAuthMethodId: "cached_token",
      },
    });
    return;
  }

  if (message.method === "authenticate") {
    respond(message.id, {});
    return;
  }

  if (message.method === "session/new") {
    sessionSeq += 1;
    const meta = message.params?._meta;
    const id = `mock-${sessionSeq}`;
    sessions.set(id, {
      id,
      profile: personaOf(meta),
      yolo: Boolean(meta && meta.yoloMode === true),
      asked: false,
    });
    process.stderr.write(`mock-grok-agent: session ${id} profile=${personaOf(meta)}\n`);
    respond(message.id, { sessionId: id });
    return;
  }

  if (message.method === "session/prompt") {
    const session = sessions.get(message.params?.sessionId);
    if (!session) {
      fail(message.id, -32602, "unknown sessionId");
      return;
    }
    const prompt = Array.isArray(message.params?.prompt)
      ? message.params.prompt.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n")
      : "";
    let decision = "skip";
    if (session.profile === "coder" && !session.yolo && !session.asked) {
      session.asked = true;
      decision = await askPermission(session);
    }
    const text = session.profile === "coder" ? coderText(decision) : session.profile === "researcher" ? researchText(prompt) : `Mock ${session.profile} received: ${excerptOf(prompt)}`;
    streamText(session.id, text);
    respond(message.id, { stopReason: "end_turn" });
    return;
  }

  fail(message.id, -32601, `method not found: ${message.method}`);
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stderr.write("mock-grok-agent: ignored non-JSON stdin\n");
    return;
  }
  if (message.id !== undefined && !message.method) {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
      return;
    }
  }
  void handle(message).catch((error) => {
    process.stderr.write(`mock-grok-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    if (message.id !== undefined && message.method) {
      fail(message.id, -32603, "mock agent failed");
    }
  });
});

rl.on("close", () => {
  process.exit(0);
});
