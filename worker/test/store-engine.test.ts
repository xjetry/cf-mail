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
