import test from "node:test";
import assert from "node:assert/strict";
import { ForwardStoreEngine, type StorageLike } from "../src/store-engine.ts";

class MemoryStorage implements StorageLike {
  private data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const val = this.data.get(key);
    return val === undefined ? undefined : structuredClone(val as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      let n = 0;
      for (const k of keyOrKeys) {
        if (this.data.delete(k)) n++;
      }
      return n;
    }
    return this.data.delete(keyOrKeys);
  }

  async list<T>(opts?: {
    prefix?: string;
    limit?: number;
    reverse?: boolean;
  }): Promise<Map<string, T>> {
    let keys = [...this.data.keys()].sort();
    if (opts?.prefix) {
      keys = keys.filter((k) => k.startsWith(opts.prefix!));
    }
    if (opts?.reverse) {
      keys.reverse();
    }
    if (opts?.limit !== undefined) {
      keys = keys.slice(0, opts.limit);
    }
    const out = new Map<string, T>();
    for (const k of keys) {
      out.set(k, structuredClone(this.data.get(k) as T));
    }
    return out;
  }
}

test("inbox-only rule allows empty targets, generates cfmk_ key, and enforces allowedSenders", async () => {
  const engine = new ForwardStoreEngine(new MemoryStorage());

  // Empty targets without inboxEnabled must still fail
  const bad = await engine.setRule("u1", [], "my.domain");
  assert.ok("error" in bad);

  // Inbox-only rule with allowedSenders succeeds and generates inboxKey
  const saved = await engine.setRule("u1", [], "my.domain", {
    inboxEnabled: true,
    allowedSenders: ["anthropic.com"],
  });
  assert.ok(!("error" in saved));
  assert.equal(saved.address, "u1@my.domain");
  assert.deepEqual(saved.destinations, []);
  assert.equal(saved.inboxEnabled, true);
  assert.deepEqual(saved.allowedSenders, ["anthropic.com"]);
  assert.match(saved.inboxKey ?? "", /^cfmk_[0-9a-f]{32}$/);

  // Key resolves strictly to u1@my.domain
  const resolved = await engine.resolveAddressByInboxKey(saved.inboxKey!);
  assert.equal(resolved, "u1@my.domain");

  // Delivery plan rejects non-whitelisted sender
  const rejectedPlan = await engine.resolveDeliveryPlan(
    "u1@my.domain",
    "spam@other.com",
  );
  assert.equal(rejectedPlan.action, "reject");
  assert.equal(rejectedPlan.reason, "sender not allowed");

  // Delivery plan accepts mail.anthropic.com into inbox without forwarding
  const okPlan = await engine.resolveDeliveryPlan(
    "u1@my.domain",
    "Anthropic <noreply@mail.anthropic.com>",
  );
  assert.equal(okPlan.action, "accept");
  assert.equal(okPlan.captureInbox, true);
  assert.deepEqual(okPlan.forwardTo, []);
});

test("rotating or deleting inboxKey immediately invalidates old key", async () => {
  const engine = new ForwardStoreEngine(new MemoryStorage());
  const r1 = await engine.setRule("u2", [], "my.domain", { inboxEnabled: true });
  assert.ok(!("error" in r1));
  const key1 = r1.inboxKey!;

  const rotated = await engine.rotateInboxKey("u2", "my.domain");
  assert.ok(!("error" in rotated));
  const key2 = rotated.inboxKey!;
  assert.notEqual(key1, key2);

  assert.equal(await engine.resolveAddressByInboxKey(key1), null);
  assert.equal(await engine.resolveAddressByInboxKey(key2), "u2@my.domain");

  // Deleting rule invalidates key2
  await engine.deleteRule("u2", "my.domain");
  assert.equal(await engine.resolveAddressByInboxKey(key2), null);
});

