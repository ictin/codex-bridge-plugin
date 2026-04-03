import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildConversationKey, parseConversationKey } from "./lib/conversation-key.js";
import { isApprovalEnabled, requiresApproval } from "./lib/approval-policy.js";

const TOOL_NAME = "codex_thread_run";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

class PluginError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.cause = cause;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function stringify(obj) {
  return JSON.stringify(obj, null, 2);
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function withTimeout(promise, timeoutMs, message = "Operation timed out") {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PluginError("RUN_TIMEOUT", message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function extractThreadId(threadOrResult) {
  if (!threadOrResult || typeof threadOrResult !== "object") return null;
  return (
    threadOrResult.threadId ||
    threadOrResult.thread_id ||
    threadOrResult.id ||
    threadOrResult.thread?.id ||
    threadOrResult.thread?.threadId ||
    null
  );
}

function normalizeResultText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";

  const candidates = [
    result.text,
    result.outputText,
    result.output_text,
    result.answer,
    result.response,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }

  const messages = result.messages || result.output || result.items;
  if (Array.isArray(messages)) {
    const textParts = [];
    for (const msg of messages) {
      if (typeof msg === "string") {
        textParts.push(msg);
        continue;
      }
      if (!msg || typeof msg !== "object") continue;
      if (typeof msg.text === "string") textParts.push(msg.text);
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part?.text === "string") textParts.push(part.text);
          if (typeof part?.value === "string") textParts.push(part.value);
        }
      }
    }
    if (textParts.length > 0) return textParts.join("\n").trim();
  }

  return stringify(result);
}

