# cf-mail

基于 **Cloudflare Email Routing + Workers + Durable Objects** 的无服务器（Serverless）动态邮件转发服务，内置 Web 管理后台、REST API、双模式 CLI（`cfm` / `cfmctl`）、部署前 Token 权限自检器与 Agent Skill。

```
外部邮件 → Cloudflare Email Routing (Catch-all → Worker)
                ↓
          Worker email() 查询 Durable Object 转发规则
                ↓
          过滤出当前处于启用状态 (enabled) 的目标邮箱
                ↓
          message.forward() 并行转发 + 记录投递日志（自动解码 RFC 2047 UTF-8 主题）
```

## 核心特性

- **动态转发规则**：支持 `任意前缀@你的域名` 转发到一个或多个目标邮箱，修改立即生效，无需重新部署。
- **目标邮箱独立开关**：同一规则下添加多个目标邮箱时，支持在列表或弹窗中一键暂停/启用其中某一个或某几个目标，无需删除规则。
- **目标邮箱验证状态检查**：保存规则时自动检查各目标是否已在 Cloudflare Destination Addresses 中验证（`message.forward()` 只能发往已验证地址），未验证目标在规则弹窗中直观标注，并可一键发送/重发验证邮件；CLI 提供 `check-dest` / `verify-dest` 命令。
- **投递失败可观测**：全部目标转发失败时日志标记 `rejected` 并记录错误详情，部分失败原因也会在 Web 日志与 CLI 中展示。
- **多租户三角色权限隔离**：
  - **管理员 (`ADMIN_TOKEN`)**：管理全部邮箱规则、全局收件箱、全局日志，以及创建/启停/轮换/删除租户管理员访问令牌 (`cfmt_...`)。
  - **租户管理员 (`cfmt_...`)**：仅可管理管理员授权的前缀邮箱规则（配置转发目标、开启/关闭临时收件箱、编辑发件人白名单、复制/重置/吊销 `cfmk_...`），**严格禁止读取临时收件箱邮件、禁止新建未授权地址或删除规则**；仅可查看已授权邮箱的脱敏投递日志（服务端隐去邮件主题）。
  - **单邮箱用户 (`cfmk_...`)**：支持通过 `https://mail.example.com/?key=cfmk_...` 直达进入 Web 收件箱视图（自动擦除地址栏密钥且标签页会话隔离防顶号），仅可读取该邮箱临时收件箱、展开纯文本正文与全部链接、复制验证码与自助重置 `inbox-key`。
- **Web 管理面板**：
  - 收件地址后缀自动固定补全（只需输入前缀，如 `hello`）。
  - 实时动态搜索过滤（同时匹配收件地址与所有目标邮箱）+ 分页浏览（支持 10/20/50 条/页）。
  - Modal 弹窗新增与编辑规则（支持修改收件前缀、独立开关或增删目标地址）。
  - 实时投递日志查看（完整支持 RFC 2047 MIME Encoded-Word 中文/UTF-8 邮件主题解码）。
- **部署前 CF Token 权限检测 (`check-token`)**：零副作用探测 Cloudflare API Token 所需的全部 7 项 `Read`/`Edit` 权限，缺失任何权限时直接给出精确的 `fix_hint` 修复指引。
- **零依赖双 CLI（`cfm` / `cfmctl`）**：本地开发与远程生产共用同一套二进制，支持规则增删改查、目标独立启停、日志查看与 Token 权限自检。
- **Docker 本地模拟栈**：基于 `wrangler dev` + Docker Volume 持久化 Durable Object 状态，附带测试发信脚本。

---

## 项目结构

