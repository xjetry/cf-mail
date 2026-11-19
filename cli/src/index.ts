import {
  createClient,
  resolveConfig,
  ApiError,
  type DestinationVerification,
  type ForwardRule,
  type TenantToken,
} from "./client.js";
import { checkCloudflareToken, formatTokenCheckReport } from "./cf-token.js";
import { getFullSchema, renderCliHelp } from "../../worker/src/schema.js";

const HELP = renderCliHelp();

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function formatTargets(r: ForwardRule): string {
  const parts: string[] = [];
  if (r.inboxEnabled) {
    const senderHint =
      r.allowedSenders && r.allowedSenders.length > 0
        ? `[inbox:only=${r.allowedSenders.join(",")}]`
        : "[inbox]";
    parts.push(senderHint);
  }
  if (Array.isArray(r.targets) && r.targets.length > 0) {
    parts.push(
      ...r.targets.map((t) => (t.enabled ? t.address : `${t.address} (off)`)),
    );
  } else if (r.destinations && r.destinations.length > 0) {
    parts.push(...r.destinations);
  }
  return parts.length > 0 ? parts.join(", ") : "(unconfigured)";
}

function formatTenantTokenLine(t: TenantToken): string {
  const state = !t.enabled
    ? "DISABLED"
    : t.expiresAt && t.expiresAt <= Date.now()
      ? "EXPIRED"
      : "ACTIVE";
  const exp = t.expiresAt
    ? ` expires=${new Date(t.expiresAt).toISOString()}`
    : "";
  const addrs = t.addresses.length > 0 ? t.addresses.join(",") : "(no-mailboxes)";
  return `${t.id}  [${state}]  ${t.name}  token=${t.token}${exp}  -> ${addrs}`;
}

const DEST_STATUS_LABEL: Record<DestinationVerification["status"], string> = {
  verified: "verified (已验证，可正常转发)",
  pending: "pending (已添加但未验证，转发会失败)",
  missing: "missing (未添加到 Cloudflare，转发会失败)",
  unknown: "unknown (无法检查)",
};