function ensureDirectoryExists(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureAbsoluteExistingDirectory(dirPath) {
  const resolved = path.resolve(String(dirPath || "").trim());
  if (!path.isAbsolute(resolved)) {
    throw new PluginError("INVALID_REPO", `Path must be absolute: ${dirPath}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new PluginError("INVALID_REPO", `Path does not exist: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new PluginError("INVALID_REPO", `Path is not a directory: ${resolved}`);
  }
  return resolved;
}

function isPathInsideRoot(targetPath, rootPath) {
  const target = path.resolve(targetPath);
  const root = path.resolve(rootPath);
  if (target === root) return true;
  return target.startsWith(`${root}${path.sep}`);
}

function assertAllowedRoot(repoCwd, pluginConfig) {
  const allowedRoots = Array.isArray(pluginConfig?.allowedRoots)
    ? pluginConfig.allowedRoots.map((entry) => String(entry)).filter(Boolean)
    : [];
  if (allowedRoots.length === 0) return;

  const allowed = allowedRoots.some((root) => isPathInsideRoot(repoCwd, root));
  if (!allowed) {
    throw new PluginError(
      "INVALID_REPO",
      `Path is outside allowedRoots. Path: ${repoCwd}. allowedRoots: ${allowedRoots.join(", ")}`,
    );
  }
}

function resolveStateDbPath(pluginConfig) {
  const configured = pluginConfig?.stateDbPath;
  if (typeof configured === "string" && configured.trim()) {
    return path.resolve(configured.trim());
  }
  return path.join(os.homedir(), ".openclaw", "plugin-data", "codex-bridge", "state.sqlite");
}

class SqliteStateStore {
  constructor(db) {
    this.db = db;
    this.prepareStatements();
  }

  static async create(dbPath) {
    const mod = await import("better-sqlite3");
    const DatabaseCtor = mod?.default || mod;
    ensureDirectoryExists(path.dirname(dbPath));

    const db = new DatabaseCtor(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_bindings (
        conversation_key TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL,
        peer_kind TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        repo_cwd TEXT NOT NULL,
        codex_thread_id TEXT,
        model TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        auto_route INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS run_history (
        id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL,
        prompt_preview TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        thread_id TEXT,
        error_code TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    return new SqliteStateStore(db);
  }

  prepareStatements() {
    this.stmtGetBinding = this.db.prepare(
      `SELECT * FROM conversation_bindings WHERE conversation_key = ?`,
    );
    this.stmtUpsertBinding = this.db.prepare(`
      INSERT INTO conversation_bindings (
        conversation_key, channel, account_id, peer_kind, peer_id,
        repo_cwd, codex_thread_id, model, enabled, auto_route,
        created_at, updated_at, last_run_at, last_error
      ) VALUES (
        @conversation_key, @channel, @account_id, @peer_kind, @peer_id,
        @repo_cwd, @codex_thread_id, @model, @enabled, @auto_route,
        @created_at, @updated_at, @last_run_at, @last_error
      )
      ON CONFLICT(conversation_key) DO UPDATE SET
        channel = excluded.channel,
        account_id = excluded.account_id,
        peer_kind = excluded.peer_kind,
        peer_id = excluded.peer_id,
        repo_cwd = excluded.repo_cwd,
        codex_thread_id = excluded.codex_thread_id,
        model = excluded.model,
        enabled = excluded.enabled,
        auto_route = excluded.auto_route,
        updated_at = excluded.updated_at,
        last_run_at = excluded.last_run_at,
        last_error = excluded.last_error
    `);
    this.stmtUpdateBindingRepoAndThread = this.db.prepare(`
      UPDATE conversation_bindings
      SET repo_cwd = @repo_cwd,
          codex_thread_id = @codex_thread_id,
          updated_at = @updated_at,
          last_error = NULL
      WHERE conversation_key = @conversation_key
    `);
    this.stmtUpdateModel = this.db.prepare(
      `UPDATE conversation_bindings SET model = ?, updated_at = ? WHERE conversation_key = ?`,
    );
    this.stmtUpdateEnabled = this.db.prepare(
      `UPDATE conversation_bindings SET enabled = ?, updated_at = ? WHERE conversation_key = ?`,
    );
    this.stmtResetThread = this.db.prepare(
      `UPDATE conversation_bindings SET codex_thread_id = NULL, updated_at = ? WHERE conversation_key = ?`,
    );
    this.stmtAttachThread = this.db.prepare(
      `UPDATE conversation_bindings SET codex_thread_id = ?, updated_at = ?, last_error = NULL WHERE conversation_key = ?`,
    );
    this.stmtUnbind = this.db.prepare(`DELETE FROM conversation_bindings WHERE conversation_key = ?`);
    this.stmtListThreadsForConversation = this.db.prepare(`
      SELECT thread_id, MAX(COALESCE(finished_at, started_at)) AS last_at
      FROM run_history
      WHERE conversation_key = ? AND thread_id IS NOT NULL AND thread_id != ''
      GROUP BY thread_id
      ORDER BY last_at DESC
      LIMIT ? OFFSET ?
    `);
    this.stmtCountThreadsForConversation = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM (
        SELECT thread_id
        FROM run_history
        WHERE conversation_key = ? AND thread_id IS NOT NULL AND thread_id != ''
        GROUP BY thread_id
      ) AS uniq
    `);
    this.stmtListThreadsGlobal = this.db.prepare(`
      SELECT conversation_key, thread_id, MAX(COALESCE(finished_at, started_at)) AS last_at
      FROM run_history
      WHERE thread_id IS NOT NULL AND thread_id != ''
      GROUP BY conversation_key, thread_id
      ORDER BY last_at DESC
      LIMIT ? OFFSET ?
    `);
    this.stmtCountThreadsGlobal = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM (
        SELECT conversation_key, thread_id
        FROM run_history
        WHERE thread_id IS NOT NULL AND thread_id != ''
        GROUP BY conversation_key, thread_id
      ) AS uniq
    `);
    this.stmtListPromptPreviewsForThread = this.db.prepare(`
      SELECT prompt_preview
      FROM run_history
      WHERE thread_id = ? AND prompt_preview IS NOT NULL AND prompt_preview != ''
      ORDER BY started_at ASC
      LIMIT ?
    `);
    this.stmtGetSetting = this.db.prepare(`SELECT value FROM settings WHERE key = ?`);
    this.stmtUpsertSetting = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    this.stmtDeleteSetting = this.db.prepare(`DELETE FROM settings WHERE key = ?`);
    this.stmtInsertRun = this.db.prepare(`
      INSERT INTO run_history (
        id, conversation_key, prompt_preview, status,
        started_at, finished_at, thread_id, error_code, error_message
      ) VALUES (
        @id, @conversation_key, @prompt_preview, @status,
        @started_at, @finished_at, @thread_id, @error_code, @error_message
      )
    `);
    this.stmtFinishRun = this.db.prepare(`
      UPDATE run_history
      SET status = @status,
          finished_at = @finished_at,
          thread_id = @thread_id,
          error_code = @error_code,
          error_message = @error_message
      WHERE id = @id
    `);
    this.stmtMarkBindingRunSuccess = this.db.prepare(`
      UPDATE conversation_bindings
      SET codex_thread_id = @thread_id,
          last_run_at = @last_run_at,
          last_error = NULL,
          updated_at = @updated_at
      WHERE conversation_key = @conversation_key
    `);
    this.stmtMarkBindingRunError = this.db.prepare(`
      UPDATE conversation_bindings
      SET last_error = @last_error,
          updated_at = @updated_at
      WHERE conversation_key = @conversation_key
    `);
  }

  getBinding(conversationKey) {
    return this.stmtGetBinding.get(conversationKey) || null;
  }

  createOrUpdateBinding({
    conversationKey,
    repoCwd,
    model,
    enabled = 1,
    autoRoute = 1,
    codexThreadId = null,
  }) {
    const parsed = parseConversationKey(conversationKey);
    if (!parsed) {
      throw new PluginError("INVALID_CONVERSATION_KEY", `Invalid conversation key: ${conversationKey}`);
    }
    const existing = this.getBinding(conversationKey);
    const timestamp = nowIso();
    this.stmtUpsertBinding.run({
      conversation_key: conversationKey,
      channel: parsed.channel,
      account_id: parsed.accountId,
      peer_kind: parsed.peerKind,
      peer_id: parsed.peerId,
      repo_cwd: repoCwd,
      codex_thread_id: codexThreadId,
      model: model || null,
      enabled: enabled ? 1 : 0,
      auto_route: autoRoute ? 1 : 0,
      created_at: existing?.created_at || timestamp,
      updated_at: timestamp,
      last_run_at: existing?.last_run_at || null,
      last_error: existing?.last_error || null,
    });
    return this.getBinding(conversationKey);
  }

  setRepoAndOptionalThread(conversationKey, repoCwd, codexThreadId = null) {
    this.stmtUpdateBindingRepoAndThread.run({
      conversation_key: conversationKey,
      repo_cwd: repoCwd,
      codex_thread_id: codexThreadId,
      updated_at: nowIso(),
    });
    return this.getBinding(conversationKey);
  }

  setModel(conversationKey, model) {
    this.stmtUpdateModel.run(model || null, nowIso(), conversationKey);
    return this.getBinding(conversationKey);
  }

  setEnabled(conversationKey, enabled) {
    this.stmtUpdateEnabled.run(enabled ? 1 : 0, nowIso(), conversationKey);
    return this.getBinding(conversationKey);
  }

  resetThread(conversationKey) {
    this.stmtResetThread.run(nowIso(), conversationKey);
    return this.getBinding(conversationKey);
  }

  attachThread(conversationKey, threadId) {
    this.stmtAttachThread.run(String(threadId), nowIso(), conversationKey);
    return this.getBinding(conversationKey);
  }

  unbind(conversationKey) {
    const before = this.getBinding(conversationKey);
    this.stmtUnbind.run(conversationKey);
    return before;
  }

  startRun({ conversationKey, prompt }) {
    const id = crypto.randomUUID();
    this.stmtInsertRun.run({
      id,
      conversation_key: conversationKey,
      prompt_preview: String(prompt || "").slice(0, 240),
      status: "running",
      started_at: nowIso(),
      finished_at: null,
      thread_id: null,
      error_code: null,
      error_message: null,
    });
    return id;
  }

  finishRunSuccess({ runId, conversationKey, threadId }) {
    const ts = nowIso();
    this.stmtFinishRun.run({
      id: runId,
      status: "ok",
      finished_at: ts,
      thread_id: threadId || null,
      error_code: null,
      error_message: null,
    });
    this.stmtMarkBindingRunSuccess.run({
      conversation_key: conversationKey,
      thread_id: threadId || null,
      last_run_at: ts,
      updated_at: ts,
    });
    if (threadId) {
      this.recomputeThreadAutoTitle(threadId);
    }
  }

  finishRunError({ runId, conversationKey, errorCode, errorMessage }) {
    const ts = nowIso();
    this.stmtFinishRun.run({
      id: runId,
      status: "error",
      finished_at: ts,
      thread_id: null,
      error_code: errorCode || "RUN_FAILED",
      error_message: errorMessage || "Unknown error",
    });
    this.stmtMarkBindingRunError.run({
      conversation_key: conversationKey,
      last_error: `${errorCode || "RUN_FAILED"}: ${errorMessage || "Unknown error"}`,
      updated_at: ts,
    });
  }

  listThreadsForConversation(conversationKey, limit = 10, offset = 0) {
    const normalizedLimit = Number.isFinite(Number(limit)) ? Number(limit) : 10;
    const normalizedOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
    return this.stmtListThreadsForConversation.all(
      conversationKey,
      Math.max(1, Math.min(50, normalizedLimit)),
      Math.max(0, normalizedOffset),
    );
  }

  countThreadsForConversation(conversationKey) {
    const row = this.stmtCountThreadsForConversation.get(conversationKey);
    return Number(row?.total || 0);
  }

  listThreadsGlobal(limit = 10, offset = 0) {
    const normalizedLimit = Number.isFinite(Number(limit)) ? Number(limit) : 10;
    const normalizedOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
    return this.stmtListThreadsGlobal.all(
      Math.max(1, Math.min(100, normalizedLimit)),
      Math.max(0, normalizedOffset),
    );
  }

  countThreadsGlobal() {
    const row = this.stmtCountThreadsGlobal.get();
    return Number(row?.total || 0);
  }

  listPromptPreviewsForThread(threadId, limit = 200) {
    const normalizedLimit = Number.isFinite(Number(limit)) ? Number(limit) : 200;
    return this.stmtListPromptPreviewsForThread
      .all(String(threadId), Math.max(1, Math.min(500, normalizedLimit)))
      .map((row) => String(row?.prompt_preview || "").trim())
      .filter(Boolean);
  }

  recomputeThreadAutoTitle(threadId, fallbackName = "Unnamed session") {
    const prompts = this.listPromptPreviewsForThread(threadId, 300);
    const computed = normalizeAutoThreadTitle(deriveThreadTitleFromPrompts(prompts));
    const fallback = normalizeAutoThreadTitle(fallbackName);
    const normalized =
      scoreTitleQuality(fallback) > scoreTitleQuality(computed || "")
        ? fallback
        : computed || fallback;
    if (!normalized) return null;
    this.setSetting(threadAutoTitleKey(threadId), normalized);
    return normalized;
  }

  getEffectiveThreadName(threadId, fallbackName = "Unnamed session") {
    const manual = this.getSetting(threadAliasKey(threadId));
    if (manual) return normalizeLowSignalTitle(manual);
    const auto = this.getSetting(threadAutoTitleKey(threadId));
    if (auto) return normalizeLowSignalTitle(auto);
    return normalizeLowSignalTitle(fallbackName);
  }

  getSetting(key) {
    const row = this.stmtGetSetting.get(String(key));
    return row?.value ?? null;
  }

  setSetting(key, value) {
    this.stmtUpsertSetting.run(String(key), String(value), nowIso());
  }

  deleteSetting(key) {
    this.stmtDeleteSetting.run(String(key));
  }
}

class CodexSdkAdapter {
  constructor({ timeoutMs, logger, skipGitRepoCheck = true }) {
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.skipGitRepoCheck = skipGitRepoCheck;
    this.codexClient = null;
  }

  async getClient() {
    if (this.codexClient) return this.codexClient;
    let mod;
    try {
      mod = await import("@openai/codex-sdk");
    } catch (err) {
      throw new PluginError(
        "AUTH_ERROR",
        "@openai/codex-sdk is not installed or failed to load in codex-bridge plugin",
        err,
      );
    }
    const CodexCtor = mod?.Codex || mod?.default || mod;
    this.codexClient = new CodexCtor();
    return this.codexClient;
  }

  async createThread(client, opts) {
    const maybeThread = client.startThread?.(opts || {});
    if (!maybeThread) {
      throw new PluginError("RUN_FAILED", "Codex SDK startThread() returned no thread object");
    }
    return await Promise.resolve(maybeThread);
  }

  async resumeThread(client, threadId, opts) {
    const maybeThread = client.resumeThread?.(threadId, opts || {});
    if (!maybeThread) {
      throw new PluginError("THREAD_NOT_FOUND", `Failed to resume thread: ${threadId}`);
    }
    return await Promise.resolve(maybeThread);
  }

  async runTurn({ threadId, prompt, cwd, model, createIfMissing = true, onProgress }) {
    const client = await this.getClient();
    const options = {};
    if (cwd) {
      // Codex SDK expects `workingDirectory`; keep `cwd` for backward compatibility.
      options.workingDirectory = cwd;
      options.cwd = cwd;
    }
    if (model) options.model = model;
    options.skipGitRepoCheck = this.skipGitRepoCheck;

    let thread = null;
    if (threadId) {
      try {
        thread = await this.resumeThread(client, threadId, options);
      } catch (err) {
        if (!createIfMissing) throw this.mapCodexError(err);
        this.logger.warn?.(
          `codex-bridge: resumeThread failed for ${threadId}; creating new thread (${String(err?.message || err)})`,
        );
      }
    }
    if (!thread) thread = await this.createThread(client, options);

    const startedAt = Date.now();
    let runResult;
    try {
      if (typeof onProgress === "function") {
        runResult = await withTimeout(
          this.runTurnStreamed(thread, prompt, onProgress),
          this.timeoutMs,
          `Codex run exceeded timeout (${this.timeoutMs}ms)`,
        );
      } else {
        runResult = await withTimeout(
          Promise.resolve(thread.run(prompt)),
          this.timeoutMs,
          `Codex run exceeded timeout (${this.timeoutMs}ms)`,
        );
      }
    } catch (err) {
      throw this.mapCodexError(err);
    }

    const finalThreadId = extractThreadId(runResult) || extractThreadId(thread) || threadId || null;
    return {
      threadId: finalThreadId,
      text: normalizeResultText(runResult),
      durationMs: Date.now() - startedAt,
      raw: runResult,
    };
  }

  async runTurnStreamed(thread, prompt, onProgress) {
    const streamed = await Promise.resolve(thread.runStreamed(prompt));
    const items = [];
    let finalResponse = "";
    let usage = null;
    let turnFailure = null;
    for await (const event of streamed.events) {
      const progressText = formatProgressEvent(event);
      if (progressText) {
        await Promise.resolve(onProgress(progressText, event));
      }
      if (event?.type === "item.completed") {
        if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
          finalResponse = event.item.text;
        }
        items.push(event.item);
      } else if (event?.type === "turn.completed") {
        usage = event.usage || null;
      } else if (event?.type === "turn.failed") {
        turnFailure = event.error || { message: "Turn failed" };
        break;
      } else if (event?.type === "error") {
        turnFailure = { message: event.message || "Thread stream error" };
        break;
      }
    }
    if (turnFailure) {
      throw new Error(String(turnFailure?.message || "Turn failed"));
    }
    return { items, finalResponse, usage, threadId: thread?.id || null };
  }

  mapCodexError(err) {
    if (err instanceof PluginError) return err;
    const message = String(err?.message || err || "Unknown Codex SDK error");
    const lower = message.toLowerCase();
    if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("api key")) {
      return new PluginError("AUTH_ERROR", message, err);
    }
    if (lower.includes("thread") && lower.includes("not found")) {
      return new PluginError("THREAD_NOT_FOUND", message, err);
    }
    if (lower.includes("timeout")) {
      return new PluginError("RUN_TIMEOUT", message, err);
    }
    if (
      (lower.includes("trusted directory") || lower.includes("not inside a trusted directory")) &&
      lower.includes("skip-git-repo-check")
    ) {
      return new PluginError(
        "INVALID_REPO",
        `${message}. Configure codex-bridge with skipGitRepoCheck=true or bind a Git repo directory.`,
        err,
      );
    }
    return new PluginError("RUN_FAILED", message, err);
  }
}

function formatProgressEvent(event) {
  if (!event || typeof event !== "object") return "";
  if (event.type === "thread.started") return "Thread started";
  if (event.type === "turn.started") return "Turn started";
  if (event.type === "turn.completed") return "Turn completed";
  if (event.type === "turn.failed") return `Turn failed: ${event?.error?.message || "unknown error"}`;
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return "";
  const item = event.item || {};
  const itemType = item.type || "item";
  if (itemType === "command_execution") {
    const command = String(item.command || "").trim();
    const status = String(item.status || "").trim();
    if (event.type === "item.started") return `Running command: ${command || "command"}`;
    if (event.type === "item.completed") return `Command ${status || "completed"}: ${command || "command"}`;
  }
  if (itemType === "file_change" && event.type === "item.completed") {
    const count = Array.isArray(item.changes) ? item.changes.length : 0;
    return `Applied file changes: ${count}`;
  }
  if (itemType === "mcp_tool_call") {
    const tool = String(item.tool || "tool");
    if (event.type === "item.started") return `Calling tool: ${tool}`;
    if (event.type === "item.completed") return `Tool completed: ${tool}`;
  }
  if (itemType === "web_search" && event.type === "item.started") {
    return `Web search: ${String(item.query || "").slice(0, 100)}`;
  }
  if (itemType === "todo_list" && event.type === "item.updated") {
    const total = Array.isArray(item.items) ? item.items.length : 0;
    const done = Array.isArray(item.items) ? item.items.filter((i) => i?.completed).length : 0;
    return `Plan updated: ${done}/${total} done`;
  }
  return "";
}

function formatStatus(binding, conversationKey) {
  if (!binding) {
    return [
      `Conversation: ${conversationKey}`,
      "Status: unbound",
      "Use /codex_bind <absolute-path> to bind a repo.",
    ].join("\n");
  }
  return [
    `Conversation: ${conversationKey}`,
    `Repo: ${binding.repo_cwd}`,
    `Enabled: ${binding.enabled ? "on" : "off"}`,
    `Auto-route: ${binding.auto_route ? "on" : "off"}`,
    `Thread: ${binding.codex_thread_id || "not created"}`,
    `Model: ${binding.model || "default"}`,
    `Last run: ${binding.last_run_at || "never"}`,
    `Last error: ${binding.last_error || "none"}`,
  ].join("\n");
}

function summarizeRunForReply(run) {
  const text = String(run?.text || "").trim();
  const preview = text.length > 4000 ? `${text.slice(0, 4000)}\n\n[truncated]` : text;
  const lines = [
    preview || "(No text output)",
    "",
    `thread: ${run.threadId || "unknown"}`,
    `repo: ${run.repoCwd || "unknown"}`,
    `model: ${run.model || "default"}`,
  ];
  if (typeof run.durationMs === "number") lines.push(`durationMs: ${run.durationMs}`);
  return lines.join("\n");
}

function normalizeLowSignalTitle(rawTitle) {
  const normalized = normalizeThreadName(rawTitle || "");
  if (!normalized) return "";
  return isLowSignalPrompt(normalized) ? "Smoke/Test run" : normalized;
}

function trimToWordLimit(rawTitle, maxWords = 10) {
  const text = normalizeThreadName(rawTitle || "", 120);
  if (!text) return "";
  const safe = text
    .replace(/[|()[\]{}]/g, " ")
    .replace(/[,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!safe) return "";

  const words = safe.split(" ").filter(Boolean);
  if (words.length <= maxWords) return safe;

  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "of",
    "for",
    "with",
    "in",
    "on",
    "at",
    "by",
    "is",
    "are",
    "was",
    "were",
    "that",
    "this",
    "it",
    "as",
    "from",
    "what",
    "how",
    "latest",
    "work",
    "done",
    "did",
    "you",
    "your",
  ]);
  const filtered = words.filter((w) => !stop.has(w.toLowerCase()));
  const source = filtered.length >= Math.min(maxWords, 3) ? filtered : words;
  return source.slice(0, maxWords).join(" ");
}

function normalizeAutoThreadTitle(rawTitle) {
  const base = normalizeLowSignalTitle(rawTitle || "");
  if (!base) return "";
  return trimToWordLimit(base, 10);
}

function scoreTitleQuality(name) {
  const text = String(name || "").trim();
  if (!text) return -100;
  const lower = text.toLowerCase();
  let score = 0;
  if (isLowSignalPrompt(text)) score -= 60;
  if (isMetaNamingPrompt(text)) score -= 45;
  if (lower.includes("not capturing")) score -= 35;
  if (lower.includes("latest work")) score -= 25;
  if (lower.includes("what was the")) score -= 15;
  if (text.length < 8) score -= 15;
  if (text.length > 90) score -= 10;
  if (/\b(codex|telegram|openclaw|plugin|session|thread|wealthops|news bot|bot)\b/i.test(text)) score += 20;
  if (/\b(implement|build|integration|feature|bridge|workflow)\b/i.test(text)) score += 12;
  return score;
}

function resolveTelegramChatIdFromContext(ctx) {
  const to = String(ctx?.to || "").trim();
  if (to.startsWith("tg:")) return to.slice(3);
  if (/^-?\d+$/.test(to)) return to;
  if (to.startsWith("telegram:")) {
    const numeric = to.split(":").find((part) => /^-?\d+$/.test(part));
    if (numeric) return numeric;
  }
  const from = String(ctx?.from || "").trim();
  if (from.startsWith("tg:")) return from.slice(3);
  if (/^-?\d+$/.test(from)) return from;
  if (from.startsWith("telegram:")) {
    const numeric = from.split(":").find((part) => /^-?\d+$/.test(part));
    if (numeric) return numeric;
  }
  try {
    const key = buildConversationKey(ctx);
    const parsed = parseConversationKey(key);
    if (parsed?.channel === "telegram" && parsed.peerId) return parsed.peerId;
  } catch {}
  return null;
}

async function sendTelegramProgress(api, ctx, text) {
  const sendMessageTelegram = api?.runtime?.channel?.telegram?.sendMessageTelegram;
  if (typeof sendMessageTelegram !== "function") return;
  const chatId = resolveTelegramChatIdFromContext(ctx);
  if (!chatId) return;

  const opts = {};
  if (ctx?.accountId) opts.accountId = String(ctx.accountId);
  if (typeof ctx?.messageThreadId === "number" && Number.isFinite(ctx.messageThreadId)) {
    opts.messageThreadId = ctx.messageThreadId;
  } else {
    try {
      const parsed = parseConversationKey(buildConversationKey(ctx));
      if (typeof parsed?.topicId === "number" && Number.isFinite(parsed.topicId)) {
        opts.messageThreadId = parsed.topicId;
      }
    } catch {}
  }

  try {
    await sendMessageTelegram(chatId, text, opts);
  } catch {
    // Best-effort only; do not fail run command on progress update failure.
  }
}

function parseRunArgs(rawArgs) {
  const input = String(rawArgs || "").trim();
  if (!input) {
    return { mode: "default", prompt: "" };
  }

  if (input.toLowerCase() === "new") {
    return { mode: "new", prompt: "" };
  }
  if (input.toLowerCase().startsWith("new ")) {
    return { mode: "new", prompt: input.slice(4).trim() };
  }

  if (input.toLowerCase().startsWith("use ")) {
    const rest = input.slice(4).trim();
    const firstSpace = rest.indexOf(" ");
    if (firstSpace === -1) {
      return { mode: "use", threadId: rest, prompt: "" };
    }
    return {
      mode: "use",
      threadId: rest.slice(0, firstSpace).trim(),
      prompt: rest.slice(firstSpace + 1).trim(),
    };
  }

  if (input.toLowerCase().startsWith("thread:")) {
    const rest = input.slice("thread:".length).trim();
    const firstSpace = rest.indexOf(" ");
    if (firstSpace === -1) {
      return { mode: "use", threadId: rest, prompt: "" };
    }
    return {
      mode: "use",
      threadId: rest.slice(0, firstSpace).trim(),
      prompt: rest.slice(firstSpace + 1).trim(),
    };
  }

  return { mode: "default", prompt: input };
}

function parseSessionsArgs(rawArgs) {
  const input = String(rawArgs || "").trim();
  if (!input) {
    return { mode: "page", page: 1, limit: 10 };
  }
  if (input.toLowerCase() === "all") {
    return { mode: "all", page: 1, limit: 50 };
  }

  const pageMatch = input.match(/^page\s+(\d+)(?:\s+limit\s+(\d+))?$/i);
  if (pageMatch) {
    const page = Math.max(1, Number.parseInt(pageMatch[1], 10));
    const limit = pageMatch[2] ? Number.parseInt(pageMatch[2], 10) : 10;
    return { mode: "page", page, limit };
  }

  const limitMatch = input.match(/^limit\s+(\d+)$/i);
  if (limitMatch) {
    const limit = Number.parseInt(limitMatch[1], 10);
    return { mode: "page", page: 1, limit };
  }

  const maybeNumber = Number.parseInt(input, 10);
  if (Number.isFinite(maybeNumber) && String(maybeNumber) === input) {
    return { mode: "page", page: maybeNumber, limit: 10 };
  }

  return { mode: "invalid", raw: input };
}

function parseThreadIdsArgs(rawArgs) {
  const input = String(rawArgs || "").trim();
  if (!input) return { limit: 20 };
  const limitMatch = input.match(/^limit\s+(\d+)$/i);
  if (limitMatch) {
    return { limit: Number.parseInt(limitMatch[1], 10) };
  }
  const numeric = Number.parseInt(input, 10);
  if (Number.isFinite(numeric) && String(numeric) === input) {
    return { limit: numeric };
  }
  return { invalid: true };
}

function parseThreadNameArgs(rawArgs) {
  const input = String(rawArgs || "").trim();
  if (!input) return { invalid: true };
  const firstSpace = input.indexOf(" ");
  if (firstSpace === -1) {
    return { invalid: true };
  }
  const threadId = input.slice(0, firstSpace).trim();
  const name = input.slice(firstSpace + 1).trim();
  if (!threadId || !name) return { invalid: true };
  return { threadId, name };
}

function parseThreadNameAutoArgs(rawArgs) {
  const input = String(rawArgs || "").trim();
  if (!input) return { limit: 30, force: false };

  const force = /\bforce\b/i.test(input);
  const cleaned = input.replace(/\bforce\b/gi, "").trim();
  if (!cleaned || cleaned.toLowerCase() === "all") {
    return { limit: 200, force };
  }
  const limitMatch = cleaned.match(/^limit\s+(\d+)$/i);
  if (limitMatch) {
    return { limit: Number.parseInt(limitMatch[1], 10), force };
  }
  const numeric = Number.parseInt(cleaned, 10);
  if (Number.isFinite(numeric) && String(numeric) === cleaned) {
    return { limit: numeric, force };
  }
  return { invalid: true };
}

function parseAttachArgs(rawArgs) {
  const input = String(rawArgs || "").trim();
  if (!input) return { mode: "picker", page: 1, limit: 10 };
  if (/^list$/i.test(input)) return { mode: "picker", page: 1, limit: 10 };

  const pageMatch = input.match(/^page\s+(\d+)(?:\s+limit\s+(\d+))?$/i);
  if (pageMatch) {
    const page = Math.max(1, Number.parseInt(pageMatch[1], 10));
    const limit = pageMatch[2] ? Math.max(1, Number.parseInt(pageMatch[2], 10)) : 10;
    return { mode: "picker", page, limit };
  }

  const limitMatch = input.match(/^limit\s+(\d+)$/i);
  if (limitMatch) {
    return { mode: "picker", page: 1, limit: Math.max(1, Number.parseInt(limitMatch[1], 10)) };
  }

  return { mode: "attach", threadId: input };
}

function resolveCodexSessionsDir(pluginConfig) {
  const configured = pluginConfig?.codexSessionsDir;
  if (typeof configured === "string" && configured.trim()) {
    return path.resolve(configured.trim());
  }
  return path.join(os.homedir(), ".codex", "sessions");
}

function walkFiles(rootDir, predicate) {
  if (!fs.existsSync(rootDir)) return [];
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && predicate(fullPath, entry.name)) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

function readFirstLine(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const firstNl = content.indexOf("\n");
    return firstNl === -1 ? content : content.slice(0, firstNl);
  } catch {
    return "";
  }
}

