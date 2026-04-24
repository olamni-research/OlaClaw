# Microsoft Teams Chat extension for OlaClaw

Receive Teams 1:1 and group chat messages in OlaClaw and respond using Claude. Shares the same Azure AD app / auth tokens as the Outlook extension.

## Why polling, not webhooks

Microsoft charges **per notification** for Teams chat change notifications (metered billing tied to the tenant). For a personal-assistant use case the cost-vs-latency tradeoff isn't worth it, so this extension **polls** `/me/chats/getAllMessages` every 45s by default. Messages show up with at most 30–60s latency and the Graph API cost is $0.

If you ever want real-time, switch to a subscription model — the code here can be adapted, but be ready to configure Azure billing.

## Prerequisites

- You've already set up the **Outlook extension** (`extensions/outlook/README.md`) and run `olaclaw outlook auth`. Teams reuses Outlook's cached access/refresh tokens.
- Azure AD app has `Chat.ReadWrite` + `ChatMessage.Send` delegated permissions. If you followed the Outlook setup with the recommended minimal scope set, these are already granted.

## Setup

Add a `teams` block to `.claude/olaclaw/settings.json`:

```json
{
  "teams": {
    "enabled": true,
    "pollIntervalSeconds": 45,
    "allowedChatMembers": ["colleague@bancstreet.com"]
  }
}
```

`allowedChatMembers` is default-deny: emails or AAD user IDs allowed to trigger Claude. Leave empty and no Teams message will be processed.

Restart the daemon — you'll see `Teams: enabled` and a poll every 45s.

## How it works

1. Every 45s, OlaClaw calls `GET /me/chats/getAllMessages?$filter=lastModifiedDateTime gt {last}&$orderby=lastModifiedDateTime desc`.
2. For each new message:
   - Skip if it's from the authenticated user (loop guard).
   - Skip if the sender's email isn't in `allowedChatMembers`.
   - Build a prompt with `[Teams from <name> <email>] Message: ...`
   - Send to Claude via `runUserMessage("teams", prompt)`.
   - Post the stdout back to the same chat via `POST /chats/{chatId}/messages`.
3. Dedupe by message ID (rolling cache of last 500 IDs) so duplicates across polls get filtered.

## State files

- `.claude/olaclaw/teams-state.json` — persists `lastSeenIso` (poll cursor) + message ID dedupe set. Safe to delete; it'll rebuild on the next poll.
- Tokens: shared with Outlook at `.claude/olaclaw/outlook-tokens.json`.

## Limitations

- **1:1 and group chats only.** `Chat.ReadWrite` doesn't cover Teams **channels** (team posts) — that needs `ChannelMessage.Read.All` + admin consent + Resource Specific Consent (RSC).
- **Messages appear as you**, not a bot. Delegated flow has no bot identity.
- **Polling-only.** No real-time. Ok for personal use.
- **No attachments / mentions / cards.** Plain text replies only.
- **Rate limits:** Graph allows ~30 req/s per app per tenant; polling at 45s is well under that, but sending a burst of replies back-to-back can hit 15 msg/s per chat.

## File layout

```
extensions/teams/
├── README.md       ← this file
└── teams.ts        ← polling loop, allowlist, send-reply, dedupe
```

Core integration:
- `src/config.ts` — `TeamsConfig` schema
- `src/commands/start.ts` — `initTeams` in the daemon lifecycle (gated on Outlook being configured since we share tokens)
- `extensions/outlook/outlook.ts` — shared auth (`graphJSON`, `graphFetch`, `getSelfAddress`)

## Troubleshooting

**`Teams: not configured` on boot** — you haven't set `teams.enabled: true` in settings.json, OR the Outlook extension isn't configured (Teams depends on it for auth).

**`403` on the first poll** — the cached Outlook token doesn't have `Chat.ReadWrite` yet. Re-run `olaclaw outlook auth` to refresh the token with the new scopes.

**Empty poll every cycle, but you can see messages in Teams** — check `allowedChatMembers` is populated with the right email. Graph returns the sender's email via a separate `/users/{id}` lookup; if that fails (e.g. external user not in your directory), the allowlist check compares against the AAD user ID instead — add the GUID if needed.
