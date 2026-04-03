import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import register from "../index.js";

function makeLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function makeFakeApi(pluginConfig = {}, runtime = {}) {
  const commands = new Map();
  const tools = new Map();
  const hooks = new Map();

  const api = {
    pluginConfig,
    logger: makeLogger(),
    runtime,
    registerCommand(def) {
      commands.set(def.name, def);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    on(hookName, handler) {
      hooks.set(hookName, handler);
    },
  };

  register(api);
  return { commands, tools, hooks };
}

function makeCtx(overrides = {}) {
  return {
    channel: "telegram",
    accountId: "default",
    to: "tg:123456789",
    from: "tg:123456789",
    ...overrides,
  };
}

function writeRolloutSession(
  filePath,
  threadId,
  cwd = "/tmp/repo",
  timestamp = "2026-04-02T12:00:00.000Z",
  firstPrompt = "Investigate and fix the build failure",
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const first = JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: {
      id: threadId,
      timestamp,
      cwd,
    },
  });
  const second = JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: firstPrompt }],
    },
  });
  fs.writeFileSync(filePath, `${first}\n${second}\n`);
  const tsMs = Number.isNaN(Date.parse(timestamp)) ? Date.now() : Date.parse(timestamp);
  fs.utimesSync(filePath, new Date(tsMs), new Date(tsMs));
}

test("integration: bind -> run -> resume same thread -> reset -> unbind", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });

  let runCount = 0;
  const fakeAdapter = {
    async runTurn({ threadId, prompt }) {
      runCount += 1;
      return {
        threadId: threadId || `thread-${runCount}`,
        text: `ok:${prompt}`,
        durationMs: 10,
      };
    },
  };

  const { commands } = makeFakeApi({
    stateDbPath: path.join(tmpDir, "state.sqlite"),
    allowedRoots: [tmpDir],
    adapterFactory: () => fakeAdapter,
  });

  const bindReply = await commands.get("codex_bind").handler(makeCtx({ args: repoDir }));
  assert.match(bindReply.text, /Codex is now bound to/);

  const status1 = await commands.get("codex_status").handler(makeCtx());
  assert.match(status1.text, /Persistent thread|Thread: not created/);

  const run1 = await commands.get("codex_run").handler(makeCtx({ args: "first task" }));
  assert.match(run1.text, /thread: thread-1/);

  const run2 = await commands.get("codex_run").handler(makeCtx({ args: "second task" }));
  assert.match(run2.text, /thread: thread-1/);

  const runNew = await commands.get("codex_run").handler(makeCtx({ args: "new start fresh context" }));
  assert.match(runNew.text, /thread: thread-3/);

  const runUse = await commands
    .get("codex_run")
    .handler(makeCtx({ args: "use thread-1 continue on old context" }));
  assert.match(runUse.text, /thread: thread-1/);

  const attach = await commands.get("codex_attach").handler(makeCtx({ args: "thread-3" }));
  assert.match(attach.text, /Attached conversation/);

  const sessions = await commands.get("codex_sessions").handler(makeCtx());
  assert.match(sessions.text, /Current thread: thread-3/);
  assert.match(sessions.text, /thread-1/);
  assert.match(sessions.text, /thread-3/);
  assert.match(sessions.text, /page 1\/1/);

  for (let i = 0; i < 12; i += 1) {
    const extra = await commands
      .get("codex_run")
      .handler(makeCtx({ args: `new extra-session-${i}` }));
    assert.match(extra.text, /thread: thread-/);
  }

  const sessionsPage2 = await commands.get("codex_sessions").handler(makeCtx({ args: "page 2" }));
  assert.match(sessionsPage2.text, /page 2\/2/);

  const sessionsAll = await commands.get("codex_sessions").handler(makeCtx({ args: "all" }));
  assert.match(sessionsAll.text, /showing all/);
  assert.match(sessionsAll.text, /thread-1/);
  assert.match(sessionsAll.text, /thread-16/);

  const sessionsBad = await commands.get("codex_sessions").handler(makeCtx({ args: "bogus arg" }));
  assert.match(sessionsBad.text, /Usage:/);

  const reset = await commands.get("codex_reset").handler(makeCtx());
  assert.match(reset.text, /thread reset/i);

  const run3 = await commands.get("codex_run").handler(makeCtx({ args: "third task" }));
  assert.match(run3.text, /thread: thread-17/);

  const off = await commands.get("codex_off").handler(makeCtx());
  assert.match(off.text, /disabled/i);

  const runBlocked = await commands.get("codex_run").handler(makeCtx({ args: "blocked task" }));
  assert.match(runBlocked.text, /DISABLED_IN_CONVERSATION/);

  const on = await commands.get("codex_on").handler(makeCtx());
  assert.match(on.text, /enabled/i);

  const modelSet = await commands.get("codex_model").handler(makeCtx({ args: "gpt-5-mini" }));
  assert.match(modelSet.text, /gpt-5-mini/);

  const unbind = await commands.get("codex_unbind").handler(makeCtx());
  assert.match(unbind.text, /removed/i);
});

