import test from "node:test";
import assert from "node:assert/strict";
import {
  buildValidatedRuleSave,
  classifyDeliveryLog,
  createInitialAppState,
  deriveRuleKeyPanel,
  detectRuleCollision,
  reduceAppState,
  selectLogsTableModel,
  selectRulesTableModel,
  selectTokenDropdownModel,
} from "../src/ui/state.ts";
import type { ForwardRule, InboxMessage } from "../src/ui/types.ts";

const SAMPLE_RULE: ForwardRule = {
  address: "support@acme.dev",
  destinations: ["ops@company.io"],
  targets: [{ address: "ops@company.io", enabled: true }],
  inboxEnabled: true,
  inboxKey: "cfmk_1234567890abcdef1234567890abcdef",
  allowedSenders: ["anthropic.com"],
  updatedAt: "2026-11-19T00:00:00.000Z",
};

test("SM-1: boot-vs-manual-login race discards stale boot response and blocks double submit", () => {
  let state = createInitialAppState({
    initialCredential: "cfmk_stale",
    credentialSource: "url",
  });
  assert.equal(state.auth.tag, "booting");
  const bootEpoch = state.auth.epoch;

  // User manually submits ADMIN_TOKEN while boot check is still in flight
  state = reduceAppState(state, {
    type: "LOGIN_SUBMIT",
    rawCredential: "adm_secret",
  });
  assert.equal(state.auth.tag, "unauthenticated");
  assert.equal(state.auth.login.status, "submitting");
  const manualEpoch = state.auth.epoch;
  assert.notEqual(manualEpoch, bootEpoch);

  // Double-clicking login while submitting is a no-op
  const afterDoubleClick = reduceAppState(state, {
    type: "LOGIN_SUBMIT",
    rawCredential: "other_token",
  });
  assert.equal(afterDoubleClick, state);

  // Stale boot response arrives late -> strictly ignored
  const afterStaleBoot = reduceAppState(state, {
    type: "BOOT_VERIFY_OK",
    epoch: bootEpoch,
    principal: {
      role: "user",
      domain: "acme.dev",
      credential: "cfmk_stale",
      address: "u@acme.dev",
      keyRotation: "idle",
      apiDrawerOpen: false,
      secretRevealed: false,
    },
  });
  assert.equal(afterStaleBoot, state);

  // Manual login succeeds -> enters admin workspace
  state = reduceAppState(state, {
    type: "LOGIN_OK",
    epoch: manualEpoch,
    principal: {
      role: "admin",
      domain: "acme.dev",
      credential: "adm_secret",
    },
  });
  assert.equal(state.auth.tag, "authenticated");
  assert.equal(state.auth.principal.role, "admin");
  assert.equal(state.mailDomain, "acme.dev");
});

test("SM-1: user self-rotate-key ignores 401 from old key and purges all slices/modals on genuine 401", () => {
  let state = createInitialAppState();
  state = reduceAppState(state, {
    type: "LOGIN_SUBMIT",
    rawCredential: "cfmk_old",
  });
  const ep = state.auth.epoch;
  state = reduceAppState(state, {
    type: "LOGIN_OK",
    epoch: ep,
    principal: {
      role: "user",
      domain: "acme.dev",
      credential: "cfmk_old",
      address: "vip@acme.dev",
      keyRotation: "idle",
      apiDrawerOpen: false,
      secretRevealed: false,
    },
  });

  // Load an inbox message & open detail modal
  const msg: InboxMessage = {
    id: "m1",
    ts: "2026-11-19T00:00:00Z",
    expiresAt: Date.now() + 60_000,
    read: false,
    from: "a@b.com",
    to: "vip@acme.dev",
    subject: "Code",
    messageId: "<1>",
    text: "123456",
    links: [],
    codes: ["123456"],
  };
  state = reduceAppState(state, {
    type: "INBOX_LOAD_START",
    requestId: 1,
    appliedFilter: "",
  });
  state = reduceAppState(state, {
    type: "INBOX_LOAD_OK",
    requestId: 1,
    messages: [msg],
  });
  state = reduceAppState(state, { type: "MESSAGE_MODAL_OPEN", message: msg });
  assert.equal(state.primaryModal.tag, "message");

  // Start rotating key -> concurrent request with cfmk_old gets 401 -> MUST NOT log out!
  state = reduceAppState(state, { type: "USER_ROTATE_KEY_START" });
  const afterRace401 = reduceAppState(state, {
    type: "HTTP_401_RECEIVED",
    epoch: ep,
    usedCredential: "cfmk_old",
  });
  assert.equal(afterRace401.auth.tag, "authenticated");

  // Rotation finishes with cfmk_new -> late 401 from cfmk_old STILL ignored
  state = reduceAppState(state, {
    type: "USER_ROTATE_KEY_OK",
    epoch: ep,
    nextKey: "cfmk_new",
  });
  const afterStaleCred401 = reduceAppState(state, {
    type: "HTTP_401_RECEIVED",
    epoch: ep,
    usedCredential: "cfmk_old",
  });
  assert.equal(afterStaleCred401.auth.tag, "authenticated");

  // Genuine 401 on active cfmk_new -> logs out, closes modal, and resets inbox slice (no cross-session leak)
  state = reduceAppState(state, {
    type: "HTTP_401_RECEIVED",
    epoch: ep,
    usedCredential: "cfmk_new",
  });
  assert.equal(state.auth.tag, "unauthenticated");
  assert.equal(state.primaryModal.tag, "none");
  assert.equal(state.inbox.resource.status, "idle");
});

