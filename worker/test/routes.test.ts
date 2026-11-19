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

test("multi-tenant RBAC: admin manages tokens, tenant manages only authorized rules without reading inbox or deleting rules, user self-rotates cfmk_", async () => {
  const { env, engine } = makeEnv();
  const adminHeaders = {
    Authorization: "Bearer adm_secret",
    "Content-Type": "application/json",
  };

  // 1. Admin creates an existing private rule that tenant is NOT authorized to see
  await app.request(
    "http://localhost/admin/api/rules/secret",
    {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ targets: ["boss@corp.com"] }),
    },
    env,
  );

  // 2. Admin creates a tenant token authorizing a1 and a2 (auto-initializing placeholder rules)
  const createTokRes = await app.request(
    "http://localhost/admin/api/tokens",
    {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "渠道A", addresses: ["a1", "a2"] }),
    },
    env,
  );
  assert.equal(createTokRes.status, 200);
  const { token: tenantRecord } = (await createTokRes.json()) as {
    token: { id: string; name: string; token: string; addresses: string[] };
  };
  assert.match(tenantRecord.token, /^cfmt_/);
  assert.deepEqual(tenantRecord.addresses, ["a1@team.test", "a2@team.test"]);

  const tenantHeaders = {
    Authorization: `Bearer ${tenantRecord.token}`,
    "Content-Type": "application/json",
  };

  // 3. /api/session identifies admin, tenant, and user accurately
  const admSession = await app.request(
    "http://localhost/api/session",
    { headers: adminHeaders },
    env,
  );
  assert.equal(admSession.status, 200);
  assert.equal(((await admSession.json()) as { role: string }).role, "admin");

  const tenSession = await app.request(
    `http://localhost/api/session?key=${tenantRecord.token}`,
    {},
    env,
  );
  assert.equal(tenSession.status, 200);
  const tenSessionBody = (await tenSession.json()) as {
    role: string;
    token: { id: string; name: string; addresses: string[]; token?: string };
  };
  assert.equal(tenSessionBody.role, "tenant");
  assert.equal(tenSessionBody.token.name, "渠道A");
  assert.equal(tenSessionBody.token.token, undefined);

  // 4. Tenant CANNOT manage tokens
  const forbidTokens = await app.request(
    "http://localhost/admin/api/tokens",
    { headers: tenantHeaders },
    env,
  );
  assert.equal(forbidTokens.status, 403);

  // 5. Tenant lists rules -> sees ONLY a1 and a2, NOT secret@team.test
  const listRes = await app.request(
    "http://localhost/admin/api/rules",
    { headers: tenantHeaders },
    env,
  );
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as {
    rules: Array<{ address: string }>;
  };
  assert.deepEqual(
    listBody.rules.map((r) => r.address),
    ["a1@team.test", "a2@team.test"],
  );

  // 6. Tenant CANNOT read or modify unauthorized rule, create new rule, rename rule, or delete authorized rule
  assert.equal(
    (
      await app.request(
        "http://localhost/admin/api/rules/secret",
        { headers: tenantHeaders },
        env,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request(
        "http://localhost/admin/api/rules/newbox",
        {
          method: "PUT",
          headers: tenantHeaders,
          body: JSON.stringify({ targets: ["x@y.com"] }),
        },
        env,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request(
        "http://localhost/admin/api/rules/a1",
        {
          method: "PUT",
          headers: tenantHeaders,
          body: JSON.stringify({ address: "a2", targets: ["x@y.com"] }),
        },
        env,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request(
        "http://localhost/admin/api/rules/a1",
        { method: "DELETE", headers: tenantHeaders },
        env,
      )
    ).status,
    403,
  );

  // 7. Tenant CAN configure targets, allowedSenders, inboxEnabled, and rotate/revoke inbox-key on authorized a1
  const updateA1 = await app.request(
    "http://localhost/admin/api/rules/a1",
    {
      method: "PUT",
      headers: tenantHeaders,
      body: JSON.stringify({
        targets: ["forward@client.com"],
        inboxEnabled: true,
        allowedSenders: ["anthropic.com"],
      }),
    },
    env,
  );
  assert.equal(updateA1.status, 200);
  const a1Data = (await updateA1.json()) as {
    rule: { address: string; inboxKey: string; inboxEnabled: boolean };
  };
  const key1 = a1Data.rule.inboxKey;
  assert.match(key1, /^cfmk_/);

  // Tenant can toggle target enabled & check destination status
  const toggleRes = await app.request(
    "http://localhost/admin/api/rules/a1/targets",
    {
      method: "PATCH",
      headers: tenantHeaders,
      body: JSON.stringify({ target: "forward@client.com", enabled: false }),
    },
    env,
  );
  assert.equal(toggleRes.status, 200);

  const destStatusRes = await app.request(
    "http://localhost/admin/api/destinations/status?addresses=forward@client.com",
    { headers: tenantHeaders },
    env,
  );
  assert.equal(destStatusRes.status, 200);

  // 8. Incoming mail arrives at a1 and secret; logs recorded for both
  await engine.saveInboxMessage({
    from: "noreply@anthropic.com",
    to: "a1@team.test",
    subject: "Login code 998877",
    messageId: "<m-a1>",
    text: "Your code is 998877",
    links: [],
    codes: ["998877"],
  });
  await engine.logDelivery({
    from: "noreply@anthropic.com",
    to: "a1@team.test",
    subject: "Login code 998877",
    messageId: "<m-a1>",
    forwardedTo: ["[inbox]"],
  });
  await engine.logDelivery({
    from: "ceo@corp.com",
    to: "secret@team.test",
    subject: "Confidential M&A",
    messageId: "<m-sec>",
    forwardedTo: ["boss@corp.com"],
  });

  // 9. Tenant CANNOT read inbox or watch slots under any endpoint
  assert.equal(
    (
      await app.request(
        "http://localhost/admin/api/inbox?to=a1@team.test",
        { headers: tenantHeaders },
        env,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request(
        "http://localhost/api/inbox",
        { headers: tenantHeaders },
        env,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await app.request(
        "http://localhost/admin/api/inbox/watch",
        {
          method: "POST",
          headers: tenantHeaders,
          body: JSON.stringify({ address: "a1" }),
        },
        env,
      )
    ).status,
    403,
  );

  // 10. Tenant CAN read logs ONLY for authorized addresses, with subject redacted
  const tenantLogsRes = await app.request(
    "http://localhost/admin/api/logs",
    { headers: tenantHeaders },
    env,
  );
  assert.equal(tenantLogsRes.status, 200);
  const tenantLogsBody = (await tenantLogsRes.json()) as {
    logs: Array<{ to: string; subject: string }>;
  };
  assert.equal(tenantLogsBody.logs.length, 1);
  assert.equal(tenantLogsBody.logs[0].to, "a1@team.test");
  assert.equal(tenantLogsBody.logs[0].subject, "");

  // 11. User with cfmk_ can check /api/session, read inbox, and self-rotate inbox-key
  const userSess = await app.request(
    `http://localhost/api/session?key=${key1}`,
    {},
    env,
  );
  assert.equal(userSess.status, 200);
  assert.deepEqual(await userSess.json(), {
    role: "user",
    domain: "team.test",
    address: "a1@team.test",
  });

  const userRotRes = await app.request(
    "http://localhost/api/inbox/rotate-key",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key1}` },
    },
    env,
  );
  assert.equal(userRotRes.status, 200);
  const userRotBody = (await userRotRes.json()) as {
    address: string;
    inboxKey: string;
  };
  assert.equal(userRotBody.address, "a1@team.test");
  assert.match(userRotBody.inboxKey, /^cfmk_/);
  assert.notEqual(userRotBody.inboxKey, key1);

  // Old key immediately fails; new key reads message
  assert.equal(
    (
      await app.request(
        "http://localhost/api/inbox",
        { headers: { Authorization: `Bearer ${key1}` } },
        env,
      )
    ).status,
    401,
  );
  const newPoll = await app.request(
    `http://localhost/api/inbox?key=${userRotBody.inboxKey}`,
    {},
    env,
  );
  assert.equal(newPoll.status, 200);

  // 12. Tenant can also turn off inboxEnabled on a2 even with empty targets (pausing mailbox without deleting)
  const pauseA2 = await app.request(
    "http://localhost/admin/api/rules/a2",
    {
      method: "PUT",
      headers: tenantHeaders,
      body: JSON.stringify({ targets: [], inboxEnabled: false }),
    },
    env,
  );
  assert.equal(pauseA2.status, 200);

  // 13. Admin token lifecycle: update (disable/enable/expiresAt/addresses), rotate, list, delete
  const disableTokRes = await app.request(
    `http://localhost/admin/api/tokens/${tenantRecord.id}`,
    {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ enabled: false, name: "渠道A-暂停" }),
    },
    env,
  );
  assert.equal(disableTokRes.status, 200);

  // Disabled tenant token immediately gets 401
  assert.equal(
    (
      await app.request(
        "http://localhost/admin/api/rules",
        { headers: tenantHeaders },
        env,
      )
    ).status,
    401,
  );

  // Re-enable and rotate tenant token
  await app.request(
    `http://localhost/admin/api/tokens/${tenantRecord.id}`,
    {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ enabled: true, addresses: ["a1"] }),
    },
    env,
  );
  const rotTokRes = await app.request(
    `http://localhost/admin/api/tokens/${tenantRecord.id}/rotate`,
    { method: "POST", headers: adminHeaders },
    env,
  );
  assert.equal(rotTokRes.status, 200);
  const { token: rotatedTenant } = (await rotTokRes.json()) as {
    token: { token: string; addresses: string[] };
  };
  assert.notEqual(rotatedTenant.token, tenantRecord.token);
  assert.deepEqual(rotatedTenant.addresses, ["a1@team.test"]);

  // Old tenant token gets 401; new tenant token sees only a1
  assert.equal(
    (
      await app.request(
        "http://localhost/admin/api/rules",
        { headers: tenantHeaders },
        env,
      )
    ).status,
    401,
  );
  const newTenantList = await app.request(
    "http://localhost/admin/api/rules",
    { headers: { Authorization: `Bearer ${rotatedTenant.token}` } },
    env,
  );
  assert.equal(newTenantList.status, 200);
  const newTenantRules = (await newTenantList.json()) as {
    rules: Array<{ address: string }>;
  };
  assert.deepEqual(
    newTenantRules.rules.map((r) => r.address),
    ["a1@team.test"],
  );

  // Delete tenant token
  const delTokRes = await app.request(
    `http://localhost/admin/api/tokens/${tenantRecord.id}`,
    { method: "DELETE", headers: adminHeaders },
    env,
  );
  assert.equal(delTokRes.status, 200);
  assert.equal(
    (
      await app.request(
        "http://localhost/admin/api/rules",
        { headers: { Authorization: `Bearer ${rotatedTenant.token}` } },
        env,
      )
    ).status,
    401,
  );
});

