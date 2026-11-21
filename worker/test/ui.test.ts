import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { compileUiHtml } from "../scripts/build-ui.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiPath = resolve(__dirname, "../src/ui.html");

test("ui.html inline script compiles cleanly, matches source modules, and every $(id) target exists in DOM markup", async () => {
  const html = readFileSync(uiPath, "utf-8");
  const freshHtml = await compileUiHtml();
  assert.equal(
    html,
    freshHtml,
    "worker/src/ui.html is out of sync with worker/src/ui/* — run `npm run build`",
  );

  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "expected inline <script> block in ui.html");
  const jsCode = scriptMatch[1];

  // 1. Verify valid JavaScript syntax via V8 compiler
  assert.doesNotThrow(() => {
    new vm.Script(jsCode, { filename: "ui.html" });
  });

  // 2. Collect all HTML id="..." attributes
  const definedIds = new Set<string>();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
    definedIds.add(m[1]);
  }

  // 3. Verify every $("...") lookup in script corresponds to a real id in HTML
  const referencedIds = new Set<string>();
  for (const m of jsCode.matchAll(/\$\("([^"]+)"\)/g)) {
    referencedIds.add(m[1]);
  }
  assert.ok(referencedIds.size > 20);

  for (const id of referencedIds) {
    assert.ok(
      definedIds.has(id),
      `ui.html script references $("${id}") which does not exist in HTML markup`,
    );
  }

  // 4. Verify Inbox table 5-column header order & non-toggling destination capsules
  const inboxTableMatch = html.match(
    /id="inbox-table-wrap"[\s\S]*?<thead>([\s\S]*?)<\/thead>/,
  );
  assert.ok(inboxTableMatch, "expected #inbox-table-wrap thead in ui.html");
  const inboxHeaders = Array.from(
    inboxTableMatch[1].matchAll(/<th[^>]*>([^<]+)<\/th>/g),
    (m) => m[1].trim(),
  );
  assert.deepEqual(inboxHeaders, ["收件人", "发件人", "主题", "状态", "操作"]);
  const logsTableMatch = html.match(
    /id="logs-table-wrap"[\s\S]*?<thead>([\s\S]*?)<\/thead>/,
  );
  assert.ok(logsTableMatch, "expected #logs-table-wrap thead in ui.html");
  const logsHeaders = Array.from(
    logsTableMatch[1].matchAll(/<th[^>]*>([^<]+)<\/th>/g),
    (m) => m[1].trim(),
  );
  assert.deepEqual(logsHeaders, ["收件人", "发件人", "主题", "状态", "时间"]);
  assert.ok(
    !jsCode.includes('method: "PATCH"'),
    "inline rule-row target toggle PATCH should not be invoked from UI list capsules",
  );

  // 5. Verify real HTML email preview iframe & no extracted-links wall in #msg-modal
  assert.ok(
    html.includes('id="msg-modal-iframe"'),
    "expected sandboxed #msg-modal-iframe for real HTML email rendering",
  );
  assert.ok(
    html.includes('sandbox="allow-popups allow-popups-to-escape-sandbox"'),
    "expected strict sandbox attribute on email preview iframe",
  );
  assert.ok(
    !html.includes('id="msg-modal-links"'),
    "extracted links wall should not replace real email rendering in #msg-modal",
  );
  assert.ok(
    jsCode.includes("includeHtml=1") || jsCode.includes('includeHtml: "1"'),
    "inbox requests should request includeHtml for real email rendering",
  );
  assert.ok(
    !jsCode.includes("row.onmouseenter"),
    "token dropdown options must not attach per-row onmouseenter that rebuilds list DOM",
  );
});