```text
cf-mail/
├── worker/                 # Cloudflare Worker（邮件处理 + Hono 管理 API + 内嵌 Web UI）
│   ├── src/index.ts        # email() 转发入口与 fetch() 路由
│   ├── src/forward-store.ts# Durable Object：规则 CRUD、目标启停、日志与 RFC 2047 解码
│   ├── src/admin.ts        # /admin/api/* REST 接口（Bearer Token 鉴权）
│   ├── src/cf-destinations.ts # Cloudflare Destination Addresses 验证状态检查与验证邮件发送
│   ├── src/ui.html         # 单文件响应式 Web 管理界面
│   └── wrangler.jsonc      # Worker 与 Durable Object 配置
├── cli/                    # cfm / cfmctl 命令行工具（Node >= 18，零运行时依赖）
│   ├── src/index.ts        # CLI 命令入口
│   ├── src/client.ts       # 管理 API 客户端
│   └── src/cf-token.ts     # Cloudflare API Token 权限检测与 fix_hint 生成器
├── scripts/
│   └── deploy.mjs          # 一键部署脚本（自动预检 Token 权限 → 注入域名变量 → wrangler deploy）
├── skills/cf-mail/         # Claude Code / Cursor Agent 技能定义 (SKILL.md)
├── docker/                 # 本地 Docker 环境与模拟发信脚本 mail.sh
└── docker-compose.yml
```

---

## 部署到 Cloudflare（生产环境）

### 1. 前置条件

1. 你的域名已托管在 Cloudflare（Zone 状态为 `Active`）。
2. Workers Free 免费计划即可运行（SQLite 后端的 Durable Objects 已对免费计划开放）。

### 2. 创建 Cloudflare API Token

前往 [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) 点击 **Create Custom Token**，配置以下最小权限：

| 作用域 (Scope) | 资源项 | 权限级别 | 用途 |
|---|---|---|---|
| **Account** | `Workers Scripts` | **Edit** | 部署 Worker、绑定 Durable Object、写入 `ADMIN_TOKEN` |
| **Account** | `Email Routing Addresses` | **Edit** | 添加目标转发邮箱并发送验证邮件 |
| **Zone** | `Zone` | **Read** | 查询域名 Zone ID 与所属 Account ID |
| **Zone** | `DNS` | **Edit** | 绑定自定义管理域名及自动创建 `MX` / `SPF` / `DKIM` 记录 |
| **Zone** | `Email Routing Rules` | **Edit** | 配置 Catch-All 规则指向 `cf-mail` Worker |
| **Zone** | `Zone Settings` | **Edit** | 开启域名 Email Routing 总开关并锁定邮件 DNS 记录 |

- **Account Resources**：包含该域名所属的 Cloudflare 账号（或 `All accounts`）。
- **Zone Resources**：包含目标域名（或 `All zones`）。

### 3. 检测 Token 权限 (`check-token`)

在部署前可随时运行权限预检命令，若缺少权限会输出具体原因和 `fix_hint`：

```bash
npm install && npm run build

# 检测指定域名的部署权限
CLOUDFLARE_API_TOKEN=<你的_CF_API_TOKEN> MAIL_DOMAIN=example.com npm run check-token
# 或直接通过 CLI 调用（支持 --json 输出结构化结果）：
./cli/dist/index.js check-token example.com --cf-token <你的_CF_API_TOKEN>
```

### 4. 配置 `.env` 并一键部署 Worker

复制 `.env.example` 为 `.env`（`.env` 已在 `.gitignore` 中排除，不会被提交）：

```bash
cp .env.example .env
```

编辑 `.env`：

```dotenv
# 生成随机管理密钥：openssl rand -hex 24
ADMIN_TOKEN=cfm_your_strong_random_token_here

# 你的邮件后缀域名
MAIL_DOMAIN=example.com

# 可选：自定义 Web 管理域名（会自动在 Cloudflare 添加 Custom Domain 路由与证书）
CUSTOM_DOMAIN=mail.example.com

# CLI 远程管理地址与密钥
CFMCTL_URL=https://mail.example.com
CFMCTL_TOKEN=cfm_your_strong_random_token_here
```

执行一键部署（内部会自动先运行 `check-token`，通过后部署 Worker 并绑定 `MAIL_DOMAIN` 与 `CUSTOM_DOMAIN`）：

