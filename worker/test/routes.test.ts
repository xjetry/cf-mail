import test from "node:test";
import assert from "node:assert/strict";
import app, { type Env } from "../src/admin.ts";
import { ForwardStoreEngine, type StorageLike } from "../src/store-engine.ts";

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

function makeEnv() {
  const engine = new ForwardStoreEngine(new MemoryStorage());
  const env = {
    ADMIN_TOKEN: "adm_secret",
    MAIL_DOMAIN: "team.test",
    FORWARD_STORE: {
      idFromName: () => "global",
      get: () => engine,
    },
  } as unknown as Env;
  return { env, engine };
}

test("admin creates inbox-only rule, user polls /api/inbox with cfmk_ key and cannot touch /admin/*", async () => {
  const { env, engine } = makeEnv();

  // 1. Admin creates inbox-only rule with allowedSenders
  const putRes = await app.request(
    "http://localhost/admin/api/rules/claude01",
    {
      method: "PUT",
      headers: {
        Authorization: "Bearer adm_secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targets: [],
        inboxEnabled: true,
        allowedSenders: ["anthropic.com"],
      }),
    },
    env,
  );
  assert.equal(putRes.status, 200);
  const putJson = (await putRes.json()) as { rule: { address: string; inboxKey: string } };
  assert.equal(putJson.rule.address, "claude01@team.test");
  const userKey = putJson.rule.inboxKey;
  assert.match(userKey, /^cfmk_/);

  // 2. User cfmk_ key MUST NOT access /admin/api/rules
  const forbidRes = await app.request(
    "http://localhost/admin/api/rules",
    { headers: { Authorization: `Bearer ${userKey}` } },
    env,
  );
  assert.equal(forbidRes.status, 401);

  // 3. Deliver a simulated message into inbox
  await engine.saveInboxMessage({
    from: "noreply@mail.anthropic.com",
    to: "claude01@team.test",
    subject: "Sign in to Claude",
    messageId: "<id-1>",
    text: "Click to sign in",
    links: ["https://claude.ai/magic-link#tok123"],
    codes: ["654321"],
  });

  // 4. User polls /api/inbox?unread=1&consume=1 via ?key= query param
  const poll1 = await app.request(
    `http://localhost/api/inbox?unread=1&consume=1&key=${userKey}`,
    {},
    env,
  );
  assert.equal(poll1.status, 200);
  const poll1Json = (await poll1.json()) as {
    address: string;
    messages: Array<{ id: string; links: string[]; read: boolean }>;
  };
  assert.equal(poll1Json.address, "claude01@team.test");
  assert.equal(poll1Json.messages.length, 1);
  assert.equal(poll1Json.messages[0].links[0], "https://claude.ai/magic-link#tok123");

  // 5. Next unread=1 poll returns 0 messages
  const poll2 = await app.request(
    "http://localhost/api/inbox?unread=1",
    { headers: { Authorization: `Bearer ${userKey}` } },
    env,
  );
  const poll2Json = (await poll2.json()) as { messages: unknown[] };
  assert.equal(poll2Json.messages.length, 0);

  // 6. Admin rotates inboxKey -> old userKey returns 401 immediately
  const rotRes = await app.request(
    "http://localhost/admin/api/rules/claude01/inbox-key",
    {
      method: "POST",
      headers: { Authorization: "Bearer adm_secret" },
    },
    env,
  );
  assert.equal(rotRes.status, 200);
  const oldKeyPoll = await app.request(
    "http://localhost/api/inbox",
    { headers: { Authorization: `Bearer ${userKey}` } },
    env,
  );
  assert.equal(oldKeyPoll.status, 401);
});
