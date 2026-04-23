import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { ensureProjectClaudeMd, runUserMessage } from "../../src/runner";
import { getSettings, loadSettings } from "../../src/config";
import { resetSession } from "../../src/sessions";
import { transcribeAudioToText } from "../../src/whisper";
import { resolveSkillPrompt } from "../../src/skills";

// Confine [send-file:...] directives to paths under the project directory.
// Mirrors the telegram.ts guard — prompt injection shouldn't be able to
// exfiltrate arbitrary files by emitting [send-file:/etc/passwd].
function isPathInsideProject(candidate: string): boolean {
  if (!candidate) return false;
  try {
    const projectRoot = resolve(process.cwd());
    const target = resolve(isAbsolute(candidate) ? candidate : join(projectRoot, candidate));
    const rel = relative(projectRoot, target);
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

// --- WhatsApp Cloud API types (only fields we use) ---

interface WhatsAppContact {
  profile?: { name?: string };
  wa_id: string;
}

interface WhatsAppTextBody { body: string }
interface WhatsAppMediaRef {
  id: string;
  mime_type?: string;
  filename?: string;
  caption?: string;
  sha256?: string;
}

interface WhatsAppReactionIncoming {
  message_id: string;
  emoji: string;
}

interface WhatsAppMessageIn {
  id: string;
  from: string;               // phone number (wa_id)
  timestamp: string;
  type: "text" | "image" | "audio" | "voice" | "document" | "video" | "sticker" | "reaction" | "button" | "interactive" | "location" | string;
  text?: WhatsAppTextBody;
  image?: WhatsAppMediaRef;
  audio?: WhatsAppMediaRef;
  voice?: WhatsAppMediaRef;
  document?: WhatsAppMediaRef;
  video?: WhatsAppMediaRef;
  reaction?: WhatsAppReactionIncoming;
  context?: { from?: string; id?: string };
}

interface WhatsAppChangeValue {
  messaging_product: "whatsapp";
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessageIn[];
  statuses?: Array<{ id: string; status: string }>;
}

interface WhatsAppChange {
  field: "messages" | string;
  value: WhatsAppChangeValue;
}

interface WhatsAppWebhookPayload {
  object: "whatsapp_business_account" | string;
  entry: Array<{ id: string; changes: WhatsAppChange[] }>;
}

// --- Debug logging ---

let whatsappDebug = false;
function debugLog(message: string): void {
  if (!whatsappDebug) return;
  console.log(`[WhatsApp][debug] ${message}`);
}

// --- WhatsApp → plain text conversion ---
// WhatsApp supports *bold*, _italic_, ~strike~, ```code```. Convert markdown
// conservatively: leave WhatsApp-native formatting intact, strip things that
// would show as literal characters.

function markdownToWhatsApp(text: string): string {
  if (!text) return "";
  // Strip ATX headers
  let out = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");
  // Strip blockquote markers
  out = out.replace(/^>\s*(.*)$/gm, "$1");
  // **bold** → *bold* (WhatsApp uses single-star)
  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");
  out = out.replace(/__(.+?)__/g, "*$1*");
  // Links [text](url) → "text (url)"
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  // Bullet lists: keep as-is, WhatsApp renders dashes fine
  return out;
}

// --- Directive extraction (react / send-file) ---

function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
  let reactionEmoji: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_m, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionEmoji };
}

function extractSendFileDirectives(text: string): { cleanedText: string; filePaths: string[] } {
  const filePaths: string[] = [];
  const cleanedText = text
    .replace(/\[send-file:([^\]\r\n]+)\]/gi, (_m, raw) => {
      const candidate = String(raw).trim();
      if (candidate) filePaths.push(candidate);
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, filePaths };
}

function extractCommand(text: string): string | null {
  const firstToken = text.trim().split(/\s+/, 1)[0];
  if (!firstToken?.startsWith("/")) return null;
  return firstToken.toLowerCase();
}

// --- WhatsApp Graph API calls ---

function apiBase(version: string): string {
  return `https://graph.facebook.com/${version}`;
}

