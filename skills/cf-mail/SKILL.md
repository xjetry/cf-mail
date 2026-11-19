---
name: cf-mail
description: 使用 cfm / cfmctl CLI 或 REST API 管理 cf-mail 动态邮件转发服务（Cloudflare Worker + Durable Objects）：查询/新增/修改/删除转发规则、单独启用或暂停目标邮箱、查看投递日志、检测 Cloudflare API Token 部署权限。当用户提到 cf-mail、cfmctl、cfm、邮件转发规则、把某邮箱转发到某处、暂停/恢复某个转发目标或查看邮件投递日志时使用。
---

<!-- AUTO-GENERATED FROM worker/src/schema.ts BY cli/build.mjs — DO NOT EDIT MANUALLY -->

# cf-mail CLI (`cfm` / `cfmctl`) & API 技能指南

> **自动同步声明**：本文件由 `cli/build.mjs` 在每次 `npm run build` / `npm run deploy` 时从唯一真实数据源 `worker/src/schema.ts` 自动生成。
> Agent 也可以随时在运行时执行 `cfmctl schema`（本地）或 `cfmctl schema --remote`（请求线上 `GET /admin/schema`）实时自省最新 API 与命令契约。

## 1. Agent 核心操作铁律

1. 执行任何命令前，若工作目录存在 `.env`，先执行 `set -a && source .env && set +a` 加载 `CFMCTL_URL` 与 `CFMCTL_TOKEN`。
2. 系统支持三类角色凭证：`ADMIN_TOKEN`（全局管理员）、`cfmt_...`（租户管理员，仅管理已授权邮箱规则，不可读收件箱、不可删规则）、`cfmk_...`（单邮箱用户凭证，仅读该邮箱临时收件箱并可自助重置 Key，支持 Web `/?key=cfmk_...` 免输直达）。不确定当前身份时先运行 `cfmctl whoami`。
3. 可以通过 `cfmctl schema`（本地定义）或 `cfmctl schema --remote`（实时向线上 Worker 请求 `/admin/schema`）随时自省最新的 API 与 CLI 结构。
4. 需要不转发、仅程序化轮询收验证码/Magic-Link 时，使用 `cfmctl set <prefix> --inbox --allow-from anthropic.com` 创建纯收件箱规则，并将生成的 `cfmk_...` 凭证（或 `/?key=cfmk_...` 直达链接）提供给消费方。
5. `<address>` 参数支持只写前缀（如 `hi`），服务端会自动补全 `@<MAIL_DOMAIN>`。
6. 新增转发目标后务必检查响应中的 `verification`：目标为 pending 或 missing 时转发必然失败，应执行 `cfmctl verify-dest <dest>` 发送验证邮件。

### 重点命令注意事项

- **`set`**：set 默认是全量覆盖语义；新建规则时建议传 --no-overwrite 防止意外覆盖已有规则（冲突时返回 409）。

---

## 2. CLI 命令契约表 (`cfmctl` / `cfm`)

