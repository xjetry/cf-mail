/**
 * cf-mail 统一契约（Single Source of Truth）：
 * - Worker 管理 API、租户管理 API 与公开单邮箱 API 路由表、请求/响应类型说明
 * - CLI (cfm / cfmctl) 命令定义、参数、对应 API 与 Agent 约束
 */

export type ApiAuthSpec =
  | false
  | true
  | "admin"
  | "adminOrTenant"
  | "inboxKey"
  | "anyToken";

export type ApiEndpointSpec = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  auth: ApiAuthSpec;
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
    address:
      "string (收件地址，如 test@example.com；输入前缀自动补全 @<MAIL_DOMAIN>)",
    destinations:
      "string[] (全部目标邮箱地址列表；inboxEnabled=true 或预分配未启用规则时允许为空数组 [])",
    targets: "DestinationTarget[] (带独立启用开关状态的目标邮箱列表)",
    inboxEnabled:
      "boolean? (是否开启临时收件箱暂存，支持不转发仅收件箱模式)",
    allowedSenders:
      "string[]? (可选发件人域名/邮箱白名单，如 ['anthropic.com'] 匹配其自身及子域)",
    inboxKey: "string? (该前缀专属收件箱查询凭证 cfmk_<32hex>)",
    updatedAt: "string (ISO-8601 更新时间)",
  },
  TenantToken: {
    id: "string (UUID)",
    name: "string (租户/访问令牌备注名)",
    token: "string (租户管理员访问凭证 cfmt_<32hex>)",
    addresses:
      "string[] (授权管理的完整收件邮箱列表，小写；支持多对多灵活绑定)",
    enabled: "boolean (true=启用，false=暂停)",
    expiresAt: "number? (可选到期时间 epoch ms；未设表示永不过期)",
    createdAt: "string (ISO-8601)",
    updatedAt: "string (ISO-8601)",
  },
  SessionInfo: {
    role: '"admin" | "tenant" | "user"',
    domain: "string (当前邮件域名)",
    token:
      "{ id: string, name: string, addresses: string[], expiresAt?: number }? (仅 role='tenant' 返回)",
    address: "string? (仅 role='user' 返回，当前 cfmk_ 绑定的收件地址)",
  },
  InboxMessage: {
    id: "string (UUID)",
    ts: "string (ISO-8601 到达时间)",
    expiresAt: "number (epoch ms，默认到达后 30 分钟过期清理)",
    read: "boolean (是否已被消费/标记已读)",
    readAt: "string? (ISO-8601 已读时间)",
    from: "string (发件人)",
    to: "string (收件地址)",
    subject: "string (已解码 RFC 2047 UTF-8 主题)",
    messageId: "string",
    text: "string (纯文本正文)",
    links:
      "string[] (提取出的 https 链接，已反转义 &amp;，claude.ai 链接优先排在最前)",
    codes: "string[] (提取出的 6 位数字验证码)",
  },
  WatchSlot: {
    address: "string (临时监听收件地址)",
    createdAt: "string (ISO-8601)",
    expiresAt: "number (epoch ms)",
    allowedSenders: "string[]?",
  },
  DeliveryLogEntry: {
    id: "string (UUID)",
    ts: "string (ISO-8601 投递时间)",
    from: "string (发件人)",
    to: "string (收件地址)",
    subject:
      "string (已自动解码 RFC 2047 UTF-8 的邮件主题；租户管理员视角下服务端抹除为空串)",
    messageId: "string",
    forwardedTo: "string[] (实际成功投递目标列表，含 '[inbox]')",
    rejected:
      "boolean? (是否拒信：无规则 / 发件人不在白名单 / 目标全部暂停 / 全部目标转发失败)",
    reason: "string? (拒信或部分失败原因)",
  },
  DestinationVerification: {
    address: "string (目标邮箱地址，小写)",
    status:
      '"verified" | "pending" | "missing" | "unknown"（verified=已验证可转发；pending=已添加未验证；missing=未添加到 Cloudflare；unknown=未配置 CF API）',
    verifiedAt: "string? (ISO-8601 验证通过时间)",
    message: "string? (状态提示或检查错误详情)",
  },
  DestinationCheckResult: {
    configured:
      "boolean (Worker 是否已配置 CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID)",
    destinations: "DestinationVerification[]",
  },
} as const;

