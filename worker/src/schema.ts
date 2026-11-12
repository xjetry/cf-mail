/**
 * cf-mail 统一契约（Single Source of Truth）：
 * - Worker 管理 API 路由表、请求/响应类型说明
 * - CLI (cfm / cfmctl) 命令定义、参数、对应 API 与 Agent 约束
 * - scripts/gen-skill.mjs 与 `/admin/schema`、CLI `schema` 命令均直接读取此模块，
 *   确保 API 变更时 CLI 帮助、运行时自省 Schema 与 skills/cf-mail/SKILL.md 100% 自动同步。
 */

export type ApiEndpointSpec = {
  method: "GET" | "PUT" | "PATCH" | "DELETE";
  path: string;
  auth: boolean;
  summary: string;
  requestBody?: string;
  responseBody: string;
};

export type CliCommandSpec = {
  command: string;
  args: string;
  summary: string;
  api?: string;
  examples: string[];
  agentNotes?: string;
};

export const DATA_MODELS_SPEC = {
  DestinationTarget: {
    address: "string (目标邮箱地址，小写)",
    enabled: "boolean (true=启用转发，false=临时暂停)",
  },
  ForwardRule: {
    address: "string (收件地址，如 test@example.com；输入前缀自动补全 @<MAIL_DOMAIN>)",
    destinations: "string[] (全部目标邮箱地址列表)",
    targets: "DestinationTarget[] (带独立启用开关状态的目标邮箱列表)",
    updatedAt: "string (ISO-8601 更新时间)",
  },
  DeliveryLogEntry: {
    id: "string (UUID)",
    ts: "string (ISO-8601 投递时间)",
    from: "string (发件人)",
    to: "string (收件地址)",
    subject: "string (已自动解码 RFC 2047 UTF-8 的邮件主题)",
    messageId: "string",
    forwardedTo: "string[] (实际成功转发的目标列表)",
    rejected: "boolean? (是否拒信)",
    reason: "string? (拒信或部分失败原因：no rule / all destinations disabled / 错误详情)",
  },
} as const;

export const API_ENDPOINTS_SPEC: ApiEndpointSpec[] = [
  {
    method: "GET",
    path: "/admin/healthz",
    auth: false,
    summary: "健康检查",
    responseBody: "{ ok: true }",
  },
  {
    method: "GET",
    path: "/admin/schema",
    auth: false,
    summary: "返回机器可读的 API & CLI Schema（供 Agent / CLI 动态自省）",
    responseBody: "{ models, endpoints, cliCommands, agentRules }",
  },
  {
    method: "GET",
    path: "/admin/api/rules",
    auth: true,
    summary: "获取当前邮件域名与全部转发规则列表",
    responseBody: "{ domain: string, rules: ForwardRule[] }",
  },
  {
    method: "GET",
    path: "/admin/api/rules/:address",
    auth: true,
    summary: "获取单条转发规则（:address 支持完整邮箱或仅传前缀）",
    responseBody: "{ rule: ForwardRule }",
  },
  {
    method: "PUT",
    path: "/admin/api/rules/:address",
    auth: true,
    summary: "新增或覆盖转发规则（若传入 body.address 与 :address 不同则自动迁移改名）",
    requestBody:
      "{ address?: string, destinations?: string[], targets?: Array<{ address: string, enabled?: boolean }> }",
    responseBody: "{ rule: ForwardRule }",
  },
  {
    method: "PATCH",
    path: "/admin/api/rules/:address/targets",
    auth: true,
    summary: "单独切换某条规则下某个目标邮箱的启用/暂停状态",
    requestBody: "{ target: string, enabled: boolean }",
    responseBody: "{ rule: ForwardRule }",
  },
  {
    method: "DELETE",
    path: "/admin/api/rules/:address",
    auth: true,
    summary: "删除指定收件地址的转发规则",
    responseBody: "{ ok: true }",
  },
  {
    method: "GET",
    path: "/admin/api/logs?limit=50",
    auth: true,
    summary: "查看最近邮件投递日志（默认 50 条，最大 200 条）",
    responseBody: "{ logs: DeliveryLogEntry[] }",
  },
];