test("partitioned inbox supports unread + consume atomicity and cross-address isolation", async () => {
  let now = 1_700_000_000_000;
  const engine = new ForwardStoreEngine(new MemoryStorage(), () => now);

  await engine.setRule("alice", [], "my.domain", { inboxEnabled: true });
  await engine.setRule("bob", [], "my.domain", { inboxEnabled: true });

  await engine.saveInboxMessage({
    from: "noreply@mail.anthropic.com",
    to: "alice@my.domain",
    subject: "Sign in to Claude #1",
    messageId: "<m1>",
    text: "Link 1",
    html: "<a href='https://claude.ai/magic-link#1'>1</a>",
    links: ["https://claude.ai/magic-link#1"],
    codes: [],
  });
  now += 1000;
  await engine.saveInboxMessage({
    from: "noreply@mail.anthropic.com",
    to: "bob@my.domain",
    subject: "Bob Sign in",
    messageId: "<m2>",
    text: "Bob Link",
    html: "",
    links: ["https://claude.ai/magic-link#bob"],
    codes: [],
  });

  // Alice only sees Alice's message; consume=true marks it read
  const poll1 = await engine.queryInbox({
    address: "alice@my.domain",
    unreadOnly: true,
    consume: true,
  });
  assert.equal(poll1.length, 1);
  assert.equal(poll1[0].links[0], "https://claude.ai/magic-link#1");
  assert.equal(poll1[0].read, true);
  assert.equal(poll1[0].html, undefined); // omitted by default unless includeHtml=true

  // Second poll with unreadOnly=true returns empty (prevents stale magic-link reuse!)
  const poll2 = await engine.queryInbox({
    address: "alice@my.domain",
    unreadOnly: true,
    consume: true,
  });
  assert.equal(poll2.length, 0);

  // Alice cannot ack or delete Bob's message
  const bobMsgs = await engine.queryInbox({ address: "bob@my.domain" });
  assert.equal(bobMsgs.length, 1);
  const crossDelete = await engine.deleteInboxMessage("alice@my.domain", bobMsgs[0].id);
  assert.equal(crossDelete, false);

  // After 31 minutes, expired messages are automatically pruned
  now += 31 * 60 * 1000;
  const afterExpiry = await engine.queryInbox({ address: "bob@my.domain" });
  assert.equal(afterExpiry.length, 0);
});

test("temporary watch slot accepts mail without rule until TTL expires", async () => {
  let now = 1_700_000_000_000;
  const engine = new ForwardStoreEngine(new MemoryStorage(), () => now);

  await engine.watchAddress("temp01", "my.domain", 600, ["anthropic.com"]);
  const activePlan = await engine.resolveDeliveryPlan(
    "temp01@my.domain",
    "noreply@mail.anthropic.com",
  );
  assert.equal(activePlan.action, "accept");
  assert.equal(activePlan.captureInbox, true);

  // Advance past 600s TTL
  now += 601 * 1000;
  const expiredPlan = await engine.resolveDeliveryPlan(
    "temp01@my.domain",
    "noreply@mail.anthropic.com",
  );
  assert.equal(expiredPlan.action, "reject");
  assert.equal(expiredPlan.reason, "no rule");
});