test("PUT /admin/api/rules/:address enforces overwrite=false 409 guard, lists watches, and paginates inbox & logs by cursor", async () => {
  const { env, engine } = makeEnv();
  const adminHeaders = {
    Authorization: "Bearer adm_secret",
    "Content-Type": "application/json",
  };

  // 1. Create rule r1 with overwrite=false -> 200
  const create1 = await app.request(
    "http://localhost/admin/api/rules/r1",
    {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ targets: ["a@dest.io"], overwrite: false }),
    },
    env,
  );
  assert.equal(create1.status, 200);

  // 2. Re-create r1 with overwrite=false -> 409 Conflict
  const conflictAdd = await app.request(
    "http://localhost/admin/api/rules/r1",
    {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ targets: ["b@dest.io"], overwrite: false }),
    },
    env,
  );
  assert.equal(conflictAdd.status, 409);

  // 3. Create r2 and attempt to rename r2 -> r1 with overwrite=false -> 409 Conflict
  await app.request(
    "http://localhost/admin/api/rules/r2",
    {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ targets: ["b@dest.io"], overwrite: false }),
    },
    env,
  );
  const conflictRename = await app.request(
    "http://localhost/admin/api/rules/r2",
    {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        address: "r1",
        targets: ["b@dest.io"],
        overwrite: false,
      }),
    },
    env,
  );
  assert.equal(conflictRename.status, 409);

  // 4. Watch slots CRUD + listWatches endpoint
  const wRes = await app.request(
    "http://localhost/admin/api/inbox/watch",
    {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        address: "temp-slot",
        ttlSeconds: 600,
        allowedSenders: ["github.com"],
      }),
    },
    env,
  );
  assert.equal(wRes.status, 200);

  const listWRes = await app.request(
    "http://localhost/admin/api/inbox/watches",
    { headers: adminHeaders },
    env,
  );
  assert.equal(listWRes.status, 200);
  const { watches } = (await listWRes.json()) as {
    watches: Array<{ address: string; allowedSenders?: string[] }>;
  };
  assert.equal(watches.length, 1);
  assert.equal(watches[0].address, "temp-slot@team.test");
  assert.deepEqual(watches[0].allowedSenders, ["github.com"]);

  // 5. Cursor pagination across /admin/api/inbox and /admin/api/logs (no duplicates, no gaps)
  for (let i = 1; i <= 5; i++) {
    await engine.saveInboxMessage({
      from: `s${i}@example.org`,
      to: "temp-slot@team.test",
      subject: `Msg ${i}`,
      messageId: `<m-${i}>`,
      text: `Body ${i}`,
      links: [],
      codes: [],
    });
    await engine.logDelivery({
      from: `s${i}@example.org`,
      to: "r1@team.test",
      subject: `Log ${i}`,
      messageId: `<l-${i}>`,
      forwardedTo: ["a@dest.io"],
    });
  }

  // Paginate inbox 2 at a time
  const seenMsgSubjects: string[] = [];
  let inboxCursor: string | null = null;
  while (true) {
    const qs = new URLSearchParams({ limit: "2" });
    if (inboxCursor) qs.set("cursor", inboxCursor);
    const res = await app.request(
      `http://localhost/admin/api/inbox?${qs.toString()}`,
      { headers: adminHeaders },
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      messages: Array<{ subject: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    seenMsgSubjects.push(...body.messages.map((m) => m.subject));
    if (!body.hasMore) {
      assert.equal(body.nextCursor, null);
      break;
    }
    assert.ok(body.nextCursor);
    inboxCursor = body.nextCursor;
  }
  assert.equal(seenMsgSubjects.length, 5);
  assert.equal(new Set(seenMsgSubjects).size, 5);

  // Paginate logs 2 at a time
  const seenLogSubjects: string[] = [];
  let logCursor: string | null = null;
  while (true) {
    const qs = new URLSearchParams({ limit: "2" });
    if (logCursor) qs.set("cursor", logCursor);
    const res = await app.request(
      `http://localhost/admin/api/logs?${qs.toString()}`,
      { headers: adminHeaders },
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      logs: Array<{ subject: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    seenLogSubjects.push(...body.logs.map((l) => l.subject));
    if (!body.hasMore) {
      assert.equal(body.nextCursor, null);
      break;
    }
    assert.ok(body.nextCursor);
    logCursor = body.nextCursor;
  }
  assert.equal(seenLogSubjects.length, 5);
  assert.equal(new Set(seenLogSubjects).size, 5);
});
