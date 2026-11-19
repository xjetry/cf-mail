import { Hono } from "hono";
import { cors } from "hono/cors";
import type {
  DestinationInput,
  ForwardStore,
  RuleInboxOptions,
  TenantToken,
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

export type AdminAuthContext =
  | { role: "admin" }
  | { role: "tenant"; token: TenantToken };

const app = new Hono<{
  Bindings: Env;
  Variables: { auth: AdminAuthContext };
}>();

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

function parseOptionalTimestamp(
  raw: unknown,
): { value?: number | null } | { error: string } {
  if (raw === undefined) return {};
  if (raw === null || raw === "") return { value: null };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) {
      return { error: "invalid expiresAt timestamp" };
    }
    return { value: raw < 10_000_000_000 ? raw * 1000 : raw };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { value: null };
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return { value: n < 10_000_000_000 ? n * 1000 : n };
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) {
      return { error: "invalid expiresAt date string" };
    }
    return { value: parsed };
  }
  return { error: "invalid expiresAt" };
}

function parseBoolParam(raw?: string): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function extractCredential(authHeader?: string, queryKey?: string): string {
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return (queryKey ?? "").trim();
}

function isAddressAuthorized(
  auth: AdminAuthContext,
  normalizedAddress: string,
): boolean {
  if (auth.role === "admin") return true;
  return auth.token.addresses.includes(normalizedAddress);
}

// ============================================================================
// 公开会话自省与单邮箱收件箱接口（/api/session 与 /api/inbox*）
// ============================================================================
app.use("/api/*", cors());

app.get("/api/session", async (c) => {
  const cred = extractCredential(
    c.req.header("Authorization"),
    c.req.query("key") ?? c.req.query("token"),
  );
  if (!cred) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const domain = getDomain(c.env);
  if (c.env.ADMIN_TOKEN && cred === c.env.ADMIN_TOKEN) {
    return c.json({ role: "admin" as const, domain });
  }
  const store = getStore(c.env);
  if (cred.startsWith("cfmt_")) {
    const tok = await store.resolveTenantToken(cred);
    if (!tok) {
      return c.json({ error: "invalid, disabled, or expired tenant token" }, 401);
    }
    return c.json({
      role: "tenant" as const,
      domain,
      token: {
        id: tok.id,
        name: tok.name,
        addresses: tok.addresses,
        ...(tok.expiresAt !== undefined ? { expiresAt: tok.expiresAt } : {}),
      },
    });
  }
  if (cred.startsWith("cfmk_")) {
    const address = await store.resolveAddressByInboxKey(cred);
    if (!address) {
      return c.json({ error: "invalid or revoked inbox key" }, 401);
    }
    return c.json({ role: "user" as const, domain, address });
  }
  return c.json({ error: "unauthorized" }, 401);
});