test("tenant token CRUD auto-initializes placeholder rules, enforces enabled & expiresAt, and rotates key", async () => {
  let now = 1_700_000_000_000;
  const engine = new ForwardStoreEngine(new MemoryStorage(), () => now);

  // Creating token with new addresses auto-creates placeholder rules that safely reject mail until configured
  const created = await engine.createTenantToken(
    {
      name: "客服组",
      addresses: ["s1", "s2@my.domain"],
      expiresAt: now + 3600_000,
    },
    "my.domain",
  );
  assert.ok(!("error" in created));
  assert.equal(created.name, "客服组");
  assert.match(created.token, /^cfmt_[0-9a-f]{32}$/);
  assert.deepEqual(created.addresses, ["s1@my.domain", "s2@my.domain"]);
  assert.equal(created.enabled, true);

  // Placeholder rule exists and rejects incoming mail cleanly
  const r1 = await engine.getRule("s1", "my.domain");
  assert.ok(r1);
  assert.deepEqual(r1.targets, []);
  assert.equal(r1.inboxEnabled, undefined);
  const plan = await engine.resolveDeliveryPlan("s1@my.domain", "a@b.com");
  assert.deepEqual(plan, { action: "reject", reason: "all destinations disabled" });

  // Active token resolves
  const resolved1 = await engine.resolveTenantToken(created.token);
  assert.equal(resolved1?.id, created.id);

  // Disabling token prevents resolution; re-enabling restores it
  const disabled = await engine.updateTenantToken(
    created.id,
    { enabled: false },
    "my.domain",
  );
  assert.ok(!("error" in disabled));
  assert.equal(await engine.resolveTenantToken(created.token), null);

  await engine.updateTenantToken(created.id, { enabled: true }, "my.domain");
  assert.equal((await engine.resolveTenantToken(created.token))?.id, created.id);

  // Rotating token invalidates old cfmt_ secret immediately
  const oldSecret = created.token;
  const rotated = await engine.rotateTenantToken(created.id);
  assert.ok(!("error" in rotated));
  assert.notEqual(rotated.token, oldSecret);
  assert.equal(await engine.resolveTenantToken(oldSecret), null);
  assert.equal((await engine.resolveTenantToken(rotated.token))?.id, created.id);

  // Advancing past expiresAt invalidates resolution unless expiresAt is cleared
  now += 3601_000;
  assert.equal(await engine.resolveTenantToken(rotated.token), null);
  await engine.updateTenantToken(created.id, { expiresAt: null }, "my.domain");
  assert.equal((await engine.resolveTenantToken(rotated.token))?.id, created.id);

  // Deleting token invalidates secret without deleting underlying rules
  assert.equal(await engine.deleteTenantToken(created.id), true);
  assert.equal(await engine.resolveTenantToken(rotated.token), null);
  assert.ok(await engine.getRule("s1", "my.domain"));
});

test("deleteRule cascades to tenant token addresses and cleans up inbox messages", async () => {
  const engine = new ForwardStoreEngine(new MemoryStorage());

  await engine.setRule("a1", [], "my.domain", { inboxEnabled: true });
  await engine.saveInboxMessage({
    from: "x@y.com",
    to: "a1@my.domain",
    subject: "Code 123456",
    messageId: "<m1>",
    text: "123456",
    links: [],
    codes: ["123456"],
  });

  const tok = await engine.createTenantToken(
    { name: "租户1", addresses: ["a1", "a2"] },
    "my.domain",
  );
  assert.ok(!("error" in tok));
  assert.deepEqual(tok.addresses, ["a1@my.domain", "a2@my.domain"]);

  // Delete rule a1 -> purged from inbox and removed from tok.addresses
  assert.equal(await engine.deleteRule("a1", "my.domain"), true);
  const remainingMsgs = await engine.queryInbox({ address: "a1@my.domain" });
  assert.equal(remainingMsgs.length, 0);

  const updatedTok = await engine.getTenantToken(tok.id);
  assert.deepEqual(updatedTok?.addresses, ["a2@my.domain"]);
});

test("listLogs filters by allowedAddresses and redacts subject when requested", async () => {
  let now = 1_700_000_000_000;
  const engine = new ForwardStoreEngine(new MemoryStorage(), () => now);

  await engine.logDelivery({
    from: "s@x.com",
    to: "a1@my.domain",
    subject: "Your OTP is 889900",
    messageId: "<1>",
    forwardedTo: ["dest@x.com"],
  });
  now += 1000;
  await engine.logDelivery({
    from: "s@x.com",
    to: "other@my.domain",
    subject: "Other secret",
    messageId: "<2>",
    forwardedTo: ["dest2@x.com"],
  });

  const tenantLogs = await engine.listLogs(50, {
    allowedAddresses: ["a1@my.domain"],
    redactSubject: true,
  });
  assert.equal(tenantLogs.length, 1);
  assert.equal(tenantLogs[0].to, "a1@my.domain");
  assert.equal(tenantLogs[0].subject, "");

  const adminLogs = await engine.listLogs(50);
  assert.equal(adminLogs.length, 2);
  assert.equal(adminLogs[1].subject, "Your OTP is 889900");
});