test("integration: before_tool_call approval block when enabled", async () => {
  const { hooks } = makeFakeApi({
    approval: {
      enabled: true,
      riskHeuristics: ["\\bfix\\b"],
    },
  });

  const beforeToolCall = hooks.get("before_tool_call");
  assert.equal(typeof beforeToolCall, "function");

  const blocked = await beforeToolCall({
    toolName: "codex_thread_run",
    params: { prompt: "please fix this bug" },
  });
  assert.equal(blocked?.block, true);

  const passthrough = await beforeToolCall({
    toolName: "codex_thread_run",
    params: { prompt: "explain architecture only" },
  });
  assert.equal(passthrough, undefined);
});

test("integration: codex_sessions works without binding by falling back to global scope", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-global-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });

  let runCount = 0;
  const fakeAdapter = {
    async runTurn({ threadId, prompt }) {
      runCount += 1;
      return {
        threadId: threadId || `thread-${runCount}`,
        text: `ok:${prompt}`,
        durationMs: 10,
      };
    },
  };

  const { commands } = makeFakeApi({
    stateDbPath: path.join(tmpDir, "state.sqlite"),
    allowedRoots: [tmpDir],
    adapterFactory: () => fakeAdapter,
  });

  const boundCtx = makeCtx({ to: "tg:111" });
  await commands.get("codex_bind").handler({ ...boundCtx, args: repoDir });
  await commands.get("codex_run").handler({ ...boundCtx, args: "task one" });

  const unboundCtx = makeCtx({ to: "tg:999" });
  const globalSessions = await commands.get("codex_sessions").handler(unboundCtx);
  assert.match(globalSessions.text, /Scope: global/);
  assert.match(globalSessions.text, /thread-1/);
});