> 部署脚本还会自动注入 `CF_ACCOUNT_ID` 变量与 `CLOUDFLARE_API_TOKEN` Secret，供 Worker 在保存规则时检查目标邮箱验证状态、发送验证邮件（复用部署 Token 的 `Email Routing Addresses Edit` 权限）。若不希望启用该功能，可不注入，此时验证状态全部显示为 `unknown`，不影响规则管理。

```bash
CLOUDFLARE_API_TOKEN=<你的_CF_API_TOKEN> npm run deploy
```

将 `ADMIN_TOKEN` 写入云端 Worker Secret：

```bash
cd worker
printf "%s" "<你的_ADMIN_TOKEN>" | CLOUDFLARE_API_TOKEN=<你的_CF_API_TOKEN> npx wrangler secret put ADMIN_TOKEN
```

### 5. 开启 Email Routing 与验证目标邮箱

你可以在 **Cloudflare Dashboard → 你的域名 → Email → Email Routing** 页面完成，或直接用 API 完成：

1. **添加并验证目标邮箱**：在 **Destination addresses** 中添加你要接收转发邮件的个人邮箱（如 `you@gmail.com`），去收件箱点击 Cloudflare 发来的确认链接（若该邮箱本身就是当前 Cloudflare 账号邮箱，则自动处于 `Verified` 状态）。
   - *注：目标邮箱验证是 Cloudflare 账号级共享池，同一邮箱只需验证一次，后续在规则间任意切换无需重复验证。*
   - **也可以直接在 cf-mail 内完成**：新增/编辑规则弹窗会实时标注每个目标的验证状态（已验证 / 待验证 / 未添加），点击「发送验证邮件」即可；CLI 则使用 `cfmctl verify-dest you@gmail.com` 发送、`cfmctl check-dest you@gmail.com` 复查。
2. **开启 Email Routing & Catch-All**：
   - 添加 Email Routing 所需的 `MX` / `SPF` / `DKIM` DNS 记录并开启 Email Routing 总开关。
   - 将 **Catch-all address** 动作设为 **Send to a Worker** → 选择 `cf-mail` 并开启。

完成后即可访问 `https://mail.example.com`（或 `https://cf-mail.<subdomain>.workers.dev`），输入 `ADMIN_TOKEN` 登录管理界面。

---

## CLI 命令行使用（`cfm` / `cfmctl`）

全局链接后可直接使用 `cfm`（本地）与 `cfmctl`（远程）：

```bash
npm run build
cd cli && npm link
```

```bash
# 加载 .env 中的 CFMCTL_URL 和 CFMCTL_TOKEN
set -a && source .env && set +a

# 1. 检查服务连通性
cfmctl health

# 2. 新增/覆盖转发规则（收件地址可只写前缀，自动补全 @example.com）
cfmctl set hi you@gmail.com backup@outlook.com

# 3. 临时暂停/恢复某条规则下的某个目标邮箱
cfmctl disable hi backup@outlook.com
cfmctl enable hi backup@outlook.com

# 4. 查看所有规则或单条规则详情
cfmctl list
cfmctl get hi

# 5. 删除规则
cfmctl delete hi

# 6. 查看最近投递日志（默认 50 条）
cfmctl logs 20

# 7. 检查目标邮箱验证状态 / 发送验证邮件（未验证的目标转发会失败）
cfmctl check-dest you@gmail.com
cfmctl verify-dest you@gmail.com   # 发送后到目标邮箱点击验证链接，再 check-dest 复查为 verified
# 8. 创建「不转发、仅收件箱」规则（限 anthropic.com 发件人）并生成该前缀独立查询 Key
cfmctl set claude01 --inbox --allow-from anthropic.com
cfmctl key claude01 --rotate
cfmctl inbox claude01 --unread --consume
```