test("SM-2: AsyncResource distinguishes initial error from empty list and ignores out-of-order responses", () => {
  let state = createInitialAppState();
  state = reduceAppState(state, { type: "RULES_LOAD_START", requestId: 1 });
  assert.equal(state.rules.resource.status, "loading");

  // Network error -> status is "error", NOT empty ready array
  state = reduceAppState(state, {
    type: "RULES_LOAD_ERR",
    requestId: 1,
    error: "HTTP 502",
  });
  assert.equal(state.rules.resource.status, "error");

  // Start request #2, then request #3; #3 resolves first, #2 resolves late -> #2 is ignored
  state = reduceAppState(state, { type: "INBOX_LOAD_START", requestId: 2, appliedFilter: "alice" });
  state = reduceAppState(state, { type: "INBOX_LOAD_START", requestId: 3, appliedFilter: "bob" });

  state = reduceAppState(state, {
    type: "INBOX_LOAD_OK",
    requestId: 3,
    messages: [],
  });
  assert.equal(state.inbox.resource.status, "ready");

  const staleMsg: InboxMessage = {
    id: "stale",
    ts: "2026-11-19T00:00:00Z",
    expiresAt: Date.now() + 60_000,
    read: false,
    from: "x@y.com",
    to: "alice@acme.dev",
    subject: "Stale",
    messageId: "<s1>",
    text: "",
    links: [],
    codes: [],
  };
  // Out-of-order response for reqId=2 while ready at reqId=3 (no active reload=2) must NOT overwrite
  state = reduceAppState(state, {
    type: "INBOX_LOAD_START",
    requestId: 4,
    appliedFilter: "bob",
  });
  state = reduceAppState(state, {
    type: "INBOX_LOAD_OK",
    requestId: 2,
    messages: [staleMsg],
  });
  assert.equal(
    state.inbox.resource.status === "ready"
      ? state.inbox.resource.data.length
      : -1,
    0,
  );
});