function printVerificationWarnings(dests: DestinationVerification[]) {
  const bad = dests.filter(
    (d) => d.status === "pending" || d.status === "missing",
  );
  for (const d of bad) {
    console.error(`warning: ${d.address} ${DEST_STATUS_LABEL[d.status]}`);
    console.error(
      `  fix: cfmctl verify-dest ${d.address}  # 发送验证邮件，到该邮箱点击验证链接后执行 cfmctl check-dest ${d.address} 复查`,
    );
  }
  for (const d of dests.filter((d) => d.status === "unknown" && d.message)) {
    console.error(`note: ${d.address} 验证状态未知: ${d.message}`);
  }
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  const boolFlags = new Set<string>();
  const positional: string[] = [];
  const valueFlagNames = new Set([
    "--url",
    "--token",
    "--cf-token",
    "--domain",
    "--allow-from",
    "--ttl",
    "--since",
    "--limit",
    "--cursor",
    "--name",
    "--expires",
  ]);
  const boolFlagNames = new Set([
    "--json",
    "--remote",
    "--inbox",
    "--no-inbox",
    "--no-overwrite",
    "--list",
    "--rotate",
    "--revoke",
    "--unread",
    "--consume",
    "--no-expires",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlagNames.has(a)) {
      const v = argv[++i];
      if (!v) die(`missing value for ${a}`);
      flags[a.slice(2)] = v;
    } else if (boolFlagNames.has(a)) {
      boolFlags.add(a.slice(2));
    } else if (a.startsWith("--")) {
      die(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { flags, boolFlags, positional };
}

function parseSendersFlag(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const invokedAs = process.argv[1]?.split("/").pop() ?? "cfm";
  const isRemote = invokedAs.startsWith("cfmctl");

  const { flags, boolFlags, positional: args } = parseArgs(
    process.argv.slice(2),
  );
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
  let baseUrl = "";
  let activeToken = "";
  try {
    const resolved = resolveConfig(process.env, flags.url, flags.token);
    baseUrl = resolved.baseUrl.replace(/\/+$/, "");
    activeToken = resolved.token.trim();
    client = createClient(resolved);
  } catch (e) {
    if (e instanceof ApiError) die(e.message);
    throw e;
  }

  const isUserKey = activeToken.startsWith("cfmk_");

  try {
    switch (cmd) {
      case "health": {
        const r = await client.health();
        console.log(
          JSON.stringify({ ...r, url: isRemote ? "remote" : "local" }),
        );
        break;
      }
      case "whoami": {
        const s = await client.session();
        if (boolFlags.has("json")) {
          console.log(JSON.stringify(s, null, 2));
        } else if (s.role === "admin") {
          console.log(`role: admin  domain: ${s.domain}`);
        } else if (s.role === "tenant") {
          console.log(
            `role: tenant (${s.token?.name ?? ""})  domain: ${s.domain}  addresses: ${(s.token?.addresses ?? []).join(", ") || "(none)"}`,
          );
        } else {
          console.log(
            `role: user  address: ${s.address ?? ""}  domain: ${s.domain}`,
          );
        }
        break;
      }
      case "schema": {
        const s = await client.schema();
        console.log(JSON.stringify(s, null, 2));
        break;
      }
      case "token": {
        const sub = args[1];
        if (!sub) {
          die(
            "usage: token <list | get <id> | create <name> [addr...] | set <id> [--name N] [addr...] | rotate <id> | enable <id> | disable <id> | delete <id>>",
          );
        }
        switch (sub) {
          case "list": {
            const { tokens } = await client.listTokens();
            if (boolFlags.has("json")) {
              console.log(JSON.stringify(tokens, null, 2));
              break;
            }
            if (tokens.length === 0) return console.log("(no tenant tokens)");
            for (const t of tokens) {
              console.log(formatTenantTokenLine(t));
            }
            break;
          }
          case "get": {
            const id = args[2];
            if (!id) die("usage: token get <id>");
            const { token: tok } = await client.getToken(id);
            console.log(JSON.stringify(tok, null, 2));
            break;
          }
          case "create": {
            const name = flags.name ?? args[2];
            const addrs = flags.name ? args.slice(2) : args.slice(3);
            if (!name) {
              die("usage: token create <name> [addr...] [--expires ISO_OR_EPOCH]");
            }
            const { token: tok } = await client.createToken({
              name,
              addresses: addrs,
              ...(flags.expires ? { expiresAt: flags.expires } : {}),
            });
            if (boolFlags.has("json")) {
              console.log(JSON.stringify(tok, null, 2));
            } else {
              console.log(`created: ${formatTenantTokenLine(tok)}`);
              console.log(`link:    ${baseUrl}/?key=${tok.token}`);
            }
            break;
          }
          case "set": {
            const id = args[2];
            const addrs = args.slice(3);
            if (!id) {
              die(
                "usage: token set <id> [--name NAME] [--expires ISO | --no-expires] [addr...]",
              );
            }
            const patch: {
              name?: string;
              addresses?: string[];
              expiresAt?: string | null;
            } = {};
            if (flags.name !== undefined) patch.name = flags.name;
            if (addrs.length > 0) patch.addresses = addrs;
            if (boolFlags.has("no-expires")) patch.expiresAt = null;
            else if (flags.expires !== undefined) patch.expiresAt = flags.expires;
            const { token: tok } = await client.updateToken(id, patch);
            if (boolFlags.has("json")) {
              console.log(JSON.stringify(tok, null, 2));
            } else {
              console.log(`updated: ${formatTenantTokenLine(tok)}`);
            }
            break;
          }
          case "rotate": {
            const id = args[2];
            if (!id) die("usage: token rotate <id>");
            const { token: tok } = await client.rotateToken(id);
            if (boolFlags.has("json")) {
              console.log(JSON.stringify(tok, null, 2));
            } else {
              console.log(`${tok.id} (${tok.name}): ${tok.token}`);
              console.log(`link: ${baseUrl}/?key=${tok.token}`);
            }
            break;
          }
          case "enable":
          case "disable": {
            const id = args[2];
            if (!id) die(`usage: token ${sub} <id>`);
            const { token: tok } = await client.updateToken(id, {
              enabled: sub === "enable",
            });
            console.log(`updated: ${formatTenantTokenLine(tok)}`);
            break;
          }
          case "delete": {
            const id = args[2];
            if (!id) die("usage: token delete <id>");
            await client.deleteToken(id);
            console.log(`deleted token: ${id}`);
            break;
          }
          default:
            die(`unknown token subcommand: ${sub}`);
        }
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
        const inboxEnabled = boolFlags.has("inbox")
          ? true
          : boolFlags.has("no-inbox")
            ? false
            : undefined;
        const allowedSenders = parseSendersFlag(flags["allow-from"]);
        if (!address || (dests.length === 0 && inboxEnabled === undefined)) {
          die(
            "usage: set <address> [--inbox | --no-inbox] [--allow-from d1,d2] [dest...]",
          );
        }
        const { rule, verification } = await client.setRule(address, dests, {
          inboxEnabled,
          allowedSenders,
          ...(boolFlags.has("no-overwrite") ? { overwrite: false } : {}),
        });
        console.log(`saved: ${rule.address} -> ${formatTargets(rule)}`);
        if (rule.inboxKey && rule.inboxEnabled) {
          console.log(`inboxKey: ${rule.inboxKey}`);
          console.log(`link:     ${baseUrl}/?key=${rule.inboxKey}`);
          console.log(
            `poll:     curl -s "${baseUrl}/api/inbox?unread=1&consume=1" -H "Authorization: Bearer ${rule.inboxKey}"`,
          );
        }
        if (verification && verification.destinations.length > 0) {
          printVerificationWarnings(verification.destinations);
        }
        break;
      }
      case "key": {
        if (isUserKey) {
          if (boolFlags.has("revoke")) {
            die("user cfmk_ token cannot revoke itself; use --rotate to reset");
          }
          if (boolFlags.has("rotate")) {
            const { address, inboxKey } = await client.rotateUserInboxKey();
            console.log(`${address}: ${inboxKey}`);
            console.log(`link: ${baseUrl}/?key=${inboxKey}`);
          } else {
            const s = await client.session();
            console.log(`${s.address}: ${activeToken}`);
          }
          break;
        }
        const address = args[1];
        if (!address) die("usage: key <address> [--rotate | --revoke]");
        if (boolFlags.has("rotate")) {
          const { rule, inboxKey } = await client.rotateInboxKey(address);
          console.log(`${rule.address}: ${inboxKey}`);
          console.log(`link: ${baseUrl}/?key=${inboxKey}`);
        } else if (boolFlags.has("revoke")) {
          const { rule } = await client.revokeInboxKey(address);
          console.log(`revoked inboxKey for ${rule.address}`);
        } else {
          const { rule } = await client.getRule(address);
          if (!rule.inboxKey) {
            console.log(
              `${rule.address}: (no inboxKey; run 'cfmctl key ${address} --rotate' to generate)`,
            );
          } else {
            console.log(`${rule.address}: ${rule.inboxKey}`);
            console.log(`link: ${baseUrl}/?key=${rule.inboxKey}`);
          }
        }
        break;
      }
      case "inbox": {
        const to = args[1];
        const limit = flags.limit ? Number(flags.limit) : undefined;
        const inboxPage = isUserKey
          ? await client.listUserInbox({
              unread: boolFlags.has("unread"),
              consume: boolFlags.has("consume"),
              since: flags.since,
              limit,
              cursor: flags.cursor,
            })
          : await client.listInbox({
              to,
              unread: boolFlags.has("unread"),
              consume: boolFlags.has("consume"),
              since: flags.since,
              limit,
              cursor: flags.cursor,
            });
        const { messages } = inboxPage;
        if (boolFlags.has("json")) {
          console.log(JSON.stringify(messages, null, 2));
          break;
        }
        if (messages.length === 0) {
          console.log("(inbox empty)");
          break;
        }
        for (const m of messages) {
          const state = m.read ? "read" : "NEW";
          console.log(
            `[${state}] ${m.ts}  ${m.from} -> ${m.to}  Subject: ${m.subject}`,
          );
          if (m.codes.length > 0) console.log(`  codes: ${m.codes.join(", ")}`);
          for (const link of m.links) {
            console.log(`  link:  ${link}`);
          }
        }
        if (inboxPage.hasMore && inboxPage.nextCursor) {
          console.log(`next-cursor: ${inboxPage.nextCursor}`);
        }
        break;
      }
      case "watch": {
        const address = args[1];
        if (boolFlags.has("list") || !address) {
          if (!boolFlags.has("list") && !address) {
            die("usage: watch <address> [--ttl SECONDS] [--allow-from d1,d2] | watch --list");
          }
          const { watches } = await client.listWatches();
          if (boolFlags.has("json")) {
            console.log(JSON.stringify(watches, null, 2));
            break;
          }
          if (watches.length === 0) {
            console.log("(no active watches)");
            break;
          }
          for (const w of watches) {
            const allow =
              w.allowedSenders && w.allowedSenders.length > 0
                ? `  allow=${w.allowedSenders.join(",")}`
                : "";
            console.log(
              `${w.address}  until=${new Date(w.expiresAt).toISOString()}${allow}`,
            );
          }
          break;
        }
        const ttlSeconds = flags.ttl ? Number(flags.ttl) : undefined;
        const allowedSenders = parseSendersFlag(flags["allow-from"]);
        const { watch } = await client.watchInbox(address, {
          ttlSeconds,
          allowedSenders,
        });
        console.log(
          `watching: ${watch.address} until ${new Date(watch.expiresAt).toISOString()}`,
        );
        break;
      }
      case "unwatch": {
        const address = args[1];
        if (!address) die("usage: unwatch <address>");
        await client.unwatchInbox(address);
        console.log(`unwatched: ${address}`);
        break;
      }
      case "check-dest": {
        const dests = args.slice(1);
        if (dests.length === 0) die("usage: check-dest <dest...>");
        const result = await client.checkDestinations(dests);
        if (boolFlags.has("json")) {
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        if (!result.configured) {
          console.log(
            "note: Worker 未配置 CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID，无法检查（重新 npm run deploy 可自动注入）",
          );
        }
        for (const d of result.destinations) {
          console.log(`${d.address}: ${DEST_STATUS_LABEL[d.status]}`);
          if (d.message && d.status !== "verified") console.log(`  ${d.message}`);
        }
        printVerificationWarnings(result.destinations);
        break;
      }
      case "verify-dest": {
        const address = args[1];
        if (!address) die("usage: verify-dest <dest>");
        const r = await client.verifyDestination(address);
        console.log(`${r.action}: ${r.message}`);
        if (r.action !== "already_verified") {
          console.log(
            `next: 验证完成后执行 cfmctl check-dest ${r.destination.address} 确认为 verified`,
          );
        }
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
        const limit = Number(args[1] ?? flags.limit ?? 50);
        const logPage = await client.listLogs(limit, flags.cursor);
        const { logs } = logPage;
        if (boolFlags.has("json")) {
          console.log(JSON.stringify(logPage, null, 2));
          break;
        }
        if (logs.length === 0) return console.log("(no logs)");
        for (const l of logs) {
          let status = l.rejected
            ? `REJECTED (${l.reason ?? ""})`
            : l.forwardedTo.join(", ") || "NOT FORWARDED";
          if (!l.rejected && l.reason) status += `  WARN (${l.reason})`;
          const subj = l.subject || "(subject hidden)";
          console.log(`${l.ts}  ${l.from} -> ${l.to}  [${subj}]  => ${status}`);
        }
        if (logPage.hasMore && logPage.nextCursor) {
          console.log(`next-cursor: ${logPage.nextCursor}`);
        }
        break;
      }
      default:
        die(`unknown command: ${cmd}\n\n${HELP}`);
    }
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401) die("unauthorized: check token");
      if (e.status === 403) die(`forbidden: ${e.message}`);
      die(e.message);
    }
    throw e;
  }
}

main();
