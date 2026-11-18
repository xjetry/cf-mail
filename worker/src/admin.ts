import { Hono } from "hono";
import { cors } from "hono/cors";
import type {
  DestinationInput,
  ForwardStore,
  RuleInboxOptions,
} from "./forward-store.ts";
import { normalizeRecipient } from "./store-engine.ts";
import { getFullSchema } from "./schema.ts";
import {
  checkDestinations,
  sendDestinationVerification,
} from "./cf-destinations.ts";

export type Env = {
  FORWARD_STORE: DurableObjectNamespace<ForwardStore>;
  ADMIN_TOKEN: string;
  MAIL_DOMAIN?: string;
  /** 可选：目标邮箱验证状态检查 / 发送验证邮件（部署脚本自动注入） */
  CLOUDFLARE_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
};

const app = new Hono<{ Bindings: Env }>();

function getStore(env: Env) {
  const id = env.FORWARD_STORE.idFromName("global");
  return env.FORWARD_STORE.get(id);
}

function getDomain(env: Env): string {
  return (
    (env.MAIL_DOMAIN ?? "example.com").trim().toLowerCase() || "example.com"
  );
}

function parseSinceParam(raw?: string): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    // 兼容秒级与毫秒级时间戳
    return num < 10_000_000_000 ? num * 1000 : num;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolParam(raw?: string): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function extractUserInboxKey(authHeader?: string, queryKey?: string): string {
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return (queryKey ?? "").trim();
}

// ============================================================================
// 公开单邮箱收件箱接口（持单前缀专属 cfmk_... 访问，与 /admin/* 完全隔离）
// ============================================================================
app.use("/api/inbox*", cors());

app.get("/api/inbox", async (c) => {
  const key = extractUserInboxKey(
    c.req.header("Authorization"),
    c.req.query("key"),
  );
  if (!key) {
    return c.json({ error: "missing inbox key" }, 401);
  }
  const store = getStore(c.env);
  const address = await store.resolveAddressByInboxKey(key);
  if (!address) {
    return c.json({ error: "invalid or revoked inbox key" }, 401);
  }

  const limitRaw = Number(c.req.query("limit") ?? 10);
  const messages = await store.queryInbox({
    address,
    unreadOnly: parseBoolParam(c.req.query("unread")),
    sinceMs: parseSinceParam(c.req.query("since")),
    consume: parseBoolParam(c.req.query("consume")),
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10,
    includeHtml: parseBoolParam(c.req.query("includeHtml")),
  });

  return c.json({ address, messages });
});