| 命令 | 说明 |
|---|---|
| `health` | 检查 Worker `/admin/healthz` 连通性 |
| `whoami` | 查看当前凭证对应的角色身份（`admin` / `tenant` / `user`）及授权范围 |
| `token <subcmd>` | 【仅管理员】管理租户管理员令牌（`list` / `get` / `create` / `set` / `rotate` / `enable` / `disable` / `delete`） |
| `list` | 列出规则（管理员看全部，租户管理员看授权邮箱；暂停的目标标注 `(off)`） |
| `get <address>` | 查看单条规则 JSON（含 `inboxKey`） |
| `set <address> [--inbox \| --no-inbox] [--allow-from d1,d2] [dest...]` | 新增或覆盖规则（租户管理员仅可修改已授权邮箱配置） |
| `key [address] [--rotate \| --revoke]` | 查看、重置或吊销收件箱 Key（持 `cfmk_` 用户凭证可直接 `--rotate` 自助重置） |
| `inbox [address] [--unread] [--consume]` | 查看临时收件箱邮件（管理员查全局/按地址；`cfmk_` 用户查本邮箱；租户管理员不可调用） |
| `watch <address> [--ttl SEC] [--allow-from d1,d2]` | 【仅管理员】开启一次性临时收件监听槽位（默认 30 分钟） |
| `unwatch <address>` | 【仅管理员】关闭临时收件监听槽位 |
| `enable <address> <dest>` | 启用某条规则下的指定目标邮箱 |
| `disable <address> <dest>` | 暂停某条规则下的指定目标邮箱 |
| `delete <address>` | 【仅管理员】删除规则（同时作废 `inboxKey`、清理残留收件箱并从租户令牌移除） |
| `logs [limit]` | 查看最近投递日志（租户管理员仅见已授权邮箱且隐藏邮件主题） |
| `check-dest <dest...>` | 检查目标邮箱的 Cloudflare 验证状态（`verified` / `pending` / `missing` / `unknown`） |
| `verify-dest <dest>` | 向目标邮箱发送/重发 Cloudflare 验证邮件（已验证则跳过） |
| `check-token [domain]` | 检测 Cloudflare API Token 是否具备全部部署权限并输出 `fix_hint` |

### 单邮箱用户直达与程序化接口 (`/api/inbox`)

为开启收件箱的前缀生成的 `cfmk_...` 凭证严格绑定单个邮箱，既可通过浏览器打开 `https://mail.example.com/?key=cfmk_your_prefix_key` 直达用户收件箱页面，也可直接调用 HTTP 接口：

```bash
# 1. 拉取未读邮件并原子标记为已消费（防止重复登录时拿到上一封失效的 Magic-Link）
curl -s "https://mail.example.com/api/inbox?unread=1&consume=1" \
  -H "Authorization: Bearer cfmk_your_prefix_key"

# 2. 用户自助重置当前邮箱专属 Key（旧 Key 立即作废）
curl -s -X POST "https://mail.example.com/api/inbox/rotate-key" \
  -H "Authorization: Bearer cfmk_your_prefix_key"
```

---

## 本地开发与测试

### 方式一：Node 本地开发

```bash
npm install && npm run build
cd worker
cp .dev.vars.example .dev.vars    # 默认 ADMIN_TOKEN=dev-token
npm run dev                        # 启动在 http://localhost:8787
```

模拟发送一封带 UTF-8 编码主题的测试邮件：

```bash
curl --request POST 'http://localhost:8787/cdn-cgi/local/email' \
  --url-query 'from=sender@example.com' \
  --url-query 'to=test@example.com' \
  --data-raw 'From: sender@example.com
To: test@example.com
Subject: =?utf-8?q?=E6=B5=8B=E8=AF=95?=
Message-ID: <test-1@localhost>

Hello cf-mail!'
```

### 方式二：Docker Compose

```bash
cp .env.example .env
docker compose up --build -d
# 发送测试邮件
./docker/mail.sh test@example.com
```

---

## Agent Skill 安装

将 `skills/cf-mail` 复制到 Claude Code 或 Cursor 的技能目录后，即可直接用自然语言让 AI 管理转发规则：

```bash
mkdir -p ~/.claude/skills
cp -r skills/cf-mail ~/.claude/skills/
```
