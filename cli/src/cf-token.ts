/**
 * Cloudflare API Token 权限检测器（部署前自检，零副作用探测 Read + Edit 权限）
 */

export type PermissionCheckItem = {
  id: string;
  scope: string;
  permission: string;
  purpose: string;
  ok: boolean;
  error?: string;
  fix_hint?: string;
};

export type TokenCheckReport = {
  ok: boolean;
  tokenStatus?: string;
  domain?: string;
  zoneId?: string;
  accountId?: string;
  accountName?: string;
  checks: PermissionCheckItem[];
  missing: Array<{
    id: string;
    scope: string;
    permission: string;
    error: string;
    fix_hint: string;
  }>;
};

type CfEnvelope<T = unknown> = {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
};

const CF_API = "https://api.cloudflare.com/client/v4";
const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

async function cfRequest<T = unknown>(
  cfToken: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; data: CfEnvelope<T> }> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfToken}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const data = (await res.json().catch(() => ({
    success: false,
    result: null,
    errors: [{ code: res.status, message: res.statusText }],
  }))) as CfEnvelope<T>;
  return { status: res.status, data };
}

function isAuthError(status: number, data: CfEnvelope): boolean {
  if (status === 401 || status === 403) return true;
  const codes = (data.errors ?? []).map((e) => e.code);
  return codes.includes(10000) || codes.includes(9109) || codes.includes(6003);
}

function formatCfError(data: CfEnvelope): string {
  if (!data.errors || data.errors.length === 0) return "permission denied";
  return data.errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
}