function listCliThreadIds(pluginConfig, limit = 20) {
  const sessionsDir = resolveCodexSessionsDir(pluginConfig);
  const files = walkFiles(
    sessionsDir,
    (fullPath, name) => name.endsWith(".jsonl") && (name.startsWith("rollout-") || fullPath.includes("/rollout-")),
  );
  const withStats = files.map((file) => {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs || 0;
    } catch {}
    return { file, mtimeMs };
  });
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const byThread = new Map();
  const rows = [];
  for (const item of withStats) {
    const firstLine = readFirstLine(item.file).trim();
    if (!firstLine) continue;
    let parsed;
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      continue;
    }
    const threadId = parsed?.payload?.id;
    if (!threadId) continue;
    const existing = byThread.get(threadId);
    if (existing) {
      existing.files.push(item.file);
      continue;
    }
    byThread.set(threadId, {
      threadId,
      timestamp: parsed?.payload?.timestamp || parsed?.timestamp || null,
      cwd: parsed?.payload?.cwd || null,
      files: [item.file],
    });
  }

  for (const row of byThread.values()) {
    rows.push({
      threadId: row.threadId,
      timestamp: row.timestamp,
      cwd: row.cwd,
      defaultName: extractThreadSummaryFromSessionFiles(row.files),
      file: row.files[0],
    });
    if (rows.length >= limit) break;
  }
  return { sessionsDir, rows };
}

