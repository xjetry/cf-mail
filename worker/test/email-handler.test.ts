import test from "node:test";
import assert from "node:assert/strict";
import { handleIncomingEmail } from "../src/email-handler.ts";
import { ForwardStoreEngine, type StorageLike } from "../src/store-engine.ts";
import type { Env } from "../src/admin.ts";

class MemoryStorage implements StorageLike {
  private data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : structuredClone(v as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      let c = 0;
      for (const k of keyOrKeys) if (this.data.delete(k)) c++;
      return c;
    }
    return this.data.delete(keyOrKeys);
  }
  async list<T>(opts?: {
    prefix?: string;
    limit?: number;
    reverse?: boolean;
  }): Promise<Map<string, T>> {
    let keys = [...this.data.keys()].sort();
    if (opts?.prefix) keys = keys.filter((k) => k.startsWith(opts.prefix!));
    if (opts?.reverse) keys.reverse();
    if (opts?.limit !== undefined) keys = keys.slice(0, opts.limit);
    const out = new Map<string, T>();
    for (const k of keys) out.set(k, structuredClone(this.data.get(k) as T));
    return out;
  }
}

function makeFakeMessage(opts: {
  from: string;
  to: string;
  subject: string;
  bodyHtml: string;
}) {
  const mime = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    "Message-ID: <msg-123@anthropic.com>",
    "Content-Type: text/html; charset=utf-8",
    "",
    opts.bodyHtml,
  ].join("\r\n");

  const bytes = new TextEncoder().encode(mime);
  let rejectedReason: string | null = null;
  const forwarded: string[] = [];

  const msg = {
    from: opts.from,
    to: opts.to,
    headers: new Headers({
      subject: opts.subject,
      "message-id": "<msg-123@anthropic.com>",
    }),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    rawSize: bytes.byteLength,
    setReject(reason: string) {
      rejectedReason = reason;
    },
    async forward(dest: string) {
      forwarded.push(dest);
    },
    async reply() {},
  } as unknown as ForwardableEmailMessage;

  return {
    msg,
    getRejected: () => rejectedReason,
    getForwarded: () => forwarded,
  };
}

test("handleIncomingEmail accepts anthropic mail into inbox without forwarding and rejects unauthorized sender", async () => {
  const engine = new ForwardStoreEngine(new MemoryStorage());
  const env = {
    ADMIN_TOKEN: "adm",
    MAIL_DOMAIN: "team.test",
    FORWARD_STORE: {
      idFromName: () => "global",
      get: () => engine,
    },
  } as unknown as Env;

  await engine.setRule("pool01", [], "team.test", {
    inboxEnabled: true,
    allowedSenders: ["anthropic.com"],
  });

  // 1. Unauthorized sender gets rejected
  const spam = makeFakeMessage({
    from: "spam@evil.org",
    to: "pool01@team.test",
    subject: "Verify account",
    bodyHtml: '<a href="https://evil.org/v">click</a>',
  });
  await handleIncomingEmail(spam.msg, env);
  assert.equal(spam.getRejected(), "Sender not allowed for this address");
  assert.equal((await engine.queryInbox({ address: "pool01@team.test" })).length, 0);

  // 2. Anthropic sender is accepted without forwarding and stored with parsed links
  const invite = makeFakeMessage({
    from: "noreply@mail.anthropic.com",
    to: "pool01@team.test",
    subject: "You are invited to join Claude Team",
    bodyHtml:
      '<p>Join now: <a href="https://claude.ai/accept-invite?token=abc&amp;org=xyz">Accept</a></p>',
  });
  await handleIncomingEmail(invite.msg, env);
  assert.equal(invite.getRejected(), null);
  assert.deepEqual(invite.getForwarded(), []);

  const stored = await engine.queryInbox({ address: "pool01@team.test" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].links[0], "https://claude.ai/accept-invite?token=abc&org=xyz");

  const logs = await engine.listLogs(5);
  assert.deepEqual(logs[0].forwardedTo, ["[inbox]"]);
});