test("SM-4: Rule modal prevents revoke-then-save zombie key, preserves sending lock across re-renders, and detects collisions", () => {
  let state = createInitialAppState();
  state = reduceAppState(state, {
    type: "LOGIN_SUBMIT",
    rawCredential: "adm",
  });
  state = reduceAppState(state, {
    type: "LOGIN_OK",
    epoch: state.auth.epoch,
    principal: { role: "admin", domain: "acme.dev", credential: "adm" },
  });
  state = reduceAppState(state, {
    type: "RULES_LOAD_START",
    requestId: 1,
  });
  state = reduceAppState(state, {
    type: "RULES_LOAD_OK",
    requestId: 1,
    domain: "acme.dev",
    rules: [
      SAMPLE_RULE,
      {
        address: "billing@acme.dev",
        destinations: ["fin@company.io"],
        targets: [{ address: "fin@company.io", enabled: true }],
        updatedAt: "2026-11-19T00:00:00.000Z",
      },
    ],
  });

  // Open Edit Modal on support@acme.dev
  state = reduceAppState(state, {
    type: "RULE_MODAL_OPEN_EDIT",
    rule: SAMPLE_RULE,
  });
  assert.equal(state.primaryModal.tag, "rule");
  const instId = state.primaryModal.modal.instanceId;

  // Start sending destination verification on ops@company.io
  state = reduceAppState(state, {
    type: "RULE_MODAL_SEND_VERIFY_START",
    instanceId: instId,
    address: "ops@company.io",
  });
  // Toggle target & run background status check while sendVerification is in-flight -> "sending" lock MUST survive!
  state = reduceAppState(state, {
    type: "RULE_MODAL_TOGGLE_TARGET",
    index: 0,
    enabled: false,
  });
  state = reduceAppState(state, {
    type: "RULE_MODAL_VERIFY_CHECK_START",
    instanceId: instId,
    verifyReqId: 1,
    addresses: ["ops@company.io"],
  });
  assert.equal(state.primaryModal.tag, "rule");
  assert.equal(
    state.primaryModal.modal.verificationByAddr["ops@company.io"]?.tag,
    "sending",
  );

  // Send verification finishes -> cleanly exits "sending"
  state = reduceAppState(state, {
    type: "RULE_MODAL_SEND_VERIFY_DONE",
    instanceId: instId,
    address: "ops@company.io",
    nextStatus: "pending",
    message: "Sent",
  });
  assert.equal(
    state.primaryModal.modal.verificationByAddr["ops@company.io"]?.tag,
    "checked",
  );

  // Unchecking inboxEnabled transitions key panel to dormant_when_disabled
  state = reduceAppState(state, {
    type: "RULE_MODAL_DRAFT_PATCH",
    patch: { inboxEnabled: false },
  });
  assert.equal(
    deriveRuleKeyPanel(state.primaryModal.modal).kind,
    "dormant_when_disabled",
  );

  // Re-enable inbox and revoke key -> saving MUST emit generateKey: false to prevent zombie key!
  state = reduceAppState(state, {
    type: "RULE_MODAL_DRAFT_PATCH",
    patch: { inboxEnabled: true },
  });
  state = reduceAppState(state, {
    type: "RULE_MODAL_KEY_REVOKE_OK",
    instanceId: instId,
  });
  assert.equal(
    deriveRuleKeyPanel(state.primaryModal.modal).kind,
    "revoked_no_key",
  );
  const validated = buildValidatedRuleSave(
    state.primaryModal.modal,
    "admin",
    "acme.dev",
  );
  assert.equal(validated.ok, true);
  if (validated.ok) {
    assert.equal(validated.payload.generateKey, false);
  }

  // Renaming support@acme.dev to billing@acme.dev flags collision, self-save does not
  assert.equal(detectRuleCollision(state, "support@acme.dev"), undefined);
  assert.equal(
    detectRuleCollision(state, "billing@acme.dev")?.address,
    "billing@acme.dev",
  );

  // Submitting locks modal close
  state = reduceAppState(state, {
    type: "RULE_MODAL_SUBMIT_START",
    instanceId: instId,
  });
  const closedWhileSubmitting = reduceAppState(state, {
    type: "RULE_MODAL_CLOSE",
  });
  assert.equal(closedWhileSubmitting.primaryModal.tag, "rule");
});

