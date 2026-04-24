import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runUserMessage } from "../../src/runner";
import { getSettings, loadSettings } from "../../src/config";
import { graphJSON, graphFetch, getSelfAddress } from "../outlook/outlook";

// ---------- Types ----------

interface ChatMessageBody { contentType: "text" | "html"; content: string }
interface ChatMessageFromUser {
  user?: { id?: string; displayName?: string; userIdentityType?: string };
  application?: { id?: string; displayName?: string };
}
interface ChatMessage {
  id: string;
  chatId?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  from?: ChatMessageFromUser;
  body?: ChatMessageBody;
  importance?: string;
  messageType?: string;        // "message" | "chatEvent" | "typing" | ...
  subject?: string;
}

interface ChatMember {
  id: string;
  userId?: string;
  email?: string;
  displayName?: string;
}

interface TeamsConfigLike {
  enabled: boolean;
  pollIntervalSeconds: number;
  allowedChatMembers: string[]; // emails or AAD user IDs
}

// ---------- Constants ----------

const TEAMS_DIR = join(process.cwd(), ".claude", "olaclaw");
const STATE_FILE = join(TEAMS_DIR, "teams-state.json");

// ---------- Debug ----------

let teamsDebug = false;
function debugLog(msg: string): void {
  if (teamsDebug) console.log(`[Teams][debug] ${msg}`);
}

// ---------- Config ----------

function getConfig(): TeamsConfigLike {
  const s = getSettings() as unknown as { teams?: TeamsConfigLike };
  const t = s.teams;
  if (!t) throw new Error("Teams config missing — add a `teams` block to settings.json");
  return t;
}

// ---------- State (last-seen message timestamp + dedupe) ----------

interface TeamsState {
  lastSeenIso?: string;     // ISO timestamp — we ask Graph for messages after this
  seenMessageIds?: string[]; // rolling dedupe set (capped)
}

const DEDUPE_MAX = 500;

async function loadState(): Promise<TeamsState> {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(await readFile(STATE_FILE, "utf8")) as TeamsState; }
  catch { return {}; }
}