| CLI 命令 | 对应 Worker API | 说明 |
|---|---|---|
| `cfmctl health` | `GET /admin/healthz` | 检查服务连通性 |
| `cfmctl whoami [--json]` | `GET /api/session` | 查看当前 Token 对应的角色身份（admin / tenant / user）及授权范围 |
| `cfmctl schema [--remote]` | `GET /admin/schema` | 输出当前 CLI 与 API 的完整 JSON Schema（传 --remote 从线上 Worker 实时拉取） |
| `cfmctl list` | `GET /admin/api/rules` | 列出规则（管理员看全部，租户管理员看已授权邮箱；标注 [inbox]、白名单及暂停目标） |
| `cfmctl get <address>` | `GET /admin/api/rules/:address` | 查看单条规则详情 JSON（含 inboxKey） |
| `cfmctl set <address> [--inbox | --no-inbox] [--allow-from d1,d2] [--no-overwrite] [dest...]` | `PUT /admin/api/rules/:address` | 新增或覆盖规则（支持 --inbox 纯收件箱规则与 --no-overwrite 防覆盖保护；租户管理员仅可修改已授权邮箱） |
| `cfmctl key [address] [--rotate | --revoke]` | `POST /admin/api/rules/:address/inbox-key | POST /api/inbox/rotate-key` | 查看、重置（--rotate）或吊销（--revoke）收件箱 Key（持 cfmk_ 用户凭证时可省略 address 直接 --rotate 自助重置） |
| `cfmctl inbox [address] [--unread] [--consume] [--json]` | `GET /admin/api/inbox | GET /api/inbox` | 查看临时收件箱邮件（管理员走 /admin/api/inbox；持 cfmk_ 用户凭证自动走 /api/inbox；租户管理员不可调用） |
| `cfmctl token <list|get|create|set|rotate|enable|disable|delete> ...` | `/admin/api/tokens*` | 【仅管理员】管理租户管理员访问令牌（cfmt_...）：创建授权邮箱列表、启停、轮换密钥与删除 |
| `cfmctl watch [<address> [--ttl SECONDS] [--allow-from d1,d2] | --list]` | `POST /admin/api/inbox/watch | GET /admin/api/inbox/watches` | 【仅管理员】开启或列出一次性临时收件监听槽位（默认 1800 秒） |
| `cfmctl unwatch <address>` | `DELETE /admin/api/inbox/watch/:address` | 【仅管理员】关闭临时收件监听槽位 |
| `cfmctl enable <address> <dest>` | `PATCH /admin/api/rules/:address/targets` | 启用某条规则下的指定目标邮箱 |
| `cfmctl disable <address> <dest>` | `PATCH /admin/api/rules/:address/targets` | 临时暂停某条规则下的指定目标邮箱 |
| `cfmctl delete <address>` | `DELETE /admin/api/rules/:address` | 【仅管理员】删除整条规则（同时清理关联收件箱与租户授权） |
| `cfmctl logs [limit]` | `GET /admin/api/logs` | 查看最近投递日志（租户管理员仅见已授权邮箱且隐藏邮件主题） |
| `cfmctl check-dest <dest...>` | `GET /admin/api/destinations/status` | 检查目标邮箱的 Cloudflare 验证状态（verified/pending/missing/unknown） |
| `cfmctl verify-dest <dest>` | `POST /admin/api/destinations/verify` | 向目标邮箱发送/重发 Cloudflare 验证邮件 |
| `cfmctl check-token [domain] [--cf-token TOKEN] [--json]` | — | 检测部署所需的 Cloudflare API Token 7 项权限并输出缺失项的 fix_hint |

### 快速调用示例

```bash
# 1. 加载环境变量 (.env 中包含 CFMCTL_URL / CFMCTL_TOKEN / MAIL_DOMAIN)
set -a && [ -f .env ] && source .env && set +a

# 2. 动态自省当前版本 CLI & 远端 Worker 的完整 JSON Schema
cfmctl schema
cfmctl schema --remote

# 3. 常用操作
cfmctl health
cfmctl list
cfmctl get test
cfmctl set test me@gmail.com backup@outlook.com
cfmctl disable test backup@outlook.com
cfmctl enable test backup@outlook.com
cfmctl delete test
cfmctl logs 20
cfmctl check-token example.com --cf-token <CLOUDFLARE_API_TOKEN>
```

---

## 3. REST API 路由契约表