test("SM-8 & SM-9: Delivery log classifier handles [inbox] accurately and Toast timer ignores stale IDs", () => {
  const inboxOnly = classifyDeliveryLog({
    id: "1",
    ts: "2026-11-19T00:00:00Z",
    from: "noreply@anthropic.com",
    to: "claude@acme.dev",
    subject: "Sign in",
    messageId: "<1>",
    forwardedTo: ["[inbox]"],
  });
  assert.equal(inboxOnly.category, "inbox");
  assert.equal(inboxOnly.statusBadge.label, "已存入收件箱");
  assert.equal(inboxOnly.statusBadge.variant, "accent");

  const rejected = classifyDeliveryLog({
    id: "2",
    ts: "2026-11-19T00:00:00Z",
    from: "bad@spam.xyz",
    to: "claude@acme.dev",
    subject: "Spam",
    messageId: "<2>",
    forwardedTo: [],
    rejected: true,
    reason: "sender not allowed",
  });
  assert.equal(rejected.category, "rejected");
  assert.equal(rejected.reasonDisplay, "非白名单发件人");

  // Toast sequencing: earlier toast timeout must NOT hide newer error toast
  let state = createInitialAppState();
  state = reduceAppState(state, {
    type: "TOAST_SHOW",
    message: "已复制",
    tone: "ok",
  });
  assert.equal(state.toast.tag, "visible");
  const firstId = state.toast.id;

  state = reduceAppState(state, {
    type: "TOAST_SHOW",
    message: "目标未通过 Cloudflare 验证",
    tone: "error",
  });
  assert.equal(state.toast.tag, "visible");
  const secondId = state.toast.id;
  assert.notEqual(firstId, secondId);

  // First timer fires late -> ignored!
  state = reduceAppState(state, { type: "TOAST_HIDE", id: firstId });
  assert.equal(state.toast.tag, "visible");
  assert.equal(state.toast.message, "目标未通过 Cloudflare 验证");

  // Second timer fires -> hides cleanly
  state = reduceAppState(state, { type: "TOAST_HIDE", id: secondId });
  assert.equal(state.toast.tag, "hidden");

  // Confirm dialog prevents double open and tracks executing state
  state = reduceAppState(state, {
    type: "CONFIRM_OPEN",
    title: "删除规则",
    message: "确定删除？",
    confirmText: "删除",
    cancelText: "取消",
    danger: true,
  });
  assert.equal(state.confirmDialog.tag, "open");
  const confirmId = state.confirmDialog.instanceId;

  const afterDuplicateConfirm = reduceAppState(state, {
    type: "CONFIRM_OPEN",
    title: "Other",
    message: "Other",
    confirmText: "OK",
    cancelText: "No",
    danger: false,
  });
  assert.equal(afterDuplicateConfirm, state);

  state = reduceAppState(state, {
    type: "CONFIRM_EXEC_START",
    instanceId: confirmId,
  });
  assert.equal(
    state.confirmDialog.tag === "open" ? state.confirmDialog.status : "",
    "executing",
  );

  // Rules pagination clamping check
  const tableModel = selectRulesTableModel(state);
  assert.equal(tableModel.page, 1);
});

