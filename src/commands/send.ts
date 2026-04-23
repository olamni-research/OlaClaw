import { runUserMessage } from "../runner";
import { getSession } from "../sessions";
import { loadSettings, initConfig } from "../config";

export async function send(args: string[]) {
  const telegramFlag = args.includes("--telegram");
  const discordFlag = args.includes("--discord");
  const whatsappFlag = args.includes("--whatsapp");
  const message = args
    .filter((a) => a !== "--telegram" && a !== "--discord" && a !== "--whatsapp")
    .join(" ");

  if (!message) {
    console.error("Usage: olaclaw send <message> [--telegram] [--discord] [--whatsapp]");
    process.exit(1);
  }

  await initConfig();
  await loadSettings();

  const session = await getSession();
  if (!session) {
    console.error("No active session. Start the daemon first.");
    process.exit(1);
  }

  const result = await runUserMessage("send", message);
  console.log(result.stdout);

  if (telegramFlag) {
    const settings = await loadSettings();
    const token = settings.telegram.token;
    const userIds = settings.telegram.allowedUserIds;

    if (!token || userIds.length === 0) {
      console.error("Telegram is not configured in settings.");
      process.exit(1);
    }

    const text = result.exitCode === 0
      ? result.stdout || "(empty)"
      : `error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;

    for (const userId of userIds) {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: userId, text }),
        }
      );
      if (!res.ok) {
        console.error(`Failed to send to Telegram user ${userId}: ${res.statusText}`);
      }
    }
    console.log("Sent to Telegram.");
  }

  if (discordFlag) {
    const settings = await loadSettings();
    const dToken = settings.discord.token;
    const dUserIds = settings.discord.allowedUserIds;

    if (!dToken || dUserIds.length === 0) {
      console.error("Discord is not configured in settings.");
      process.exit(1);
    }

    const dText = result.exitCode === 0
      ? result.stdout || "(empty)"
      : `error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;

    for (const userId of dUserIds) {
      // Create DM channel
      const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
        method: "POST",
        headers: {
          Authorization: `Bot ${dToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ recipient_id: userId }),
      });
      if (!dmRes.ok) {
        console.error(`Failed to create DM for Discord user ${userId}: ${dmRes.statusText}`);
        continue;
      }
      const { id: channelId } = (await dmRes.json()) as { id: string };
      const msgRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${dToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: dText.slice(0, 2000) }),
      });
      if (!msgRes.ok) {
        console.error(`Failed to send to Discord user ${userId}: ${msgRes.statusText}`);
      }
    }
    console.log("Sent to Discord.");
  }

  if (whatsappFlag) {
    const settings = await loadSettings();
    const wa = settings.whatsapp;
    if (!wa.token || !wa.phoneNumberId || wa.allowedPhoneNumbers.length === 0) {
      console.error("WhatsApp is not configured in settings.");
      process.exit(1);
    }
    const text = result.exitCode === 0
      ? result.stdout || "(empty)"
      : `error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;

    for (const phone of wa.allowedPhoneNumbers) {
      const res = await fetch(
        `https://graph.facebook.com/${wa.apiVersion}/${wa.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${wa.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: phone,
            type: "text",
            text: { body: text.slice(0, 4096), preview_url: false },
          }),
        }
      );
      if (!res.ok) {
        const body = await res.text();
        console.error(`Failed to send to WhatsApp ${phone}: ${res.status} ${body}`);
      }
    }
    console.log("Sent to WhatsApp.");
  }

  if (result.exitCode !== 0) process.exit(result.exitCode);
}
