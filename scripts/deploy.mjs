#!/usr/bin/env node
/**
 * cf-mail 部署脚本：
 * 1. 自动读取环境变量与根目录 .env（如 MAIL_DOMAIN / CUSTOM_DOMAIN / CLOUDFLARE_API_TOKEN）
 * 2. 部署前调用 check-token 检测 Cloudflare API Token 全部 7 项权限，缺失时输出 fix_hint 并中止
 * 3. 自动解析域名对应的 Account ID 与 Zone ID，执行 wrangler deploy（支持动态注入 MAIL_DOMAIN 与 CUSTOM_DOMAIN）
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

function loadDotEnv() {
  const envPath = resolve(rootDir, ".env");
  if (!existsSync(envPath)) return {};
  const map = {};
  const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    map[k] = v;
  }
  return map;
}

function parseArgs(argv) {
  const flags = {};
  const bools = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (
      a === "--domain" ||
      a === "--custom-domain" ||
      a === "--cf-token" ||
      a === "--verify-email"
    ) {
      flags[a.slice(2)] = argv[++i];
    } else if (a === "--check-only" || a === "--json") {
      bools.add(a.slice(2));
    }
  }
  return { flags, bools };
}

function readDefaultDomain() {
  try {
    const raw = readFileSync(resolve(rootDir, "worker/wrangler.jsonc"), "utf-8");
    const m = raw.match(/"MAIL_DOMAIN"\s*:\s*"([^"]+)"/);
    return m && m[1] !== "example.com" ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const dotEnv = loadDotEnv();
  const { flags, bools } = parseArgs(process.argv.slice(2));
  const cfToken =
    flags["cf-token"] ??
    process.env.CLOUDFLARE_API_TOKEN ??
    process.env.CF_API_TOKEN ??
    dotEnv.CLOUDFLARE_API_TOKEN ??
    "";
  const domain =
    flags.domain ??
    process.env.MAIL_DOMAIN ??
    dotEnv.MAIL_DOMAIN ??
    readDefaultDomain();
  const customDomain =
    flags["custom-domain"] ??
    process.env.CUSTOM_DOMAIN ??
    dotEnv.CUSTOM_DOMAIN;

  let accountId = "";
  let resolvedDomain = domain ?? "example.com";

  if (cfToken) {
    const cliArgs = [
      resolve(rootDir, "cli/dist/index.js"),
      "check-token",
      ...(domain ? [domain] : []),
      "--cf-token",
      cfToken,
    ];
    if (bools.has("json")) cliArgs.push("--json");

    const checkRes = spawnSync(process.execPath, cliArgs, {
      cwd: rootDir,
      stdio: "inherit",
    });
    if (checkRes.status !== 0) {
      process.exit(checkRes.status ?? 1);
    }

    if (bools.has("check-only")) {
      return;
    }

    const reportOut = spawnSync(process.execPath, [...cliArgs, "--json"], {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const report = JSON.parse(reportOut.stdout);
    accountId = report.accountId;
    resolvedDomain = domain ?? report.domain ?? "example.com";
  } else {
    if (bools.has("check-only")) {
      console.error(
        "error: check-token 需要提供 CLOUDFLARE_API_TOKEN 环境变量或 --cf-token 参数。",
      );
      process.exit(1);
    }
    const whoamiRes = spawnSync("npx", ["wrangler", "whoami"], {
      cwd: resolve(rootDir, "worker"),
      encoding: "utf-8",
    });
    const combined = `${whoamiRes.stdout ?? ""}\n${whoamiRes.stderr ?? ""}`;
    const accMatch = combined.match(/\b([0-9a-f]{32})\b/);
    if (whoamiRes.status !== 0 || !accMatch) {
      console.error(
        "error: 未提供 CLOUDFLARE_API_TOKEN，且本地未检测到有效的 wrangler 登录会话。\n" +
          "fix_hint: 执行 `cd worker && npx wrangler login`，或前往 https://dash.cloudflare.com/profile/api-tokens 创建 Token 后执行:\n" +
          `  CLOUDFLARE_API_TOKEN=<你的Token> MAIL_DOMAIN=<你的域名> npm run deploy`,
      );
      process.exit(1);
    }
    accountId = accMatch[1];
    console.log(
      `=== 检测到本地 Wrangler OAuth 登录会话 (Account: ${accountId})，跳过 API Token 预检直接部署 ===`,
    );
  }

  const wranglerArgs = [
    "wrangler",
    "deploy",
    "--var",
    `MAIL_DOMAIN:${resolvedDomain}`,
    // 供 Worker 调用 Cloudflare API 检查目标邮箱验证状态 / 发送验证邮件
    "--var",
    `CF_ACCOUNT_ID:${accountId}`,
  ];
  if (customDomain) {
    wranglerArgs.push("--domain", customDomain);
  }

  const deployEnv = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    ...(cfToken ? { CLOUDFLARE_API_TOKEN: cfToken } : {}),
  };

  console.log(
    `\n=== 开始部署 Worker cf-mail (Account: ${accountId}, MAIL_DOMAIN: ${resolvedDomain}${customDomain ? `, Custom Domain: ${customDomain}` : ""}) ===`,
  );
  const deployRes = spawnSync("npx", wranglerArgs, {
    cwd: resolve(rootDir, "worker"),
    stdio: "inherit",
    env: deployEnv,
  });
  if (deployRes.status !== 0) {
    process.exit(deployRes.status ?? 1);
  }

  // 仅当显式传入 CLOUDFLARE_API_TOKEN 时更新 Secret（OAuth 部署自动保留云端已存在的 Secret）
  if (cfToken) {
    console.log(
      "\n=== 注入 CLOUDFLARE_API_TOKEN Secret（目标邮箱验证状态检查 / 发送验证邮件） ===",
    );
    const secretRes = spawnSync(
      "npx",
      ["wrangler", "secret", "put", "CLOUDFLARE_API_TOKEN"],
      {
        cwd: resolve(rootDir, "worker"),
        input: cfToken,
        stdio: ["pipe", "inherit", "inherit"],
        env: deployEnv,
      },
    );
    if (secretRes.status !== 0) {
      console.warn(
        "warning: CLOUDFLARE_API_TOKEN Secret 注入失败，目标邮箱验证检查功能将不可用（规则管理不受影响）。\n" +
          '可手动执行: printf "%s" "<你的_CF_API_TOKEN>" | npx wrangler secret put CLOUDFLARE_API_TOKEN',
      );
    }
  }
}

main();
