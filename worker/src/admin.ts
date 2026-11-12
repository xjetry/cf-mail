import { Hono } from "hono";
import { cors } from "hono/cors";
import type { DestinationInput, ForwardStore } from "./forward-store";
import { getFullSchema } from "./schema";

export type Env = {
  FORWARD_STORE: DurableObjectNamespace<ForwardStore>;
  ADMIN_TOKEN: string;
  MAIL_DOMAIN?: string;
};

const app = new Hono<{ Bindings: Env }>();

function getStore(env: Env) {
  const id = env.FORWARD_STORE.idFromName("global");
  return env.FORWARD_STORE.get(id);
}

function getDomain(env: Env): string {
  return (env.MAIL_DOMAIN ?? "example.com").trim().toLowerCase() || "example.com";
}

// 全部接口要求 Bearer Token（/admin/healthz 与 /admin/schema 除外）
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
  const rawTargets: DestinationInput[] | undefined = Array.isArray(
    body?.targets,
  )
    ? body.targets
    : Array.isArray(body?.destinations)
      ? body.destinations
      : undefined;

  if (!rawTargets) {
    return c.json(
      { error: "targets or destinations (array) required" },
      400,
    );
  }
  const domain = getDomain(c.env);
  const oldAddress = decodeURIComponent(c.req.param("address"));
  const newAddress =
    typeof body?.address === "string" && body.address.trim()
      ? body.address
      : oldAddress;
  const result = await getStore(c.env).updateRule(
    oldAddress,
    newAddress,
    rawTargets,
    domain,
  );
  if ("error" in result) return c.json(result, 400);
  return c.json({ rule: result });
});

app.patch("/admin/api/rules/:address/targets", async (c) => {
  const body = await c.req.json().catch(() => null);
  const target = typeof body?.target === "string" ? body.target.trim() : "";
  const enabled = body?.enabled;
  if (!target || typeof enabled !== "boolean") {
    return c.json({ error: "target (string) and enabled (boolean) required" }, 400);
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

app.delete("/admin/api/rules/:address", async (c) => {
  const ok = await getStore(c.env).deleteRule(
    decodeURIComponent(c.req.param("address")),
    getDomain(c.env),
  );
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
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