function isBoilerplateLine(line) {
  const lower = String(line || "").trim().toLowerCase();
  if (!lower) return true;
  if (/^<\s*(environment[_\s-]*context|cwd|shell|current[_\s-]*date|timezone)\b/.test(lower)) return true;
  if (/<\s*\/\s*(environment[_\s-]*context|cwd|shell|current[_\s-]*date|timezone)\b/.test(lower)) return true;
  return (
    lower.startsWith("<environment_context>") ||
    lower.startsWith("<environment context>") ||
    lower.startsWith("</environment_context>") ||
    lower.startsWith("</environment context>") ||
    lower.startsWith("<cwd>") ||
    lower.startsWith("<shell>") ||
    lower.startsWith("<current_date>") ||
    lower.startsWith("<timezone>") ||
    lower.startsWith("</cwd>") ||
    lower.startsWith("</shell>") ||
    lower.startsWith("</current_date>") ||
    lower.startsWith("</timezone>") ||
    lower.startsWith("<") && lower.endsWith(">") ||
    lower.includes("sandbox_mode") ||
    lower.includes("collaboration mode") ||
    lower.includes("permissions instructions")
  );
}

function extractHumanPromptPreview(rawText, maxChars = 70) {
  const text = String(rawText || "");
  const normalized = text.replace(/\r/g, "");
  const lines = normalized
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !isBoilerplateLine(line));

  for (const line of lines) {
    // Skip XML-like fragments that survive basic filtering.
    if (line.startsWith("<")) continue;
    const cleaned = line.replace(/[`*_#>-]+/g, "").trim();
    if (!cleaned) continue;
    const compact = summarizePromptToTitle(cleaned, maxChars);
    if (compact) return compact;
  }
  return "Unnamed session";
}

function summarizePromptToTitle(text, maxChars = 70) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (
    lower.startsWith("you are ") ||
    lower.startsWith("## ") ||
    lower.startsWith("phase ") ||
    lower.includes("strict output format") ||
    lower.includes("non-negotiable product requirements")
  ) {
    return "";
  }

  let compact = raw;
  compact = compact.replace(/^i want (you )?(to )?/i, "");
  compact = compact.replace(/^please\s+/i, "");
  compact = compact.replace(/^can you\s+/i, "");
  compact = compact.replace(/^could you\s+/i, "");
  compact = compact.replace(/^let's\s+/i, "");

  // Keep short action-oriented titles.
  const words = compact.split(" ").filter(Boolean);
  if (words.length > 12) {
    compact = words.slice(0, 12).join(" ");
  }
  compact = compact.replace(/[.:;,\-–—]+$/, "").trim();
  if (!compact) return "";
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}…` : compact;
}

function extractFirstUserPromptPreview(filePath, maxChars = 70) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return "Unnamed session";
  }
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed?.type !== "response_item") continue;
    const payload = parsed?.payload;
    if (!payload || payload.role !== "user" || !Array.isArray(payload.content)) continue;
    for (const part of payload.content) {
      if (!part || typeof part !== "object") continue;
      const maybeText =
        (part.type === "input_text" && typeof part.text === "string" && part.text) ||
        (part.type === "text" && typeof part.text === "string" && part.text) ||
        (typeof part.text === "string" && part.text);
      if (!maybeText) continue;
      const preview = extractHumanPromptPreview(maybeText, maxChars);
      if (preview && preview !== "Unnamed session") {
        return preview;
      }
    }
  }
  return "Unnamed session";
}

