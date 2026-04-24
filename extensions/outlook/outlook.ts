import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureProjectClaudeMd, runUserMessage } from "../../src/runner";
import { getSettings, loadSettings } from "../../src/config";

// ---------- Types ----------

interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;   // unix ms
  scope: string;
  clientId: string;    // which app issued these — invalidate if the config changes
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

interface GraphMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType: "text" | "html"; content: string };
  from?: { emailAddress: { address: string; name?: string } };
  toRecipients?: Array<{ emailAddress: { address: string; name?: string } }>;
  ccRecipients?: Array<{ emailAddress: { address: string; name?: string } }>;
  conversationId?: string;
  internetMessageId?: string;
  receivedDateTime?: string;
  isRead?: boolean;
}

interface GraphSubscription {
  id: string;
  resource: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState?: string;
}

interface WebhookNotification {
  subscriptionId: string;
  clientState?: string;
  resource: string;
  resourceData?: { id?: string };
  changeType: string;
}

interface OutlookConfigLike {
  clientId: string;
  tenantId: string;
  allowedSenders: string[];
  webhookPath: string;
  webhookHost: string;
  webhookPort: number;
  publicUrl: string; // e.g. https://abc.ngrok-free.dev  (no trailing slash)
}

// ---------- Constants ----------

// Matches the API permissions granted in Azure. offline_access is required
// for refresh tokens; the rest cover mail, calendar, teams chat, contacts,
// and directory search. Scopes are superset-chosen (e.g. Mail.ReadWrite
// includes Mail.Read), so this list stays compact.
const SCOPES = [
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
  "Chat.ReadWrite",
  "ChatMessage.Send",
  "Contacts.ReadWrite",
  "Directory.Read.All",
].join(" ");

const GRAPH = "https://graph.microsoft.com/v1.0";

// Inbox subscriptions max out at 4230 minutes (~70h). Renew ~24h before that.
const SUBSCRIPTION_LIFETIME_MIN = 4230;
const RENEW_BEFORE_EXPIRY_MIN = 60 * 24;

const OUTLOOK_DIR = join(process.cwd(), ".claude", "olaclaw");
const TOKEN_FILE = join(OUTLOOK_DIR, "outlook-tokens.json");
const STATE_FILE = join(OUTLOOK_DIR, "outlook-state.json");

// ---------- Debug ----------

let outlookDebug = false;
function debugLog(msg: string): void {
  if (outlookDebug) console.log(`[Outlook][debug] ${msg}`);
}

// ---------- Config accessor ----------

function getConfig(): OutlookConfigLike {
  const s = getSettings() as unknown as { outlook?: OutlookConfigLike };
  const o = s.outlook;
  if (!o) throw new Error("Outlook config missing — add an `outlook` block to settings.json");
  return o;
}

// ---------- Token persistence ----------

async function loadTokens(): Promise<TokenBundle | null> {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const raw = await readFile(TOKEN_FILE, "utf8");
    return JSON.parse(raw) as TokenBundle;
  } catch {
    return null;
  }
}

async function saveTokens(bundle: TokenBundle): Promise<void> {
  await mkdir(OUTLOOK_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(bundle, null, 2));
  if (process.platform !== "win32") {
    try { await chmod(TOKEN_FILE, 0o600); } catch {}
  }
}

// ---------- Device code flow ----------

function authority(tenantId: string): string {
  const t = tenantId.trim() || "common";
  return `https://login.microsoftonline.com/${t}`;
}