test("integration: codex_threadids discovers local codex CLI sessions", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-threadids-"));
  const sessionsDir = path.join(tmpDir, "sessions");
  writeRolloutSession(
    path.join(sessionsDir, "2026/04/02/rollout-2026-04-02T10-00-00-threadA.jsonl"),
    "thread-A",
    "/repo/A",
    "2026-04-02T10:00:00.000Z",
    "Implement Telegram codex session sharing",
  );
  writeRolloutSession(
    path.join(sessionsDir, "2026/04/02/rollout-2026-04-02T10-01-00-threadB.jsonl"),
    "thread-B",
    "/repo/B",
    "2026-04-02T10:01:00.000Z",
  );
  // Duplicate thread id in a different file should be deduped.
  writeRolloutSession(
    path.join(sessionsDir, "2026/04/02/rollout-2026-04-02T10-02-00-threadA-dup.jsonl"),
    "thread-A",
    "/repo/A2",
    "2026-04-02T10:02:00.000Z",
    "Reply exactly SESSA",
  );

  const { commands } = makeFakeApi({
    stateDbPath: path.join(tmpDir, "state.sqlite"),
    codexSessionsDir: sessionsDir,
  });

  const out = await commands.get("codex_threadids").handler(makeCtx());
  assert.match(out.text, /Found: 2/);
  assert.match(out.text, /thread-A/);
  assert.match(out.text, /thread-B/);
  assert.match(out.text, /last-updated:/);
  assert.match(out.text, /Codex Telegram bridge work/);
  assert.match(out.text, /Attach one: \/codex_attach/);
  assert.ok(out.text.indexOf("thread-A") < out.text.indexOf("thread-B"));

  const renamed = await commands
    .get("codex_threadname")
    .handler(makeCtx({ args: "thread-A Critical payment regression thread" }));
  assert.match(renamed.text, /Thread name updated/);

  const outAfterRename = await commands.get("codex_threadids").handler(makeCtx());
  assert.match(outAfterRename.text, /Critical payment regression thread/);

  const resetName = await commands.get("codex_threadname").handler(makeCtx({ args: "thread-A default" }));
  assert.match(resetName.text, /reset to default preview/);

  const limited = await commands.get("codex_threadids").handler(makeCtx({ args: "limit 1" }));
  assert.match(limited.text, /Found: 1/);

  const usage = await commands.get("codex_threadids").handler(makeCtx({ args: "bad arg" }));
  assert.match(usage.text, /Usage:/);

  const auto = await commands.get("codex_threadname_auto").handler(makeCtx({ args: "all" }));
  assert.match(auto.text, /Auto naming completed/);

  const outAfterAuto = await commands.get("codex_threadids").handler(makeCtx());
  assert.match(outAfterAuto.text, /Investigate and fix the build failure/);

  await commands
    .get("codex_threadname")
    .handler(makeCtx({ args: "thread-B Temporary stale alias to clear" }));
  const autoForce = await commands.get("codex_threadname_auto").handler(makeCtx({ args: "all force" }));
  assert.match(autoForce.text, /Cleared old aliases: /);
  assert.match(autoForce.text, /Updated:/);

  const outAfterForce = await commands.get("codex_threadids").handler(makeCtx());
  assert.doesNotMatch(outAfterForce.text, /Temporary stale alias to clear/);
});

test("integration: codex_attach without args returns telegram picker buttons", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-attach-picker-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });

  const sessionsDir = path.join(tmpDir, "sessions");
  writeRolloutSession(
    path.join(sessionsDir, "2026/04/02/rollout-2026-04-02T10-00-00-threadA.jsonl"),
    "thread-A",
    "/repo/A",
    "2026-04-02T10:00:00.000Z",
    "Implement Telegram codex attach picker",
  );
  writeRolloutSession(
    path.join(sessionsDir, "2026/04/02/rollout-2026-04-02T10-01-00-threadB.jsonl"),
    "thread-B",
    "/repo/B",
    "2026-04-02T10:01:00.000Z",
    "Fix session listing edge cases",
  );

  const { commands } = makeFakeApi({
    stateDbPath: path.join(tmpDir, "state.sqlite"),
    codexSessionsDir: sessionsDir,
    allowedRoots: [tmpDir],
    adapterFactory: () => ({
      async runTurn({ threadId, prompt }) {
        return { threadId: threadId || "thread-new", text: `ok:${prompt}`, durationMs: 10 };
      },
    }),
  });

  await commands.get("codex_bind").handler(makeCtx({ args: repoDir }));
  const picker = await commands.get("codex_attach").handler(makeCtx());
  assert.match(picker.text, /Known sessions: page 1\/1/);
  const buttons = picker.channelData?.telegram?.buttons;
  assert.ok(Array.isArray(buttons));
  assert.ok(buttons.length >= 2);
  const callbacks = buttons.flat().map((btn) => btn.callback_data);
  assert.ok(callbacks.includes("/codex_attach thread-A"));
  assert.ok(callbacks.includes("/codex_attach thread-B"));

  const pickerList = await commands.get("codex_attach_list").handler(makeCtx());
  assert.match(pickerList.text, /Known sessions: page 1\/1/);
  assert.ok(Array.isArray(pickerList.channelData?.telegram?.buttons));
});