function parseJsonl(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // ignore malformed records
    }
  }
  return out;
}

function extractUserTextsFromSession(filePath) {
  const records = parseJsonl(filePath);
  const userTexts = [];
  for (const rec of records) {
    if (rec?.type !== "response_item") continue;
    const payload = rec?.payload;
    if (!payload || payload.role !== "user" || !Array.isArray(payload.content)) continue;
    for (const part of payload.content) {
      if (!part || typeof part !== "object") continue;
      const maybeText =
        (part.type === "input_text" && typeof part.text === "string" && part.text) ||
        (part.type === "text" && typeof part.text === "string" && part.text) ||
        (typeof part.text === "string" && part.text);
      if (!maybeText) continue;
      userTexts.push(maybeText);
    }
  }
  return userTexts;
}

function extractMessageTextsFromSession(filePath, role = "user") {
  const records = parseJsonl(filePath);
  const texts = [];
  for (const rec of records) {
    if (rec?.type !== "response_item") continue;
    const payload = rec?.payload;
    if (!payload || payload.role !== role || !Array.isArray(payload.content)) continue;
    for (const part of payload.content) {
      if (!part || typeof part !== "object") continue;
      const maybeText =
        (part.type === "input_text" && typeof part.text === "string" && part.text) ||
        (part.type === "output_text" && typeof part.text === "string" && part.text) ||
        (part.type === "text" && typeof part.text === "string" && part.text) ||
        (typeof part.text === "string" && part.text);
      if (!maybeText) continue;
      texts.push(maybeText);
    }
  }
  return texts;
}

