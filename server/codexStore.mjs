import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getStateDir } from "./state.mjs";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SESSION_INDEX = path.join(CODEX_HOME, "session_index.jsonl");
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const APP_STATE_DIR = getStateDir();
const OUTBOX_DIR = path.join(APP_STATE_DIR, "outbox");
const JOBS_DIR = path.join(APP_STATE_DIR, "jobs");

const MAX_PREVIEW_CHARS = 320;
const DEFAULT_DETAIL_ITEMS = 120;
const MAX_DETAIL_ITEMS = 300;
const MAX_SESSION_LIMIT = 120;
const MAX_GIT_CHANGE_FILES = 20;
const GIT_CHANGES_CACHE_TTL_MS = 1500;
const JSON_ESCAPED_PROMPT_MARKER_PATTERN = /JSON[_ ]ESCAPED[_ ]PROMPT:/i;
const JSON_ESCAPED_PROMPT_PREFIX = "The exact task prompt is encoded below as a JSON string with Unicode escapes.";
const parseCache = new Map();
const gitChangesCache = new Map();

export function getCodexHome() {
  return CODEX_HOME;
}

export function getWatchedPaths() {
  return [SESSION_INDEX, SESSIONS_DIR];
}

export function ensureStateDirs() {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  fs.mkdirSync(JOBS_DIR, { recursive: true });
}

export function listSessions(options = {}) {
  const limit = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.offset);
  const summaries = sortedSessionSummaries();
  const page = limit ? summaries.slice(offset, offset + limit) : summaries.slice(offset);
  const sessions = page.map((summary) => hydrateSessionSummary(summary));
  sessions.total = summaries.length;
  sessions.hasMore = limit ? offset + sessions.length < summaries.length : false;
  sessions.nextOffset = offset + sessions.length;
  return sessions;
}

export function listSessionPage(options = {}) {
  const sessions = listSessions(options);
  return {
    sessions,
    total: sessions.total || sessions.length,
    hasMore: Boolean(sessions.hasMore),
    nextOffset: sessions.nextOffset || sessions.length
  };
}

export function getSessionDetail(id, options = {}) {
  const summary = sortedSessionSummaries().find((item) => item.id === id);
  if (!summary?.path) return summary ? hydrateSessionSummary(summary) : null;
  const parsed = parseSessionFile(summary.path, {
    detail: true,
    maxDetailItems: normalizeDetailLimit(options.limit)
  });
  const outbox = readOutbox(id);
  const pendingAction = visiblePendingAction(parsed.pendingAction, outbox) || pendingActionFromJobs(outbox);
  const cwd = parsed.cwd || summary.cwd;
  return {
    ...summary,
    ...parsed,
    title: readableTitle(summary.title, parsed),
    isSubagent: parsed.threadSource === "subagent",
    status: parsed.status === "waiting" && !pendingAction ? "idle" : parsed.status,
    pendingAction,
    outbox,
    gitChanges: patchChangesForCwd(cwd, parsed.patchChanges)
      || gitChangesForCwd(cwd)
      || gitCommittedChangesForCwd(cwd, parsed.commitHash)
  };
}

function sortedSessionSummaries() {
  const index = readSessionIndex();
  const files = indexSessionFiles();
  const summaries = new Map();

  for (const row of index) {
    if (!row?.id) continue;
    const filePath = files.get(row.id) || null;
    const fileUpdatedAt = filePath ? safeStat(filePath)?.mtime?.toISOString() : null;
    summaries.set(row.id, {
      id: row.id,
      title: row.thread_name || "Untitled session",
      updatedAt: latestIsoDate(row.updated_at, fileUpdatedAt),
      path: filePath
    });
  }

  for (const [id, filePath] of files) {
    if (!summaries.has(id)) {
      summaries.set(id, {
        id,
        title: titleFromFile(filePath),
        updatedAt: safeStat(filePath)?.mtime?.toISOString(),
        path: filePath
      });
    }
  }

  return [...summaries.values()]
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

function latestIsoDate(...values) {
  return values
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0];
}