test("integration: thread auto-name prefers feature intent over smoke prompts", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-name-score-"));
  const sessionsDir = path.join(tmpDir, "sessions");
  const filePath = path.join(sessionsDir, "2026/04/02/rollout-2026-04-02T10-03-00-threadX.jsonl");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const records = [
    {
      timestamp: "2026-04-02T10:03:00.000Z",
      type: "session_meta",
      payload: {
        id: "thread-X",
        timestamp: "2026-04-02T10:03:00.000Z",
        cwd: "/repo/X",
      },
    },
    {
      timestamp: "2026-04-02T10:03:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Reply exactly GLOBALSMOKE" }],
      },
    },
    {
      timestamp: "2026-04-02T10:03:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Implement Telegram session sharing for Codex threads" }],
      },
    },
  ];
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n"));

  const { commands } = makeFakeApi({
    stateDbPath: path.join(tmpDir, "state.sqlite"),
    codexSessionsDir: sessionsDir,
  });

  const out = await commands.get("codex_threadids").handler(makeCtx());
  assert.match(out.text, /Codex Telegram bridge work/);
});

test("integration: codex_run sends telegram start progress when runtime sender is available", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-progress-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });

  const sent = [];
  const runtime = {
    channel: {
      telegram: {
        async sendMessageTelegram(to, text, opts) {
          sent.push({ to, text, opts });
          return { messageId: "1", chatId: String(to) };
        },
      },
    },
  };

  const { commands } = makeFakeApi(
    {
      stateDbPath: path.join(tmpDir, "state.sqlite"),
      allowedRoots: [tmpDir],
      adapterFactory: () => ({
        async runTurn({ threadId, prompt }) {
          return { threadId: threadId || "thread-progress", text: `ok:${prompt}`, durationMs: 10 };
        },
      }),
    },
    runtime,
  );

  await commands.get("codex_bind").handler(makeCtx({ args: repoDir }));
  const out = await commands.get("codex_run").handler(makeCtx({ args: "diagnose this issue" }));
  assert.match(out.text, /run: /);
  assert.match(out.text, /thread: thread-progress/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "123456789");
  assert.match(sent[0].text, /Codex run started/);
});

test("integration: codex_sessions uses persistent auto-title from run history", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-auto-title-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });

  let runCount = 0;
  const { commands } = makeFakeApi({
    stateDbPath: path.join(tmpDir, "state.sqlite"),
    allowedRoots: [tmpDir],
    adapterFactory: () => ({
      async runTurn({ threadId, prompt }) {
        runCount += 1;
        return {
          threadId: threadId || "thread-title-1",
          text: `ok:${prompt}`,
          durationMs: 10,
        };
      },
    }),
  });

  await commands.get("codex_bind").handler(makeCtx({ args: repoDir }));
  await commands.get("codex_run").handler(makeCtx({ args: "Reply exactly SESSA" }));
  await commands.get("codex_run").handler(makeCtx({ args: "Implement Telegram session picker with inline buttons" }));

  const sessions = await commands.get("codex_sessions").handler(makeCtx());
  assert.match(sessions.text, /thread-title-1/);
  assert.match(sessions.text, /Implement Telegram session picker .*inline buttons/);
});

test("integration: codex_threadname_current renames bound current thread", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-threadname-current-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });

  const { commands } = makeFakeApi({
    stateDbPath: path.join(tmpDir, "state.sqlite"),
    allowedRoots: [tmpDir],
    adapterFactory: () => ({
      async runTurn({ threadId, prompt }) {
        return { threadId: threadId || "thread-current-1", text: `ok:${prompt}`, durationMs: 10 };
      },
    }),
  });

  await commands.get("codex_bind").handler(makeCtx({ args: repoDir }));
  await commands.get("codex_run").handler(makeCtx({ args: "build feature bridge" }));
  const renamed = await commands
    .get("codex_threadname_current")
    .handler(makeCtx({ args: "Bridge implementation thread" }));
  assert.match(renamed.text, /Thread name updated for current thread/);

  const sessions = await commands.get("codex_sessions").handler(makeCtx());
  assert.match(sessions.text, /Bridge implementation thread/);
});