app.post("/api/inbox/:id/ack", async (c) => {
  const key = extractUserInboxKey(
    c.req.header("Authorization"),
    c.req.query("key"),
  );
  if (!key) {
    return c.json({ error: "missing inbox key" }, 401);
  }
  const store = getStore(c.env);
  const address = await store.resolveAddressByInboxKey(key);
  if (!address) {
    return c.json({ error: "invalid or revoked inbox key" }, 401);
  }
  const ok = await store.ackInboxMessage(address, c.req.param("id"));
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/api/inbox/:id", async (c) => {
  const key = extractUserInboxKey(
    c.req.header("Authorization"),
    c.req.query("key"),
  );
  if (!key) {
    return c.json({ error: "missing inbox key" }, 401);
  }
  const store = getStore(c.env);
  const address = await store.resolveAddressByInboxKey(key);
  if (!address) {
    return c.json({ error: "invalid or revoked inbox key" }, 401);
  }
  const ok = await store.deleteInboxMessage(address, c.req.param("id"));
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// ============================================================================
// 管理接口（全部要求 Bearer ADMIN_TOKEN，/admin/healthz 与 /admin/schema 除外）
// ============================================================================
app.use("/admin/*", cors());
app.use("/admin/*", async (c, next) => {
  if (c.req.path === "/admin/healthz" || c.req.path === "/admin/schema") {
    return next();
  }
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!token || token !== c.env.ADMIN_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

// ---------------- rules ----------------

app.get("/admin/api/rules", async (c) => {
  return c.json({
    domain: getDomain(c.env),
    rules: await getStore(c.env).listRules(),
  });
});

app.get("/admin/api/rules/:address", async (c) => {
  const rule = await getStore(c.env).getRule(
    decodeURIComponent(c.req.param("address")),
    getDomain(c.env),
  );
  if (!rule) return c.json({ error: "not found" }, 404);
  return c.json({ rule });
});

app.put("/admin/api/rules/:address", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const inboxEnabled =
    typeof body.inboxEnabled === "boolean" ? body.inboxEnabled : undefined;

  const rawTargets: DestinationInput[] | undefined = Array.isArray(body.targets)
    ? body.targets
    : Array.isArray(body.destinations)
      ? body.destinations
      : inboxEnabled
        ? []
        : undefined;

  if (!rawTargets) {
    return c.json(
      { error: "targets or destinations (array) required unless inboxEnabled is true" },
      400,
    );
  }

  const options: RuleInboxOptions = {};
  if (inboxEnabled !== undefined) {
    options.inboxEnabled = inboxEnabled;
  }
  if ("allowedSenders" in body) {
    if (Array.isArray(body.allowedSenders)) {
      options.allowedSenders = body.allowedSenders.map(String);
    } else if (body.allowedSenders === null) {
      options.allowedSenders = [];
    }
  }
  if (typeof body.generateKey === "boolean") {
    options.generateKey = body.generateKey;
  }

  const domain = getDomain(c.env);
  const oldAddress = decodeURIComponent(c.req.param("address"));
  const newAddress =
    typeof body.address === "string" && body.address.trim()
      ? body.address
      : oldAddress;
  const result = await getStore(c.env).updateRule(
    oldAddress,
    newAddress,
    rawTargets,
    domain,
    options,
  );
  if ("error" in result) return c.json(result, 400);

  const verification =
    result.destinations.length > 0
      ? await checkDestinations(c.env, result.destinations)
      : { configured: Boolean(c.env.CLOUDFLARE_API_TOKEN && c.env.CF_ACCOUNT_ID), destinations: [] };
  return c.json({ rule: result, verification });
});

app.patch("/admin/api/rules/:address/targets", async (c) => {
  const body = await c.req.json().catch(() => null);
  const target = typeof body?.target === "string" ? body.target.trim() : "";
  const enabled = body?.enabled;
  if (!target || typeof enabled !== "boolean") {
    return c.json(
      { error: "target (string) and enabled (boolean) required" },
      400,
    );
  }
  const result = await getStore(c.env).setTargetEnabled(
    decodeURIComponent(c.req.param("address")),
    target,
    enabled,
    getDomain(c.env),
  );
  if ("error" in result) {
    return c.json(result, result.error === "not found" ? 404 : 400);
  }
  return c.json({ rule: result });
});

app.post("/admin/api/rules/:address/inbox-key", async (c) => {
  const result = await getStore(c.env).rotateInboxKey(
    decodeURIComponent(c.req.param("address")),
    getDomain(c.env),
  );
  if ("error" in result) {
    return c.json(result, result.error === "not found" ? 404 : 400);
  }
  return c.json({ rule: result, inboxKey: result.inboxKey });
});

app.delete("/admin/api/rules/:address/inbox-key", async (c) => {
  const result = await getStore(c.env).revokeInboxKey(
    decodeURIComponent(c.req.param("address")),
    getDomain(c.env),
  );
  if ("error" in result) {
    return c.json(result, result.error === "not found" ? 404 : 400);
  }
  return c.json({ rule: result });
});

app.delete("/admin/api/rules/:address", async (c) => {
  const ok = await getStore(c.env).deleteRule(
    decodeURIComponent(c.req.param("address")),
    getDomain(c.env),
  );
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// ---------------- admin inbox & watch ----------------

app.post("/admin/api/inbox/watch", async (c) => {
  const body = await c.req.json().catch(() => null);
  const address = typeof body?.address === "string" ? body.address.trim() : "";
  if (!address) return c.json({ error: "address (string) required" }, 400);
  const ttlSeconds =
    typeof body?.ttlSeconds === "number" && Number.isFinite(body.ttlSeconds)
      ? body.ttlSeconds
      : undefined;
  const allowedSenders = Array.isArray(body?.allowedSenders)
    ? body.allowedSenders.map(String)
    : undefined;

  const slot = await getStore(c.env).watchAddress(
    address,
    getDomain(c.env),
    ttlSeconds,
    allowedSenders,
  );
  if ("error" in slot) return c.json(slot, 400);
  return c.json({ watch: slot });
});

app.delete("/admin/api/inbox/watch/:address", async (c) => {
  const ok = await getStore(c.env).unwatchAddress(
    decodeURIComponent(c.req.param("address")),
    getDomain(c.env),
  );
  return c.json({ ok });
});

app.get("/admin/api/inbox", async (c) => {
  const rawTo = (c.req.query("to") ?? "").trim();
  const domain = getDomain(c.env);
  const address = rawTo ? normalizeRecipient(rawTo, domain) : undefined;
  const limitRaw = Number(c.req.query("limit") ?? 20);

  const messages = await getStore(c.env).queryInbox({
    address,
    unreadOnly: parseBoolParam(c.req.query("unread")),
    sinceMs: parseSinceParam(c.req.query("since")),
    consume: parseBoolParam(c.req.query("consume")),
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20,
    includeHtml: parseBoolParam(c.req.query("includeHtml")),
  });

  return c.json({ messages });
});

app.delete("/admin/api/inbox/:id", async (c) => {
  const rawTo = (c.req.query("to") ?? "").trim();
  const address = rawTo
    ? normalizeRecipient(rawTo, getDomain(c.env))
    : undefined;
  const ok = await getStore(c.env).deleteInboxMessage(address, c.req.param("id"));
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// ---------------- destination verification ----------------

app.get("/admin/api/destinations/status", async (c) => {
  const addresses = (c.req.query("addresses") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (addresses.length === 0) {
    return c.json(
      { error: "addresses query param required (comma separated)" },
      400,
    );
  }
  if (addresses.length > 50) {
    return c.json({ error: "too many addresses (max 50)" }, 400);
  }
  return c.json(await checkDestinations(c.env, addresses));
});

app.post("/admin/api/destinations/verify", async (c) => {
  const body = await c.req.json().catch(() => null);
  const address = typeof body?.address === "string" ? body.address.trim() : "";
  if (!address) return c.json({ error: "address (string) required" }, 400);
  try {
    return c.json(await sendDestinationVerification(c.env, address));
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
});

// ---------------- logs ----------------

app.get("/admin/api/logs", async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json({
    logs: await getStore(c.env).listLogs(
      Number.isFinite(limit) && limit > 0 ? limit : 50,
    ),
  });
});

app.get("/admin/healthz", (c) => c.json({ ok: true }));
app.get("/admin/schema", (c) => c.json(getFullSchema()));

export default app;