function hydrateSessionSummary(summary) {
  const parsed = summary.path ? parseSessionFile(summary.path, { detail: false }) : null;
  const outbox = readOutbox(summary.id);
  const pendingAction = visiblePendingAction(parsed?.pendingAction, outbox) || pendingActionFromJobs(outbox);
  return {
    ...summary,
    title: readableTitle(summary.title, parsed),
    cwd: parsed?.cwd,
    model: parsed?.model,
    reasoning: parsed?.reasoning,
    threadSource: parsed?.threadSource || "user",
    parentThreadId: parsed?.parentThreadId || "",
    agentNickname: parsed?.agentNickname || "",
    isSubagent: parsed?.threadSource === "subagent",
    status: parsed?.status === "waiting" && !pendingAction ? "idle" : parsed?.status || "idle",
    progress: parsed?.progress || [],
    pendingAction,
    lastOutput: parsed?.lastOutput || "",
    messageCount: parsed?.messageCount || 0,
    toolCount: parsed?.toolCount || 0,
    updatedAt: parsed?.updatedAt || summary.updatedAt
  };
}

export function enqueueRemoteMessage(sessionId, message, options = {}) {
  ensureStateDirs();
  const record = {
    id: cryptoId(),
    sessionId,
    message,
    options,
    status: "queued",
    createdAt: new Date().toISOString()
  };
  fs.appendFileSync(path.join(OUTBOX_DIR, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export function appendBridgeJob(sessionId, record) {
  ensureStateDirs();
  fs.appendFileSync(path.join(JOBS_DIR, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
}

export function resolveAction(sessionId, actionId, decision, options = {}) {
  ensureStateDirs();
  const normalized = normalizeDecisionRecord(decision);
  const record = {
    id: cryptoId(),
    sessionId,
    actionId,
    decision: normalized.decision,
    ...(normalized.answers ? { answers: normalized.answers } : {}),
    ...(normalized.scope ? { scope: normalized.scope } : {}),
    status: options.status || "queued",
    createdAt: new Date().toISOString()
  };
  fs.appendFileSync(path.join(OUTBOX_DIR, `${sessionId}.actions.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

function readSessionIndex() {
  if (!fs.existsSync(SESSION_INDEX)) return [];
  return readJsonl(SESSION_INDEX);
}

function indexSessionFiles() {
  const files = new Map();
  for (const filePath of walkJsonl(SESSIONS_DIR)) {
    const id = idFromRolloutName(filePath);
    if (!id) continue;
    const current = files.get(id);
    if (!current || (safeStat(filePath)?.mtimeMs || 0) > (safeStat(current)?.mtimeMs || 0)) {
      files.set(id, filePath);
    }
  }
  return files;
}

function parseSessionFile(filePath, { detail, maxDetailItems = DEFAULT_DETAIL_ITEMS }) {
  const stat = safeStat(filePath);
  const cacheKey = `${filePath}|${stat?.mtimeMs || 0}|${detail ? maxDetailItems : 0}`;
  const cached = parseCache.get(cacheKey);
  if (cached) return cached;

  const rows = readJsonl(filePath);
  const timeline = [];
  const progress = [];
  const stats = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let id = idFromRolloutName(filePath);
  let cwd = "";
  let model = "";
  let reasoning = "";
  let threadSource = "user";
  let parentThreadId = "";
  let agentNickname = "";
  let status = "idle";
  let pendingAction = null;
  let lastOutput = "";
  let commitHash = "";
  let patchChanges = null;
  let messageCount = 0;
  let toolCount = 0;
  let updatedAt = stat?.mtime?.toISOString();

  for (const row of rows) {
    updatedAt = row.timestamp || updatedAt;
    if (row.type === "session_meta") {
      id = row.payload?.id || id;
      cwd = row.payload?.cwd || cwd;
      model = row.payload?.model || model;
      threadSource = row.payload?.thread_source || threadSource;
      parentThreadId = row.payload?.source?.subagent?.thread_spawn?.parent_thread_id
        || row.payload?.forked_from_id
        || parentThreadId;
      agentNickname = row.payload?.agent_nickname
        || row.payload?.source?.subagent?.thread_spawn?.agent_nickname
        || agentNickname;
      continue;
    }

    if (row.type === "turn_context") {
      model = row.payload?.model || model;
      reasoning = row.payload?.effort || row.payload?.collaboration_mode?.settings?.reasoning_effort || reasoning;
      continue;
    }

    if (row.type === "event_msg") {
      const eventType = row.payload?.type;
      if (eventType === "task_started") status = "running";
      if (["task_complete", "task_completed", "turn_complete", "task_stopped"].includes(eventType)) {
        status = "idle";
        pendingAction = null;
      }
      if (eventType === "token_count") {
        const usage = row.payload?.info?.total_token_usage || row.payload?.info?.last_token_usage;
        if (usage) {
          stats.inputTokens = usage.input_tokens || stats.inputTokens;
          stats.outputTokens = usage.output_tokens || stats.outputTokens;
          stats.totalTokens = usage.total_tokens || stats.totalTokens;
        }
      }
      if (eventType === "patch_apply_end" && row.payload?.success) {
        patchChanges = mergePatchChanges(patchChanges, row.payload);
      }
      if (eventType && eventType !== "token_count") {
        progress.push({ type: eventType, at: row.timestamp });
      }
      continue;
    }

    if (row.type !== "response_item") continue;
    const item = row.payload;

    if (item?.type === "message") {
      if (["developer", "system"].includes(item.role)) continue;
      const text = normalizeDisplayText(flattenContent(item.content));
      if (text) {
        messageCount += 1;
        lastOutput = item.role === "assistant" ? text : lastOutput || text;
        if (item.role === "assistant") commitHash = commitHashFromText(text) || commitHash;
        pushTimeline(timeline, detail, {
          id: item.id || `${timeline.length}`,
          kind: "message",
          role: item.role || "assistant",
          title: roleTitle(item.role),
          text: truncateForDetail(text, detail),
          at: row.timestamp
        });
      }
    }

    if (["function_call", "tool_call"].includes(item?.type)) {
      toolCount += 1;
      const name = item.name || item.call?.name || "tool";
      if (isUserDecisionTool(name)) {
        const args = parseArgs(item.arguments || item.call?.arguments);
        status = "waiting";
        pendingAction = {
          id: item.call_id || item.id || `${timeline.length}`,
          title: decisionTitle(name),
          kind: name === "request_user_input" ? "input" : "approval",
          questions: args?.questions || [],
          detail: prettyArgs(args || item.arguments || item.call?.arguments)
        };
      }
      pushTimeline(timeline, detail, {
        id: item.call_id || item.id || `${timeline.length}`,
        kind: "tool",
        role: "tool",
        title: name,
        text: summarizeToolCall(name, item.arguments || item.call?.arguments),
        at: row.timestamp
      });
    }

    if (item?.type === "function_call_output") {
      const output = String(item.output || "").trim();
      if (output) {
        pushTimeline(timeline, detail, {
          id: item.call_id || `${timeline.length}`,
          kind: "tool-output",
          role: "tool",
          title: "Tool output",
          text: truncateForDetail(output, detail),
          at: row.timestamp
        });
      }
    }
  }

  const compactedTimeline = detail ? compactTimeline(timeline, status) : undefined;
  const parsed = {
    id,
    cwd,
    model,
    reasoning,
    threadSource,
    parentThreadId,
    agentNickname,
    status,
    progress: progress.slice(-5),
    pendingAction,
    commitHash,
    patchChanges,
    lastOutput: clip(lastOutput, MAX_PREVIEW_CHARS),
    messageCount,
    toolCount,
    updatedAt,
    stats,
    timeline: detail ? compactedTimeline.slice(-maxDetailItems) : undefined,
    timelineTotal: detail ? compactedTimeline.length : undefined,
    timelineHasMore: detail ? compactedTimeline.length > maxDetailItems : undefined
  };
  rememberParse(cacheKey, parsed);
  return parsed;
}

function readOutbox(sessionId) {
  const files = [
    path.join(OUTBOX_DIR, `${sessionId}.jsonl`),
    path.join(OUTBOX_DIR, `${sessionId}.actions.jsonl`),
    path.join(JOBS_DIR, `${sessionId}.jsonl`)
  ];
  return files
    .flatMap((file) => (fs.existsSync(file) ? readJsonl(file) : []))
    .sort((a, b) => recordTime(a) - recordTime(b));
}

function recordTime(record) {
  const value = record?.createdAt || record?.at || record?.startedAt || record?.finishedAt;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function pendingActionFromJobs(records) {
  const resolved = new Set(records.map((record) => record.actionId).filter(Boolean));
  const latest = new Map();
  for (const record of records) {
    const key = record.serverRequestId || record.actionId || record.id;
    if (key) latest.set(key, record);
  }
  for (const record of [...latest.values()].reverse()) {
    if (resolved.has(record.serverRequestId || record.id)) continue;
    if (!["needs_approval", "needs_input", "needs_response"].includes(record.status)) continue;
    return {
      id: record.serverRequestId || record.id,
      title: record.status === "needs_input" ? "User input required" : "Approval required",
      kind: record.status === "needs_input" ? "input" : "approval",
      method: record.method,
      questions: record.params?.questions || [],
      detail: prettyArgs({
        method: record.method,
        params: record.params
      })
    };
  }
  return null;
}

function visiblePendingAction(action, records) {
  if (!action?.id) return null;
  const resolved = records.some((record) => record.actionId === action.id);
  return resolved ? null : action;
}

function readJsonl(filePath) {
  try {
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function compactTimeline(timeline, status) {
  const compacted = [];
  let group = null;

  function flushGroup(isFinal = false) {
    if (!group) return;
    const commandCount = group.items.filter((item) => item.kind === "tool").length;
    const lastTool = [...group.items].reverse().find((item) => item.kind === "tool");
    compacted.push({
      id: group.id,
      kind: "tool-group",
      role: "tool",
      title: isFinal && status === "running" ? `正在运行 ${lastTool?.title || "工具"}` : `已运行 ${commandCount} 条命令`,
      text: clip(group.items.map((item) => `${item.title}: ${collapseWhitespace(item.text)}`).join("\n"), MAX_PREVIEW_CHARS),
      at: group.at,
      commandCount,
      items: group.items
    });
    group = null;
  }

  for (const item of timeline) {
    if (["tool", "tool-output"].includes(item.kind)) {
      if (!group) {
        group = {
          id: `tool-group-${item.id || compacted.length}`,
          at: item.at,
          items: []
        };
      }
      group.at = item.at || group.at;
      group.items.push(item);
      continue;
    }
    flushGroup(false);
    compacted.push(item);
  }
  flushGroup(true);
  return compacted;
}

function mergePatchChanges(current, payload) {
  const turnId = payload?.turn_id || "";
  const files = current?.turnId === turnId ? new Map(current.files.map((file) => [file.path, { ...file }])) : new Map();
  for (const [filePath, change] of Object.entries(payload?.changes || {})) {
    const stats = diffLineStats(change?.unified_diff || "");
    if (!stats.additions && !stats.deletions) continue;
    const normalized = normalizeChangePath(filePath);
    if (!normalized) continue;
    const existing = files.get(normalized) || {
      path: normalized,
      additions: 0,
      deletions: 0,
      status: change?.type || "modified"
    };
    existing.additions += stats.additions;
    existing.deletions += stats.deletions;
    existing.status = change?.type || existing.status;
    files.set(normalized, existing);
  }
  if (!files.size) return current;
  return {
    source: "codex-patch",
    turnId,
    files: [...files.values()]
  };
}

function patchChangesForCwd(cwd, patchChanges) {
  const files = patchChanges?.files || [];
  if (!files.length) return null;
  const gitRoot = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  const root = gitRoot || cwd;
  const rootCandidates = [gitRoot, cwd].filter(Boolean);
  const normalizedFiles = files
    .map((file) => ({
      ...file,
      path: normalizeChangePath(file.path, rootCandidates)
    }))
    .filter((file) => file.path);
  if (!normalizedFiles.length) return null;
  const additions = normalizedFiles.reduce((total, file) => total + (file.additions || 0), 0);
  const deletions = normalizedFiles.reduce((total, file) => total + (file.deletions || 0), 0);
  return {
    source: patchChanges.source || "codex-patch",
    root,
    totalFiles: normalizedFiles.length,
    additions,
    deletions,
    files: normalizedFiles.slice(0, MAX_GIT_CHANGE_FILES),
    hasMore: normalizedFiles.length > MAX_GIT_CHANGE_FILES
  };
}

function gitChangesForCwd(cwd) {
  const cacheKey = `working|${String(cwd || "")}`;
  const cached = gitChangesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < GIT_CHANGES_CACHE_TTL_MS) return cached.value;
  const repoRoot = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) return rememberGitChanges(cacheKey, null);
  const status = gitStatusMap(repoRoot);
  const files = [];
  let additions = 0;
  let deletions = 0;

  for (const line of gitOutput(repoRoot, ["diff", "--numstat", "HEAD", "--"]).split(/\r?\n/).filter(Boolean)) {
    const [added, deleted, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    if (!filePath) continue;
    const normalized = normalizeGitPath(filePath);
    const addedCount = parseGitCount(added);
    const deletedCount = parseGitCount(deleted);
    additions += addedCount || 0;
    deletions += deletedCount || 0;
    files.push({
      path: normalized,
      additions: addedCount,
      deletions: deletedCount,
      status: status.get(normalized) || "modified"
    });
  }

  for (const [filePath, fileStatus] of status) {
    if (fileStatus !== "untracked" || files.some((file) => file.path === filePath)) continue;
    const addedCount = countTextLines(path.join(repoRoot, filePath));
    additions += addedCount || 0;
    files.push({
      path: filePath,
      additions: addedCount,
      deletions: 0,
      status: "untracked"
    });
  }

  if (!files.length) return rememberGitChanges(cacheKey, null);
  return rememberGitChanges(cacheKey, {
    source: "working-tree",
    root: repoRoot,
    totalFiles: files.length,
    additions,
    deletions,
    files: files.slice(0, MAX_GIT_CHANGE_FILES),
    hasMore: files.length > MAX_GIT_CHANGE_FILES
  });
}

function gitCommittedChangesForCwd(cwd, commitHash) {
  const normalizedHash = normalizeCommitHash(commitHash);
  if (!normalizedHash) return null;
  const cacheKey = `commit|${String(cwd || "")}|${normalizedHash}`;
  const cached = gitChangesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < GIT_CHANGES_CACHE_TTL_MS) return cached.value;
  const repoRoot = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) return rememberGitChanges(cacheKey, null);
  const verifiedHash = gitOutput(repoRoot, ["rev-parse", "--verify", `${normalizedHash}^{commit}`]);
  if (!verifiedHash) return rememberGitChanges(cacheKey, null);

  const files = [];
  let additions = 0;
  let deletions = 0;
  const output = gitOutput(repoRoot, ["show", "--numstat", "--format=", "--find-renames", verifiedHash, "--"]);
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [added, deleted, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    if (!filePath) continue;
    const normalized = normalizeGitPath(filePath);
    const addedCount = parseGitCount(added);
    const deletedCount = parseGitCount(deleted);
    additions += addedCount || 0;
    deletions += deletedCount || 0;
    files.push({
      path: normalized,
      additions: addedCount,
      deletions: deletedCount,
      status: "modified"
    });
  }

  if (!files.length) return rememberGitChanges(cacheKey, null);
  return rememberGitChanges(cacheKey, {
    source: "commit",
    ref: normalizedHash,
    root: repoRoot,
    totalFiles: files.length,
    additions,
    deletions,
    files: files.slice(0, MAX_GIT_CHANGE_FILES),
    hasMore: files.length > MAX_GIT_CHANGE_FILES
  });
}

function rememberGitChanges(key, value) {
  if (gitChangesCache.size > 200) gitChangesCache.clear();
  gitChangesCache.set(key, { at: Date.now(), value });
  return value;
}

function gitOutput(cwd, args) {
  if (!cwd || !fs.existsSync(cwd)) return "";
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 2000,
    windowsHide: true
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function gitStatusMap(repoRoot) {
  const status = new Map();
  for (const line of gitOutput(repoRoot, ["status", "--porcelain=v1", "--untracked-files=normal"]).split(/\r?\n/).filter(Boolean)) {
    const code = line.slice(0, 2);
    const rawPath = line.slice(3);
    const filePath = normalizeGitPath(rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath);
    if (!filePath) continue;
    status.set(filePath, code === "??" ? "untracked" : statusLabel(code));
  }
  return status;
}

function statusLabel(code) {
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  return "modified";
}

function normalizeGitPath(value) {
  return String(value || "").replace(/^"|"$/g, "").replace(/\\/g, "/").trim();
}

function normalizeChangePath(value, roots = []) {
  const normalized = normalizeGitPath(value);
  if (!normalized) return "";
  const rootList = Array.isArray(roots) ? roots : [roots];
  for (const root of rootList) {
    const normalizedRoot = normalizeGitPath(root);
    if (normalizedRoot && normalized.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
      return normalized.slice(normalizedRoot.length + 1);
    }
  }
  return normalized;
}

function parseGitCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

function diffLineStats(diff) {
  const stats = { additions: 0, deletions: 0 };
  for (const line of String(diff || "").split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) stats.additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) stats.deletions += 1;
  }
  return stats;
}

function commitHashFromText(text) {
  const lines = String(text || "").split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 160) continue;
    const match = trimmed.match(/^`?([0-9a-f]{7,40})`?(?:\s+.+)?$/i);
    if (match) return match[1];
  }
  return "";
}

function normalizeCommitHash(value) {
  const match = String(value || "").trim().match(/^[0-9a-f]{7,40}$/i);
  return match ? match[0] : "";
}

function countTextLines(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 512 * 1024) return null;
    const text = fs.readFileSync(filePath, "utf8");
    if (text.includes("\u0000")) return null;
    return text ? text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0) : 0;
  } catch {
    return null;
  }
}

function walkJsonl(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(next);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(next);
    }
  }
  return found;
}

function idFromRolloutName(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || null;
}

function titleFromFile(filePath) {
  return path.basename(filePath).replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, "").replace(/\.jsonl$/, "");
}

function readableTitle(title, parsed) {
  if (title && !looksMojibake(title)) return title;
  const firstUser = parsed?.timeline?.find((item) => item.role === "user")?.text;
  return firstUser ? clip(firstUser, 48) : title || "Codex session";
}

function looksMojibake(text) {
  return /[�]|[ÃÂ]|[鐟閸娣囬]/.test(text || "");
}

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const imageSource = imageSourceFromContentPart(part);
      if (imageSource) return `![${escapeMarkdownLabel(part.alt || part.name || "image")}](${markdownUrlForPath(imageSource)})`;
      return part.text || part.input_text || part.output_text || "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeDisplayText(text) {
  return normalizeMarkdownImages(stripCodexAppDirectives(stripImageWrapperTags(unwrapJsonEscapedPrompt(text))));
}

function unwrapJsonEscapedPrompt(text) {
  const value = String(text || "").trim();
  if (!value.startsWith(JSON_ESCAPED_PROMPT_PREFIX) || !JSON_ESCAPED_PROMPT_MARKER_PATTERN.test(value)) return value;
  const marker = value.match(JSON_ESCAPED_PROMPT_MARKER_PATTERN);
  if (!marker) return value;
  const markerIndex = marker.index || 0;
  const encoded = value
    .slice(markerIndex + marker[0].length)
    .trim()
    .match(/^"(?:\\.|[^"\\])*"/s)?.[0];
  if (!encoded) return value;
  try {
    const decoded = JSON.parse(encoded);
    return typeof decoded === "string" && decoded.trim() ? decoded.trim() : value;
  } catch {
    return value;
  }
}

function normalizeMarkdownImages(text) {
  return String(text || "").replace(/!\[([^\]]*)\]\s*\(\s*(data:image\/[a-z0-9.+-]+;base64,[^)]+)\)/gis, (_match, alt, src) => {
    return `![${alt}](${src.replace(/\s+/g, "")})`;
  }).replace(/!\[([^\]]*)\]\s*\(\s*((?:<[^>]+>)|(?:[^)\s]+))(?:\s+["'][^"']*["'])?\)/g, (_match, alt, src) => {
    return `![${alt}](${src})`;
  });
}

function stripImageWrapperTags(text) {
  return String(text || "").replace(/^\s*<\/?image>\s*$/gim, "").trim();
}

function stripCodexAppDirectives(text) {
  return String(text || "").replace(/^\s*::git-[a-z-]+\{.*\}\s*$/gim, "").trim();
}

function imageSourceFromContentPart(part) {
  if (!part || typeof part !== "object") return "";
  const candidates = [
    part.path,
    part.file_path,
    part.local_path,
    typeof part.image_url === "string" ? part.image_url : part.image_url?.url,
    typeof part.image === "string" ? part.image : part.image?.path || part.image?.url,
    part.url,
    part.source?.path,
    part.source?.url
  ];
  const value = candidates.find((item) => typeof item === "string" && item.trim());
  if (!value) return "";
  if (isImageLikeContentPart(part) || isImageLikePath(value)) return value.trim();
  return "";
}

function isImageLikeContentPart(part) {
  return /image/i.test(String(part.type || part.mimeType || part.mime_type || ""));
}

function isImageLikePath(value) {
  return /\.(png|jpe?g|gif|webp|bmp)(?:[?#].*)?$/i.test(value) || /^data:image\//i.test(value);
}

function markdownUrlForPath(value) {
  const text = String(value || "");
  return /\s/.test(text) ? `<${text}>` : text;
}

function escapeMarkdownLabel(value) {
  return String(value || "").replace(/[\]\\]/g, "\\$&");
}

function pushTimeline(timeline, detail, item) {
  if (!detail && item.kind !== "message") return;
  timeline.push(item);
}

function truncateForDetail(text, detail) {
  if (detail && /data:image\/[a-z0-9.+-]+;base64,/i.test(String(text || ""))) return String(text || "").trim();
  return detail ? clip(text, 5000) : clip(text, MAX_PREVIEW_CHARS);
}

function collapseWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function clip(text, limit) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}...`;
}

function roleTitle(role) {
  if (role === "user") return "User";
  if (role === "assistant") return "Codex";
  if (role === "developer") return "Developer";
  return "Message";
}

function isUserDecisionTool(name) {
  return ["request_user_input", "request_plugin_install"].includes(name);
}

function decisionTitle(name) {
  if (name === "request_plugin_install") return "Plugin install approval";
  return "User input required";
}

function prettyArgs(value) {
  if (!value) return "";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function summarizeToolCall(name, value) {
  const args = parseArgs(value);
  if (!args || typeof args !== "object") return prettyArgs(value);

  if (name === "shell_command") {
    const command = args.command || args.cmd || args.script;
    const cwd = args.workdir || args.cwd;
    return [
      command ? `运行命令：${command}` : "运行 shell 命令",
      cwd ? `目录：${cwd}` : "",
      args.timeout_ms ? `超时：${args.timeout_ms}ms` : ""
    ].filter(Boolean).join("\n");
  }

  if (name === "apply_patch") return "修改文件";
  if (name === "view_image") return args.path ? `View image\n\n![image](${markdownUrlForPath(args.path)})` : "View image";
  if (name.includes("browser") || name.includes("screenshot")) return `浏览器操作：${name}`;
  if (name === "request_user_input") return "等待用户选择或输入";
  if (name === "request_plugin_install") return "请求安装插件或连接器";

  const keys = Object.keys(args).slice(0, 4);
  if (!keys.length) return "调用工具";
  return [`调用工具：${name}`, `参数：${keys.join(", ")}`].join("\n");
}

function parseArgs(value) {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeDecisionRecord(decision) {
  if (decision && typeof decision === "object") {
    return {
      decision: decision.decision || "approved",
      answers: decision.answers,
      scope: decision.scope
    };
  }
  return { decision: decision || "approved" };
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === "") return 0;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(Math.floor(limit), MAX_SESSION_LIMIT);
}

function normalizeDetailLimit(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_DETAIL_ITEMS;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_DETAIL_ITEMS;
  return Math.min(Math.floor(limit), MAX_DETAIL_ITEMS);
}

function normalizeOffset(value) {
  const offset = Number(value);
  if (!Number.isFinite(offset) || offset <= 0) return 0;
  return Math.floor(offset);
}

function rememberParse(key, parsed) {
  if (parseCache.size > 500) parseCache.clear();
  parseCache.set(key, parsed);
}

function cryptoId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