export async function checkCloudflareToken(opts: {
  cfToken: string;
  domain?: string;
}): Promise<TokenCheckReport> {
  const cfToken = opts.cfToken.trim();
  const checks: PermissionCheckItem[] = [];

  // 1. 验证 Token 本身是否有效
  const verifyRes = await cfRequest<{ id: string; status: string }>(
    cfToken,
    "/user/tokens/verify",
  );
  // 如果是 Account Token（非 User Token），/user/tokens/verify 可能失败，此时退化通过 /zones 验证
  const verifyOk =
    verifyRes.data.success && verifyRes.data.result?.status === "active";

  // 2. 查询 Zone (验证 Zone -> Zone -> Read)
  const zoneQuery = opts.domain
    ? `/zones?name=${encodeURIComponent(opts.domain)}`
    : "/zones?per_page=50";
  const zonesRes = await cfRequest<
    Array<{
      id: string;
      name: string;
      status: string;
      account: { id: string; name?: string };
    }>
  >(cfToken, zoneQuery);

  if (!verifyOk && isAuthError(zonesRes.status, zonesRes.data)) {
    checks.push({
      id: "token_valid",
      scope: "API Token",
      permission: "Active Token",
      purpose: "验证 Cloudflare API Token 有效性",
      ok: false,
      error: formatCfError(verifyRes.data),
      fix_hint: `Token 无效、已过期或格式错误。请前往 ${TOKEN_URL} 检查或重新创建 Token。`,
    });
    return buildReport(checks);
  }

  checks.push({
    id: "token_valid",
    scope: "API Token",
    permission: "Active Token",
    purpose: "验证 Cloudflare API Token 有效性",
    ok: true,
  });

  const zones = zonesRes.data.result ?? [];
  const targetZone = opts.domain
    ? zones.find((z) => z.name.toLowerCase() === opts.domain!.toLowerCase())
    : zones[0];

  if (!zonesRes.data.success || !targetZone) {
    const domainLabel = opts.domain ? `域名 ${opts.domain}` : "任何域名 Zone";
    checks.push({
      id: "zone_read",
      scope: "Zone → Zone",
      permission: "Read",
      purpose: `读取 ${domainLabel} 的 Zone ID 与所属 Account ID`,
      ok: false,
      error: !zonesRes.data.success
        ? formatCfError(zonesRes.data)
        : `未找到 ${domainLabel}（可能未包含在 Token 的 Zone Resources 中）`,
      fix_hint: `在 ${TOKEN_URL} 编辑该 Token：1) Permissions 添加 [Zone] - [Zone] - [Read]；2) Zone Resources 包含 ${opts.domain ?? "目标域名"}（或 All zones）。`,
    });
    return buildReport(checks, { domain: opts.domain });
  }

  checks.push({
    id: "zone_read",
    scope: "Zone → Zone",
    permission: "Read",
    purpose: `读取域名 ${targetZone.name} 信息`,
    ok: true,
  });

  const zoneId = targetZone.id;
  const accountId = targetZone.account.id;
  const accountName = targetZone.account.name;
  const domain = targetZone.name;

  // 并行探测其余 5 项权限（均使用无副作用的鉴权探测）
  const [
    workersRead,
    workersWriteProbe,
    emailAddrRead,
    emailAddrWriteProbe,
    dnsRead,
    dnsWriteProbe,
    routingRulesRead,
    routingRulesWriteProbe,
    zoneSettingsWriteProbe,
  ] = await Promise.all([
    cfRequest(cfToken, `/accounts/${accountId}/workers/scripts`),
    cfRequest(
      cfToken,
      `/accounts/${accountId}/workers/scripts/__cf_mail_perm_probe__/secrets`,
      { method: "PUT", body: "{}" },
    ),
    cfRequest(cfToken, `/accounts/${accountId}/email/routing/addresses`),
    cfRequest(cfToken, `/accounts/${accountId}/email/routing/addresses`, {
      method: "POST",
      body: "{}",
    }),
    cfRequest(cfToken, `/zones/${zoneId}/dns_records?per_page=1`),
    cfRequest(cfToken, `/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: "{}",
    }),
    cfRequest(cfToken, `/zones/${zoneId}/email/routing/rules`),
    cfRequest(cfToken, `/zones/${zoneId}/email/routing/rules`, {
      method: "POST",
      body: "{}",
    }),
    cfRequest(cfToken, `/zones/${zoneId}/email/routing/dns`, {
      method: "PATCH",
      body: JSON.stringify({ name: "_cf_mail_perm_probe" }),
    }),
  ]);

  // 3. Account → Workers Scripts → Edit
  const workersOk =
    workersRead.data.success &&
    !isAuthError(workersWriteProbe.status, workersWriteProbe.data);
  checks.push({
    id: "workers_scripts_edit",
    scope: "Account → Workers Scripts",
    permission: "Edit",
    purpose: "部署 cf-mail Worker、绑定 Durable Object 与注入 ADMIN_TOKEN Secret",
    ok: workersOk,
    ...(workersOk
      ? {}
      : {
          error: !workersRead.data.success
            ? formatCfError(workersRead.data)
            : formatCfError(workersWriteProbe.data),
          fix_hint: `在 ${TOKEN_URL} 编辑该 Token：1) Permissions 添加 [Account] - [Workers Scripts] - [Edit]；2) Account Resources 必须包含域名 ${domain} 所属账号 (${accountId}) 或选 All accounts。`,
        }),
  });

  // 4. Account → Email Routing Addresses → Edit
  const emailAddrOk =
    emailAddrRead.data.success &&
    !isAuthError(emailAddrWriteProbe.status, emailAddrWriteProbe.data);
  checks.push({
    id: "email_routing_addresses_edit",
    scope: "Account → Email Routing Addresses",
    permission: "Edit",
    purpose: "查询/添加目标转发邮箱并触发验证邮件",
    ok: emailAddrOk,
    ...(emailAddrOk
      ? {}
      : {
          error: !emailAddrRead.data.success
            ? formatCfError(emailAddrRead.data)
            : formatCfError(emailAddrWriteProbe.data),
          fix_hint: `在 ${TOKEN_URL} 编辑该 Token：1) Permissions 添加 [Account] - [Email Routing Addresses] - [Edit]；2) Account Resources 包含账号 (${accountId}) 或 All accounts。`,
        }),
  });

  // 5. Zone → DNS → Edit
  const dnsOk =
    dnsRead.data.success && !isAuthError(dnsWriteProbe.status, dnsWriteProbe.data);
  checks.push({
    id: "zone_dns_edit",
    scope: "Zone → DNS",
    permission: "Edit",
    purpose: `为 ${domain} 配置自定义管理域名 (mail.${domain}) 及 MX/SPF/DKIM 记录`,
    ok: dnsOk,
    ...(dnsOk
      ? {}
      : {
          error: !dnsRead.data.success
            ? formatCfError(dnsRead.data)
            : formatCfError(dnsWriteProbe.data),
          fix_hint: `在 ${TOKEN_URL} 编辑该 Token：Permissions 添加 [Zone] - [DNS] - [Edit]（若只有 Read 权限会导致添加记录与绑定自定义域名失败）。`,
        }),
  });

  // 6. Zone → Email Routing Rules → Edit
  const rulesOk =
    routingRulesRead.data.success &&
    !isAuthError(routingRulesWriteProbe.status, routingRulesWriteProbe.data);
  checks.push({
    id: "email_routing_rules_edit",
    scope: "Zone → Email Routing Rules",
    permission: "Edit",
    purpose: `配置 ${domain} 的 Catch-All 规则转发到 cf-mail Worker`,
    ok: rulesOk,
    ...(rulesOk
      ? {}
      : {
          error: !routingRulesRead.data.success
            ? formatCfError(routingRulesRead.data)
            : formatCfError(routingRulesWriteProbe.data),
          fix_hint: `在 ${TOKEN_URL} 编辑该 Token：Permissions 添加 [Zone] - [Email Routing Rules] - [Edit]。`,
        }),
  });

  // 7. Zone → Zone Settings → Edit (开启 Email Routing 总开关与锁定邮件 DNS 必需)
  const settingsOk = !isAuthError(
    zoneSettingsWriteProbe.status,
    zoneSettingsWriteProbe.data,
  );
  checks.push({
    id: "zone_settings_edit",
    scope: "Zone → Zone Settings",
    permission: "Edit",
    purpose: `调用 /email/routing/enable 开启 ${domain} 的 Email Routing 总开关并锁定邮件 DNS`,
    ok: settingsOk,
    ...(settingsOk
      ? {}
      : {
          error: formatCfError(zoneSettingsWriteProbe.data),
          fix_hint: `在 ${TOKEN_URL} 编辑该 Token：Permissions 添加 [Zone] - [Zone Settings] - [Edit]（Cloudflare 开启域名 Email Routing 总开关接口强依赖此权限）。`,
        }),
  });

  return buildReport(checks, {
    tokenStatus: "active",
    domain,
    zoneId,
    accountId,
    accountName,
  });
}

function buildReport(
  checks: PermissionCheckItem[],
  meta?: {
    tokenStatus?: string;
    domain?: string;
    zoneId?: string;
    accountId?: string;
    accountName?: string;
  },
): TokenCheckReport {
  const missing = checks
    .filter((c) => !c.ok)
    .map((c) => ({
      id: c.id,
      scope: c.scope,
      permission: c.permission,
      error: c.error ?? "missing permission",
      fix_hint: c.fix_hint ?? "",
    }));
  return {
    ok: missing.length === 0,
    ...meta,
    checks,
    missing,
  };
}

export function formatTokenCheckReport(report: TokenCheckReport): string {
  const lines: string[] = [];
  lines.push("=== Cloudflare API Token 权限检测 ===");
  if (report.domain) {
    lines.push(
      `目标域名: ${report.domain} (zoneId: ${report.zoneId ?? "unknown"}, accountId: ${report.accountId ?? "unknown"})`,
    );
  }
  lines.push("");
  for (const c of report.checks) {
    const icon = c.ok ? "[OK]  " : "[MISS]";
    lines.push(`${icon} ${c.scope} (${c.permission}) — ${c.purpose}`);
    if (!c.ok) {
      if (c.error) lines.push(`       原因: ${c.error}`);
      if (c.fix_hint) lines.push(`       fix_hint: ${c.fix_hint}`);
    }
  }
  lines.push("");
  if (report.ok) {
    lines.push("结果: 全部必需权限检测通过，可以执行部署。");
  } else {
    lines.push(
      `结果: 缺少 ${report.missing.length} 项权限，请按上方 fix_hint 修复后重试。`,
    );
  }
  return lines.join("\n");
}