test("integration: codex_run forwards streamed progress updates", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-stream-progress-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });

  const sent = [];
  const runtime = {
    channel: {
      telegram: {
        async sendMessageTelegram(to, text, opts) {
          sent.push({ to, text, opts });
          return { messageId: String(sent.length), chatId: String(to) };
        },
      },
    },
  };

  const { commands } = makeFakeApi(
    {
      stateDbPath: path.join(tmpDir, "state.sqlite"),
      allowedRoots: [tmpDir],
      adapterFactory: () => ({
        async runTurn({ threadId, prompt, onProgress }) {
          if (onProgress) {
            await onProgress("Running command: ls -la");
            await onProgress("Command completed: ls -la");
            await onProgress("Turn completed");
          }
          return { threadId: threadId || "thread-stream-1", text: `ok:${prompt}`, durationMs: 15 };
        },
      }),
    },
    runtime,
  );

  await commands.get("codex_bind").handler(makeCtx({ args: repoDir }));
  const out = await commands.get("codex_run").handler(makeCtx({ args: "show progress please" }));
  assert.match(out.text, /run: /);
  assert.ok(sent.length >= 3);
  const joined = sent.map((s) => s.text).join("\n");
  assert.match(joined, /Codex run started/);
  assert.match(joined, /Running command/);
  assert.match(joined, /Turn completed/);
});

test("integration: semantic auto-title maps codex telegram and wealthops/news corpora", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-semantic-title-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });

  let call = 0;
  const { commands } = makeFakeApi({
    stateDbPath: path.join(tmpDir, "state.sqlite"),
    allowedRoots: [tmpDir],
    adapterFactory: () => ({
      async runTurn({ threadId, prompt }) {
        call += 1;
        return {
          threadId: threadId || (call <= 2 ? "thread-codex-tg" : "thread-wealth-news"),
          text: `ok:${prompt}`,
          durationMs: 10,
        };
      },
    }),
  });

  await commands.get("codex_bind").handler(makeCtx({ args: repoDir }));
  await commands.get("codex_run").handler(makeCtx({ args: "Build Codex Telegram bridge plugin with session attach" }));
  await commands.get("codex_run").handler(makeCtx({ args: "Implement thread reuse and Telegram integration flow" }));
  await commands.get("codex_run").handler(makeCtx({ args: "new work on WealthOps bot and News bot routing" }));

  const sessions = await commands.get("codex_sessions").handler(makeCtx({ args: "all" }));
  assert.match(sessions.text, /Build Codex Telegram bridge plugin .*session/);
  assert.match(sessions.text, /WealthOps \+ News bot work/);
});

test("integration: threadids title can be derived from assistant feature summary", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-assistant-title-"));
  const sessionsDir = path.join(tmpDir, "sessions");
  const filePath = path.join(sessionsDir, "2026/04/02/rollout-2026-04-02T10-04-00-threadY.jsonl");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const records = [
    {
      timestamp: "2026-04-02T10:04:00.000Z",
      type: "session_meta",
      payload: {
        id: "thread-Y",
        timestamp: "2026-04-02T10:04:00.000Z",
        cwd: "/repo/Y",
      },
    },
    {
      timestamp: "2026-04-02T10:04:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "what was the latest work that you did?" }],
      },
    },
    {
      timestamp: "2026-04-02T10:04:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Implemented Codex Telegram integration plugin with thread attach, run modes, and session listing.",
          },
        ],
      },
    },
  ];
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n"));

  const { commands } = makeFakeApi({
    stateDbPath: path.join(tmpDir, "state.sqlite"),
    codexSessionsDir: sessionsDir,
  });

  const out = await commands.get("codex_threadids").handler(makeCtx());
  assert.match(out.text, /Codex Telegram session bridge/);
});