export const CLI_COMMANDS_SPEC: CliCommandSpec[] = [
  {
    command: "health",
    args: "",
    summary: "检查服务连通性",
    api: "GET /admin/healthz",
    examples: ["cfmctl health"],
  },
  {
    command: "schema",
    args: "[--remote]",
    summary: "输出当前 CLI 与 API 的完整 JSON Schema（传 --remote 从线上 Worker 实时拉取）",
    api: "GET /admin/schema",
    examples: ["cfmctl schema", "cfmctl schema --remote"],
  },
  {
    command: "list",
    args: "",
    summary: "列出全部转发规则（暂停的目标标注 (off)）",
    api: "GET /admin/api/rules",
    examples: ["cfmctl list"],
  },
  {
    command: "get",
    args: "<address>",
    summary: "查看单条规则详情 JSON（address 可只写前缀，如 test）",
    api: "GET /admin/api/rules/:address",
    examples: ["cfmctl get test"],
  },
  {
    command: "set",
    args: "<address> <dest...>",
    summary: "新增或覆盖规则（多目标用空格分隔；目标前加 - 表示初始为暂停状态）",
    api: "PUT /admin/api/rules/:address",
    examples: [
      "cfmctl set test me@gmail.com backup@outlook.com",
      "cfmctl set test me@gmail.com -paused@outlook.com",
    ],
    agentNotes:
      "set 是全量覆盖语义！如果要向已有规则追加新目标，必须先执行 get 读取现有 targets（保留暂停目标的 - 前缀），合并后再执行 set。",
  },
  {
    command: "enable",
    args: "<address> <dest>",
    summary: "启用某条规则下的指定目标邮箱",
    api: "PATCH /admin/api/rules/:address/targets",
    examples: ["cfmctl enable test backup@outlook.com"],
  },
  {
    command: "disable",
    args: "<address> <dest>",
    summary: "临时暂停某条规则下的指定目标邮箱（保留在规则中，仅停止向其转发）",
    api: "PATCH /admin/api/rules/:address/targets",
    examples: ["cfmctl disable test backup@outlook.com"],
    agentNotes:
      "当用户要求临时关闭/暂停某个转发目标时，优先使用 disable 而不是重新 set 或 delete。",
  },
  {
    command: "delete",
    args: "<address>",
    summary: "删除整条转发规则（删除后发往该地址的邮件会被拒收退信）",
    api: "DELETE /admin/api/rules/:address",
    examples: ["cfmctl delete test"],
  },
  {
    command: "logs",
    args: "[limit]",
    summary: "查看最近投递日志（默认 50 条，已自动解码 UTF-8 主题）",
    api: "GET /admin/api/logs",
    examples: ["cfmctl logs 20"],
  },
  {
    command: "check-token",
    args: "[domain] [--cf-token TOKEN] [--json]",
    summary: "检测部署所需的 Cloudflare API Token 7 项权限并输出缺失项的 fix_hint",
    examples: ["cfmctl check-token example.com --cf-token <CF_API_TOKEN>"],
  },
];

export const AGENT_WORKFLOW_RULES: string[] = [
  "执行任何命令前，若工作目录存在 `.env`，先执行 `set -a && source .env && set +a` 加载 `CFMCTL_URL` 与 `CFMCTL_TOKEN`。",
  "可以通过 `cfmctl schema`（本地定义）或 `cfmctl schema --remote`（实时向线上 Worker 请求 `/admin/schema`）随时自省最新的 API 与 CLI 结构。",
  "`set` 是全量覆盖语义：若用户要求「再加一个目标邮箱」，必须先 `cfmctl get <address>` 获取现有 `targets`，合并后再 `set`（对 `enabled: false` 的目标加 `-` 前缀保持暂停状态）。",
  "临时停用或恢复某个转发目标时，直接使用 `cfmctl disable <address> <dest>` / `cfmctl enable <address> <dest>`。",
  "`<address>` 参数支持只写前缀（如 `hi`），服务端会自动补全 `@<MAIL_DOMAIN>`。",
  "遇到部署鉴权失败时，运行 `cfmctl check-token <domain> --cf-token <TOKEN>` 获取精确的 `fix_hint`。",
];

export function getFullSchema() {
  return {
    name: "cf-mail",
    models: DATA_MODELS_SPEC,
    endpoints: API_ENDPOINTS_SPEC,
    cliCommands: CLI_COMMANDS_SPEC,
    agentRules: AGENT_WORKFLOW_RULES,
  };
}

export function renderCliHelp(): string {
  const cmdLines = CLI_COMMANDS_SPEC.map((c) => {
    const left = `${c.command}${c.args ? " " + c.args : ""}`.padEnd(36, " ");
    return `  ${left}${c.summary}`;
  }).join("\n");

  return `cf-mail 管理 CLI (cfm / cfmctl)

用法:
  cfm    <command> [args]              # 本地（CFM_URL / CFM_TOKEN，默认 http://localhost:8787）
  cfmctl <command> [--url URL] [--token TOKEN] [args]   # 远程

命令:
${cmdLines}

配置:
  CFM_URL / CFM_TOKEN                 本地 Worker 地址与 Token
  CFMCTL_URL / CFMCTL_TOKEN           远程 Worker 地址与 Token（优先于 CFM_*）
  CLOUDFLARE_API_TOKEN                部署与 check-token 使用的 Cloudflare API Token
  --url / --token                     单次覆盖（cfmctl 常用）
`;
}