test("Phase 5: Watch modal lifecycle, overwrite=false payload flag, and cursor load-more deduplication", () => {
  let state = createInitialAppState();
  state = reduceAppState(state, {
    type: "LOGIN_SUBMIT",
    rawCredential: "adm",
  });
  state = reduceAppState(state, {
    type: "LOGIN_OK",
    epoch: state.auth.epoch,
    principal: { role: "admin", domain: "acme.dev", credential: "adm" },
  });

  // 1. Add Rule payload defaults overwrite=false unless overwriteConfirmed=true
  state = reduceAppState(state, { type: "RULE_MODAL_OPEN_ADD" });
  state = reduceAppState(state, {
    type: "RULE_MODAL_DRAFT_PATCH",
    patch: { addressPrefix: "new-box", inboxEnabled: true },
  });
  assert.equal(state.primaryModal.tag, "rule");
  const unconfirmed = buildValidatedRuleSave(
    state.primaryModal.modal,
    "admin",
    "acme.dev",
    false,
  );
  assert.equal(unconfirmed.ok, true);
  if (unconfirmed.ok) assert.equal(unconfirmed.payload.overwrite, false);

  const confirmed = buildValidatedRuleSave(
    state.primaryModal.modal,
    "admin",
    "acme.dev",
    true,
  );
  assert.equal(confirmed.ok, true);
  if (confirmed.ok) assert.equal(confirmed.payload.overwrite, true);

  // 2. Watch Modal open -> submit lock -> submit ok inserts sorted active watch
  state = reduceAppState(state, { type: "WATCH_MODAL_OPEN" });
  assert.equal(state.primaryModal.tag, "watch");
  const wInst = state.primaryModal.modal.instanceId;
  state = reduceAppState(state, {
    type: "WATCH_MODAL_SUBMIT_START",
    instanceId: wInst,
  });
  assert.equal(
    reduceAppState(state, { type: "WATCH_MODAL_CLOSE" }).primaryModal.tag,
    "watch",
  );
  state = reduceAppState(state, {
    type: "WATCH_MODAL_SUBMIT_OK",
    instanceId: wInst,
    watch: {
      address: "temp01@acme.dev",
      createdAt: "2026-11-19T00:00:00Z",
      expiresAt: Date.now() + 600_000,
    },
  });
  assert.equal(state.primaryModal.tag, "none");
  assert.equal(
    state.watches.resource.status === "ready"
      ? state.watches.resource.data.length
      : 0,
    1,
  );

  // 3. Cursor load-more appends & deduplicates both Inbox and Logs
  const makeMsg = (id: string): InboxMessage => ({
    id,
    ts: "2026-11-19T00:00:00Z",
    expiresAt: Date.now() + 60_000,
    read: false,
    from: "a@b.com",
    to: "temp01@acme.dev",
    subject: id,
    messageId: `<${id}>`,
    text: "",
    links: [],
    codes: [],
  });
  state = reduceAppState(state, {
    type: "INBOX_LOAD_START",
    requestId: 10,
    appliedFilter: "",
  });
  state = reduceAppState(state, {
    type: "INBOX_LOAD_OK",
    requestId: 10,
    messages: [makeMsg("m3"), makeMsg("m2")],
    nextCursor: "2026-11-19T00:00:00Z|m2",
    hasMore: true,
  });
  state = reduceAppState(state, {
    type: "INBOX_LOAD_MORE_START",
    requestId: 11,
  });
  // Duplicate load-more while pending is ignored
  assert.equal(
    reduceAppState(state, { type: "INBOX_LOAD_MORE_START", requestId: 12 }),
    state,
  );
  state = reduceAppState(state, {
    type: "INBOX_LOAD_MORE_OK",
    requestId: 11,
    messages: [makeMsg("m2"), makeMsg("m1")],
    nextCursor: null,
    hasMore: false,
  });
  assert.deepEqual(
    state.inbox.resource.status === "ready"
      ? state.inbox.resource.data.map((m) => m.id)
      : [],
    ["m3", "m2", "m1"],
  );
  assert.equal(state.inbox.hasMore, false);

  // 4. Delivery Logs page-based pagination (10/20/50, prev/next, filter resets page=1)
  const sampleLogs = Array.from({ length: 25 }, (_, i) => ({
    id: `l-${i + 1}`,
    ts: `2026-11-19T00:${String(i).padStart(2, "0")}:00.000Z`,
    from: `s${i + 1}@example.com`,
    to: "support@acme.dev",
    subject: `Subject ${i + 1}`,
    messageId: `<l-${i + 1}>`,
    forwardedTo: i % 5 === 0 ? [] : ["ops@company.io"],
    rejected: i % 5 === 0 ? true : undefined,
    reason: i % 5 === 0 ? "sender not allowed" : undefined,
  }));

  state = reduceAppState(state, { type: "LOGS_LOAD_START", requestId: 20 });
  state = reduceAppState(state, {
    type: "LOGS_LOAD_OK",
    requestId: 20,
    logs: sampleLogs,
  });

  let logsModel = selectLogsTableModel(state);
  assert.equal(logsModel.totalAll, 25);
  assert.equal(logsModel.totalFiltered, 25);
  assert.equal(logsModel.page, 1);
  assert.equal(logsModel.totalPages, 3);
  assert.equal(logsModel.items.length, 10);

  state = reduceAppState(state, { type: "LOGS_PAGE_SET", page: 2 });
  logsModel = selectLogsTableModel(state);
  assert.equal(logsModel.page, 2);
  assert.equal(logsModel.startIndex, 10);
  assert.equal(logsModel.endIndex, 20);

  // Filtering by rejected resets page back to 1 and updates totalPages to 1 (5 rejected items)
  state = reduceAppState(state, {
    type: "LOGS_STATUS_FILTER_SET",
    filter: "rejected",
  });
  logsModel = selectLogsTableModel(state);
  assert.equal(logsModel.page, 1);
  assert.equal(logsModel.totalFiltered, 5);
  assert.equal(logsModel.totalPages, 1);

  // Changing pageSize to 20 resets filter/page cleanly
  state = reduceAppState(state, {
    type: "LOGS_STATUS_FILTER_SET",
    filter: "all",
  });
  state = reduceAppState(state, { type: "LOGS_PAGE_SIZE_SET", pageSize: 20 });
  logsModel = selectLogsTableModel(state);
  assert.equal(logsModel.totalPages, 2);
  assert.equal(logsModel.items.length, 20);
});