app.get("/api/inbox", async (c) => {
  const key = extractCredential(
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
  const cursor = (c.req.query("cursor") ?? "").trim() || undefined;
  const page = await store.queryInboxPage({
    address,
    unreadOnly: parseBoolParam(c.req.query("unread")),
    sinceMs: parseSinceParam(c.req.query("since")),
    consume: parseBoolParam(c.req.query("consume")),
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10,
    includeHtml: parseBoolParam(c.req.query("includeHtml")),
    cursor,
  });

  return c.json({
    address,
    messages: page.messages,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  });
});

app.post("/api/inbox/rotate-key", async (c) => {
  const key = extractCredential(
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
  const rotated = await store.rotateInboxKey(address, getDomain(c.env));
  if ("error" in rotated) {
    return c.json(rotated, rotated.error === "not found" ? 404 : 400);
  }
  return c.json({ address: rotated.address, inboxKey: rotated.inboxKey });
});

app.post("/api/inbox/:id/ack", async (c) => {
  const key = extractCredential(
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
  const key = extractCredential(
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
// 管理接口（支持 ADMIN_TOKEN 全局管理员与 cfmt_ 租户管理员；/admin/healthz 与 /admin/schema 公开）
// ============================================================================
app.use("/admin/*", cors());
app.use("/admin/*", async (c, next) => {
  if (c.req.path === "/admin/healthz" || c.req.path === "/admin/schema") {
    return next();
  }
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : undefined;
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (c.env.ADMIN_TOKEN && token === c.env.ADMIN_TOKEN) {
    c.set("auth", { role: "admin" });
    return next();
  }
  if (token.startsWith("cfmt_")) {
    const tenantToken = await getStore(c.env).resolveTenantToken(token);
    if (!tenantToken) {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("auth", { role: "tenant", token: tenantToken });
    return next();
  }
  return c.json({ error: "unauthorized" }, 401);
});

// ---------------- tenant access tokens (admin only) ----------------

app.get("/admin/api/tokens", async (c) => {
  if (c.get("auth").role !== "admin") {
    return c.json({ error: "forbidden: admin role required" }, 403);
  }
  return c.json({ tokens: await getStore(c.env).listTenantTokens() });
});

app.get("/admin/api/tokens/:id", async (c) => {
  if (c.get("auth").role !== "admin") {
    return c.json({ error: "forbidden: admin role required" }, 403);
  }
  const tok = await getStore(c.env).getTenantToken(
    decodeURIComponent(c.req.param("id")),
  );
  if (!tok) return c.json({ error: "not found" }, 404);
  return c.json({ token: tok });
});

app.post("/admin/api/tokens", async (c) => {
  if (c.get("auth").role !== "admin") {
    return c.json({ error: "forbidden: admin role required" }, 403);
  }
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name : "";
  const addresses = Array.isArray(body.addresses)
    ? body.addresses.map(String)
    : [];
  const enabled =
    typeof body.enabled === "boolean" ? body.enabled : undefined;
  const expParsed = parseOptionalTimestamp(body.expiresAt);
  if ("error" in expParsed) {
    return c.json(expParsed, 400);
  }

  const created = await getStore(c.env).createTenantToken(
    {
      name,
      addresses,
      enabled,
      ...(typeof expParsed.value === "number"
        ? { expiresAt: expParsed.value }
        : {}),
    },
    getDomain(c.env),
  );
  if ("error" in created) return c.json(created, 400);
  return c.json({ token: created });
});

app.put("/admin/api/tokens/:id", async (c) => {
  if (c.get("auth").role !== "admin") {
    return c.json({ error: "forbidden: admin role required" }, 403);
  }
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const expParsed = parseOptionalTimestamp(body.expiresAt);
  if ("error" in expParsed) {
    return c.json(expParsed, 400);
  }

  const updated = await getStore(c.env).updateTenantToken(
    decodeURIComponent(c.req.param("id")),
    {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(Array.isArray(body.addresses)
        ? { addresses: body.addresses.map(String) }
        : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...("expiresAt" in body ? { expiresAt: expParsed.value } : {}),
    },
    getDomain(c.env),
  );
  if ("error" in updated) {
    return c.json(updated, updated.error === "not found" ? 404 : 400);
  }
  return c.json({ token: updated });
});

app.post("/admin/api/tokens/:id/rotate", async (c) => {
  if (c.get("auth").role !== "admin") {
    return c.json({ error: "forbidden: admin role required" }, 403);
  }
  const rotated = await getStore(c.env).rotateTenantToken(
    decodeURIComponent(c.req.param("id")),
  );
  if ("error" in rotated) {
    return c.json(rotated, rotated.error === "not found" ? 404 : 400);
  }
  return c.json({ token: rotated });
});

app.delete("/admin/api/tokens/:id", async (c) => {
  if (c.get("auth").role !== "admin") {
    return c.json({ error: "forbidden: admin role required" }, 403);
  }
  const ok = await getStore(c.env).deleteTenantToken(
    decodeURIComponent(c.req.param("id")),
  );
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// ---------------- rules ----------------

app.get("/admin/api/rules", async (c) => {
  const auth = c.get("auth");
  const domain = getDomain(c.env);
  const allRules = await getStore(c.env).listRules();
  if (auth.role === "tenant") {
    const allowed = new Set(auth.token.addresses);
    return c.json({
      domain,
      rules: allRules.filter((r) => allowed.has(r.address)),
    });
  }
  return c.json({ domain, rules: allRules });
});

app.get("/admin/api/rules/:address", async (c) => {
  const auth = c.get("auth");
  const domain = getDomain(c.env);
  const normAddr = normalizeRecipient(
    decodeURIComponent(c.req.param("address")),
    domain,
  );
  if (!isAddressAuthorized(auth, normAddr)) {
    return c.json({ error: "forbidden: address not authorized" }, 403);
  }
  const rule = await getStore(c.env).getRule(normAddr, domain);
  if (!rule) return c.json({ error: "not found" }, 404);
  return c.json({ rule });
});

app.put("/admin/api/rules/:address", async (c) => {
  const auth = c.get("auth");
  const domain = getDomain(c.env);
  const oldRaw = decodeURIComponent(c.req.param("address"));
  const oldNorm = normalizeRecipient(oldRaw, domain);

  if (!isAddressAuthorized(auth, oldNorm)) {
    return c.json({ error: "forbidden: address not authorized" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const newRaw =
    typeof body.address === "string" && body.address.trim()
      ? body.address
      : oldRaw;
  const newNorm = normalizeRecipient(newRaw, domain);

  if (auth.role === "tenant" && newNorm !== oldNorm) {
    return c.json(
      { error: "forbidden: tenant cannot rename rule address" },
      403,
    );
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
      {
        error:
          "targets or destinations (array) required unless inboxEnabled is true",
      },
      400,
    );
  }

  const store = getStore(c.env);
  const existingRule = await store.getRule(oldNorm, domain);
  const overwrite = typeof body.overwrite === "boolean" ? body.overwrite : true;

  if (!overwrite) {
    if (oldNorm === newNorm && existingRule) {
      return c.json(
        {
          error: `rule already exists for ${newNorm}`,
          conflict: true,
          existingRule,
        },
        409,
      );
    }
    if (oldNorm !== newNorm) {
      const targetExisting = await store.getRule(newNorm, domain);
      if (targetExisting) {
        return c.json(
          {
            error: `rule already exists for ${newNorm}`,
            conflict: true,
            existingRule: targetExisting,
          },
          409,
        );
      }
    }
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
  // 已存在规则（或租户在被授权规则上关闭收件箱且无转发目标）允许保存为空目标暂停态
  if (auth.role === "tenant" || (existingRule && inboxEnabled === false)) {
    options.allowEmptyTargets = true;
  }

  const result = await store.updateRule(
    oldNorm,
    newNorm,
    rawTargets,
    domain,
    options,
  );
  if ("error" in result) return c.json(result, 400);

  const verification =
    result.destinations.length > 0
      ? await checkDestinations(c.env, result.destinations)
      : {
          configured: Boolean(
            c.env.CLOUDFLARE_API_TOKEN && c.env.CF_ACCOUNT_ID,
          ),
          destinations: [],
        };
  return c.json({ rule: result, verification });
});

app.patch("/admin/api/rules/:address/targets", async (c) => {
  const auth = c.get("auth");
  const domain = getDomain(c.env);
  const normAddr = normalizeRecipient(
    decodeURIComponent(c.req.param("address")),
    domain,
  );
  if (!isAddressAuthorized(auth, normAddr)) {
    return c.json({ error: "forbidden: address not authorized" }, 403);
  }
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
    normAddr,
    target,
    enabled,
    domain,
  );
  if ("error" in result) {
    return c.json(result, result.error === "not found" ? 404 : 400);
  }
  return c.json({ rule: result });
});

app.post("/admin/api/rules/:address/inbox-key", async (c) => {
  const auth = c.get("auth");
  const domain = getDomain(c.env);
  const normAddr = normalizeRecipient(
    decodeURIComponent(c.req.param("address")),
    domain,
  );
  if (!isAddressAuthorized(auth, normAddr)) {
    return c.json({ error: "forbidden: address not authorized" }, 403);
  }
  const result = await getStore(c.env).rotateInboxKey(normAddr, domain);
  if ("error" in result) {
    return c.json(result, result.error === "not found" ? 404 : 400);
  }
  return c.json({ rule: result, inboxKey: result.inboxKey });
});

app.delete("/admin/api/rules/:address/inbox-key", async (c) => {
  const auth = c.get("auth");
  const domain = getDomain(c.env);
  const normAddr = normalizeRecipient(
    decodeURIComponent(c.req.param("address")),
    domain,
  );
  if (!isAddressAuthorized(auth, normAddr)) {
    return c.json({ error: "forbidden: address not authorized" }, 403);
  }
  const result = await getStore(c.env).revokeInboxKey(normAddr, domain);
  if ("error" in result) {
    return c.json(result, result.error === "not found" ? 404 : 400);
  }
  return c.json({ rule: result });
});

app.delete("/admin/api/rules/:address", async (c) => {
  if (c.get("auth").role !== "admin") {
    return c.json({ error: "forbidden: tenant cannot delete rules" }, 403);
  }
  const ok = await getStore(c.env).deleteRule(
    decodeURIComponent(c.req.param("address")),
    getDomain(c.env),
  );
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// ---------------- admin inbox & watch (admin only — tenant cannot read emails) ----------------

app.get("/admin/api/inbox/watches", async (c) => {
  if (c.get("auth").role !== "admin") {
    return c.json({ error: "forbidden: admin role required" }, 403);
  }
  return c.json({ watches: await getStore(c.env).listWatches() });
});

app.post("/admin/api/inbox/watch", async (c) => {
  if (c.get("auth").role !== "admin") {
    return c.json({ error: "forbidden: admin role required" }, 403);
  }
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
  if (c.get("auth").role !== "admin") {
    return c.json({ error: "forbidden: admin role required" }, 403);
  }
  const ok = await getStore(c.env).unwatchAddress(
    decodeURIComponent(c.req.param("address")),
    getDomain(c.env),
  );
  return c.json({ ok });
});

app.get("/admin/api/inbox", async (c) => {
  if (c.get("auth").role !== "admin") {
    return c.json({ error: "forbidden: tenant cannot read inbox" }, 403);
  }
  const rawTo = (c.req.query("to") ?? "").trim();
  const domain = getDomain(c.env);
  const address = rawTo ? normalizeRecipient(rawTo, domain) : undefined;
  const limitRaw = Number(c.req.query("limit") ?? 20);
  const cursor = (c.req.query("cursor") ?? "").trim() || undefined;

  const page = await getStore(c.env).queryInboxPage({
    address,
    unreadOnly: parseBoolParam(c.req.query("unread")),
    sinceMs: parseSinceParam(c.req.query("since")),
    consume: parseBoolParam(c.req.query("consume")),
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20,
    includeHtml: parseBoolParam(c.req.query("includeHtml")),
    cursor,
  });

  return c.json({
    messages: page.messages,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  });
});

app.delete("/admin/api/inbox/:id", async (c) => {
  if (c.get("auth").role !== "admin") {
    return c.json({ error: "forbidden: tenant cannot access inbox" }, 403);
  }
  const rawTo = (c.req.query("to") ?? "").trim();
  const address = rawTo
    ? normalizeRecipient(rawTo, getDomain(c.env))
    : undefined;
  const ok = await getStore(c.env).deleteInboxMessage(
    address,
    c.req.param("id"),
  );
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// ---------------- destination verification (admin & tenant) ----------------

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
  const auth = c.get("auth");
  const limitRaw = Number(c.req.query("limit") ?? 50);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
  const cursor = (c.req.query("cursor") ?? "").trim() || undefined;
  if (auth.role === "tenant") {
    const page = await getStore(c.env).listLogsPage(limit, {
      allowedAddresses: auth.token.addresses,
      redactSubject: true,
      cursor,
    });
    return c.json(page);
  }
  return c.json(await getStore(c.env).listLogsPage(limit, { cursor }));
});

app.get("/admin/healthz", (c) => c.json({ ok: true }));
app.get("/admin/schema", (c) => c.json(getFullSchema()));

export default app;
