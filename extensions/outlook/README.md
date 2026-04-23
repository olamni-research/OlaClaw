# Outlook 365 / Microsoft Graph extension for OlaClaw

Receive emails in OlaClaw via Microsoft Graph webhook notifications and respond using Claude, with the same security pattern as the Telegram / Discord / WhatsApp integrations.

## What you get

- Inbound email (text + HTML, auto-stripped) → Claude → threaded reply via Graph
- Outbound email for heartbeat / job forwarding via `sendMessageToUser()`
- Default-deny allowlist on the `From:` address
- Device-code OAuth flow — no client secret, no redirect URI, no password
- Automatic access-token refresh (the refresh token is cached locally, chmod 0600)
- Subscription auto-renewal before the ~70h Microsoft expiry
- `clientState` check on every notification to reject spoofed webhooks

## Prerequisites (Azure side)

1. An **Azure AD app registration** at [portal.azure.com](https://portal.azure.com) → App registrations → New registration.
   - Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
   - Redirect URI: leave blank (we use device code flow)
2. **API permissions** → Microsoft Graph → **Delegated**:
   - `User.Read`, `Mail.Read`, `Mail.Send`, `Mail.ReadWrite`, `offline_access`
3. Grab the **Application (client) ID** and **Directory (tenant) ID** from the Overview page. `common` works as tenant for personal + work accounts.

## Setup

### 1. Configure OlaClaw

Add an `outlook` block to `.claude/olaclaw/settings.json`:

```json
{
  "outlook": {
    "clientId": "00000000-0000-0000-0000-000000000000",
    "tenantId": "common",
    "allowedSenders": ["you@example.com"],
    "webhookPath": "/outlook/webhook",
    "webhookHost": "127.0.0.1",
    "webhookPort": 4634,
    "publicUrl": "https://your-tunnel.ngrok-free.dev"
  }
}
```

`allowedSenders` is default-deny: leave it empty and the handler will refuse every email.

### 2. Authenticate once

```bash
olaclaw outlook auth
```

This runs the device-code flow. You'll see something like:

```
To sign in, use a web browser to open the page https://microsoft.com/devicelogin
and enter the code A1B2C3D4.
```

Sign in, approve, done. Tokens land at `.claude/olaclaw/outlook-tokens.json` (`chmod 0600` on Linux/macOS). OlaClaw refreshes them automatically after that.

### 3. Expose the webhook

Microsoft's servers need to reach your webhook. Easiest for dev:

```bash
ngrok http 4634
```

Grab the `https://...ngrok-free.dev` URL and paste it into `outlook.publicUrl` in `settings.json`.

### 4. Start OlaClaw

```bash
olaclaw start
```

You'll see `Outlook: enabled` and the subscription get created. Microsoft validates the webhook by hitting it with a `validationToken` query param, which we echo back. After that you're live — send yourself an email from an allowed address and it'll route through Claude.

## Security notes

- **`clientState` is checked on every notification.** We generate a random 48-char hex value on subscription creation, store it in `.claude/olaclaw/outlook-state.json`, and reject any notification whose `clientState` doesn't match.
- **Tokens stay local.** `outlook-tokens.json` is chmod 0600 on Linux/macOS; don't commit it (`.claude/` is gitignored).
- **Default-deny allowlist.** Email is a spam vector — empty `allowedSenders` means the handler rejects everything. Add your own address (+ any teammate you want to trust) before expecting replies.
- **Subscription expiry is ~70h max.** We auto-renew 24h before that. If the daemon is offline for >70h the subscription dies silently and you'll need to restart OlaClaw to re-create it.

## Limitations (first cut)

- **Plain text replies only.** HTML outbound support is a nice-to-have but would need a proper sanitiser on the incoming side.
- **No attachment support.** Inbound attachments are ignored; outbound can't send any.
- **No read-receipt / heartbeat forwarding toggle yet** — add an `outlook.sendMessageToUser` call manually if you want this.
- **Single user only.** The Azure app is registered against one user's mailbox. For multi-tenant use, you'd want admin consent + a different flow.

## File layout

```
extensions/outlook/
├── README.md       ← this file
└── outlook.ts      ← device code auth + subscription + webhook + message handler
```

Core integration:
- `src/config.ts` — `OutlookConfig` schema + parser
- `src/commands/start.ts` — `initOutlook` wired into the daemon lifecycle
- `src/index.ts` — `olaclaw outlook auth` entry point

## Troubleshooting

**`Device code expired — run auth again`** — you waited more than ~15 min to approve. Just rerun `olaclaw outlook auth`.

**Subscription creation fails with `403`** — double-check your API permissions include `Mail.ReadWrite` and that you granted admin consent (work accounts only; personal accounts don't need it).

**Validation handshake failing (Microsoft returns an error when creating subscription)** — your `publicUrl` isn't reachable, or ngrok isn't running, or the path mismatches `webhookPath`. Check ngrok's web UI at `http://127.0.0.1:4040` for the incoming GET request.

**No notifications arriving but mail is hitting the inbox** — the subscription might have expired. Check `.claude/olaclaw/outlook-state.json` for `subscriptionExpiresAt`. Restart the daemon to force re-creation.
