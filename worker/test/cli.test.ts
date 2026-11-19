import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import app, { type Env } from "../src/admin.ts";
import { ForwardStoreEngine, type StorageLike } from "../src/store-engine.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliBin = resolve(__dirname, "../../cli/dist/index.js");

class MemoryStorage implements StorageLike {
  private data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : structuredClone(v as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      let c = 0;
      for (const k of keyOrKeys) if (this.data.delete(k)) c++;
      return c;
    }
    return this.data.delete(keyOrKeys);
  }
  async list<T>(opts?: {
    prefix?: string;
    limit?: number;
    reverse?: boolean;
  }): Promise<Map<string, T>> {
    let keys = [...this.data.keys()].sort();
    if (opts?.prefix) keys = keys.filter((k) => k.startsWith(opts.prefix!));
    if (opts?.reverse) keys.reverse();
    if (opts?.limit !== undefined) keys = keys.slice(0, opts.limit);
    const out = new Map<string, T>();
    for (const k of keys) out.set(k, structuredClone(this.data.get(k) as T));
    return out;
  }
}

async function startTestServer() {
  const engine = new ForwardStoreEngine(new MemoryStorage());
  const env = {
    ADMIN_TOKEN: "adm_cli_secret",
    MAIL_DOMAIN: "team.test",
    FORWARD_STORE: {
      idFromName: () => "global",
      get: () => engine,
    },
  } as unknown as Env;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const url = `http://127.0.0.1${req.url ?? "/"}`;
    const webReq = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body:
        req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const webRes = await app.fetch(webReq, env);
    res.statusCode = webRes.status;
    webRes.headers.forEach((v, k) => res.setHeader(k, v));
    const buf = Buffer.from(await webRes.arrayBuffer());
    res.end(buf);
  });

  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen()),
  );
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    engine,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function runCli(
  baseUrl: string,
  token: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [cliBin, ...args, "--url", baseUrl, "--token", token],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

test("CLI supports whoami, admin token CRUD, tenant rule management, and cfmk_ user inbox/self-rotate", async () => {
  const srv = await startTestServer();
  try {
    // 1. Admin whoami
    const wAdmin = await runCli(srv.baseUrl, "adm_cli_secret", [
      "whoami",
      "--json",
    ]);
    assert.equal(wAdmin.status, 0, wAdmin.stderr);
    assert.equal(JSON.parse(wAdmin.stdout).role, "admin");

    // 2. Admin creates tenant token
    const createdOut = await runCli(srv.baseUrl, "adm_cli_secret", [
      "token",
      "create",
      "团队A",
      "u1",
      "u2",
      "--json",
    ]);
    assert.equal(createdOut.status, 0, createdOut.stderr);
    const tokRecord = JSON.parse(createdOut.stdout) as {
      id: string;
      token: string;
      addresses: string[];
    };
    assert.match(tokRecord.token, /^cfmt_/);
    assert.deepEqual(tokRecord.addresses, ["u1@team.test", "u2@team.test"]);

    // 3. Tenant configures u1 with inbox mode
    const setOut = await runCli(srv.baseUrl, tokRecord.token, [
      "set",
      "u1",
      "--inbox",
      "--allow-from",
      "anthropic.com",
    ]);
    assert.equal(setOut.status, 0, setOut.stderr);
    const keyMatch = setOut.stdout.match(/cfmk_[0-9a-f]{32}/);
    assert.ok(keyMatch, `expected cfmk_ key in output: ${setOut.stdout}`);
    const userKey = keyMatch[0];

    // 4. Tenant cannot delete rule or read inbox
    const delForbid = await runCli(srv.baseUrl, tokRecord.token, [
      "delete",
      "u1",
    ]);
    assert.notEqual(delForbid.status, 0);
    const inboxForbid = await runCli(srv.baseUrl, tokRecord.token, ["inbox"]);
    assert.notEqual(inboxForbid.status, 0);

    // 5. Deliver mail to u1; user reads inbox and self-rotates key via cfmk_
    await srv.engine.saveInboxMessage({
      from: "noreply@anthropic.com",
      to: "u1@team.test",
      subject: "Code 112233",
      messageId: "<cli-1>",
      text: "Code 112233",
      links: ["https://claude.ai/magic"],
      codes: ["112233"],
    });

    const userInbox = await runCli(srv.baseUrl, userKey, [
      "inbox",
      "--unread",
      "--consume",
      "--json",
    ]);
    assert.equal(userInbox.status, 0, userInbox.stderr);
    const msgs = JSON.parse(userInbox.stdout) as Array<{ codes: string[] }>;
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0].codes, ["112233"]);

    const userRotate = await runCli(srv.baseUrl, userKey, ["key", "--rotate"]);
    assert.equal(userRotate.status, 0, userRotate.stderr);
    const newKeyMatch = userRotate.stdout.match(/cfmk_[0-9a-f]{32}/);
    assert.ok(newKeyMatch);
    assert.notEqual(newKeyMatch[0], userKey);

    // 6. Admin disables, rotates, and deletes tenant token
    assert.equal(
      (
        await runCli(srv.baseUrl, "adm_cli_secret", [
          "token",
          "disable",
          tokRecord.id,
        ])
      ).status,
      0,
    );
    assert.notEqual(
      (await runCli(srv.baseUrl, tokRecord.token, ["list"])).status,
      0,
    );
    assert.equal(
      (
        await runCli(srv.baseUrl, "adm_cli_secret", [
          "token",
          "enable",
          tokRecord.id,
        ])
      ).status,
      0,
    );
    assert.equal(
      (await runCli(srv.baseUrl, tokRecord.token, ["list"])).status,
      0,
    );
    assert.equal(
      (
        await runCli(srv.baseUrl, "adm_cli_secret", [
          "token",
          "delete",
          tokRecord.id,
        ])
      ).status,
      0,
    );

    // 7. CLI --no-overwrite guard & watch --list
    const dupFail = await runCli(srv.baseUrl, "adm_cli_secret", [
      "set",
      "u1",
      "other@dest.io",
      "--no-overwrite",
    ]);
    assert.notEqual(dupFail.status, 0);
    assert.match(dupFail.stderr, /already exists/);

    const watchCreate = await runCli(srv.baseUrl, "adm_cli_secret", [
      "watch",
      "slot99",
      "--ttl",
      "900",
      "--allow-from",
      "github.com",
    ]);
    assert.equal(watchCreate.status, 0, watchCreate.stderr);

    const watchList = await runCli(srv.baseUrl, "adm_cli_secret", [
      "watch",
      "--list",
      "--json",
    ]);
    assert.equal(watchList.status, 0, watchList.stderr);
    const parsedWatches = JSON.parse(watchList.stdout) as Array<{
      address: string;
    }>;
    assert.equal(parsedWatches.length, 1);
    assert.equal(parsedWatches[0].address, "slot99@team.test");
  } finally {
    await srv.close();
  }
});