async function postGraph(
  token: string,
  version: string,
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(`${apiBase(version)}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WhatsApp API ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

async function sendText(
  token: string,
  version: string,
  phoneNumberId: string,
  to: string,
  text: string,
  replyTo?: string
): Promise<void> {
  const normalized = markdownToWhatsApp(text).replace(/\[react:[^\]\r\n]+\]/gi, "");
  // WhatsApp hard limit is 4096 chars per text message.
  const MAX_LEN = 4096;
  for (let i = 0; i < normalized.length; i += MAX_LEN) {
    const chunk = normalized.slice(i, i + MAX_LEN);
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: chunk, preview_url: false },
    };
    // Only reply-to the first chunk so later chunks thread naturally.
    if (replyTo && i === 0) body.context = { message_id: replyTo };
    await postGraph(token, version, `${phoneNumberId}/messages`, body);
  }
}

async function sendReaction(
  token: string,
  version: string,
  phoneNumberId: string,
  to: string,
  messageId: string,
  emoji: string
): Promise<void> {
  await postGraph(token, version, `${phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "reaction",
    reaction: { message_id: messageId, emoji },
  });
}

async function markRead(
  token: string,
  version: string,
  phoneNumberId: string,
  messageId: string
): Promise<void> {
  try {
    await postGraph(token, version, `${phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    });
  } catch (err) {
    debugLog(`markRead failed: ${err instanceof Error ? err.message : err}`);
  }
}

// --- Media download (two-step: resolve URL, then fetch binary) ---

interface MediaMeta { url: string; mime_type: string; file_size?: number; id: string }

async function resolveMediaUrl(token: string, version: string, mediaId: string): Promise<MediaMeta> {
  const res = await fetch(`${apiBase(version)}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WhatsApp media lookup failed: ${res.status} ${text}`);
  }
  return (await res.json()) as MediaMeta;
}

async function downloadMedia(
  token: string,
  version: string,
  media: WhatsAppMediaRef,
  hintExt: string,
  messageId: string
): Promise<{ localPath: string; originalName: string } | null> {
  const meta = await resolveMediaUrl(token, version, media.id);
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`WhatsApp media download failed: ${res.status} ${res.statusText}`);

  const dir = join(process.cwd(), ".claude", "olaclaw", "inbox", "whatsapp");
  await mkdir(dir, { recursive: true });

  const originalName = media.filename ?? `media${hintExt}`;
  const ext = extname(originalName) || hintExt;
  const filename = `${messageId}-${Date.now()}${ext}`;
  const localPath = join(dir, filename);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await Bun.write(localPath, bytes);
  return { localPath, originalName };
}

function extensionFromMime(mime?: string): string {
  if (!mime) return "";
  switch (mime.split(";")[0].trim()) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    case "audio/ogg": return ".ogg";
    case "audio/mpeg": return ".mp3";
    case "audio/mp4":
    case "audio/x-m4a": return ".m4a";
    case "audio/wav":
    case "audio/x-wav": return ".wav";
    case "application/pdf": return ".pdf";
    case "text/plain": return ".txt";
    case "text/csv": return ".csv";
    default: return "";
  }
}

// --- Signature verification ---

// Meta signs webhook bodies with HMAC-SHA256(appSecret, rawBody).
// Header format: "sha256=<hex>". Compare in constant time.
function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = header.startsWith("sha256=") ? header.slice(7) : header;
  if (expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    return false;
  }
}

// --- Message handling ---

interface WhatsAppConfigLike {
  token: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  allowedPhoneNumbers: string[];
  apiVersion: string;
  webhookPath: string;
  webhookHost: string;
  webhookPort: number;
}

function getConfig(): WhatsAppConfigLike {
  const s = getSettings() as unknown as { whatsapp?: WhatsAppConfigLike };
  const w = s.whatsapp;
  if (!w) throw new Error("WhatsApp config missing — add a `whatsapp` block to settings.json");
  return w;
}

async function handleMessage(
  message: WhatsAppMessageIn,
  contacts: WhatsAppContact[] | undefined
): Promise<void> {
  const config = getConfig();
  const from = message.from;

  // Default-deny: empty allowlist blocks everyone. Mirrors telegram/discord
  // behaviour — a misconfigured webhook shouldn't be an open injection vector.
  const allowed = config.allowedPhoneNumbers ?? [];
  if (allowed.length === 0) {
    console.warn(
      `[WhatsApp] Refusing message from ${from}: allowedPhoneNumbers is empty. ` +
      `Add your WhatsApp numbers (E.164, digits only) to whatsapp.allowedPhoneNumbers in settings.json.`
    );
    return;
  }
  if (!allowed.includes(from)) {
    debugLog(`Unauthorized sender ${from}`);
    return;
  }

  // Ack receipt so the user sees the double-tick immediately.
  markRead(config.token, config.apiVersion, config.phoneNumberId, message.id).catch(() => {});

  const contact = contacts?.find((c) => c.wa_id === from);
  const label = contact?.profile?.name ?? from;

  const text = message.text?.body ?? "";
  const command = text ? extractCommand(text) : null;

  // Built-in commands
  if (command === "/start") {
    await sendText(
      config.token,
      config.apiVersion,
      config.phoneNumberId,
      from,
      "Hello! Send me a message and I'll respond using Claude.\nUse /reset to start a fresh session.",
      message.id
    );
    return;
  }
  if (command === "/reset") {
    await resetSession();
    await sendText(
      config.token,
      config.apiVersion,
      config.phoneNumberId,
      from,
      "Session reset. Next message starts fresh.",
      message.id
    );
    return;
  }

  // Reaction-only events: just log and drop.
  if (message.type === "reaction") {
    debugLog(`Reaction from ${from}: ${message.reaction?.emoji ?? "?"} on ${message.reaction?.message_id ?? "?"}`);
    return;
  }

  // Collect media
  let imagePath: string | null = null;
  let voiceTranscript: string | null = null;
  let documentInfo: { localPath: string; originalName: string } | null = null;

  try {
    if (message.type === "image" && message.image) {
      const result = await downloadMedia(
        config.token,
        config.apiVersion,
        message.image,
        extensionFromMime(message.image.mime_type) || ".jpg",
        message.id
      );
      imagePath = result?.localPath ?? null;
    } else if ((message.type === "voice" || message.type === "audio") && (message.voice || message.audio)) {
      const media = message.voice ?? message.audio!;
      const dl = await downloadMedia(
        config.token,
        config.apiVersion,
        media,
        extensionFromMime(media.mime_type) || ".ogg",
        message.id
      );
      if (dl) {
        try {
          voiceTranscript = await transcribeAudioToText(dl.localPath, {
            debug: whatsappDebug,
            log: (m) => debugLog(m),
          });
        } catch (err) {
          console.error(`[WhatsApp] Voice transcribe failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    } else if (message.type === "document" && message.document) {
      documentInfo = await downloadMedia(
        config.token,
        config.apiVersion,
        message.document,
        extensionFromMime(message.document.mime_type) || "",
        message.id
      );
    }
  } catch (err) {
    console.error(`[WhatsApp] Media download failed for ${label}: ${err instanceof Error ? err.message : err}`);
  }

  // Skill routing
  let skillContext: string | null = null;
  if (command && !["/start", "/reset"].includes(command)) {
    try {
      skillContext = await resolveSkillPrompt(command);
    } catch (err) {
      debugLog(`Skill resolution failed for ${command}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!text.trim() && !imagePath && !voiceTranscript && !documentInfo) {
    debugLog(`Skip empty message from ${from}`);
    return;
  }

  const promptParts = [`[WhatsApp from ${label} (${from})]`];
  if (skillContext) {
    const args = text.trim().slice(command!.length).trim();
    promptParts.push(`<command-name>${command}</command-name>`);
    promptParts.push(skillContext);
    if (args) promptParts.push(`User arguments: ${args}`);
  } else if (text.trim()) {
    promptParts.push(`Message: ${text}`);
  }
  if (imagePath) {
    promptParts.push(`Image path: ${imagePath}`);
    promptParts.push("The user attached an image. Inspect this image file directly before answering.");
  }
  if (voiceTranscript) {
    promptParts.push(`Voice transcript: ${voiceTranscript}`);
    promptParts.push("The user attached voice audio. Use the transcript as their spoken message.");
  }
  if (documentInfo) {
    promptParts.push(`Document path: ${documentInfo.localPath}`);
    promptParts.push(`Original filename: ${documentInfo.originalName}`);
    promptParts.push("The user attached a document. Read and process this file directly.");
  }

  const prompt = promptParts.join("\n");
  console.log(
    `[${new Date().toLocaleTimeString()}] WhatsApp ${label}: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`
  );

  try {
    const result = await runUserMessage("whatsapp", prompt);
    if (result.exitCode !== 0) {
      await sendText(
        config.token,
        config.apiVersion,
        config.phoneNumberId,
        from,
        `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`,
        message.id
      );
      return;
    }
    const { cleanedText: afterReact, reactionEmoji } = extractReactionDirective(result.stdout || "");
    const { cleanedText, filePaths } = extractSendFileDirectives(afterReact);

    if (reactionEmoji) {
      sendReaction(config.token, config.apiVersion, config.phoneNumberId, from, message.id, reactionEmoji).catch(
        (err) => console.error(`[WhatsApp] Reaction failed: ${err instanceof Error ? err.message : err}`)
      );
    }
    if (cleanedText) {
      await sendText(config.token, config.apiVersion, config.phoneNumberId, from, cleanedText, message.id);
    }
    for (const fp of filePaths) {
      if (!isPathInsideProject(fp)) {
        console.warn(`[WhatsApp] Refused [send-file] outside project: ${fp}`);
        await sendText(
          config.token,
          config.apiVersion,
          config.phoneNumberId,
          from,
          `Refused to send file (path outside project): ${fp.split(/[\\/]/).pop()}`
        );
        continue;
      }
      // TODO: implement document upload via /media endpoint then send type=document.
      // For now, warn that file sending isn't wired up yet.
      console.warn(`[WhatsApp] [send-file] not yet implemented; would have sent ${fp}`);
      await sendText(
        config.token,
        config.apiVersion,
        config.phoneNumberId,
        from,
        `(file send not yet implemented: ${fp.split(/[\\/]/).pop()})`
      );
    }
    if (!cleanedText && filePaths.length === 0) {
      await sendText(config.token, config.apiVersion, config.phoneNumberId, from, "(empty response)", message.id);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[WhatsApp] Error for ${label}: ${errMsg}`);
    await sendText(config.token, config.apiVersion, config.phoneNumberId, from, `Error: ${errMsg}`, message.id);
  }
}

// --- HTTP server (webhook receiver) ---

let server: ReturnType<typeof Bun.serve> | null = null;

export function startWebhookServer(debug = false): void {
  if (server) return;
  whatsappDebug = debug;

  const config = getConfig();
  if (!config.token || !config.phoneNumberId || !config.appSecret || !config.verifyToken) {
    console.warn(
      "[WhatsApp] Missing required config (token / phoneNumberId / appSecret / verifyToken). Not starting webhook."
    );
    return;
  }

  server = Bun.serve({
    hostname: config.webhookHost,
    port: config.webhookPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== config.webhookPath) {
        return new Response("Not found", { status: 404 });
      }

      // --- Webhook verification (Meta hits this with GET once on subscribe) ---
      if (req.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const tokenParam = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        if (mode === "subscribe" && tokenParam === config.verifyToken && challenge) {
          return new Response(challenge, { status: 200 });
        }
        return new Response("Forbidden", { status: 403 });
      }

      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

      // Signature verification — REQUIRED. Reject anything unsigned or mismatched.
      const rawBody = await req.text();
      const sig = req.headers.get("x-hub-signature-256");
      if (!verifySignature(rawBody, sig, config.appSecret)) {
        console.warn("[WhatsApp] Rejecting webhook: signature mismatch");
        return new Response("Forbidden", { status: 403 });
      }

      let payload: WhatsAppWebhookPayload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return new Response("Bad request", { status: 400 });
      }

      // Respond 200 quickly — Meta retries if we don't. Do the work in the background.
      queueMicrotask(() => {
        processPayload(payload).catch((err) => {
          console.error(`[WhatsApp] processPayload: ${err instanceof Error ? err.message : err}`);
        });
      });
      return new Response("ok", { status: 200 });
    },
  });

  console.log(`[WhatsApp] Webhook listening on http://${config.webhookHost}:${config.webhookPort}${config.webhookPath}`);
  console.log(`  Phone number ID: ${config.phoneNumberId}`);
  console.log(
    `  Allowed senders: ${config.allowedPhoneNumbers.length === 0 ? "NONE (bot will reject all messages)" : config.allowedPhoneNumbers.join(", ")}`
  );
  if (whatsappDebug) console.log("  Debug: enabled");
}

export function stopWebhookServer(): void {
  if (!server) return;
  server.stop();
  server = null;
}

async function processPayload(payload: WhatsAppWebhookPayload): Promise<void> {
  if (payload.object !== "whatsapp_business_account") return;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value;
      for (const message of value.messages ?? []) {
        handleMessage(message, value.contacts).catch((err) => {
          console.error(`[WhatsApp] handleMessage: ${err instanceof Error ? err.message : err}`);
        });
      }
    }
  }
}

// --- Outbound API for heartbeat forwarding / bot-to-user broadcasts ---

export async function sendMessageToUser(phoneNumber: string, text: string): Promise<void> {
  const config = getConfig();
  await sendText(config.token, config.apiVersion, config.phoneNumberId, phoneNumber, text);
}

// --- Standalone entry point (bun run src/index.ts whatsapp) ---

export async function whatsapp(): Promise<void> {
  await loadSettings();
  await ensureProjectClaudeMd();
  startWebhookServer(false);
  // Keep the process alive until signalled.
  process.on("SIGINT", () => { stopWebhookServer(); process.exit(0); });
  process.on("SIGTERM", () => { stopWebhookServer(); process.exit(0); });
  // Hang.
  await new Promise(() => {});
}