function splitCandidateLines(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .flatMap((line) => line.split(/[.!?]\s+/))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isLowSignalPrompt(line) {
  const raw = String(line || "").trim();
  const lower = raw.toLowerCase();
  if (!lower) return true;
  if (/^reply exactly\b/.test(lower)) return true;
  if (/^(smoke|test|ping|ok)\b/.test(lower)) return true;
  if (/\b(globalsmoke|smokeok)\b/.test(lower)) return true;
  if (/\b(?:SESS|BASE)[A-Z0-9_-]*\b/.test(raw)) return true;
  if (/^[a-z0-9:_ -]{1,40}$/.test(lower) && /[A-Z]{2,}/.test(raw)) return true;
  return false;
}

function isMetaNamingPrompt(line) {
  const lower = String(line || "").trim().toLowerCase();
  if (!lower) return true;
  return (
    lower.includes("thread id") ||
    lower.includes("threadids") ||
    lower.includes("thread name") ||
    lower.includes("threadname") ||
    lower.includes("session id") ||
    lower.includes("sessions dir") ||
    lower.includes("list sessions") ||
    lower.includes("codex_sessions") ||
    lower.includes("codex_threadids") ||
    lower.includes("rename") ||
    lower.includes("attach one") ||
    lower.includes("what was the latest work")
  );
}

function isLikelyFeatureSummaryLine(line) {
  const lower = String(line || "").trim().toLowerCase();
  if (!lower) return false;
  if (isBoilerplateLine(lower)) return false;
  if (isMetaNamingPrompt(lower)) return false;
  if (isLowSignalPrompt(lower)) return false;
  if (lower.length < 20 || lower.length > 220) return false;
  const hasFeatureVerb = /\b(implemented?|build|built|added?|create[sd]?|integrat(?:e|ed|ion)|support(?:ed)?|wire[sd]?|ship(?:ped)?)\b/.test(
    lower,
  );
  const hasDomain = /\b(codex|telegram|openclaw|plugin|thread|session|wealthops?|news bot|bot)\b/.test(
    lower,
  );
  return hasFeatureVerb || hasDomain;
}

function scoreCandidateLine(line) {
  const lower = line.toLowerCase();
  let score = 0;
  if (isBoilerplateLine(line)) return -1000;
  if (isLowSignalPrompt(line)) return -60;
  if (isMetaNamingPrompt(line)) return -35;
  if (line.length < 12 || line.length > 180) return -20;

  const intentWords = [
    "implement",
    "build",
    "create",
    "add",
    "enable",
    "support",
    "improve",
    "fix",
    "design",
    "feature",
  ];
  const domainWords = [
    "telegram",
    "codex",
    "thread",
    "session",
    "plugin",
    "openclaw",
    "command",
    "approval",
    "router",
    "sqlite",
    "skill",
    "bind",
  ];
  for (const w of intentWords) if (lower.includes(w)) score += 3;
  for (const w of domainWords) if (lower.includes(w)) score += 2;

  if (lower.includes("goal")) score += 2;
  if (lower.startsWith("i want")) score += 2;
  if (lower.startsWith("can you")) score += 1;
  if (lower.includes("strict output format")) score -= 5;
  if (lower.includes("phase ")) score -= 3;
  if (lower.includes("<environment_context>")) score -= 8;
  if (/^\/[a-z_]+/.test(lower)) score -= 2;
  if (/[{}<>]{2,}/.test(line)) score -= 3;

  return score;
}

function cleanupTitle(line) {
  let out = String(line || "").trim();
  out = out.replace(/^i want (you )?(to )?/i, "");
  out = out.replace(/^can you\s+/i, "");
  out = out.replace(/^could you\s+/i, "");
  out = out.replace(/^please\s+/i, "");
  out = out.replace(/^let'?s\s+/i, "");
  out = out.replace(/^goal[:\s-]*/i, "");
  out = out.replace(/^feature[:\s-]*/i, "");
  out = out.replace(/[`*_#>-]+/g, " ");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function isTemplateOrBoilerplatePrompt(line) {
  const lower = String(line || "").trim().toLowerCase();
  if (!lower) return true;
  return (
    lower.startsWith("you are working locally in") ||
    lower.startsWith("you are working in the openclaw repo") ||
    lower.startsWith("you are codex using") ||
    lower.startsWith("warning: the maximum number of unified exec processes") ||
    lower.includes("<turn_aborted>") ||
    lower.includes("governing files") ||
    lower.includes("implementation task. you may modify files") ||
    lower.includes("this is not a small patch") ||
    lower.includes("mission") ||
    lower.includes("primary governing")
  );
}

function buildSemanticCorpus(prompts) {
  const input = Array.isArray(prompts) ? prompts : [];
  return input
    .flatMap((text) => splitCandidateLines(text))
    .map((line) => cleanupTitle(line))
    .filter((line) => line && !isBoilerplateLine(line) && !isTemplateOrBoilerplatePrompt(line))
    .join("\n")
    .toLowerCase();
}

function deriveSemanticLabelFromCorpus(prompts) {
  const corpus = buildSemanticCorpus(prompts);
  if (!corpus.trim()) return "";

  const has = (re) => re.test(corpus);
  const count = (re) => (corpus.match(re) || []).length;

  const hasCodex = has(/\bcodex\b|\/codex_/);
  const hasTelegram = has(/\btelegram\b/);
  const hasPlugin = has(/\bplugin|bridge|openclaw\b/);
  const hasIntegration = has(/\bintegrat|bind|attach|session|thread\b|\/codex_(bind|attach|sessions|run|thread)/);
  const hasCodexOps = has(/\/codex_(bind|attach|sessions|run|thread|model|reset|status|on|off)/);
  const hasWealthOps = has(/\bwealthops?\b/);
  const hasNews = has(/\bnews\b|signaldesk/);
  const hasBot = has(/\bbot\b/);

  const codexScore =
    count(/\bcodex\b|\/codex_/g) * 2 +
    count(/\btelegram\b/g) * 2 +
    count(/\bplugin\b|\bbridge\b|\bopenclaw\b/g) +
    count(/\bintegration\b|\bbind\b|\battach\b|\bsession\b|\bthread\b/g) +
    count(/\/codex_(bind|attach|sessions|run|thread|model|reset|status|on|off)/g) * 3;
  const wealthScore =
    count(/\bwealthops?\b/g) * 3 +
    count(/\bsignaldesk\b|\bnews\b/g) * 2 +
    count(/\bbot\b/g);

  const codexFacetLabels = [];
  if (has(/\b(session|thread|resume|reuse|attach|bind)\b|\/codex_(attach|sessions|run|bind|reset)\b/)) {
    codexFacetLabels.push("session management");
  }
  if (has(/\b(name|title|rename|auto[- ]?name)\b|\/codex_thread(name|ids|name_auto)\b/)) {
    codexFacetLabels.push("thread naming");
  }
  if (has(/\b(button|inline|picker|menu|tap|click)\b|\/codex_attach(?:_list)?\b/)) {
    codexFacetLabels.push("attach picker");
  }
  if (has(/\b(approval|approve|policy|risky|safety|gate)\b/)) {
    codexFacetLabels.push("approval gating");
  }
  if (has(/\b(route|routing|auto-route|skill)\b/)) {
    codexFacetLabels.push("routing");
  }

  const codexFacetText = codexFacetLabels.slice(0, 2).join(" + ");

  if (wealthScore >= 6 && wealthScore > codexScore + 2 && hasWealthOps && hasNews && hasBot) {
    return "WealthOps + News bot work";
  }
  if (wealthScore >= 6 && wealthScore > codexScore + 2 && hasWealthOps && hasNews) {
    return "WealthOps SignalDesk product hardening";
  }
  if (wealthScore >= 5 && wealthScore > codexScore + 1 && hasWealthOps && hasBot) {
    return "WealthOps bot work";
  }
  if (wealthScore >= 5 && wealthScore > codexScore + 1 && hasNews && hasBot) {
    return "News bot work";
  }
  if (codexScore >= 6 && codexScore >= wealthScore && hasCodex && hasTelegram && hasPlugin && hasIntegration && hasCodexOps) {
    if (codexFacetText) return `Codex Telegram integration plugin ${codexFacetText}`;
    return "Codex Telegram integration plugin";
  }
  if (codexScore >= 5 && codexScore >= wealthScore && hasCodex && hasTelegram && hasCodexOps) {
    if (codexFacetText) return `Codex Telegram integration ${codexFacetText}`;
    return "Codex Telegram integration";
  }
  return "";
}

function deriveThreadTitleFromPrompts(prompts, maxChars = 72) {
  const input = Array.isArray(prompts) ? prompts : [];
  const semantic = deriveSemanticLabelFromCorpus(input);
  if (semantic) return normalizeAutoThreadTitle(semantic);

  const candidates = [];
  const total = Math.max(1, input.length);
  for (let i = 0; i < input.length; i += 1) {
    const prompt = input[i];
    const earlyBias = Math.max(0, 3 - Math.floor((i / total) * 6)); // favor earlier prompts
    for (const line of splitCandidateLines(prompt)) {
      const cleaned = cleanupTitle(line);
      if (!cleaned) continue;
      let score = scoreCandidateLine(cleaned) + earlyBias;
      if (isMetaNamingPrompt(cleaned)) score -= 20;
      candidates.push({ line: cleaned, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates.find((c) => c.score > 1)?.line;
  const weaker = candidates.find((c) => c.score > -5 && !isLowSignalPrompt(c.line))?.line;
  const fallback = input
    .map((text) => extractHumanPromptPreview(text, maxChars))
    .find((name) => name && name !== "Unnamed session" && !isLowSignalPrompt(name));
  const final = best || weaker || fallback || "";
  if (!final) return "";
  const compact = final.length > maxChars ? `${final.slice(0, maxChars)}…` : final;
  return normalizeAutoThreadTitle(compact);
}

function extractThreadSummaryFromSession(filePath, maxChars = 72) {
  return extractThreadSummaryFromSessionFiles([filePath], maxChars);
}

function extractThreadSummaryFromSessionFiles(filePaths, maxChars = 72) {
  const files = Array.isArray(filePaths) ? filePaths : [];
  const userTexts = files.flatMap((file) => extractUserTextsFromSession(file));
  const assistantFeatureTexts = files
    .flatMap((file) => extractMessageTextsFromSession(file, "assistant"))
    .flatMap((text) => splitCandidateLines(text))
    .map((line) => cleanupTitle(line))
    .filter((line) => isLikelyFeatureSummaryLine(line));
  const weightedCorpus = userTexts.concat(assistantFeatureTexts, assistantFeatureTexts);
  const fromPrompts = deriveThreadTitleFromPrompts(weightedCorpus, maxChars);
  const fallback =
    files
      .map((file) => extractFirstUserPromptPreview(file, maxChars))
      .find((name) => name && name !== "Unnamed session" && !isLowSignalPrompt(name)) ||
    files.map((file) => extractFirstUserPromptPreview(file, maxChars)).find(Boolean) ||
    "Unnamed session";
  const final = fromPrompts || fallback || "Unnamed session";
  const compact = final.length > maxChars ? `${final.slice(0, maxChars)}…` : final;
  return normalizeAutoThreadTitle(compact);
}

function normalizeThreadName(rawName, maxChars = 80) {
  const oneLine = String(rawName || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine) return "";
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…` : oneLine;
}

function threadAliasKey(threadId) {
  return `thread_alias:${threadId}`;
}

function threadAutoTitleKey(threadId) {
  return `thread_auto_title:${threadId}`;
}

function shortenThreadId(threadId, maxChars = 16) {
  const text = String(threadId || "").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function buildAttachPickerReply({
  store,
  pluginConfig,
  bindingExists,
  page = 1,
  limit = 10,
}) {
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 10));
  const safePage = Math.max(1, Number(page) || 1);
  const { sessionsDir, rows } = listCliThreadIds(pluginConfig, 250);
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));
  const offset = (safePage - 1) * safeLimit;
  const sliced = rows.slice(offset, offset + safeLimit);

  const lines = [];
  lines.push(`Codex sessions dir: ${sessionsDir}`);
  lines.push(`Known sessions: page ${safePage}/${totalPages} (showing ${sliced.length} of ${total})`);
  if (!bindingExists) {
    lines.push("No binding found in this conversation. Attach will work after /codex_bind <absolute-path>.");
  }
  lines.push("");
  if (sliced.length === 0) {
    lines.push("- none yet");
    lines.push("Tip: run /codex_threadids to inspect local sessions.");
    return { text: lines.join("\n") };
  }

  const buttons = [];
  for (const row of sliced) {
    const displayName = normalizeThreadName(
      store.getEffectiveThreadName(row.threadId, row.defaultName || "Unnamed session"),
      48,
    );
    lines.push(`- ${row.threadId} | ${displayName}`);
    buttons.push([
      {
        text: `${displayName} (${shortenThreadId(row.threadId)})`,
        callback_data: `/codex_attach ${row.threadId}`,
      },
    ]);
  }

  lines.push("");
  lines.push("Tap a button to attach, or run:");
  lines.push("/codex_attach <threadId>");
  lines.push("/codex_attach page <n>");

  // Plugin command replies are ReplyPayload; Telegram buttons must be nested in channelData.
  return {
    text: lines.join("\n"),
    channelData: {
      telegram: { buttons },
    },
  };
}

function getPluginConfig(api) {
  return api?.pluginConfig || {};
}

export default function register(api) {
  const pluginConfig = getPluginConfig(api);
  const timeoutMs = Number(pluginConfig?.runTimeoutMs) || DEFAULT_TIMEOUT_MS;
  const stateDbPath = resolveStateDbPath(pluginConfig);
  let storePromise = null;
  let adapter = null;

  async function getStore() {
    if (!storePromise) {
      storePromise = SqliteStateStore.create(stateDbPath);
    }
    return await storePromise;
  }

  function getAdapter() {
    if (!adapter) {
      if (typeof pluginConfig?.adapterFactory === "function") {
        adapter = pluginConfig.adapterFactory();
      } else {
        adapter = new CodexSdkAdapter({
          timeoutMs,
          logger: api.logger,
          skipGitRepoCheck: normalizeBoolean(pluginConfig?.skipGitRepoCheck, true),
        });
      }
    }
    return adapter;
  }

  async function executeCodexRun({
    conversationKey,
    prompt,
    cwd,
    model,
    createIfMissing = true,
    requireBoundRepo = true,
    threadIdOverride = null,
    forceNewThread = false,
    onProgress,
  }) {
    const store = await getStore();
    const binding = store.getBinding(conversationKey);

    if (requireBoundRepo && !binding && !cwd) {
      throw new PluginError(
        "INVALID_REPO",
        `Conversation is not bound. Run /codex_bind <absolute-path> first. key=${conversationKey}`,
      );
    }
    if (binding && !binding.enabled) {
      throw new PluginError("DISABLED_IN_CONVERSATION", "Codex mode is disabled in this conversation");
    }

    const repoCandidate = cwd || binding?.repo_cwd;
    if (!repoCandidate) {
      throw new PluginError("INVALID_REPO", "No repo path available (bind the conversation or pass cwd)");
    }
    const repoCwd = ensureAbsoluteExistingDirectory(repoCandidate);
    assertAllowedRoot(repoCwd, pluginConfig);

    const effectiveModel = model || binding?.model || pluginConfig?.defaultModel || null;
    const runId = store.startRun({ conversationKey, prompt });
    const selectedThreadId = forceNewThread ? null : threadIdOverride || binding?.codex_thread_id || null;

    try {
      const result = await getAdapter().runTurn({
        threadId: selectedThreadId,
        prompt,
        cwd: repoCwd,
        model: effectiveModel,
        createIfMissing,
        onProgress,
      });
      if (binding) {
        store.finishRunSuccess({ runId, conversationKey, threadId: result.threadId });
      }
      return {
        ok: true,
        threadId: result.threadId || null,
        repoCwd,
        model: effectiveModel,
        text: result.text,
        durationMs: result.durationMs,
      };
    } catch (err) {
      const normalized = err instanceof PluginError ? err : new PluginError("RUN_FAILED", String(err), err);
      if (binding) {
        store.finishRunError({
          runId,
          conversationKey,
          errorCode: normalized.code,
          errorMessage: normalized.message,
        });
      }
      throw normalized;
    }
  }

  api.registerTool(
    {
      name: TOOL_NAME,
      description: "Run a prompt in a persistent Codex SDK thread bound to a Telegram conversation.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          conversation_key: { type: "string" },
          prompt: { type: "string" },
          cwd: { type: "string" },
          model: { type: "string" },
          create_if_missing: { type: "boolean", default: true },
          require_bound_repo: { type: "boolean", default: true },
        },
        required: ["conversation_key", "prompt"],
      },
      async execute(_id, params) {
        const result = await executeCodexRun({
          conversationKey: String(params.conversation_key),
          prompt: String(params.prompt || ""),
          cwd: params.cwd ? String(params.cwd) : undefined,
          model: params.model ? String(params.model) : undefined,
          createIfMissing: normalizeBoolean(params.create_if_missing, true),
          requireBoundRepo: normalizeBoolean(params.require_bound_repo, true),
        });
        return {
          content: [{ type: "text", text: stringify(result) }],
        };
      },
    },
    { optional: true },
  );

  api.registerCommand({
    name: "codex_bind",
    description: "Bind this conversation to a repo path",
    acceptsArgs: true,
    handler: async (ctx) => {
      const rawPath = String(ctx.args || "").trim();
      if (!rawPath) return { text: "Usage: /codex_bind <absolute-path>" };

      const repoCwd = ensureAbsoluteExistingDirectory(rawPath);
      assertAllowedRoot(repoCwd, pluginConfig);

      const conversationKey = buildConversationKey(ctx);
      const store = await getStore();
      const existing = store.getBinding(conversationKey);
      if (!existing) {
        store.createOrUpdateBinding({
          conversationKey,
          repoCwd,
          model: pluginConfig?.defaultModel || null,
          enabled: 1,
          autoRoute: 1,
          codexThreadId: null,
        });
      } else {
        const repoChanged = path.resolve(existing.repo_cwd) !== path.resolve(repoCwd);
        store.setRepoAndOptionalThread(conversationKey, repoCwd, repoChanged ? null : existing.codex_thread_id);
      }

      const updated = store.getBinding(conversationKey);
      return {
        text: [
          `Codex is now bound to:\n${updated.repo_cwd}`,
          "",
          `Auto-routing: ${updated.auto_route ? "on" : "off"}`,
          `Persistent thread: ${updated.codex_thread_id || "not created yet"}`,
        ].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "codex_threadname_auto",
    description: "Auto-assign short names for discovered Codex thread IDs",
    acceptsArgs: true,
    handler: async (ctx) => {
      const store = await getStore();
      const parsed = parseThreadNameAutoArgs(ctx.args);
      if (parsed.invalid) {
        return {
          text: [
            "Usage:",
            "/codex_threadname_auto",
            "/codex_threadname_auto all",
            "/codex_threadname_auto 50",
            "/codex_threadname_auto all force",
            "/codex_threadname_auto limit 100 force",
          ].join("\n"),
        };
      }

      const limit = Math.max(1, Math.min(200, parsed.limit || 30));
      const { rows } = listCliThreadIds(pluginConfig, limit);
      let updated = 0;
      let skipped = 0;
      for (const row of rows) {
        const key = threadAliasKey(row.threadId);
        const existing = store.getSetting(key);
        if (existing && !parsed.force) {
          skipped += 1;
          continue;
        }
        const candidate = normalizeThreadName(row.defaultName || "Unnamed session");
        if (!candidate || candidate === "Unnamed session") {
          skipped += 1;
          continue;
        }
        store.setSetting(key, candidate);
        updated += 1;
      }
      return {
        text: [
          `Auto naming completed.`,
          `Updated: ${updated}`,
          `Skipped: ${skipped}`,
          `Total considered: ${rows.length}`,
          "",
          "See results with: /codex_threadids",
        ].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "codex_status",
    description: "Show Codex binding/thread status for this conversation",
    handler: async (ctx) => {
      const store = await getStore();
      const conversationKey = buildConversationKey(ctx);
      return { text: formatStatus(store.getBinding(conversationKey), conversationKey) };
    },
  });

  api.registerCommand({
    name: "codex_reset",
    description: "Reset Codex thread for this conversation (keep repo binding)",
    handler: async (ctx) => {
      const store = await getStore();
      const conversationKey = buildConversationKey(ctx);
      if (!store.getBinding(conversationKey)) {
        return { text: "No binding found for this conversation." };
      }
      store.resetThread(conversationKey);
      return { text: "Codex thread reset. Repo binding is preserved." };
    },
  });

  api.registerCommand({
    name: "codex_unbind",
    description: "Remove Codex binding for this conversation",
    handler: async (ctx) => {
      const store = await getStore();
      const conversationKey = buildConversationKey(ctx);
      const removed = store.unbind(conversationKey);
      if (!removed) return { text: "No binding found for this conversation." };
      return { text: "Codex binding removed for this conversation." };
    },
  });

  api.registerCommand({
    name: "codex_on",
    description: "Enable Codex mode for this conversation",
    handler: async (ctx) => {
      const store = await getStore();
      const conversationKey = buildConversationKey(ctx);
      if (!store.getBinding(conversationKey)) {
        return { text: "No binding found. Run /codex_bind <absolute-path> first." };
      }
      store.setEnabled(conversationKey, true);
      return { text: "Codex mode enabled for this conversation." };
    },
  });

  api.registerCommand({
    name: "codex_off",
    description: "Disable Codex mode for this conversation",
    handler: async (ctx) => {
      const store = await getStore();
      const conversationKey = buildConversationKey(ctx);
      if (!store.getBinding(conversationKey)) {
        return { text: "No binding found. Run /codex_bind <absolute-path> first." };
      }
      store.setEnabled(conversationKey, false);
      return { text: "Codex mode disabled for this conversation." };
    },
  });

  api.registerCommand({
    name: "codex_model",
    description: "Set preferred model for this conversation",
    acceptsArgs: true,
    handler: async (ctx) => {
      const model = String(ctx.args || "").trim();
      if (!model) return { text: "Usage: /codex_model <model>" };

      const store = await getStore();
      const conversationKey = buildConversationKey(ctx);
      if (!store.getBinding(conversationKey)) {
        return { text: "No binding found. Run /codex_bind <absolute-path> first." };
      }
      store.setModel(conversationKey, model);
      return { text: `Model set for this conversation: ${model}` };
    },
  });

  api.registerCommand({
    name: "codex_attach",
    description: "Attach this conversation to an existing Codex thread ID",
    acceptsArgs: true,
    handler: async (ctx) => {
      const store = await getStore();
      const conversationKey = buildConversationKey(ctx);
      const binding = store.getBinding(conversationKey);
      const parsed = parseAttachArgs(ctx.args);

      if (parsed.mode === "picker") {
        return buildAttachPickerReply({
          store,
          pluginConfig,
          bindingExists: Boolean(binding),
          page: parsed.page,
          limit: parsed.limit,
        });
      }

      const threadId = String(parsed.threadId || "").trim();
      if (!threadId) {
        return {
          text: [
            "Usage:",
            "/codex_attach",
            "/codex_attach <threadId>",
            "/codex_attach page <n>",
          ].join("\n"),
        };
      }

      if (!binding) {
        return { text: "No binding found. Run /codex_bind <absolute-path> first." };
      }
      store.attachThread(conversationKey, threadId);
      return { text: `Attached conversation to thread: ${threadId}` };
    },
  });

  api.registerCommand({
    name: "codex_attach_list",
    description: "Show clickable Codex session picker for attachment",
    acceptsArgs: true,
    handler: async (ctx) => {
      const store = await getStore();
      const conversationKey = buildConversationKey(ctx);
      const binding = store.getBinding(conversationKey);
      const parsed = parseAttachArgs(ctx.args);
      const reply = buildAttachPickerReply({
        store,
        pluginConfig,
        bindingExists: Boolean(binding),
        page: parsed.page,
        limit: parsed.limit,
      });
      return reply;
    },
  });

  api.registerCommand({
    name: "codex_threadids",
    description: "List Codex CLI thread IDs discoverable on this host",
    acceptsArgs: true,
    handler: async (ctx) => {
      const store = await getStore();
      const parsed = parseThreadIdsArgs(ctx.args);
      if (parsed.invalid) {
        return {
          text: ["Usage:", "/codex_threadids", "/codex_threadids 30", "/codex_threadids limit 50"].join(
            "\n",
          ),
        };
      }

      const limit = Math.max(1, Math.min(200, parsed.limit || 20));
      const { sessionsDir, rows } = listCliThreadIds(pluginConfig, limit);

      const lines = [];
      lines.push(`Codex sessions dir: ${sessionsDir}`);
      lines.push(`Found: ${rows.length}`);
      lines.push("");
      if (rows.length === 0) {
        lines.push("- none found");
      } else {
        for (const row of rows) {
          store.recomputeThreadAutoTitle(row.threadId, row.defaultName || "Unnamed session");
          const when = row.timestamp || "unknown-time";
          const cwd = row.cwd || "unknown-cwd";
          const displayName = store.getEffectiveThreadName(row.threadId, row.defaultName || "Unnamed session");
          lines.push(`- ${row.threadId} | ${displayName} | ${when} | ${cwd}`);
        }
      }
      lines.push("");
      lines.push("Attach one: /codex_attach <threadId>");
      lines.push("Rename: /codex_threadname <threadId> <name>");
      return { text: lines.join("\n") };
    },
  });

  api.registerCommand({
    name: "codex_threadname",
    description: "Set or reset a custom display name for a Codex thread ID",
    acceptsArgs: true,
    handler: async (ctx) => {
      const parsed = parseThreadNameArgs(ctx.args);
      if (parsed.invalid) {
        return {
          text: [
            "Usage:",
            "/codex_threadname <threadId> <name>",
            "/codex_threadname <threadId> default",
          ].join("\n"),
        };
      }

      const store = await getStore();
      const { threadId } = parsed;
      const desired = normalizeThreadName(parsed.name);
      if (!desired) {
        return { text: "Name cannot be empty." };
      }

      const key = threadAliasKey(threadId);
      if (desired.toLowerCase() === "default" || desired.toLowerCase() === "reset") {
        store.deleteSetting(key);
        return { text: `Thread name reset to default preview for: ${threadId}` };
      }

      store.setSetting(key, desired);
      return { text: `Thread name updated for ${threadId}: ${desired}` };
    },
  });

  api.registerCommand({
    name: "codex_threadname_current",
    description: "Set a custom display name for the currently attached thread",
    acceptsArgs: true,
    handler: async (ctx) => {
      const desired = normalizeThreadName(String(ctx.args || ""));
      if (!desired) {
        return { text: "Usage: /codex_threadname_current <name>" };
      }

      const store = await getStore();
      const conversationKey = buildConversationKey(ctx);
      const binding = store.getBinding(conversationKey);
      if (!binding) {
        return { text: "No binding found. Run /codex_bind <absolute-path> first." };
      }
      if (!binding.codex_thread_id) {
        return { text: "No current thread attached in this conversation." };
      }

      const threadId = String(binding.codex_thread_id);
      if (desired.toLowerCase() === "auto") {
        const { rows } = listCliThreadIds(pluginConfig, 500);
        const row = rows.find((r) => r.threadId === threadId);
        const auto =
          store.recomputeThreadAutoTitle(threadId, row?.defaultName || "Unnamed session") ||
          normalizeLowSignalTitle(row?.defaultName || "Unnamed session");
        if (auto) {
          store.setSetting(threadAutoTitleKey(threadId), auto);
          return { text: `Auto title recomputed for current thread ${threadId}: ${auto}` };
        }
        return { text: `No auto title could be computed for current thread ${threadId}.` };
      }

      store.setSetting(threadAliasKey(threadId), desired);
      return { text: `Thread name updated for current thread ${threadId}: ${desired}` };
    },
  });

  api.registerCommand({
    name: "codex_threadname_recompute",
    description: "Recompute auto titles for discovered thread IDs",
    acceptsArgs: true,
    handler: async (ctx) => {
      const raw = String(ctx.args || "").trim().toLowerCase();
      const force = /\bforce\b/.test(raw);
      const all = raw.includes("all");
      const limitMatch = raw.match(/\blimit\s+(\d+)\b/);
      const limit = all ? 500 : Math.max(1, Math.min(500, Number(limitMatch?.[1] || 100)));

      const store = await getStore();
      const { rows } = listCliThreadIds(pluginConfig, limit);
      let updated = 0;
      let skippedManual = 0;
      let unresolved = 0;

      for (const row of rows) {
        const manual = store.getSetting(threadAliasKey(row.threadId));
        if (manual && !force) {
          skippedManual += 1;
          continue;
        }
        if (manual && force) {
          store.deleteSetting(threadAliasKey(row.threadId));
        }
        const computed =
          store.recomputeThreadAutoTitle(row.threadId, row.defaultName || "Unnamed session") ||
          normalizeLowSignalTitle(row.defaultName || "Unnamed session");
        if (!computed) {
          unresolved += 1;
          continue;
        }
        store.setSetting(threadAutoTitleKey(row.threadId), computed);
        updated += 1;
      }

      return {
        text: [
          "Thread title recompute completed.",
          `Rows considered: ${rows.length}`,
          `Updated auto titles: ${updated}`,
          `Skipped manual aliases: ${skippedManual}`,
          `Unresolved: ${unresolved}`,
          "",
          "Inspect: /codex_threadids",
        ].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "codex_sessions",
    description: "List known Codex thread IDs for this conversation",
    acceptsArgs: true,
    handler: async (ctx) => {
      const store = await getStore();
      const conversationKey = buildConversationKey(ctx);
      const binding = store.getBinding(conversationKey);
      const rawArgs = String(ctx.args || "").trim();
      const forceGlobal = /\bglobal\b/i.test(rawArgs);
      const cleanedArgs = rawArgs.replace(/\bglobal\b/gi, "").trim();
      const scope = forceGlobal || !binding ? "global" : "conversation";

      const parsed = parseSessionsArgs(cleanedArgs);
      if (parsed.mode === "invalid") {
        return {
          text: [
            "Usage:",
            "/codex_sessions",
            "/codex_sessions global",
            "/codex_sessions all",
            "/codex_sessions page <n>",
            "/codex_sessions page <n> limit <m>",
            "/codex_sessions limit <m>",
            "/codex_sessions global all",
          ].join("\n"),
        };
      }

      const limit = Math.max(1, Math.min(50, parsed.limit || 10));
      const page = Math.max(1, parsed.page || 1);
      const offset = parsed.mode === "all" ? 0 : (page - 1) * limit;
      const total =
        scope === "global"
          ? store.countThreadsGlobal()
          : store.countThreadsForConversation(conversationKey);
      const rows = (() => {
        if (scope === "global") {
          return parsed.mode === "all"
            ? store.listThreadsGlobal(100, 0)
            : store.listThreadsGlobal(limit, offset);
        }
        return parsed.mode === "all"
          ? store.listThreadsForConversation(conversationKey, 50, 0)
          : store.listThreadsForConversation(conversationKey, limit, offset);
      })();
      const discoveredMap = new Map(
        listCliThreadIds(pluginConfig, 500).rows.map((r) => [r.threadId, r.defaultName || "Unnamed session"]),
      );

      const lines = [];
      lines.push(`Scope: ${scope}`);
      if (binding) {
        lines.push(`Current thread: ${binding.codex_thread_id || "none"}`);
      } else {
        lines.push("Current thread: none (conversation not bound)");
      }
      lines.push("");
      if (parsed.mode === "all") {
        lines.push(`Known sessions: showing all ${rows.length} of ${total}`);
      } else {
        const totalPages = Math.max(1, Math.ceil(total / limit));
        lines.push(`Known sessions: page ${page}/${totalPages} (showing ${rows.length} of ${total})`);
      }
      if (rows.length === 0) {
        lines.push("- none yet");
      } else {
        for (const row of rows) {
          const fallbackName = discoveredMap.get(row.thread_id) || "Unnamed session";
          store.recomputeThreadAutoTitle(row.thread_id, fallbackName);
          const displayName = store.getEffectiveThreadName(row.thread_id, fallbackName);
          if (scope === "global") {
            lines.push(
              `- ${row.thread_id} | ${displayName} (last: ${row.last_at || "unknown"}, key: ${row.conversation_key})`,
            );
          } else {
            lines.push(`- ${row.thread_id} | ${displayName} (last: ${row.last_at || "unknown"})`);
          }
        }
      }
      lines.push("");
      lines.push("Use: /codex_attach <threadId>");
      lines.push("Run new: /codex_run new <task>");
      lines.push("Run on existing: /codex_run use <threadId> <task>");
      lines.push("More: /codex_sessions page <n>  |  /codex_sessions all  |  /codex_sessions global");
      return { text: lines.join("\n") };
    },
  });

  api.registerCommand({
    name: "codex_run",
    description: "Run a one-turn Codex task (default/current, new, or explicit thread)",
    acceptsArgs: true,
    handler: async (ctx) => {
      const parsed = parseRunArgs(ctx.args);
      const prompt = parsed.prompt;
      if (parsed.mode === "use" && !String(parsed.threadId || "").trim()) {
        return { text: "Usage: /codex_run use <threadId> <task>" };
      }
      if (!prompt) {
        return {
          text: [
            "Usage:",
            "/codex_run <task>",
            "/codex_run new <task>",
            "/codex_run use <threadId> <task>",
          ].join("\n"),
        };
      }

      const conversationKey = buildConversationKey(ctx);
      const runId = crypto.randomUUID().slice(0, 8);
      await sendTelegramProgress(
        api,
        ctx,
        `⏳ Codex run started (${runId})\nMode: ${parsed.mode}\nI will post the final result here.`,
      );
      let lastProgressAt = 0;
      const minProgressIntervalMs = 2500;
      try {
        const result = await executeCodexRun({
          conversationKey,
          prompt,
          createIfMissing: true,
          requireBoundRepo: true,
          forceNewThread: parsed.mode === "new",
          threadIdOverride: parsed.mode === "use" ? parsed.threadId : null,
          onProgress: async (text) => {
            const now = Date.now();
            if (!text) return;
            if (now - lastProgressAt < minProgressIntervalMs && !/completed|failed/i.test(text)) return;
            lastProgressAt = now;
            await sendTelegramProgress(api, ctx, `⏱ ${text} (${runId})`);
          },
        });
        return { text: `run: ${runId}\n${summarizeRunForReply(result)}` };
      } catch (err) {
        const code = err?.code || "RUN_FAILED";
        const message = err?.message || String(err);
        return { text: `Codex run ${runId} failed (${code}): ${message}` };
      }
    },
  });

  api.on("before_tool_call", async (event) => {
    if (event.toolName !== TOOL_NAME) return;

    const ctxHint = {
      channel: event?.context?.channel || event?.channel,
      to: event?.context?.to || event?.to,
      from: event?.context?.from || event?.from,
      accountId: event?.context?.accountId || event?.accountId,
      messageThreadId: event?.context?.messageThreadId || event?.messageThreadId,
    };
    await sendTelegramProgress(
      api,
      ctxHint,
      "⏳ Codex task started from auto-route/tool call. I will send the final result when done.",
    );

    if (!isApprovalEnabled(pluginConfig)) return;
    if (!requiresApproval(String(event.params?.prompt || ""), pluginConfig)) return;
    return {
      block: true,
      blockReason:
        "Approval required by codex-bridge policy for risky Codex prompt. Disable approval or adjust risk heuristics in plugins.entries.codex-bridge.config.approval.",
    };
  });
}