export async function startDeviceCodeFlow(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.clientId) throw new Error("outlook.clientId is not set in settings.json");

  const tokenEndpoint = `${authority(cfg.tenantId)}/oauth2/v2.0/token`;
  const devEndpoint = `${authority(cfg.tenantId)}/oauth2/v2.0/devicecode`;

  const body = new URLSearchParams({ client_id: cfg.clientId, scope: SCOPES });
  const res = await fetch(devEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Device code request failed: ${res.status} ${text}`);
  }
  const device = (await res.json()) as DeviceCodeResponse;

  console.log("");
  console.log("==================================================================");
  console.log(device.message);
  console.log("==================================================================");
  console.log("");

  const interval = (device.interval || 5) * 1000;
  const deadline = Date.now() + device.expires_in * 1000;

  while (Date.now() < deadline) {
    await Bun.sleep(interval);
    const tokenRes = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: cfg.clientId,
        device_code: device.device_code,
      }).toString(),
    });

    if (tokenRes.ok) {
      const tok = (await tokenRes.json()) as TokenResponse;
      const bundle: TokenBundle = {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token,
        expiresAt: Date.now() + tok.expires_in * 1000,
        scope: tok.scope,
        clientId: cfg.clientId,
      };
      await saveTokens(bundle);
      console.log("[Outlook] Authenticated — tokens cached at", TOKEN_FILE);
      return;
    }

    const err = (await tokenRes.json().catch(() => ({ error: "unknown" }))) as { error?: string };
    if (err.error === "authorization_pending") continue;
    if (err.error === "slow_down") { await Bun.sleep(5000); continue; }
    if (err.error === "expired_token") throw new Error("Device code expired — run auth again");
    if (err.error === "authorization_declined") throw new Error("User declined authorization");
    throw new Error(`Device code token exchange failed: ${err.error ?? "unknown"}`);
  }
  throw new Error("Device code timed out");
}

async function refreshAccessToken(bundle: TokenBundle): Promise<TokenBundle> {
  const cfg = getConfig();
  if (bundle.clientId !== cfg.clientId) {
    throw new Error("Client ID changed — re-run `olaclaw outlook auth`");
  }
  const res = await fetch(`${authority(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: bundle.refreshToken,
      client_id: cfg.clientId,
      scope: SCOPES,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Refresh failed: ${res.status} ${text}`);
  }
  const tok = (await res.json()) as TokenResponse;
  const next: TokenBundle = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? bundle.refreshToken,
    expiresAt: Date.now() + tok.expires_in * 1000,
    scope: tok.scope,
    clientId: cfg.clientId,
  };
  await saveTokens(next);
  return next;
}

async function getValidAccessToken(): Promise<string> {
  const bundle = await loadTokens();
  if (!bundle) throw new Error("Not authenticated — run `olaclaw outlook auth`");
  // Refresh ~60s before expiry so concurrent calls don't race a stale token.
  if (Date.now() > bundle.expiresAt - 60_000) {
    const next = await refreshAccessToken(bundle);
    return next.accessToken;
  }
  return bundle.accessToken;
}

// ---------- Graph API helpers ----------

export async function graphFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getValidAccessToken();
  const url = path.startsWith("http") ? path : `${GRAPH}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(url, { ...init, headers });
}

export async function graphJSON<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await graphFetch(path, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph ${init.method ?? "GET"} ${path}: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

// ---------- State persistence (subscription id + clientState) ----------

interface OutlookState {
  subscriptionId?: string;
  clientState?: string;
  subscriptionExpiresAt?: number; // unix ms
}

async function loadState(): Promise<OutlookState> {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(await readFile(STATE_FILE, "utf8")) as OutlookState; }
  catch { return {}; }
}

async function saveState(state: OutlookState): Promise<void> {
  await mkdir(OUTLOOK_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- Subscription management ----------

function subscriptionExpirationIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

async function createSubscription(): Promise<OutlookState> {
  const cfg = getConfig();
  if (!cfg.publicUrl) throw new Error("outlook.publicUrl is not set — Microsoft needs a public HTTPS URL to post notifications to");

  const clientState = randomBytes(24).toString("hex");
  const body = {
    changeType: "created",
    notificationUrl: `${cfg.publicUrl.replace(/\/$/, "")}${cfg.webhookPath}`,
    resource: "me/mailFolders('inbox')/messages",
    expirationDateTime: subscriptionExpirationIso(SUBSCRIPTION_LIFETIME_MIN),
    clientState,
  };

  const sub = await graphJSON<GraphSubscription>("/subscriptions", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const state: OutlookState = {
    subscriptionId: sub.id,
    clientState,
    subscriptionExpiresAt: new Date(sub.expirationDateTime).getTime(),
  };
  await saveState(state);
  console.log(`[Outlook] Subscription created: ${sub.id} (expires ${sub.expirationDateTime})`);
  return state;
}

async function renewSubscription(id: string): Promise<number> {
  const nextIso = subscriptionExpirationIso(SUBSCRIPTION_LIFETIME_MIN);
  const sub = await graphJSON<GraphSubscription>(`/subscriptions/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ expirationDateTime: nextIso }),
  });
  const at = new Date(sub.expirationDateTime).getTime();
  const state = await loadState();
  state.subscriptionExpiresAt = at;
  await saveState(state);
  console.log(`[Outlook] Subscription renewed: ${id} (expires ${sub.expirationDateTime})`);
  return at;
}

async function ensureSubscription(): Promise<OutlookState> {
  let state = await loadState();
  if (!state.subscriptionId) return createSubscription();

  // Try to renew first. If the sub has been deleted server-side, re-create.
  try {
    await renewSubscription(state.subscriptionId);
    return await loadState();
  } catch (err) {
    debugLog(`Renew failed, re-creating: ${err instanceof Error ? err.message : err}`);
    return createSubscription();
  }
}

let renewTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRenewal() {
  if (renewTimer) clearTimeout(renewTimer);
  loadState().then((s) => {
    if (!s.subscriptionExpiresAt || !s.subscriptionId) return;
    const delay = Math.max(60_000, s.subscriptionExpiresAt - Date.now() - RENEW_BEFORE_EXPIRY_MIN * 60_000);
    renewTimer = setTimeout(async () => {
      try {
        await ensureSubscription();
      } catch (err) {
        console.error(`[Outlook] Renewal error: ${err instanceof Error ? err.message : err}`);
      } finally {
        scheduleRenewal();
      }
    }, delay);
    debugLog(`Next renewal scheduled in ${Math.round(delay / 60_000)}m`);
  });
}

// ---------- Message fetch + send ----------

function textOf(body?: { contentType: "text" | "html"; content: string }): string {
  if (!body) return "";
  if (body.contentType === "text") return body.content;
  // Strip HTML crudely — Claude reads the result, it doesn't need to be pretty.
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

// ---------- Contact / Directory lookup ----------

interface ContactRecord {
  source: "contacts" | "directory" | null;
  name?: string;
  email?: string;
  jobTitle?: string;
  companyName?: string;
  department?: string;
  officePhone?: string;
  mobilePhone?: string;
}

// Small in-memory cache keyed by lowercase email. Calls are cheap enough
// that we just re-hit Graph on daemon restart.
const contactCache = new Map<string, ContactRecord>();

async function lookupPersonalContact(email: string): Promise<ContactRecord | null> {
  const url = `/me/contacts?$filter=${encodeURIComponent(`emailAddresses/any(e: e/address eq '${email}')`)}&$top=1&$select=displayName,emailAddresses,jobTitle,companyName,department,businessPhones,mobilePhone`;
  try {
    const res = await graphJSON<{ value: Array<{ displayName?: string; emailAddresses?: Array<{ address?: string }>; jobTitle?: string; companyName?: string; department?: string; businessPhones?: string[]; mobilePhone?: string }> }>(url);
    const c = res.value?.[0];
    if (!c) return null;
    return {
      source: "contacts",
      name: c.displayName,
      email: c.emailAddresses?.[0]?.address,
      jobTitle: c.jobTitle,
      companyName: c.companyName,
      department: c.department,
      officePhone: c.businessPhones?.[0],
      mobilePhone: c.mobilePhone,
    };
  } catch (err) {
    debugLog(`lookupPersonalContact(${email}) failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function lookupDirectoryUser(email: string): Promise<ContactRecord | null> {
  const url = `/users?$filter=${encodeURIComponent(`mail eq '${email}' or userPrincipalName eq '${email}'`)}&$top=1&$select=displayName,mail,userPrincipalName,jobTitle,companyName,department,businessPhones,mobilePhone`;
  try {
    const res = await graphJSON<{ value: Array<{ displayName?: string; mail?: string; userPrincipalName?: string; jobTitle?: string; companyName?: string; department?: string; businessPhones?: string[]; mobilePhone?: string }> }>(url);
    const u = res.value?.[0];
    if (!u) return null;
    return {
      source: "directory",
      name: u.displayName,
      email: u.mail ?? u.userPrincipalName,
      jobTitle: u.jobTitle,
      companyName: u.companyName,
      department: u.department,
      officePhone: u.businessPhones?.[0],
      mobilePhone: u.mobilePhone,
    };
  } catch (err) {
    debugLog(`lookupDirectoryUser(${email}) failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Try personal contacts first (more accurate for people you actually know),
 * then fall back to the org directory. Negative results are cached too, so
 * we don't hammer Graph for every unknown address.
 */
async function lookupContact(emailRaw: string): Promise<ContactRecord | null> {
  const email = emailRaw.toLowerCase();
  const cached = contactCache.get(email);
  if (cached !== undefined) return cached.source === null ? null : cached;

  let record = await lookupPersonalContact(email);
  if (!record) record = await lookupDirectoryUser(email);
  contactCache.set(email, record ?? { source: null });
  return record;
}

function formatContactForPrompt(c: ContactRecord): string {
  const parts: string[] = [];
  if (c.name) parts.push(c.name);
  if (c.jobTitle) parts.push(c.jobTitle);
  if (c.companyName) parts.push(c.companyName);
  if (c.department) parts.push(`dept: ${c.department}`);
  const phones: string[] = [];
  if (c.officePhone) phones.push(c.officePhone);
  if (c.mobilePhone) phones.push(`mob ${c.mobilePhone}`);
  if (phones.length > 0) parts.push(phones.join(", "));
  return `Contact (${c.source}): ${parts.join(" · ")}`;
}

async function fetchMessage(id: string): Promise<GraphMessage> {
  return graphJSON<GraphMessage>(`/me/messages/${encodeURIComponent(id)}?$select=id,subject,body,bodyPreview,from,toRecipients,ccRecipients,conversationId,internetMessageId,receivedDateTime,isRead`);
}

// Cache the authenticated user's own email so we can recognise self-replies
// and skip them. Self→self emails happen when the user forwards/replies to
// themselves, and without this guard our /reply call would feed the next
// notification right back in, creating an infinite loop.
let cachedSelfAddress: string | null = null;
export async function getSelfAddress(): Promise<string | null> {
  if (cachedSelfAddress) return cachedSelfAddress;
  try {
    const me = await graphJSON<{ mail?: string; userPrincipalName?: string }>("/me");
    const addr = (me.mail ?? me.userPrincipalName ?? "").toLowerCase();
    if (addr) cachedSelfAddress = addr;
    return cachedSelfAddress;
  } catch (err) {
    debugLog(`getSelfAddress failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ---------- Calendar helpers ----------

interface CalendarEvent {
  id: string;
  subject?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  organizer?: { emailAddress: { address: string; name?: string } };
  attendees?: Array<{ emailAddress: { address: string; name?: string }; type?: string }>;
  isAllDay?: boolean;
  location?: { displayName?: string };
  showAs?: string;
}

/**
 * Fetch all events that intersect [start, end]. Uses the calendarView endpoint
 * which expands recurring instances for us.
 */
async function getEventsInRange(startIso: string, endIso: string): Promise<CalendarEvent[]> {
  const url = `/me/calendarView?startDateTime=${encodeURIComponent(startIso)}&endDateTime=${encodeURIComponent(endIso)}&$select=id,subject,start,end,organizer,attendees,isAllDay,location,showAs&$orderby=start/dateTime&$top=50`;
  const res = await graphJSON<{ value: CalendarEvent[] }>(url, {
    // Ask Graph to return times in the user's local tz when possible — still
    // get ISO on the wire, just in a readable zone.
    headers: { Prefer: 'outlook.timezone="UTC"' },
  });
  return res.value ?? [];
}

function formatEventLine(ev: CalendarEvent): string {
  const s = new Date(ev.start.dateTime + "Z").toISOString().slice(0, 16).replace("T", " ");
  const e = new Date(ev.end.dateTime + "Z").toISOString().slice(0, 16).replace("T", " ");
  const subj = ev.subject ?? "(no subject)";
  const loc = ev.location?.displayName ? ` @ ${ev.location.displayName}` : "";
  return `  ${s} – ${e.slice(11)}  ${subj}${loc}`;
}

/** Render a compact multi-line summary suitable for prompt injection. */
function renderCalendarContext(events: CalendarEvent[], startIso: string, endIso: string): string {
  if (events.length === 0) {
    return `Calendar (${startIso.slice(0, 10)} → ${endIso.slice(0, 10)}): no events scheduled.`;
  }
  const lines = [`Calendar (${startIso.slice(0, 10)} → ${endIso.slice(0, 10)}) in UTC:`];
  for (const ev of events) lines.push(formatEventLine(ev));
  return lines.join("\n");
}

interface CreateEventInput {
  subject: string;
  startIso: string;          // "2026-04-28T14:00:00" (local time in timeZone)
  endIso: string;
  timeZone?: string;         // default UTC
  attendees?: string[];      // email addresses
  body?: string;             // plain text
  location?: string;
}

async function createEvent(input: CreateEventInput): Promise<CalendarEvent> {
  const body = {
    subject: input.subject,
    body: input.body ? { contentType: "Text", content: input.body } : undefined,
    start: { dateTime: input.startIso, timeZone: input.timeZone ?? "UTC" },
    end: { dateTime: input.endIso, timeZone: input.timeZone ?? "UTC" },
    location: input.location ? { displayName: input.location } : undefined,
    attendees: (input.attendees ?? []).map((addr) => ({
      emailAddress: { address: addr },
      type: "required",
    })),
  };
  return graphJSON<CalendarEvent>("/me/events", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Pull the next ~7 days of events for prompt context. Capped to 50 items so
 * we don't blow up the prompt on a busy week.
 */
async function fetchUpcomingEvents(): Promise<string> {
  try {
    const now = new Date();
    const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const events = await getEventsInRange(now.toISOString(), weekOut.toISOString());
    return renderCalendarContext(events, now.toISOString(), weekOut.toISOString());
  } catch (err) {
    debugLog(`fetchUpcomingEvents failed: ${err instanceof Error ? err.message : err}`);
    return "Calendar: (unavailable)";
  }
}

/**
 * Extract and execute [create-event:{...json...}] directives from Claude's
 * response. Returns the cleaned text plus a list of (subject, outcome) pairs
 * to surface in the email reply so the user sees what was actually booked.
 */
async function extractAndRunCreateEventDirectives(text: string): Promise<{
  cleanedText: string;
  outcomes: Array<{ ok: boolean; summary: string }>;
}> {
  const outcomes: Array<{ ok: boolean; summary: string }> = [];
  const pattern = /\[create-event:([\s\S]*?)\]/g;
  const matches: Array<{ raw: string; body: string }> = [];

  // Find all directives first so we don't mutate during iteration.
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    matches.push({ raw: m[0], body: m[1].trim() });
  }

  for (const match of matches) {
    let parsed: CreateEventInput | null = null;
    try {
      const obj = JSON.parse(match.body);
      if (typeof obj === "object" && obj !== null && typeof obj.subject === "string" && typeof obj.startIso === "string" && typeof obj.endIso === "string") {
        parsed = {
          subject: String(obj.subject),
          startIso: String(obj.startIso),
          endIso: String(obj.endIso),
          timeZone: typeof obj.timeZone === "string" ? obj.timeZone : "UTC",
          attendees: Array.isArray(obj.attendees) ? obj.attendees.filter((a: unknown) => typeof a === "string") : [],
          body: typeof obj.body === "string" ? obj.body : undefined,
          location: typeof obj.location === "string" ? obj.location : undefined,
        };
      }
    } catch (err) {
      debugLog(`[create-event] JSON parse failed: ${err instanceof Error ? err.message : err}`);
    }

    if (!parsed) {
      outcomes.push({ ok: false, summary: `Invalid create-event payload: ${match.body.slice(0, 80)}` });
      continue;
    }

    try {
      const ev = await createEvent(parsed);
      console.log(`[Outlook] Event created: "${ev.subject}" ${ev.start.dateTime} → ${ev.end.dateTime} (id=${ev.id})`);
      outcomes.push({
        ok: true,
        summary: `Booked "${ev.subject}" ${ev.start.dateTime} → ${ev.end.dateTime}${parsed.attendees?.length ? ` with ${parsed.attendees.join(", ")}` : ""}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Outlook] Event create failed: ${msg}`);
      outcomes.push({ ok: false, summary: `Failed to book "${parsed.subject}": ${msg}` });
    }
  }

  const cleanedText = text
    .replace(pattern, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, outcomes };
}

async function markAsRead(id: string): Promise<void> {
  try {
    await graphFetch(`/me/messages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
    });
  } catch (err) {
    debugLog(`markAsRead failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function sendReply(
  to: string,
  subject: string,
  text: string,
  inReplyTo?: string,
): Promise<void> {
  // Using /me/sendMail — create-and-send in a single call. For threading, we
  // use the Reply endpoint if we have the original message id, which keeps
  // the conversationId intact.
  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  if (inReplyTo) {
    const res = await graphFetch(`/me/messages/${encodeURIComponent(inReplyTo)}/reply`, {
      method: "POST",
      body: JSON.stringify({ comment: text }),
    });
    if (res.ok) return;
    debugLog(`Reply endpoint failed (${res.status}); falling back to sendMail`);
  }
  const res = await graphFetch("/me/sendMail", {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject: replySubject,
        body: { contentType: "Text", content: text },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`sendMail failed: ${res.status} ${errText}`);
  }
}

// ---------- Notification handling ----------

async function handleNotification(notification: WebhookNotification): Promise<void> {
  const state = await loadState();
  // Constant-time-ish check — these values are both opaque strings of equal
  // expected size. Length mismatch = reject fast.
  if (!state.clientState || notification.clientState !== state.clientState) {
    console.warn("[Outlook] Rejecting notification: clientState mismatch");
    return;
  }
  if (notification.changeType !== "created") return;
  const id = notification.resourceData?.id;
  if (!id) return;

  const cfg = getConfig();
  let message: GraphMessage;
  try {
    message = await fetchMessage(id);
  } catch (err) {
    console.error(`[Outlook] fetchMessage(${id}) failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const fromAddr = message.from?.emailAddress.address?.toLowerCase();
  if (!fromAddr) { debugLog(`No From on message ${id}`); return; }

  // Loop guard: if the authenticated user is emailing themselves (forwards,
  // self-replies, or an echo of our own outbound), skip. Our /reply would
  // otherwise bounce right back through this handler.
  const self = await getSelfAddress();
  if (self && fromAddr === self) {
    debugLog(`Skipping self-addressed message ${id} (from ${fromAddr})`);
    return;
  }

  // Default-deny allowlist (matches Telegram / Discord / WhatsApp).
  const allowed = (cfg.allowedSenders ?? []).map((s) => s.toLowerCase());
  if (allowed.length === 0) {
    console.warn(
      `[Outlook] Refusing message from ${fromAddr}: allowedSenders is empty. ` +
      `Add your own email address to outlook.allowedSenders to receive replies.`
    );
    return;
  }
  if (!allowed.includes(fromAddr)) {
    debugLog(`Sender ${fromAddr} not in allowlist`);
    return;
  }

  // Mark read as a soft ack — but don't gate processing on it. The subscription
  // is scoped to inbox/created events so our own replies (which go to Sent
  // Items) can't loop through here anyway.
  markAsRead(id).catch(() => {});

  const subject = message.subject ?? "(no subject)";
  const bodyText = textOf(message.body) || message.bodyPreview || "";

  // Fetch calendar + sender contact info in parallel with building the
  // prompt — each is one Graph call and adds a tiny amount of latency.
  const [calendarContext, senderContact] = await Promise.all([
    fetchUpcomingEvents(),
    lookupContact(fromAddr),
  ]);

  const senderLine = `[Outlook from ${message.from?.emailAddress.name ?? fromAddr} <${fromAddr}>]`;
  const promptParts = [senderLine];
  if (senderContact) promptParts.push(formatContactForPrompt(senderContact));
  promptParts.push(
    `Subject: ${subject}`,
    "",
    calendarContext,
    "",
    "To book a meeting, emit: [create-event:{\"subject\":\"...\",\"startIso\":\"2026-04-28T14:00:00\",\"endIso\":\"2026-04-28T14:30:00\",\"timeZone\":\"UTC\",\"attendees\":[\"someone@example.com\"]}] anywhere in your reply. The directive gets executed and stripped before the email is sent.",
    "",
    bodyText.slice(0, 20_000), // cap monster emails
  );
  const prompt = promptParts.join("\n");
  console.log(
    `[${new Date().toLocaleTimeString()}] Outlook ${fromAddr}: "${subject.slice(0, 60)}${subject.length > 60 ? "..." : ""}"`
  );

  try {
    const result = await runUserMessage("outlook", prompt);
    if (result.exitCode !== 0) {
      await sendReply(fromAddr, subject, `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`, id);
      return;
    }

    // Execute any [create-event:...] directives Claude emitted, strip them
    // from the reply, and append a short status footer so the human can see
    // what got booked (or didn't).
    const { cleanedText, outcomes } = await extractAndRunCreateEventDirectives(result.stdout || "");
    let replyBody = cleanedText || "(empty response)";
    if (outcomes.length > 0) {
      const footer = outcomes
        .map((o) => (o.ok ? `✓ ${o.summary}` : `✗ ${o.summary}`))
        .join("\n");
      replyBody = `${replyBody}\n\n--\nCalendar actions:\n${footer}`;
    }
    await sendReply(fromAddr, subject, replyBody, id);
  } catch (err) {
    console.error(`[Outlook] Handler error: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------- HTTP webhook server ----------

let server: ReturnType<typeof Bun.serve> | null = null;

export function startWebhookServer(debug = false): void {
  if (server) return;
  outlookDebug = debug;
  const cfg = getConfig();
  if (!cfg.clientId || !cfg.tenantId) {
    console.warn("[Outlook] Missing clientId/tenantId — not starting webhook");
    return;
  }

  server = Bun.serve({
    hostname: cfg.webhookHost,
    port: cfg.webhookPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== cfg.webhookPath) return new Response("Not found", { status: 404 });

      // Validation handshake — Microsoft calls GET (or POST with validationToken query param)
      // on subscription creation. Echo back the token in plain text within 10s.
      const validationToken = url.searchParams.get("validationToken");
      if (validationToken) {
        return new Response(validationToken, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

      let payload: { value?: WebhookNotification[] };
      try {
        payload = await req.json();
      } catch {
        return new Response("Bad request", { status: 400 });
      }

      // Ack fast; do the work in background.
      const notifications = payload.value ?? [];
      queueMicrotask(() => {
        Promise.all(
          notifications.map((n) => handleNotification(n).catch((err) =>
            console.error(`[Outlook] notification error: ${err instanceof Error ? err.message : err}`)
          ))
        );
      });
      return new Response("", { status: 202 });
    },
  });

  console.log(`[Outlook] Webhook listening on http://${cfg.webhookHost}:${cfg.webhookPort}${cfg.webhookPath}`);
  console.log(`  Client ID: ${cfg.clientId}`);
  console.log(`  Tenant: ${cfg.tenantId || "common"}`);
  console.log(
    `  Allowed senders: ${cfg.allowedSenders.length === 0 ? "NONE (all mail will be dropped)" : cfg.allowedSenders.join(", ")}`
  );
  if (outlookDebug) console.log("  Debug: enabled");

  // Kick off subscription (async), warm the self-address cache, and schedule renewal.
  (async () => {
    try {
      const self = await getSelfAddress();
      if (self) console.log(`[Outlook] Authenticated as ${self}`);
      await ensureSubscription();
      scheduleRenewal();
    } catch (err) {
      console.error(`[Outlook] Subscription setup failed: ${err instanceof Error ? err.message : err}`);
    }
  })();
}

export function stopWebhookServer(): void {
  if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
  if (!server) return;
  server.stop();
  server = null;
}

// ---------- Outbound send helper (used by heartbeat forwarding) ----------

export async function sendMessageToUser(email: string, text: string): Promise<void> {
  const res = await graphFetch("/me/sendMail", {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject: "OlaClaw notification",
        body: { contentType: "Text", content: text },
        toRecipients: [{ emailAddress: { address: email } }],
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`sendMail failed: ${res.status} ${t}`);
  }
}

// ---------- Standalone entry points ----------

/** `bun run src/index.ts outlook-auth` → trigger device code flow. */
export async function outlookAuth(): Promise<void> {
  await loadSettings();
  await startDeviceCodeFlow();
}

/** `bun run src/index.ts outlook` → run just the webhook server. */
export async function outlook(): Promise<void> {
  await loadSettings();
  await ensureProjectClaudeMd();
  startWebhookServer(false);
  process.on("SIGINT", () => { stopWebhookServer(); process.exit(0); });
  process.on("SIGTERM", () => { stopWebhookServer(); process.exit(0); });
  await new Promise(() => {});
}
