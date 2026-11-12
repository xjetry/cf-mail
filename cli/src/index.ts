import { createClient, resolveConfig, ApiError, type ForwardRule } from "./client.js";
import { checkCloudflareToken, formatTokenCheckReport } from "./cf-token.js";
import { getFullSchema, renderCliHelp } from "../../worker/src/schema.js";

/**
 * cfm / cfmctl 共用入口（同一个二进制，两个名字）
 * - cfm    本地模式，读 CFM_URL / CFM_TOKEN
 * - cfmctl 远程模式，读 CFMCTL_URL / CFMCTL_TOKEN，可用 --url / --token 覆盖
 * - 命令定义与帮助直接由 worker/src/schema.ts 驱动，保持与 API / Skill 同步
 */
const HELP = renderCliHelp();

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function formatTargets(r: ForwardRule): string {
  if (Array.isArray(r.targets) && r.targets.length > 0) {
    return r.targets
      .map((t) => (t.enabled ? t.address : `${t.address} (off)`))
      .join(", ");
  }
  return r.destinations.join(", ");
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  const boolFlags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" || a === "--token" || a === "--cf-token" || a === "--domain") {
      const v = argv[++i];
      if (!v) die(`missing value for ${a}`);
      flags[a.slice(2)] = v;
    } else if (a === "--json" || a === "--remote") {
      boolFlags.add(a.slice(2));
    } else if (a.startsWith("--")) {
      die(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { flags, boolFlags, positional };
}

async function main() {
  const invokedAs = process.argv[1]?.split("/").pop() ?? "cfm";
  const isRemote = invokedAs.startsWith("cfmctl");

  const { flags, boolFlags, positional: args } = parseArgs(process.argv.slice(2));
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  if (cmd === "schema" && !boolFlags.has("remote")) {
    console.log(JSON.stringify(getFullSchema(), null, 2));
    return;
  }

  if (cmd === "check-token") {
    const cfToken =
      flags["cf-token"] ??
      process.env.CLOUDFLARE_API_TOKEN ??
      process.env.CF_API_TOKEN ??
      "";
    if (!cfToken) {
      die(
        "missing Cloudflare API Token: pass --cf-token <TOKEN> or set CLOUDFLARE_API_TOKEN",
      );
    }
    const domain = flags.domain ?? args[1] ?? process.env.MAIL_DOMAIN;
    const report = await checkCloudflareToken({ cfToken, domain });
    if (boolFlags.has("json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatTokenCheckReport(report));
    }
    if (!report.ok) process.exit(1);
    return;
  }

  let client;
  try {
    const { baseUrl, token } = resolveConfig(process.env, flags.url, flags.token);
    client = createClient({ baseUrl, token });
  } catch (e) {
    if (e instanceof ApiError) die(e.message);
    throw e;
  }

  try {
    switch (cmd) {
      case "health": {
        const r = await client.health();
        console.log(JSON.stringify({ ...r, url: isRemote ? "remote" : "local" }));
        break;
      }
      case "schema": {
        const s = await client.schema();
        console.log(JSON.stringify(s, null, 2));
        break;
      }
      case "list": {
        const { rules } = await client.listRules();
        if (rules.length === 0) return console.log("(no rules)");
        for (const r of rules) {
          console.log(`${r.address} -> ${formatTargets(r)}`);
        }
        break;
      }
      case "get": {
        const address = args[1];
        if (!address) die("usage: get <address>");
        const { rule } = await client.getRule(address);
        console.log(JSON.stringify(rule, null, 2));
        break;
      }
      case "set": {
        const [address, ...dests] = args.slice(1);
        if (!address || dests.length === 0) die("usage: set <address> <dest...>");
        const { rule } = await client.setRule(address, dests);
        console.log(`saved: ${rule.address} -> ${formatTargets(rule)}`);
        break;
      }
      case "enable":
      case "disable": {
        const address = args[1];
        const target = args[2];
        if (!address || !target) die(`usage: ${cmd} <address> <dest>`);
        const { rule } = await client.setTargetEnabled(
          address,
          target,
          cmd === "enable",
        );
        console.log(`updated: ${rule.address} -> ${formatTargets(rule)}`);
        break;
      }
      case "delete": {
        const address = args[1];
        if (!address) die("usage: delete <address>");
        await client.deleteRule(address);
        console.log(`deleted: ${address}`);
        break;
      }
      case "logs": {
        const limit = Number(args[1] ?? 50);
        const { logs } = await client.listLogs(limit);
        if (logs.length === 0) return console.log("(no logs)");
        for (const l of logs) {
          const status = l.rejected
            ? `REJECTED (${l.reason ?? ""})`
            : l.forwardedTo.join(", ");
          console.log(`${l.ts}  ${l.from} -> ${l.to}  [${l.subject}]  => ${status}`);
        }
        break;
      }
      default:
        die(`unknown command: ${cmd}\n\n${HELP}`);
    }
  } catch (e) {
    if (e instanceof ApiError) {
      die(e.status === 401 ? "unauthorized: check token" : e.message);
    }
    throw e;
  }
}

main();