export const API_ENDPOINTS_SPEC: ApiEndpointSpec[] = [
  {
    method: "GET",
    path: "/api/session",
    auth: "anyToken",
    summary:
      "【统一会话自省】识别 ADMIN_TOKEN / cfmt_ / cfmk_（支持 Bearer 或 ?key=）并返回当前角色与授权范围",
    responseBody: "SessionInfo",
  },
  {
    method: "GET",
    path: "/api/inbox?unread=1&consume=1&since=<ms>&limit=10&cursor=<ts|id>",
    auth: "inboxKey",
    summary:
      "【用户侧公开单邮箱接口】持单前缀专属 cfmk_xxx（Bearer 或 ?key=）轮询该邮箱临时收件箱；consume=1 返回同时原子标记已读防重复消费旧链接；支持 cursor 游标分页",
    responseBody:
      "{ address: string, messages: InboxMessage[], nextCursor: string | null, hasMore: boolean }",
  },
  {
    method: "POST",
    path: "/api/inbox/rotate-key",
    auth: "inboxKey",
    summary:
      "【用户侧公开单邮箱接口】持当前有效 cfmk_xxx 自助重置该邮箱收件箱 Key（旧 Key 立即失效）",
    responseBody: "{ address: string, inboxKey: string }",
  },
  {
    method: "POST",
    path: "/api/inbox/:id/ack",
    auth: "inboxKey",
    summary: "【用户侧公开单邮箱接口】显式标记某封邮件已读",
    responseBody: "{ ok: true }",
  },
  {
    method: "DELETE",
    path: "/api/inbox/:id",
    auth: "inboxKey",
    summary: "【用户侧公开单邮箱接口】删除本邮箱下的指定临时邮件",
    responseBody: "{ ok: true }",
  },
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
    path: "/admin/api/tokens",
    auth: "admin",
    summary: "【仅管理员】获取全部租户访问令牌列表",
    responseBody: "{ tokens: TenantToken[] }",
  },
  {
    method: "GET",
    path: "/admin/api/tokens/:id",
    auth: "admin",
    summary: "【仅管理员】获取单条租户访问令牌详情",
    responseBody: "{ token: TenantToken }",
  },
  {
    method: "POST",
    path: "/admin/api/tokens",
    auth: "admin",
    summary:
      "【仅管理员】创建租户访问令牌（自动为尚未存在的授权邮箱初始化空规则）",
    requestBody:
      "{ name: string, addresses: string[], enabled?: boolean, expiresAt?: number | string }",
    responseBody: "{ token: TenantToken }",
  },
  {
    method: "PUT",
    path: "/admin/api/tokens/:id",
    auth: "admin",
    summary:
      "【仅管理员】更新租户访问令牌（名称、授权邮箱列表、启停开关、过期时间；expiresAt=null 清除到期时间）",
    requestBody:
      "{ name?: string, addresses?: string[], enabled?: boolean, expiresAt?: number | string | null }",
    responseBody: "{ token: TenantToken }",
  },
  {
    method: "POST",
    path: "/admin/api/tokens/:id/rotate",
    auth: "admin",
    summary: "【仅管理员】重置轮换指定租户访问令牌的 cfmt_ 密钥（旧密钥立即失效）",
    responseBody: "{ token: TenantToken }",
  },
  {
    method: "DELETE",
    path: "/admin/api/tokens/:id",
    auth: "admin",
    summary: "【仅管理员】删除指定租户访问令牌（不影响已创建的邮箱规则本身）",
    responseBody: "{ ok: true }",
  },
  {
    method: "GET",
    path: "/admin/api/rules",
    auth: "adminOrTenant",
    summary:
      "获取当前邮件域名与规则列表（管理员返回全部，租户管理员仅返回已授权邮箱规则）",
    responseBody: "{ domain: string, rules: ForwardRule[] }",
  },
  {
    method: "GET",
    path: "/admin/api/rules/:address",
    auth: "adminOrTenant",
    summary:
      "获取单条规则（:address 支持完整邮箱或仅传前缀；租户管理员仅限授权邮箱）",
    responseBody: "{ rule: ForwardRule }",
  },
  {
    method: "PUT",
    path: "/admin/api/rules/:address",
    auth: "adminOrTenant",
    summary:
      "新增或覆盖规则（支持 overwrite=false 防误覆盖并返回 409 Conflict；租户管理员仅限修改已授权邮箱内部配置，禁止新建未授权地址或重命名收件地址）",
    requestBody:
      "{ address?: string, destinations?: string[], targets?: Array<{ address: string, enabled?: boolean }>, inboxEnabled?: boolean, allowedSenders?: string[], generateKey?: boolean, overwrite?: boolean }",
    responseBody: "{ rule: ForwardRule, verification: DestinationCheckResult }",
  },
  {
    method: "POST",
    path: "/admin/api/rules/:address/inbox-key",
    auth: "adminOrTenant",
    summary:
      "生成或轮换重置指定前缀的独立收件箱 Key（旧 Key 立即失效；租户管理员仅限授权邮箱）",
    responseBody: "{ rule: ForwardRule, inboxKey: string }",
  },
  {
    method: "DELETE",
    path: "/admin/api/rules/:address/inbox-key",
    auth: "adminOrTenant",
    summary: "吊销指定前缀的独立收件箱 Key（租户管理员仅限授权邮箱）",
    responseBody: "{ rule: ForwardRule }",
  },
  {
    method: "GET",
    path: "/admin/api/inbox/watches",
    auth: "admin",
    summary: "【仅管理员】列出当前所有尚未过期的临时收件监听槽位",
    responseBody: "{ watches: WatchSlot[] }",
  },
  {
    method: "POST",
    path: "/admin/api/inbox/watch",
    auth: "admin",
    summary:
      "【仅管理员】开启一次性临时收件监听槽位（默认 TTL 1800s，无规则地址在监听期内免拒信入库）",
    requestBody:
      "{ address: string, ttlSeconds?: number, allowedSenders?: string[] }",
    responseBody: "{ watch: WatchSlot }",
  },
  {
    method: "DELETE",
    path: "/admin/api/inbox/watch/:address",
    auth: "admin",
    summary: "【仅管理员】提前关闭临时收件监听槽位",
    responseBody: "{ ok: boolean }",
  },
  {
    method: "GET",
    path: "/admin/api/inbox?to=<addr>&unread=1&consume=1&since=<ms>&limit=20&cursor=<ts|id>",
    auth: "admin",
    summary:
      "【仅管理员】查询全局或指定收件地址的临时收件箱邮件（支持 cursor 游标分页；租户管理员禁止读收件箱）",
    responseBody:
      "{ messages: InboxMessage[], nextCursor: string | null, hasMore: boolean }",
  },
  {
    method: "DELETE",
    path: "/admin/api/inbox/:id",
    auth: "admin",
    summary: "【仅管理员】删除指定临时收件箱邮件",
    responseBody: "{ ok: true }",
  },
  {
    method: "GET",
    path: "/admin/api/destinations/status?addresses=a@x.com,b@y.com",
    auth: "adminOrTenant",
    summary: "批量检查目标邮箱在 Cloudflare Email Routing 的验证状态",
    responseBody: "DestinationCheckResult",
  },
  {
    method: "POST",
    path: "/admin/api/destinations/verify",
    auth: "adminOrTenant",
    summary: "为目标邮箱发送/重发 Cloudflare 验证邮件",
    requestBody: "{ address: string }",
    responseBody:
      "{ destination: DestinationVerification, action: 'sent' | 'resent' | 'already_verified', message: string }",
  },
  {
    method: "PATCH",
    path: "/admin/api/rules/:address/targets",
    auth: "adminOrTenant",
    summary:
      "单独切换某条规则下某个目标邮箱的启用/暂停状态（租户管理员仅限授权邮箱）",
    requestBody: "{ target: string, enabled: boolean }",
    responseBody: "{ rule: ForwardRule }",
  },
  {
    method: "DELETE",
    path: "/admin/api/rules/:address",
    auth: "admin",
    summary:
      "【仅管理员】删除指定收件地址的规则（同时作废其独立 inboxKey、清理临时邮件并从租户令牌授权列表中移除）",
    responseBody: "{ ok: true }",
  },
  {
    method: "GET",
    path: "/admin/api/logs?limit=50&cursor=<ts|id>",
    auth: "adminOrTenant",
    summary:
      "查看最近邮件投递日志（支持 cursor 游标分页；管理员查看全局日志；租户管理员仅返回已授权邮箱且服务端抹除邮件主题）",
    responseBody:
      "{ logs: DeliveryLogEntry[], nextCursor: string | null, hasMore: boolean }",
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
    command: "whoami",
    args: "[--json]",
    summary:
      "查看当前 Token 对应的角色身份（admin / tenant / user）及授权范围",
    api: "GET /api/session",
    examples: ["cfmctl whoami", "cfmctl whoami --token cfmk_xxx"],
  },
  {
    command: "schema",
    args: "[--remote]",
    summary:
      "输出当前 CLI 与 API 的完整 JSON Schema（传 --remote 从线上 Worker 实时拉取）",
    api: "GET /admin/schema",
    examples: ["cfmctl schema", "cfmctl schema --remote"],
  },
  {
    command: "list",
    args: "",
    summary:
      "列出规则（管理员看全部，租户管理员看已授权邮箱；标注 [inbox]、白名单及暂停目标）",
    api: "GET /admin/api/rules",
    examples: ["cfmctl list"],
  },
  {
    command: "get",
    args: "<address>",
    summary: "查看单条规则详情 JSON（含 inboxKey）",
    api: "GET /admin/api/rules/:address",
    examples: ["cfmctl get test"],
  },
  {
    command: "set",
    args: "<address> [--inbox | --no-inbox] [--allow-from d1,d2] [--no-overwrite] [dest...]",
    summary:
      "新增或覆盖规则（支持 --inbox 纯收件箱规则与 --no-overwrite 防覆盖保护；租户管理员仅可修改已授权邮箱）",
    api: "PUT /admin/api/rules/:address",
    examples: [
      "cfmctl set claude01 --inbox --allow-from anthropic.com --no-overwrite",
      "cfmctl set test me@gmail.com backup@outlook.com",
    ],
    agentNotes:
      "set 默认是全量覆盖语义；新建规则时建议传 --no-overwrite 防止意外覆盖已有规则（冲突时返回 409）。",
  },
  {
    command: "key",
    args: "[address] [--rotate | --revoke]",
    summary:
      "查看、重置（--rotate）或吊销（--revoke）收件箱 Key（持 cfmk_ 用户凭证时可省略 address 直接 --rotate 自助重置）",
    api: "POST /admin/api/rules/:address/inbox-key | POST /api/inbox/rotate-key",
    examples: [
      "cfmctl key claude01",
      "cfmctl key claude01 --rotate",
      "cfmctl key --rotate --token cfmk_xxx",
    ],
  },
  {
    command: "inbox",
    args: "[address] [--unread] [--consume] [--json]",
    summary:
      "查看临时收件箱邮件（管理员走 /admin/api/inbox；持 cfmk_ 用户凭证自动走 /api/inbox；租户管理员不可调用）",
    api: "GET /admin/api/inbox | GET /api/inbox",
    examples: [
      "cfmctl inbox claude01 --unread --consume",
      "cfmctl inbox --unread --consume --token cfmk_xxx",
    ],
  },
  {
    command: "token",
    args: "<list|get|create|set|rotate|enable|disable|delete> ...",
    summary:
      "【仅管理员】管理租户管理员访问令牌（cfmt_...）：创建授权邮箱列表、启停、轮换密钥与删除",
    api: "/admin/api/tokens*",
    examples: [
      "cfmctl token list",
      "cfmctl token create 渠道A claude01 claude02",
      "cfmctl token set <id> --name 渠道A新 claude01 claude02 claude03",
      "cfmctl token rotate <id>",
      "cfmctl token disable <id>",
      "cfmctl token delete <id>",
    ],
  },
  {
    command: "watch",
    args: "[<address> [--ttl SECONDS] [--allow-from d1,d2] | --list]",
    summary: "【仅管理员】开启或列出一次性临时收件监听槽位（默认 1800 秒）",
    api: "POST /admin/api/inbox/watch | GET /admin/api/inbox/watches",
    examples: [
      "cfmctl watch temp01 --allow-from anthropic.com",
      "cfmctl watch --list",
    ],
  },
  {
    command: "unwatch",
    args: "<address>",
    summary: "【仅管理员】关闭临时收件监听槽位",
    api: "DELETE /admin/api/inbox/watch/:address",
    examples: ["cfmctl unwatch temp01"],
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
    summary: "临时暂停某条规则下的指定目标邮箱",
    api: "PATCH /admin/api/rules/:address/targets",
    examples: ["cfmctl disable test backup@outlook.com"],
  },
  {
    command: "delete",
    args: "<address>",
    summary: "【仅管理员】删除整条规则（同时清理关联收件箱与租户授权）",
    api: "DELETE /admin/api/rules/:address",
    examples: ["cfmctl delete test"],
  },
  {
    command: "logs",
    args: "[limit]",
    summary: "查看最近投递日志（租户管理员仅见已授权邮箱且隐藏邮件主题）",
    api: "GET /admin/api/logs",
    examples: ["cfmctl logs 20"],
  },
  {
    command: "check-dest",
    args: "<dest...>",
    summary:
      "检查目标邮箱的 Cloudflare 验证状态（verified/pending/missing/unknown）",
    api: "GET /admin/api/destinations/status",
    examples: ["cfmctl check-dest me@gmail.com backup@outlook.com"],
  },
  {
    command: "verify-dest",
    args: "<dest>",
    summary: "向目标邮箱发送/重发 Cloudflare 验证邮件",
    api: "POST /admin/api/destinations/verify",
    examples: ["cfmctl verify-dest me@gmail.com"],
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
  "系统支持三类角色凭证：`ADMIN_TOKEN`（全局管理员）、`cfmt_...`（租户管理员，仅管理已授权邮箱规则，不可读收件箱、不可删规则）、`cfmk_...`（单邮箱用户凭证，仅读该邮箱临时收件箱并可自助重置 Key，支持 Web `/?key=cfmk_...` 免输直达）。不确定当前身份时先运行 `cfmctl whoami`。",
  "可以通过 `cfmctl schema`（本地定义）或 `cfmctl schema --remote`（实时向线上 Worker 请求 `/admin/schema`）随时自省最新的 API 与 CLI 结构。",
  "需要不转发、仅程序化轮询收验证码/Magic-Link 时，使用 `cfmctl set <prefix> --inbox --allow-from anthropic.com` 创建纯收件箱规则，并将生成的 `cfmk_...` 凭证（或 `/?key=cfmk_...` 直达链接）提供给消费方。",
  "`<address>` 参数支持只写前缀（如 `hi`），服务端会自动补全 `@<MAIL_DOMAIN>`。",
  "新增转发目标后务必检查响应中的 `verification`：目标为 pending 或 missing 时转发必然失败，应执行 `cfmctl verify-dest <dest>` 发送验证邮件。",
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
    const left = `${c.command}${c.args ? " " + c.args : ""}`.padEnd(46, " ");
    return `  ${left}${c.summary}`;
  }).join("\n");

  return `cf-mail 管理 CLI (cfm / cfmctl)

用法:
  cfm    <command> [args]              # 本地（CFM_URL / CFM_TOKEN，默认 http://localhost:8787）
  cfmctl <command> [--url URL] [--token TOKEN] [args]   # 远程

命令:
${cmdLines}

凭证角色:
  ADMIN_TOKEN                         全局管理员（管理全部邮箱、访问令牌、收件箱与日志）
  cfmt_<32hex>                        租户管理员（仅管理授权邮箱规则，禁读收件箱、禁删规则）
  cfmk_<32hex>                        单邮箱用户（仅读该邮箱临时收件箱与自助重置 Key）

配置:
  CFM_URL / CFM_TOKEN                 本地 Worker 地址与 Token
  CFMCTL_URL / CFMCTL_TOKEN           远程 Worker 地址与 Token（优先于 CFM_*）
  CLOUDFLARE_API_TOKEN                部署与 check-token 使用的 Cloudflare API Token
  --url / --token                     单次覆盖（cfmctl 常用）
`;
}
