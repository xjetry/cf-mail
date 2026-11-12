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
3. `set` 是全量覆盖语义：若用户要求「再加一个目标邮箱」，必须先 `cfmctl get <address>` 获取现有 `targets`，合并后再 `set`（对 `enabled: false` 的目标加 `-` 前缀保持暂停状态）。
4. 临时停用或恢复某个转发目标时，直接使用 `cfmctl disable <address> <dest>` / `cfmctl enable <address> <dest>`。
5. `<address>` 参数支持只写前缀（如 `hi`），服务端会自动补全 `@<MAIL_DOMAIN>`。
6. 遇到部署鉴权失败时，运行 `cfmctl check-token <domain> --cf-token <TOKEN>` 获取精确的 `fix_hint`。

### 重点命令注意事项

- **`set`**：set 是全量覆盖语义！如果要向已有规则追加新目标，必须先执行 get 读取现有 targets（保留暂停目标的 - 前缀），合并后再执行 set。
- **`disable`**：当用户要求临时关闭/暂停某个转发目标时，优先使用 disable 而不是重新 set 或 delete。

---

## 2. CLI 命令契约表 (`cfmctl` / `cfm`)

| CLI 命令 | 对应 Worker API | 说明 |
|---|---|---|
| `cfmctl health` | `GET /admin/healthz` | 检查服务连通性 |
| `cfmctl schema [--remote]` | `GET /admin/schema` | 输出当前 CLI 与 API 的完整 JSON Schema（传 --remote 从线上 Worker 实时拉取） |
| `cfmctl list` | `GET /admin/api/rules` | 列出全部转发规则（暂停的目标标注 (off)） |
| `cfmctl get <address>` | `GET /admin/api/rules/:address` | 查看单条规则详情 JSON（address 可只写前缀，如 test） |
| `cfmctl set <address> <dest...>` | `PUT /admin/api/rules/:address` | 新增或覆盖规则（多目标用空格分隔；目标前加 - 表示初始为暂停状态） |
| `cfmctl enable <address> <dest>` | `PATCH /admin/api/rules/:address/targets` | 启用某条规则下的指定目标邮箱 |
| `cfmctl disable <address> <dest>` | `PATCH /admin/api/rules/:address/targets` | 临时暂停某条规则下的指定目标邮箱（保留在规则中，仅停止向其转发） |
| `cfmctl delete <address>` | `DELETE /admin/api/rules/:address` | 删除整条转发规则（删除后发往该地址的邮件会被拒收退信） |
| `cfmctl logs [limit]` | `GET /admin/api/logs` | 查看最近投递日志（默认 50 条，已自动解码 UTF-8 主题） |
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
| `GET /admin/healthz` | 公开 | 健康检查 | `-` | `{ ok: true }` |
| `GET /admin/schema` | 公开 | 返回机器可读的 API & CLI Schema（供 Agent / CLI 动态自省） | `-` | `{ models, endpoints, cliCommands, agentRules }` |
| `GET /admin/api/rules` | Bearer Token | 获取当前邮件域名与全部转发规则列表 | `-` | `{ domain: string, rules: ForwardRule[] }` |
| `GET /admin/api/rules/:address` | Bearer Token | 获取单条转发规则（:address 支持完整邮箱或仅传前缀） | `-` | `{ rule: ForwardRule }` |
| `PUT /admin/api/rules/:address` | Bearer Token | 新增或覆盖转发规则（若传入 body.address 与 :address 不同则自动迁移改名） | `{ address?: string, destinations?: string[], targets?: Array<{ address: string, enabled?: boolean }> }` | `{ rule: ForwardRule }` |
| `PATCH /admin/api/rules/:address/targets` | Bearer Token | 单独切换某条规则下某个目标邮箱的启用/暂停状态 | `{ target: string, enabled: boolean }` | `{ rule: ForwardRule }` |
| `DELETE /admin/api/rules/:address` | Bearer Token | 删除指定收件地址的转发规则 | `-` | `{ ok: true }` |
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
    "destinations": "string[] (全部目标邮箱地址列表)",
    "targets": "DestinationTarget[] (带独立启用开关状态的目标邮箱列表)",
    "updatedAt": "string (ISO-8601 更新时间)"
  },
  "DeliveryLogEntry": {
    "id": "string (UUID)",
    "ts": "string (ISO-8601 投递时间)",
    "from": "string (发件人)",
    "to": "string (收件地址)",
    "subject": "string (已自动解码 RFC 2047 UTF-8 的邮件主题)",
    "messageId": "string",
    "forwardedTo": "string[] (实际成功转发的目标列表)",
    "rejected": "boolean? (是否拒信)",
    "reason": "string? (拒信或部分失败原因：no rule / all destinations disabled / 错误详情)"
  }
}
```