| 路由 | 鉴权 | 说明 | 请求体 (Request JSON) | 响应体 (Response JSON) |
|---|---|---|---|---|
| `GET /api/session` | ADMIN_TOKEN / cfmt_ / cfmk_ | 【统一会话自省】识别 ADMIN_TOKEN / cfmt_ / cfmk_（支持 Bearer 或 ?key=）并返回当前角色与授权范围 | `-` | `SessionInfo` |
| `GET /api/inbox?unread=1&consume=1&since=<ms>&limit=10&cursor=<ts|id>` | cfmk_ (Bearer / ?key=) | 【用户侧公开单邮箱接口】持单前缀专属 cfmk_xxx（Bearer 或 ?key=）轮询该邮箱临时收件箱；consume=1 返回同时原子标记已读防重复消费旧链接；支持 cursor 游标分页 | `-` | `{ address: string, messages: InboxMessage[], nextCursor: string | null, hasMore: boolean }` |
| `POST /api/inbox/rotate-key` | cfmk_ (Bearer / ?key=) | 【用户侧公开单邮箱接口】持当前有效 cfmk_xxx 自助重置该邮箱收件箱 Key（旧 Key 立即失效） | `-` | `{ address: string, inboxKey: string }` |
| `POST /api/inbox/:id/ack` | cfmk_ (Bearer / ?key=) | 【用户侧公开单邮箱接口】显式标记某封邮件已读 | `-` | `{ ok: true }` |
| `DELETE /api/inbox/:id` | cfmk_ (Bearer / ?key=) | 【用户侧公开单邮箱接口】删除本邮箱下的指定临时邮件 | `-` | `{ ok: true }` |
| `GET /admin/healthz` | 公开 | 健康检查 | `-` | `{ ok: true }` |
| `GET /admin/schema` | 公开 | 返回机器可读的 API & CLI Schema（供 Agent / CLI 动态自省） | `-` | `{ models, endpoints, cliCommands, agentRules }` |
| `GET /admin/api/tokens` | ADMIN_TOKEN | 【仅管理员】获取全部租户访问令牌列表 | `-` | `{ tokens: TenantToken[] }` |
| `GET /admin/api/tokens/:id` | ADMIN_TOKEN | 【仅管理员】获取单条租户访问令牌详情 | `-` | `{ token: TenantToken }` |
| `POST /admin/api/tokens` | ADMIN_TOKEN | 【仅管理员】创建租户访问令牌（自动为尚未存在的授权邮箱初始化空规则） | `{ name: string, addresses: string[], enabled?: boolean, expiresAt?: number | string }` | `{ token: TenantToken }` |
| `PUT /admin/api/tokens/:id` | ADMIN_TOKEN | 【仅管理员】更新租户访问令牌（名称、授权邮箱列表、启停开关、过期时间；expiresAt=null 清除到期时间） | `{ name?: string, addresses?: string[], enabled?: boolean, expiresAt?: number | string | null }` | `{ token: TenantToken }` |
| `POST /admin/api/tokens/:id/rotate` | ADMIN_TOKEN | 【仅管理员】重置轮换指定租户访问令牌的 cfmt_ 密钥（旧密钥立即失效） | `-` | `{ token: TenantToken }` |
| `DELETE /admin/api/tokens/:id` | ADMIN_TOKEN | 【仅管理员】删除指定租户访问令牌（不影响已创建的邮箱规则本身） | `-` | `{ ok: true }` |
| `GET /admin/api/rules` | ADMIN_TOKEN / cfmt_ | 获取当前邮件域名与规则列表（管理员返回全部，租户管理员仅返回已授权邮箱规则） | `-` | `{ domain: string, rules: ForwardRule[] }` |
| `GET /admin/api/rules/:address` | ADMIN_TOKEN / cfmt_ | 获取单条规则（:address 支持完整邮箱或仅传前缀；租户管理员仅限授权邮箱） | `-` | `{ rule: ForwardRule }` |
| `PUT /admin/api/rules/:address` | ADMIN_TOKEN / cfmt_ | 新增或覆盖规则（支持 overwrite=false 防误覆盖并返回 409 Conflict；租户管理员仅限修改已授权邮箱内部配置，禁止新建未授权地址或重命名收件地址） | `{ address?: string, destinations?: string[], targets?: Array<{ address: string, enabled?: boolean }>, inboxEnabled?: boolean, allowedSenders?: string[], generateKey?: boolean, overwrite?: boolean }` | `{ rule: ForwardRule, verification: DestinationCheckResult }` |
| `POST /admin/api/rules/:address/inbox-key` | ADMIN_TOKEN / cfmt_ | 生成或轮换重置指定前缀的独立收件箱 Key（旧 Key 立即失效；租户管理员仅限授权邮箱） | `-` | `{ rule: ForwardRule, inboxKey: string }` |
| `DELETE /admin/api/rules/:address/inbox-key` | ADMIN_TOKEN / cfmt_ | 吊销指定前缀的独立收件箱 Key（租户管理员仅限授权邮箱） | `-` | `{ rule: ForwardRule }` |
| `GET /admin/api/inbox/watches` | ADMIN_TOKEN | 【仅管理员】列出当前所有尚未过期的临时收件监听槽位 | `-` | `{ watches: WatchSlot[] }` |
| `POST /admin/api/inbox/watch` | ADMIN_TOKEN | 【仅管理员】开启一次性临时收件监听槽位（默认 TTL 1800s，无规则地址在监听期内免拒信入库） | `{ address: string, ttlSeconds?: number, allowedSenders?: string[] }` | `{ watch: WatchSlot }` |
| `DELETE /admin/api/inbox/watch/:address` | ADMIN_TOKEN | 【仅管理员】提前关闭临时收件监听槽位 | `-` | `{ ok: boolean }` |
| `GET /admin/api/inbox?to=<addr>&unread=1&consume=1&since=<ms>&limit=20&cursor=<ts|id>` | ADMIN_TOKEN | 【仅管理员】查询全局或指定收件地址的临时收件箱邮件（支持 cursor 游标分页；租户管理员禁止读收件箱） | `-` | `{ messages: InboxMessage[], nextCursor: string | null, hasMore: boolean }` |
| `DELETE /admin/api/inbox/:id` | ADMIN_TOKEN | 【仅管理员】删除指定临时收件箱邮件 | `-` | `{ ok: true }` |
| `GET /admin/api/destinations/status?addresses=a@x.com,b@y.com` | ADMIN_TOKEN / cfmt_ | 批量检查目标邮箱在 Cloudflare Email Routing 的验证状态 | `-` | `DestinationCheckResult` |
| `POST /admin/api/destinations/verify` | ADMIN_TOKEN / cfmt_ | 为目标邮箱发送/重发 Cloudflare 验证邮件 | `{ address: string }` | `{ destination: DestinationVerification, action: 'sent' | 'resent' | 'already_verified', message: string }` |
| `PATCH /admin/api/rules/:address/targets` | ADMIN_TOKEN / cfmt_ | 单独切换某条规则下某个目标邮箱的启用/暂停状态（租户管理员仅限授权邮箱） | `{ target: string, enabled: boolean }` | `{ rule: ForwardRule }` |
| `DELETE /admin/api/rules/:address` | ADMIN_TOKEN | 【仅管理员】删除指定收件地址的规则（同时作废其独立 inboxKey、清理临时邮件并从租户令牌授权列表中移除） | `-` | `{ ok: true }` |
| `GET /admin/api/logs?limit=50&cursor=<ts|id>` | ADMIN_TOKEN / cfmt_ | 查看最近邮件投递日志（支持 cursor 游标分页；管理员查看全局日志；租户管理员仅返回已授权邮箱且服务端抹除邮件主题） | `-` | `{ logs: DeliveryLogEntry[], nextCursor: string | null, hasMore: boolean }` |