test("SM-6: Token modal filterable multi-select dropdown filters rules, creates unseen prefixes, and closes cleanly", () => {
  let state = createInitialAppState();
  state = reduceAppState(state, {
    type: "LOGIN_SUBMIT",
    rawCredential: "adm",
  });
  state = reduceAppState(state, {
    type: "LOGIN_OK",
    epoch: state.auth.epoch,
    principal: { role: "admin", domain: "acme.dev", credential: "adm" },
  });
  state = reduceAppState(state, { type: "RULES_LOAD_START", requestId: 1 });
  state = reduceAppState(state, {
    type: "RULES_LOAD_OK",
    requestId: 1,
    domain: "acme.dev",
    rules: [
      SAMPLE_RULE,
      {
        address: "vip-01@acme.dev",
        destinations: ["vip@company.io"],
        targets: [{ address: "vip@company.io", enabled: true }],
        updatedAt: "2026-11-19T00:00:00.000Z",
      },
      {
        address: "vip-02@acme.dev",
        destinations: [],
        targets: [],
        inboxEnabled: true,
        updatedAt: "2026-11-19T00:00:00.000Z",
      },
    ],
  });

  state = reduceAppState(state, { type: "TOKEN_MODAL_OPEN_ADD" });
  assert.equal(state.primaryModal.tag, "token");
  assert.equal(state.primaryModal.modal.dropdown.open, false);

  // Typing a filter opens dropdown and narrows selectable options + offers creatable option for "vip"
  state = reduceAppState(state, {
    type: "TOKEN_MODAL_FILTER_SET",
    query: "vip",
  });
  assert.equal(state.primaryModal.tag, "token");
  assert.equal(state.primaryModal.modal.dropdown.open, true);

  let dd = selectTokenDropdownModel(state);
  assert.deepEqual(dd.filteredSelectableAddresses, [
    "vip-01@acme.dev",
    "vip-02@acme.dev",
  ]);
  assert.equal(dd.options.length, 3); // 2 existing + 1 creatable "vip@acme.dev"
  assert.equal(dd.options[2]?.kind, "create");

  // Select all filtered rules ("vip-01@acme.dev", "vip-02@acme.dev") — does NOT accidentally create "vip@acme.dev"
  state = reduceAppState(state, {
    type: "TOKEN_MODAL_SELECT_MANY",
    addresses: dd.filteredSelectableAddresses,
  });
  assert.equal(state.primaryModal.tag, "token");
  assert.deepEqual(state.primaryModal.modal.draft.addresses, [
    "vip-01@acme.dev",
    "vip-02@acme.dev",
  ]);

  // Explicitly create a brand-new prefix via TOKEN_MODAL_ADD_ADDRESSES -> clears filterQuery & keeps dropdown open
  state = reduceAppState(state, {
    type: "TOKEN_MODAL_FILTER_SET",
    query: "partner-new",
  });
  dd = selectTokenDropdownModel(state);
  assert.equal(dd.options[0]?.kind, "create");
  if (dd.options[0]?.kind === "create") {
    state = reduceAppState(state, {
      type: "TOKEN_MODAL_ADD_ADDRESSES",
      addresses: dd.options[0].addresses,
    });
  }
  assert.equal(state.primaryModal.tag, "token");
  assert.equal(state.primaryModal.modal.dropdown.filterQuery, "");
  assert.deepEqual(state.primaryModal.modal.draft.addresses, [
    "partner-new@acme.dev",
    "vip-01@acme.dev",
    "vip-02@acme.dev",
  ]);

  // Closing dropdown resets filterQuery without losing selected addresses
  state = reduceAppState(state, {
    type: "TOKEN_MODAL_DROPDOWN_TOGGLE",
    open: false,
  });
  assert.equal(state.primaryModal.tag, "token");
  assert.equal(state.primaryModal.modal.dropdown.open, false);
  assert.equal(state.primaryModal.modal.draft.addresses.length, 3);

  // Authorized mailboxes overflow modal opens, filters, and closes cleanly
  state = reduceAppState(state, {
    type: "TOKEN_ADDRS_MODAL_OPEN",
    token: {
      id: "t1",
      name: "pcoin",
      token: "cfmt_1234567890abcdef",
      addresses: Array.from(
        { length: 10 },
        (_, i) => `pcoin-${String(i + 1).padStart(2, "0")}@acme.dev`,
      ),
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  });
  assert.equal(state.primaryModal.tag, "tokenAddrs");
  assert.equal(state.primaryModal.modal.addresses.length, 10);

  state = reduceAppState(state, {
    type: "TOKEN_ADDRS_MODAL_SEARCH_SET",
    query: "09",
  });
  assert.equal(state.primaryModal.tag, "tokenAddrs");
  assert.equal(state.primaryModal.modal.searchQuery, "09");

  state = reduceAppState(state, { type: "TOKEN_ADDRS_MODAL_CLOSE" });
  assert.equal(state.primaryModal.tag, "none");
});