async function saveState(state: TeamsState): Promise<void> {
  await mkdir(TEAMS_DIR, { recursive: true });
  // Cap the dedupe list so the file doesn't grow forever.
  if (state.seenMessageIds && state.seenMessageIds.length > DEDUPE_MAX) {
    state.seenMessageIds = state.seenMessageIds.slice(-DEDUPE_MAX);
  }
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- HTML → text ----------

function textOf(body?: ChatMessageBody): string {
  if (!body) return "";
  if (body.contentType === "text") return body.content;
  return body.content
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- Chat helpers ----------

async function listChatMembers(chatId: string): Promise<ChatMember[]> {
  try {
    const res = await graphJSON<{ value: ChatMember[] }>(
      `/chats/${encodeURIComponent(chatId)}/members?$top=50`
    );
    return res.value ?? [];
  } catch (err) {
    debugLog(`listChatMembers(${chatId}) failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

async function sendChatMessage(chatId: string, text: string): Promise<void> {
  const res = await graphFetch(`/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      body: { contentType: "text", content: text },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Teams send failed: ${res.status} ${body}`);
  }
}

/**
 * Public: send a plain-text message into a chat by chat ID.
 * Useful for heartbeat forwarding and the `send` CLI path.
 */
export async function sendMessageToChat(chatId: string, text: string): Promise<void> {
  await sendChatMessage(chatId, text);
}

// ---------- Polling ----------

async function fetchRecentMessages(sinceIso: string): Promise<ChatMessage[]> {
  // /me/chats/getAllMessages is the flat cross-chat feed. Filter by
  // lastModifiedDateTime > since to get only new/changed messages.
  const url = `/me/chats/getAllMessages?$filter=lastModifiedDateTime gt ${sinceIso}&$top=50&$orderby=lastModifiedDateTime desc`;
  try {
    const res = await graphJSON<{ value: ChatMessage[] }>(url);
    return res.value ?? [];
  } catch (err) {
    console.error(`[Teams] Poll fetch failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

async function handleMessage(msg: ChatMessage): Promise<void> {
  // Skip non-message events (typing, chatEvent, etc)
  if (msg.messageType && msg.messageType !== "message") {
    debugLog(`Skipping ${msg.messageType} ${msg.id}`);
    return;
  }

  // Loop guard: skip our own messages.
  const self = await getSelfAddress();
  const fromUser = msg.from?.user;
  if (!fromUser) { debugLog(`No user on message ${msg.id}, skipping`); return; }

  // Resolve sender identity. userIdentityType === "aadUser" gives us a real
  // AAD user; id is the userId (GUID). Use displayName for prompt context.
  const senderId = fromUser.id ?? "";
  const senderName = fromUser.displayName ?? senderId;

  // Try to get the sender's email for allowlist comparison. Graph gives us
  // userId; we have to look up email separately. Keep a tiny cache.
  const senderEmail = (await resolveUserEmail(senderId)).toLowerCase();

  // Self check — our own sent messages come back through the same feed.
  if (self && senderEmail && senderEmail === self) {
    debugLog(`Skipping self message ${msg.id}`);
    return;
  }

  const cfg = getConfig();
  const allowed = (cfg.allowedChatMembers ?? []).map((s) => s.toLowerCase());
  if (allowed.length === 0) {
    console.warn(
      `[Teams] Refusing message from ${senderEmail || senderId}: allowedChatMembers is empty.`
    );
    return;
  }
  if (!allowed.includes(senderEmail) && !allowed.includes(senderId.toLowerCase())) {
    debugLog(`Sender ${senderEmail || senderId} not in allowlist`);
    return;
  }

  const bodyText = textOf(msg.body);
  if (!bodyText.trim()) {
    debugLog(`Skipping empty body ${msg.id}`);
    return;
  }

  const chatId = msg.chatId;
  if (!chatId) { debugLog(`No chatId on message ${msg.id}`); return; }

  const prompt = [
    `[Teams from ${senderName}${senderEmail ? ` <${senderEmail}>` : ""}] (chat ${chatId})`,
    `Message: ${bodyText.slice(0, 20_000)}`,
  ].join("\n");

  console.log(
    `[${new Date().toLocaleTimeString()}] Teams ${senderName}: "${bodyText.slice(0, 60)}${bodyText.length > 60 ? "..." : ""}"`
  );

  try {
    const result = await runUserMessage("teams", prompt);
    if (result.exitCode !== 0) {
      await sendChatMessage(chatId, `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`);
      return;
    }
    const replyText = (result.stdout || "").trim() || "(empty response)";
    await sendChatMessage(chatId, replyText);
  } catch (err) {
    console.error(`[Teams] Handler error: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------- Email resolution cache ----------

const emailCache = new Map<string, string>();
async function resolveUserEmail(userId: string): Promise<string> {
  if (!userId) return "";
  const cached = emailCache.get(userId);
  if (cached !== undefined) return cached;
  try {
    const u = await graphJSON<{ mail?: string; userPrincipalName?: string }>(`/users/${encodeURIComponent(userId)}?$select=mail,userPrincipalName`);
    const email = (u.mail ?? u.userPrincipalName ?? "").toLowerCase();
    emailCache.set(userId, email);
    return email;
  } catch (err) {
    debugLog(`resolveUserEmail(${userId}) failed: ${err instanceof Error ? err.message : err}`);
    emailCache.set(userId, "");
    return "";
  }
}

// ---------- Poll loop ----------

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function pollOnce(): Promise<void> {
  const state = await loadState();
  const sinceIso = state.lastSeenIso ?? new Date(Date.now() - 5 * 60_000).toISOString();
  const seenSet = new Set(state.seenMessageIds ?? []);

  const messages = await fetchRecentMessages(sinceIso);
  // Sort oldest-first so reply order matches arrival order.
  messages.sort((a, b) =>
    (a.lastModifiedDateTime ?? a.createdDateTime ?? "").localeCompare(
      b.lastModifiedDateTime ?? b.createdDateTime ?? ""
    )
  );

  let newestTs = state.lastSeenIso ?? "";
  for (const msg of messages) {
    if (seenSet.has(msg.id)) continue;
    seenSet.add(msg.id);
    await handleMessage(msg).catch((err) =>
      console.error(`[Teams] handleMessage: ${err instanceof Error ? err.message : err}`)
    );
    const ts = msg.lastModifiedDateTime ?? msg.createdDateTime ?? "";
    if (ts > newestTs) newestTs = ts;
  }

  await saveState({
    lastSeenIso: newestTs || sinceIso,
    seenMessageIds: [...seenSet],
  });
}

function scheduleNext(intervalMs: number): void {
  if (!running) return;
  pollTimer = setTimeout(async () => {
    try { await pollOnce(); }
    catch (err) { console.error(`[Teams] Poll error: ${err instanceof Error ? err.message : err}`); }
    scheduleNext(intervalMs);
  }, intervalMs);
}

export function startTeamsPolling(debug = false): void {
  if (running) return;
  teamsDebug = debug;
  const cfg = getConfig();
  if (!cfg.enabled) {
    console.log("[Teams] Disabled in settings");
    return;
  }
  running = true;
  const intervalMs = Math.max(10, cfg.pollIntervalSeconds || 45) * 1000;
  console.log(`[Teams] Polling every ${Math.round(intervalMs / 1000)}s`);
  console.log(
    `  Allowed members: ${cfg.allowedChatMembers.length === 0 ? "NONE (all messages dropped)" : cfg.allowedChatMembers.join(", ")}`
  );

  // Kick off immediately, then schedule recurring.
  pollOnce()
    .catch((err) => console.error(`[Teams] First poll: ${err instanceof Error ? err.message : err}`))
    .finally(() => scheduleNext(intervalMs));
}

export function stopTeamsPolling(): void {
  running = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

// ---------- Standalone entry ----------

export async function teams(): Promise<void> {
  await loadSettings();
  startTeamsPolling(false);
  process.on("SIGINT", () => { stopTeamsPolling(); process.exit(0); });
  process.on("SIGTERM", () => { stopTeamsPolling(); process.exit(0); });
  await new Promise(() => {});
}
