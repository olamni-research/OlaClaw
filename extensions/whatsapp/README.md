# WhatsApp Business extension for OlaClaw

Receive WhatsApp messages in OlaClaw via Meta's WhatsApp Cloud API and respond using Claude, mirroring the Telegram / Discord integrations.

## What you get

- Inbound text, images, voice (auto-transcribed), and documents
- Outbound text with chunking at 4096 chars
- Outbound files via `[send-file:path]` — auto-classifies as image / audio / video / document
- Native WhatsApp reactions via the standard `[react:<emoji>]` directive
- Default-deny allowlist (empty list blocks everyone)
- HMAC-SHA256 webhook signature verification — unsigned/mismatched requests get 403
- Built-in commands: `/start`, `/reset`, `/status`, `/context`, `/compact`; skill slash commands also resolve

## Prerequisites (Meta side)

1. A [Meta for Developers](https://developers.facebook.com/) app configured with the WhatsApp product.
2. A verified WhatsApp Business phone number — grab its **Phone Number ID**.
3. A **permanent access token** (System User → generate token with `whatsapp_business_messaging` and `whatsapp_business_management` scopes).
4. The **App Secret** (App settings → Basic → show). Used to verify webhook signatures.
5. A **verify token** — any random string you choose. You'll paste it both into OlaClaw settings and into Meta's webhook subscription UI.

## Setup

### 1. Configure OlaClaw

Add the `whatsapp` block to `.claude/olaclaw/settings.json`:

```json
{
  "whatsapp": {
    "token": "EAAG...PERMANENT_TOKEN",
    "phoneNumberId": "123456789012345",
    "appSecret": "abcdef0123456789abcdef0123456789",
    "verifyToken": "pick-a-random-string",
    "allowedPhoneNumbers": ["15551234567"],
    "apiVersion": "v21.0",
    "webhookPath": "/whatsapp/webhook",
    "webhookHost": "127.0.0.1",
    "webhookPort": 4633
  }
}
```

**`allowedPhoneNumbers`**: E.164 digits only, no leading `+`. These are the numbers OlaClaw will respond to — everyone else is rejected silently.

### 2. Expose the webhook publicly

Meta can't hit `127.0.0.1:4633`. Put a TLS-terminating reverse proxy (Caddy / nginx / Cloudflare Tunnel) in front of it:

```
https://your-domain.example/whatsapp/webhook  →  http://127.0.0.1:4633/whatsapp/webhook
```

Keep the host bound to `127.0.0.1` — the proxy is your only exposed surface.

### 3. Subscribe the webhook in Meta

In the app's WhatsApp → Configuration page:

- **Callback URL**: `https://your-domain.example/whatsapp/webhook`
- **Verify token**: same string you put in `settings.json`
- **Subscribe to fields**: at minimum, `messages`

Meta will hit the callback with a `GET` carrying `hub.verify_token` — OlaClaw will echo the challenge back if the token matches.

### 4. Start OlaClaw

```bash
olaclaw start
```

You'll see `WhatsApp: enabled` and the webhook listening line. Send yourself a message from one of your allowed numbers and it'll route through Claude.

## Security notes

- **Signature verification is mandatory.** Requests without a valid `X-Hub-Signature-256` header get rejected. If you see `signature mismatch` in logs, double-check `appSecret`.
- **Don't commit `settings.json`.** Tokens live there in plaintext. On Linux/macOS the file is `chmod 0600` automatically.
- **Keep `webhookHost` at `127.0.0.1`.** If you bind to `0.0.0.0`, anyone on your network could hit the raw HTTP server (still signature-protected, but unnecessary attack surface).
- **Allowlist everyone you want to talk to.** Empty list = bot is mute. This is intentional — a misconfigured bot with an open allowlist is a prompt-injection vector into a Claude session with tool access.

## Limitations

- Group messaging — WhatsApp's Cloud API doesn't expose groups yet, so this extension is 1:1 only.
- No template messages. The 24-hour customer service window applies: the user has to message you first, then you have 24 hours to reply freely.
- Unknown file extensions fall back to `application/octet-stream` and are sent as documents — check WhatsApp's [supported media types](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media) if something doesn't render.

## File layout

```
extensions/whatsapp/
├── README.md          ← this file
└── whatsapp.ts        ← webhook server + message handler
```

Core integration lives in:
- `src/config.ts` — adds the `whatsapp` block to `Settings`
- `src/commands/start.ts` — wires `initWhatsApp` into the daemon lifecycle