---

## 4. 数据模型 (Data Models)

```json
{
  "DestinationTarget": {
    "address": "string (目标邮箱地址，小写)",
    "enabled": "boolean (true=启用转发，false=临时暂停)"
  },
  "ForwardRule": {
    "address": "string (收件地址，如 test@example.com；输入前缀自动补全 @<MAIL_DOMAIN>)",
    "destinations": "string[] (全部目标邮箱地址列表；inboxEnabled=true 或预分配未启用规则时允许为空数组 [])",
    "targets": "DestinationTarget[] (带独立启用开关状态的目标邮箱列表)",
    "inboxEnabled": "boolean? (是否开启临时收件箱暂存，支持不转发仅收件箱模式)",
    "allowedSenders": "string[]? (可选发件人域名/邮箱白名单，如 ['anthropic.com'] 匹配其自身及子域)",
    "inboxKey": "string? (该前缀专属收件箱查询凭证 cfmk_<32hex>)",
    "updatedAt": "string (ISO-8601 更新时间)"
  },
  "TenantToken": {
    "id": "string (UUID)",
    "name": "string (租户/访问令牌备注名)",
    "token": "string (租户管理员访问凭证 cfmt_<32hex>)",
    "addresses": "string[] (授权管理的完整收件邮箱列表，小写；支持多对多灵活绑定)",
    "enabled": "boolean (true=启用，false=暂停)",
    "expiresAt": "number? (可选到期时间 epoch ms；未设表示永不过期)",
    "createdAt": "string (ISO-8601)",
    "updatedAt": "string (ISO-8601)"
  },
  "SessionInfo": {
    "role": "\"admin\" | \"tenant\" | \"user\"",
    "domain": "string (当前邮件域名)",
    "token": "{ id: string, name: string, addresses: string[], expiresAt?: number }? (仅 role='tenant' 返回)",
    "address": "string? (仅 role='user' 返回，当前 cfmk_ 绑定的收件地址)"
  },
  "InboxMessage": {
    "id": "string (UUID)",
    "ts": "string (ISO-8601 到达时间)",
    "expiresAt": "number (epoch ms，默认到达后 30 分钟过期清理)",
    "read": "boolean (是否已被消费/标记已读)",
    "readAt": "string? (ISO-8601 已读时间)",
    "from": "string (发件人)",
    "to": "string (收件地址)",
    "subject": "string (已解码 RFC 2047 UTF-8 主题)",
    "messageId": "string",
    "text": "string (纯文本正文)",
    "links": "string[] (提取出的 https 链接，已反转义 &amp;，claude.ai 链接优先排在最前)",
    "codes": "string[] (提取出的 6 位数字验证码)"
  },
  "WatchSlot": {
    "address": "string (临时监听收件地址)",
    "createdAt": "string (ISO-8601)",
    "expiresAt": "number (epoch ms)",
    "allowedSenders": "string[]?"
  },
  "DeliveryLogEntry": {
    "id": "string (UUID)",
    "ts": "string (ISO-8601 投递时间)",
    "from": "string (发件人)",
    "to": "string (收件地址)",
    "subject": "string (已自动解码 RFC 2047 UTF-8 的邮件主题；租户管理员视角下服务端抹除为空串)",
    "messageId": "string",
    "forwardedTo": "string[] (实际成功投递目标列表，含 '[inbox]')",
    "rejected": "boolean? (是否拒信：无规则 / 发件人不在白名单 / 目标全部暂停 / 全部目标转发失败)",
    "reason": "string? (拒信或部分失败原因)"
  },
  "DestinationVerification": {
    "address": "string (目标邮箱地址，小写)",
    "status": "\"verified\" | \"pending\" | \"missing\" | \"unknown\"（verified=已验证可转发；pending=已添加未验证；missing=未添加到 Cloudflare；unknown=未配置 CF API）",
    "verifiedAt": "string? (ISO-8601 验证通过时间)",
    "message": "string? (状态提示或检查错误详情)"
  },
  "DestinationCheckResult": {
    "configured": "boolean (Worker 是否已配置 CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID)",
    "destinations": "DestinationVerification[]"
  }
}
```
