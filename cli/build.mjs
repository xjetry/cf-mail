import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

await build({
  entryPoints: [resolve(__dirname, "src/index.ts")],
  outfile: resolve(__dirname, "dist/index.js"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
});
console.log("built dist/index.js (cfm / cfmctl)");

// 从刚编译好的 CLI 二进制读取统一 Schema（Single Source of Truth: worker/src/schema.ts），自动生成 SKILL.md
const schemaOut = spawnSync(
  process.execPath,
  [resolve(__dirname, "dist/index.js"), "schema"],
  { encoding: "utf-8" },
);

if (schemaOut.status === 0 && schemaOut.stdout) {
  const schema = JSON.parse(schemaOut.stdout);
  const skillMd = generateSkillMarkdown(schema);
  const skillPath = resolve(rootDir, "skills/cf-mail/SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, skillMd, "utf-8");
  console.log("synced skills/cf-mail/SKILL.md from worker/src/schema.ts");
}

function generateSkillMarkdown(schema) {
  const cmdTable = schema.cliCommands
    .map(
      (c) =>
        `| \`cfmctl ${c.command}${c.args ? " " + c.args : ""}\` | ${c.api ? `\`${c.api}\`` : "—"} | ${c.summary} |`,
    )
    .join("\n");

  const cmdDetails = schema.cliCommands
    .filter((c) => c.agentNotes)
    .map((c) => `- **\`${c.command}\`**：${c.agentNotes}`)
    .join("\n");

  const apiTable = schema.endpoints
    .map(
      (e) =>
        `| \`${e.method} ${e.path}\` | ${e.auth ? "Bearer Token" : "公开"} | ${e.summary} | \`${e.requestBody ?? "-"}\` | \`${e.responseBody}\` |`,
    )
    .join("\n");

  const modelsBlock = JSON.stringify(schema.models, null, 2);
  const rulesList = schema.agentRules
    .map((r, idx) => `${idx + 1}. ${r}`)
    .join("\n");

  return `---
name: cf-mail
description: 使用 cfm / cfmctl CLI 或 REST API 管理 cf-mail 动态邮件转发服务（Cloudflare Worker + Durable Objects）：查询/新增/修改/删除转发规则、单独启用或暂停目标邮箱、查看投递日志、检测 Cloudflare API Token 部署权限。当用户提到 cf-mail、cfmctl、cfm、邮件转发规则、把某邮箱转发到某处、暂停/恢复某个转发目标或查看邮件投递日志时使用。
---

<!-- AUTO-GENERATED FROM worker/src/schema.ts BY cli/build.mjs — DO NOT EDIT MANUALLY -->

# cf-mail CLI (\`cfm\` / \`cfmctl\`) & API 技能指南

> **自动同步声明**：本文件由 \`cli/build.mjs\` 在每次 \`npm run build\` / \`npm run deploy\` 时从唯一真实数据源 \`worker/src/schema.ts\` 自动生成。
> Agent 也可以随时在运行时执行 \`cfmctl schema\`（本地）或 \`cfmctl schema --remote\`（请求线上 \`GET /admin/schema\`）实时自省最新 API 与命令契约。

## 1. Agent 核心操作铁律

${rulesList}

${cmdDetails ? `### 重点命令注意事项\n\n${cmdDetails}\n` : ""}
---

## 2. CLI 命令契约表 (\`cfmctl\` / \`cfm\`)

| CLI 命令 | 对应 Worker API | 说明 |
|---|---|---|
${cmdTable}

### 快速调用示例

\`\`\`bash
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
\`\`\`

---

## 3. REST API 路由契约表

| 路由 | 鉴权 | 说明 | 请求体 (Request JSON) | 响应体 (Response JSON) |
|---|---|---|---|---|
${apiTable}

---

## 4. 数据模型 (Data Models)

\`\`\`json
${modelsBlock}
\`\`\`
`;
}
