import type { NoticeLevel } from "./settings.js";

/**
 * Pushing notifications to a phone.
 *
 * Email is the only channel TrueNAS offers, and it is the one nobody reads on
 * a Saturday. A drive failing at 2am matters in the next ten minutes, not at
 * the next inbox check, so the same notices the console raises also go to
 * whatever the household actually has notifications turned on for.
 *
 * Each service is a different shape of POST, and none of them needs a library:
 * Discord wants an embed, Telegram wants query parameters on a bot URL, ntfy
 * wants the message as the body and everything else in headers.
 */

export type WebhookKind = "discord" | "telegram" | "ntfy" | "generic";

export interface Webhook {
  id: string;
  kind: WebhookKind;
  /** Discord/generic: the full URL. ntfy: server URL. Telegram: unused. */
  url: string;
  /** Telegram only. */
  botToken?: string;
  chatId?: string;
  /** ntfy only: the topic to publish to. */
  topic?: string;
  enabled: boolean;
  /** Only send things at least this serious. */
  level: NoticeLevel;
}

export interface Payload {
  level: NoticeLevel;
  title: string;
  detail: string;
  server: string;
  category: string;
}

const EMOJI: Record<NoticeLevel, string> = { bad: "🚨", warn: "⚠️", info: "🔵" };
const COLOUR: Record<NoticeLevel, number> = { bad: 0xf7_6a_6a, warn: 0xf5_b2_3d, info: 0x45_b8_f5 };

/**
 * Written the way somebody would say it out loud.
 *
 * A push notification is read on a lock screen in about a second. "Pool tank14
 * is 91% full" followed by what to do about it beats a formatted table nobody
 * can act on from a phone.
 */
export function friendly(p: Payload, name?: string): { title: string; body: string } {
  const who = name ? `Hey ${name}! ` : "";
  return {
    title: `${EMOJI[p.level]} ${p.title}`,
    body: `${who}${p.server ? `${p.server}: ` : ""}${p.detail}`,
  };
}

/**
 * Anything an HTTP header can legally carry.
 *
 * Header values are latin-1, so a pool nickname with an emoji or an accent in
 * it would otherwise throw before the request is even sent. Stripped rather
 * than encoded: this is a lock-screen title, and RFC 2047 word encoding is
 * shown literally by more clients than it is decoded by.
 */
const headerSafe = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[^\x20-\x7e\xa0-\xff]/g, "").replace(/\s+/g, " ").trim().slice(0, 200) || "Notification";

async function send(url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }
}

export async function deliver(hook: Webhook, p: Payload, name?: string): Promise<void> {
  const msg = friendly(p, name);

  switch (hook.kind) {
    case "discord":
      await send(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "EzNAS",
          embeds: [{
            title: msg.title,
            description: msg.body,
            color: COLOUR[p.level],
            footer: { text: p.server || "EzNAS" },
            timestamp: new Date().toISOString(),
          }],
        }),
      });
      return;

    case "telegram": {
      if (!hook.botToken || !hook.chatId) throw new Error("A Telegram webhook needs a bot token and a chat id.");
      await send(`https://api.telegram.org/bot${hook.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: hook.chatId,
          // Plain text: a pool called *tank* would otherwise be read as
          // markdown emphasis and silently lose its name.
          text: `${msg.title}\n\n${msg.body}`,
          disable_web_page_preview: true,
        }),
      });
      return;
    }

    case "ntfy": {
      const base = (hook.url || "https://ntfy.sh").replace(/\/+$/, "");
      if (!hook.topic) throw new Error("An ntfy webhook needs a topic.");
      await send(`${base}/${encodeURIComponent(hook.topic)}`, {
        method: "POST",
        headers: {
          // Headers, not JSON: ntfy reads the body as the message itself.
          //
          // And header values are latin-1. The emoji that makes the title
          // readable on a lock screen is three bytes of UTF-8 and throws
          // outright — "character at index 0 has a value of 55357". The emoji
          // goes in Tags instead, which is where ntfy wants it anyway, and it
          // renders it in front of the title on the device.
          Title: headerSafe(p.title),
          Priority: p.level === "bad" ? "urgent" : p.level === "warn" ? "high" : "default",
          Tags: p.level === "bad" ? "rotating_light" : p.level === "warn" ? "warning" : "information_source",
          "content-type": "text/plain; charset=utf-8",
        },
        // The body is UTF-8 and may hold anything.
        body: msg.body,
      });
      return;
    }

    default:
      await send(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          level: p.level,
          category: p.category,
          server: p.server,
          title: p.title,
          detail: p.detail,
          text: `${msg.title} — ${msg.body}`,
          at: new Date().toISOString(),
        }),
      });
  }
}

/** What a hook needs before it can be saved, so a broken one is caught here. */
export function validate(h: Partial<Webhook>): string | null {
  if (h.kind === "telegram") {
    if (!h.botToken?.trim()) return "A Telegram webhook needs the bot token from @BotFather.";
    if (!h.chatId?.trim()) return "A Telegram webhook needs the chat id to send to.";
    return null;
  }
  if (h.kind === "ntfy") {
    if (!h.topic?.trim()) return "An ntfy webhook needs a topic.";
    return null;
  }
  if (!h.url?.trim()) return "This needs the webhook URL.";
  try {
    const u = new URL(h.url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "That is not an http or https URL.";
  } catch {
    return "That is not a valid URL.";
  }
  return null;
}
