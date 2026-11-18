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
2. 可以通过 `cfmctl schema`（本地定义）或 `cfmctl schema --remote`（实时向线上 Worker 请求 `/admin/schema`）随时自省最新的 API 与 CLI 结构。
3. 需要不转发、仅程序化轮询收验证码/Magic-Link 时，使用 `cfmctl set <prefix> --inbox --allow-from anthropic.com` 创建纯收件箱规则，并将生成的 `cfmk_...` 凭证提供给对应消费方轮询 `GET /api/inbox?unread=1&consume=1`。
4. `<address>` 参数支持只写前缀（如 `hi`），服务端会自动补全 `@<MAIL_DOMAIN>`。
5. 新增转发目标后务必检查响应中的 `verification`：目标为 pending 或 missing 时转发必然失败，应执行 `cfmctl verify-dest <dest>` 发送验证邮件。

### 重点命令注意事项

- **`set`**：set 是全量覆盖语义！若要向已有规则追加目标或修改白名单，先执行 get 读取现有配置合并后再 set。

---

## 2. CLI 命令契约表 (`cfmctl` / `cfm`)

| CLI 命令 | 对应 Worker API | 说明 |
|---|---|---|
| `cfmctl health` | `GET /admin/healthz` | 检查服务连通性 |
| `cfmctl schema [--remote]` | `GET /admin/schema` | 输出当前 CLI 与 API 的完整 JSON Schema（传 --remote 从线上 Worker 实时拉取） |
| `cfmctl list` | `GET /admin/api/rules` | 列出全部规则（标注 [inbox]、发件人白名单及暂停目标） |
| `cfmctl get <address>` | `GET /admin/api/rules/:address` | 查看单条规则详情 JSON（含 inboxKey） |
| `cfmctl set <address> [--inbox] [--allow-from d1,d2] [dest...]` | `PUT /admin/api/rules/:address` | 新增或覆盖规则（支持 --inbox 创建零转发目标的纯收件箱规则并生成独立 Key） |
| `cfmctl key <address> [--rotate | --revoke]` | `POST /admin/api/rules/:address/inbox-key` | 查看、轮换重置（--rotate）或吊销（--revoke）指定前缀的独立收件箱 Key |
| `cfmctl inbox [address] [--unread] [--consume] [--json]` | `GET /admin/api/inbox` | 查看临时收件箱邮件（含自动提取的 Magic-Link 与验证码） |
| `cfmctl watch <address> [--ttl SECONDS] [--allow-from d1,d2]` | `POST /admin/api/inbox/watch` | 开启一次性临时收件监听槽位（默认 1800 秒） |
| `cfmctl unwatch <address>` | `DELETE /admin/api/inbox/watch/:address` | 关闭临时收件监听槽位 |
| `cfmctl enable <address> <dest>` | `PATCH /admin/api/rules/:address/targets` | 启用某条规则下的指定目标邮箱 |
| `cfmctl disable <address> <dest>` | `PATCH /admin/api/rules/:address/targets` | 临时暂停某条规则下的指定目标邮箱 |
| `cfmctl delete <address>` | `DELETE /admin/api/rules/:address` | 删除整条规则（删除后发往该地址的邮件会被拒收退信） |
| `cfmctl logs [limit]` | `GET /admin/api/logs` | 查看最近投递日志（默认 50 条，已自动解码 UTF-8 主题） |
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
| `GET /api/inbox?unread=1&consume=1&since=<ms>&limit=10` | Bearer Token | 【用户侧公开单邮箱接口】持单前缀专属 cfmk_xxx（Bearer 或 ?key=）轮询该邮箱临时收件箱；consume=1 返回同时原子标记已读防重复消费旧链接 | `-` | `{ address: string, messages: InboxMessage[] }` |
| `POST /api/inbox/:id/ack` | Bearer Token | 【用户侧公开单邮箱接口】显式标记某封邮件已读 | `-` | `{ ok: true }` |
| `DELETE /api/inbox/:id` | Bearer Token | 【用户侧公开单邮箱接口】删除本邮箱下的指定临时邮件 | `-` | `{ ok: true }` |
| `GET /admin/healthz` | 公开 | 健康检查 | `-` | `{ ok: true }` |
| `GET /admin/schema` | 公开 | 返回机器可读的 API & CLI Schema（供 Agent / CLI 动态自省） | `-` | `{ models, endpoints, cliCommands, agentRules }` |
| `GET /admin/api/rules` | Bearer Token | 获取当前邮件域名与全部转发/收件箱规则列表 | `-` | `{ domain: string, rules: ForwardRule[] }` |
| `GET /admin/api/rules/:address` | Bearer Token | 获取单条规则（:address 支持完整邮箱或仅传前缀） | `-` | `{ rule: ForwardRule }` |
| `PUT /admin/api/rules/:address` | Bearer Token | 新增或覆盖规则（支持 inboxEnabled=true 无转发目标模式、allowedSenders 发件人白名单及自动生成 inboxKey） | `{ address?: string, destinations?: string[], targets?: Array<{ address: string, enabled?: boolean }>, inboxEnabled?: boolean, allowedSenders?: string[], generateKey?: boolean }` | `{ rule: ForwardRule, verification: DestinationCheckResult }` |
| `POST /admin/api/rules/:address/inbox-key` | Bearer Token | 生成或轮换重置指定前缀的独立收件箱 Key（旧 Key 立即失效） | `-` | `{ rule: ForwardRule, inboxKey: string }` |
| `DELETE /admin/api/rules/:address/inbox-key` | Bearer Token | 吊销指定前缀的独立收件箱 Key | `-` | `{ rule: ForwardRule }` |
| `POST /admin/api/inbox/watch` | Bearer Token | 开启一次性临时收件监听槽位（默认 TTL 1800s，无规则地址在监听期内免拒信入库） | `{ address: string, ttlSeconds?: number, allowedSenders?: string[] }` | `{ watch: WatchSlot }` |
| `DELETE /admin/api/inbox/watch/:address` | Bearer Token | 提前关闭临时收件监听槽位 | `-` | `{ ok: boolean }` |
| `GET /admin/api/inbox?to=<addr>&unread=1&consume=1&since=<ms>&limit=20` | Bearer Token | 管理员查询全局或指定收件地址的临时收件箱邮件 | `-` | `{ messages: InboxMessage[] }` |
| `DELETE /admin/api/inbox/:id` | Bearer Token | 管理员删除指定临时收件箱邮件 | `-` | `{ ok: true }` |
| `GET /admin/api/destinations/status?addresses=a@x.com,b@y.com` | Bearer Token | 批量检查目标邮箱在 Cloudflare Email Routing 的验证状态 | `-` | `DestinationCheckResult` |
| `POST /admin/api/destinations/verify` | Bearer Token | 为目标邮箱发送/重发 Cloudflare 验证邮件 | `{ address: string }` | `{ destination: DestinationVerification, action: 'sent' | 'resent' | 'already_verified', message: string }` |
| `PATCH /admin/api/rules/:address/targets` | Bearer Token | 单独切换某条规则下某个目标邮箱的启用/暂停状态 | `{ target: string, enabled: boolean }` | `{ rule: ForwardRule }` |
| `DELETE /admin/api/rules/:address` | Bearer Token | 删除指定收件地址的规则（同时作废其独立 inboxKey） | `-` | `{ ok: true }` |
| `GET /admin/api/logs?limit=50` | Bearer Token | 查看最近邮件投递日志（默认 50 条，最大 200 条） | `-` | `{ logs: DeliveryLogEntry[] }` |

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
    "destinations": "string[] (全部目标邮箱地址列表；inboxEnabled=true 时允许为空数组 [])",
    "targets": "DestinationTarget[] (带独立启用开关状态的目标邮箱列表)",
    "inboxEnabled": "boolean? (是否开启临时收件箱暂存，支持不转发仅收件箱模式)",
    "allowedSenders": "string[]? (可选发件人域名/邮箱白名单，如 ['anthropic.com'] 匹配其自身及子域)",
    "inboxKey": "string? (该前缀专属收件箱查询凭证 cfmk_<32hex>)",
    "updatedAt": "string (ISO-8601 更新时间)"
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
    "subject": "string (已自动解码 RFC 2047 UTF-8 的邮件主题)",
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
