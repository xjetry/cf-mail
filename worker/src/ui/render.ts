import { ICONS } from "./icons.ts";
import {
  buildEmailPreviewSrcdoc,
  escapeHtml,
  formatRemainingTtl,
  formatTimestamp,
  maskSecret,
  renderPlainTextWithLinks,
} from "./primitives.ts";
import {
  deriveRuleKeyPanel,
  getAllowedTabsForRole,
  getRuleTargets,
  selectFilteredTokens,
  selectInboxModel,
  selectLogsTableModel,
  selectRulesTableModel,
  selectTokenDropdownModel,
  summarizeRuleMeta,
} from "./state.ts";
import {
  assertNever,
  type AppState,
  type AsyncResource,
  type ForwardRule,
  type InboxMessage,
  type TenantToken,
  type WatchSlot,
  type WatchTtlOption,
  type WorkspaceTab,
} from "./types.ts";

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element #${id}`);
  return el as T;
};

export function buildQuickLink(keyVal: string): string {
  return `${location.origin}/?key=${encodeURIComponent(keyVal)}`;
}

export function buildPollCurl(keyVal: string): string {
  return `curl -s "${location.origin}/api/inbox?unread=1&consume=1" -H "Authorization: Bearer ${keyVal}"`;
}

export interface UiActions {
  onCopy(text: string, successMessage: string): void;
  onSelectTab(tab: WorkspaceTab): void;
  // Rules
  onClearRuleSearch(): void;
  onOpenAddRule(): void;
  onOpenEditRule(rule: ForwardRule): void;
  onDeleteRule(rule: ForwardRule): void;
  onRetryRules(): void;
  // Rule Modal
  onRuleModalToggleTarget(index: number, enabled: boolean): void;
  onRuleModalRemoveTarget(index: number): void;
  onRuleModalSendVerify(address: string): void;
  onRuleModalToggleKeyReveal(): void;
  onRuleModalRotateKey(): void;
  onRuleModalRevokeKey(): void;
  // Tokens
  onClearTokenSearch(): void;
  onOpenAddToken(): void;
  onOpenEditToken(tok: TenantToken): void;
  onOpenTokenAddrsModal(tok: TenantToken): void;
  onToggleTokenEnabled(tok: TenantToken, enabled: boolean): void;
  onRotateToken(tok: TenantToken): void;
  onDeleteToken(tok: TenantToken): void;
  onDismissTokenBanner(): void;
  onRetryTokens(): void;
  // Token Modal
  onTokenModalRemoveAddr(address: string): void;
  // Inbox & Watch Slots
  onOpenWatchModal(): void;
  onFilterInboxByWatch(address: string): void;
  onUnwatchSlot(slot: WatchSlot): void;
  onOpenMessage(msg: InboxMessage): void;
  onAckMessage(msg: InboxMessage): void;
  onDeleteMessage(msg: InboxMessage): void;
  onClearInboxFilter(): void;
  onShowAllInboxMessages(): void;
  onRetryInbox(): void;
  onLoadMoreInbox(): void;
  // Logs
  onClearLogFilters(): void;
  onRetryLogs(): void;
}

export interface SelectSyncCallbacks {
  pageSize(val: 10 | 20 | 50): void;
  logsPageSize(val: 10 | 20 | 50): void;
  logStatus(val: AppState["logs"]["statusFilter"]): void;
  watchTtl(val: WatchTtlOption): void;
}

function setInputValueSafe(el: HTMLInputElement, nextVal: string): void {
  if (el.value !== nextVal) {
    el.value = nextVal;
  }
}

function renderResourceBlock(
  host: HTMLElement,
  opts: {
    title: string;
    desc: string;
    isError?: boolean;
    actionLabel?: string;
    onAction?: () => void;
  },
): void {
  host.innerHTML = "";
  host.hidden = false;
  const wrap = document.createElement("div");
  wrap.className = "state-block";

  const title = document.createElement("div");
  title.className = "state-title";
  if (opts.isError) title.style.color = "var(--danger-text)";
  title.textContent = opts.title;
  wrap.appendChild(title);

  const desc = document.createElement("p");
  desc.className = "state-desc";
  desc.textContent = opts.desc;
  wrap.appendChild(desc);

  if (opts.actionLabel && opts.onAction) {
    const actWrap = document.createElement("div");
    actWrap.className = "state-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-secondary";
    btn.textContent = opts.actionLabel;
    btn.onclick = opts.onAction;
    actWrap.appendChild(btn);
    wrap.appendChild(actWrap);
  }
  host.appendChild(wrap);
}

function renderSkeletonRows(tbody: HTMLElement, cols: number): void {
  tbody.innerHTML = "";
  for (let r = 0; r < 3; r++) {
    const tr = document.createElement("tr");
    for (let c = 0; c < cols; c++) {
      const td = document.createElement("td");
      const bar = document.createElement("div");
      bar.className = "skeleton-line";
      bar.style.width = c === cols - 1 ? "72px" : c === 0 ? "140px" : "80%";
      if (c === cols - 1) bar.style.marginLeft = "auto";
      td.appendChild(bar);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function hasReloadBanner<T>(res: AsyncResource<T>): string | undefined {
  return res.status === "ready" ? res.reloadError : undefined;
}

function createCopyableAddressEl(
  address: string,
  label: string,
  actions: UiActions,
  textClassName = "addr-primary",
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "copyable-addr";

  const textSpan = document.createElement("span");
  textSpan.className = textClassName;
  textSpan.textContent = address;
  textSpan.title = address;
  wrap.appendChild(textSpan);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "hover-copy-btn";
  copyBtn.setAttribute("aria-label", `复制${label} ${address}`);
  copyBtn.title = `复制${label}`;
  copyBtn.innerHTML = ICONS.copy;

  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  copyBtn.onclick = () => {
    actions.onCopy(address, `已复制${label} ${address}`);
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copyBtn.classList.add("is-copied");
    copyBtn.innerHTML = ICONS.checkInline;
    copiedTimer = setTimeout(() => {
      copiedTimer = null;
      copyBtn.classList.remove("is-copied");
      copyBtn.innerHTML = ICONS.copy;
    }, 1200);
  };

  wrap.appendChild(copyBtn);
  return wrap;
}

function createCopyableDestPill(
  opts: {
    address: string;
    enabled: boolean;
    disabled?: boolean;
    pausedHint?: boolean;
  },
  actions: UiActions,
): HTMLButtonElement {
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "dest-pill " + (opts.enabled ? "is-on" : "is-off");
  pill.disabled = Boolean(opts.disabled);
  pill.title = `点击复制目标邮箱 ${opts.address}${
    !opts.enabled && opts.pausedHint ? "（当前已暂停，可在编辑中启用）" : ""
  }`;
  pill.setAttribute(
    "aria-label",
    `复制目标邮箱 ${opts.address}${opts.enabled ? "" : "（已暂停）"}`,
  );

  const lead = document.createElement("span");
  lead.className = "dest-pill-lead";
  lead.setAttribute("aria-hidden", "true");

  const dot = document.createElement("span");
  dot.className = "status-dot " + (opts.enabled ? "is-on" : "is-off");

  const copyIcon = document.createElement("span");
  copyIcon.className = "dest-copy-icon";
  copyIcon.innerHTML = ICONS.copy;

  lead.append(dot, copyIcon);

  const textSpan = document.createElement("span");
  textSpan.className = "dest-pill-text";
  textSpan.textContent = opts.address;

  pill.append(lead, textSpan);

  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  pill.onclick = () => {
    actions.onCopy(opts.address, `已复制目标邮箱 ${opts.address}`);
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    pill.classList.add("is-copied");
    copyIcon.innerHTML = ICONS.checkInline;
    copiedTimer = setTimeout(() => {
      copiedTimer = null;
      pill.classList.remove("is-copied");
      copyIcon.innerHTML = ICONS.copy;
    }, 1200);
  };

  return pill;
}

/* ==========================================================================
   Reference-Equality Section Memoization (Prevents Table DOM Churn on Overlays)
   ========================================================================== */
const sectionMemo: {
  rules?: readonly unknown[];
  inbox?: readonly unknown[];
  tokens?: readonly unknown[];
  logs?: readonly unknown[];
} = {};

let tokenDropdownListMemo: {
  structureKey: string;
  filterQuery: string;
} | null = null;

let renderedIframeMessageId: string | null = null;

function depsChanged(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[],
): boolean {
  if (!prev || prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) {
    if (prev[i] !== next[i]) return true;
  }
  return false;
}

/* ==========================================================================
   Static Icon Hydration (Run Once on Boot)
   ========================================================================== */
export function mountStaticIcons(): void {
  $("gate-logo-icon").innerHTML = ICONS.mail;
  $("header-brand-icon").innerHTML = ICONS.mail;
  $("refresh-icon").innerHTML = ICONS.refresh;
  $("rule-search-icon").innerHTML = ICONS.search;
  $("inbox-search-icon").innerHTML = ICONS.search;
  $("token-search-icon").innerHTML = ICONS.search;
  $("log-search-icon").innerHTML = ICONS.search;
  $("tok-mselect-search-icon").innerHTML = ICONS.search;
  $("tok-mselect-chevron").innerHTML = ICONS.chevron;
  $("tok-addrs-search-icon").innerHTML = ICONS.search;
  $("watches-header-icon").innerHTML = ICONS.clock;
  $("modal-close").innerHTML = ICONS.close;
  $("tok-modal-close").innerHTML = ICONS.close;
  $("tok-addrs-modal-close").innerHTML = ICONS.close;
  $("watch-modal-close").innerHTML = ICONS.close;
  $("msg-modal-close").innerHTML = ICONS.close;
}

/* ==========================================================================
   Top-Level Deterministic Renderer
   ========================================================================== */
export function renderApp(
  state: AppState,
  actions: UiActions,
  syncSelects: SelectSyncCallbacks,
): void {
  const bootEl = $("boot-screen");
  const gateEl = $("gate");
  const uiEl = $("ui");

  switch (state.auth.tag) {
    case "booting": {
      bootEl.hidden = false;
      gateEl.hidden = true;
      uiEl.hidden = true;
      break;
    }
    case "unauthenticated": {
      // Clear section memo cache when leaving authenticated workspace so next login renders fresh!
      sectionMemo.rules = undefined;
      sectionMemo.inbox = undefined;
      sectionMemo.tokens = undefined;
      sectionMemo.logs = undefined;
      bootEl.hidden = true;
      gateEl.hidden = false;
      uiEl.hidden = true;
      renderGate(state.auth);
      break;
    }
    case "authenticated": {
      bootEl.hidden = true;
      gateEl.hidden = true;
      uiEl.hidden = false;
      renderAuthenticatedWorkspace(state, actions, syncSelects);
      break;
    }
    default:
      assertNever(state.auth);
  }

  renderPrimaryModals(state, actions, syncSelects);
  renderConfirmModal(state.confirmDialog);
  renderToast(state.toast);
}

/* ---------------- Gate Renderer ---------------- */
function renderGate(
  auth: Extract<AppState["auth"], { tag: "unauthenticated" }>,
): void {
  const noticeEl = $("gate-notice");
  if (auth.gateNotice) {
    noticeEl.hidden = false;
    noticeEl.innerHTML = `${ICONS.alert}<span>${escapeHtml(auth.gateNotice)}</span>`;
  } else {
    noticeEl.hidden = true;
    noticeEl.textContent = "";
  }

  const errEl = $("gate-error");
  const tokenInput = $<HTMLInputElement>("token");
  const pwdBtn = $<HTMLButtonElement>("gate-toggle-pwd");
  const loginBtn = $<HTMLButtonElement>("login");

  tokenInput.type = auth.passwordRevealed ? "text" : "password";
  pwdBtn.innerHTML = auth.passwordRevealed ? ICONS.eyeOff : ICONS.eye;
  pwdBtn.setAttribute(
    "aria-label",
    auth.passwordRevealed ? "隐藏访问凭证" : "显示访问凭证",
  );

  if (auth.login.status === "submitting") {
    errEl.hidden = true;
    tokenInput.disabled = true;
    tokenInput.setAttribute("aria-invalid", "false");
    loginBtn.disabled = true;
    loginBtn.textContent = "正在验证…";
  } else {
    tokenInput.disabled = false;
    loginBtn.disabled = false;
    loginBtn.textContent = "验证并进入";
    if (auth.login.error) {
      errEl.hidden = false;
      errEl.innerHTML = `${ICONS.alert}<span>${escapeHtml(auth.login.error.message)}</span>`;
      tokenInput.setAttribute("aria-invalid", "true");
    } else {
      errEl.hidden = true;
      tokenInput.setAttribute("aria-invalid", "false");
    }
  }
}

/* ---------------- Authenticated Workspace Renderer ---------------- */
function renderAuthenticatedWorkspace(
  state: AppState,
  actions: UiActions,
  syncSelects: SelectSyncCallbacks,
): void {
  if (state.auth.tag !== "authenticated") return;
  const principal = state.auth.principal;
  const role = principal.role;

  // Domain labels
  const suffixText = "@" + state.mailDomain;
  $("header-domain-tag").textContent = suffixText;
  $("modal-domain-suffix").textContent = suffixText;
  $("tok-domain-suffix").textContent = suffixText;
  $("watch-domain-suffix").textContent = suffixText;

  // Role badge
  const roleBadge = $("role-badge");
  if (role === "admin") {
    roleBadge.innerHTML = `<span class="badge badge-ok">全局管理员</span>`;
  } else if (role === "tenant") {
    roleBadge.innerHTML = `<span class="badge badge-warn">租户管理员 · ${escapeHtml(principal.tokenMeta.name)}</span>`;
  } else {
    roleBadge.innerHTML = `<span class="badge badge-accent">单邮箱收件箱</span>`;
  }

  // Global refresh button state
  const refreshBtn = $<HTMLButtonElement>("refresh");
  refreshBtn.disabled = state.globalRefreshing;
  refreshBtn.classList.toggle("is-spinning", state.globalRefreshing);
  $("refresh-label").textContent = state.globalRefreshing ? "刷新中" : "刷新";

  // Workspace tabs
  const allowedTabs = getAllowedTabsForRole(role);
  const navEl = $("workspace-nav");
  if (allowedTabs.length <= 1) {
    navEl.hidden = true;
  } else {
    navEl.hidden = false;
    $("tab-label-rules").textContent =
      role === "tenant" ? "授权规则" : "转发规则";

    const rulesTotal =
      state.rules.resource.status === "ready"
        ? state.rules.resource.data.length
        : 0;
    const inboxModel = selectInboxModel(state);
    const tokensTotal =
      state.tokens.resource.status === "ready"
        ? state.tokens.resource.data.length
        : 0;
    const logsTotal =
      state.logs.resource.status === "ready"
        ? state.logs.resource.data.length
        : 0;

    $("tab-count-rules").textContent = String(rulesTotal);
    const inboxCountEl = $("tab-count-inbox");
    inboxCountEl.textContent =
      inboxModel.unreadCount > 0
        ? `${inboxModel.unreadCount} 未读`
        : String(inboxModel.totalLoaded);
    inboxCountEl.classList.toggle("has-unread", inboxModel.unreadCount > 0);
    $("tab-count-tokens").textContent = String(tokensTotal);
    $("tab-count-logs").textContent = state.logs.hasMore
      ? `${logsTotal}+`
      : String(logsTotal);

    const tabButtons: Array<{ id: string; tab: WorkspaceTab }> = [
      { id: "tab-btn-rules", tab: "rules" },
      { id: "tab-btn-inbox", tab: "inbox" },
      { id: "tab-btn-tokens", tab: "tokens" },
      { id: "tab-btn-logs", tab: "logs" },
    ];
    for (const item of tabButtons) {
      const btn = $<HTMLButtonElement>(item.id);
      const visible = allowedTabs.includes(item.tab);
      btn.hidden = !visible;
      const isActive = visible && state.activeTab === item.tab;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", String(isActive));
      btn.tabIndex = isActive ? 0 : -1;
    }
  }

  // Single-mailbox user identity & progressive disclosure API bar
  const userCard = $("user-credential-card");
  if (principal.role === "user") {
    userCard.hidden = false;
    $("user-current-address").textContent = principal.address;
    const apiBtn = $<HTMLButtonElement>("user-toggle-api");
    apiBtn.setAttribute("aria-expanded", String(principal.apiDrawerOpen));
    apiBtn.textContent = principal.apiDrawerOpen
      ? "收起密钥管理"
      : "API 与密钥管理";

    const drawer = $("user-api-drawer");
    drawer.hidden = !principal.apiDrawerOpen;
    if (principal.apiDrawerOpen) {
      $("user-inbox-key-val").textContent = principal.secretRevealed
        ? principal.credential
        : maskSecret(principal.credential);
      $("user-reveal-key").textContent = principal.secretRevealed
        ? "隐藏密钥"
        : "显示密钥";
      const rotBtn = $<HTMLButtonElement>("user-rotate-key");
      const rotating = principal.keyRotation === "rotating";
      rotBtn.disabled = rotating;
      rotBtn.textContent = rotating ? "重置中…" : "重置 Key";
      $<HTMLButtonElement>("user-copy-key").disabled = rotating;
      $<HTMLButtonElement>("user-copy-link").disabled = rotating;
      $<HTMLButtonElement>("user-copy-curl").disabled = rotating;
    }
  } else {
    userCard.hidden = true;
  }

  // Show active tab panel exclusively & memoize section rendering
  const activeTab = state.activeTab;
  $("rules-card").hidden = !(
    allowedTabs.includes("rules") && activeTab === "rules"
  );
  $("inbox-card").hidden = !(
    allowedTabs.includes("inbox") && activeTab === "inbox"
  );
  $("tokens-card").hidden = !(
    allowedTabs.includes("tokens") && activeTab === "tokens"
  );
  $("logs-card").hidden = !(
    allowedTabs.includes("logs") && activeTab === "logs"
  );

  if (allowedTabs.includes("rules") && activeTab === "rules") {
    const nextDeps = [
      state.rules,
      state.tokens.resource,
      state.mailDomain,
      role,
    ];
    if (depsChanged(sectionMemo.rules, nextDeps)) {
      sectionMemo.rules = nextDeps;
      renderRulesSection(state, actions, syncSelects.pageSize);
    }
  }
  if (allowedTabs.includes("inbox") && activeTab === "inbox") {
    const nextDeps = [state.inbox, state.watches, role];
    if (depsChanged(sectionMemo.inbox, nextDeps)) {
      sectionMemo.inbox = nextDeps;
      renderInboxSection(state, actions);
    }
  }
  if (allowedTabs.includes("tokens") && activeTab === "tokens") {
    const nextDeps = [state.tokens];
    if (depsChanged(sectionMemo.tokens, nextDeps)) {
      sectionMemo.tokens = nextDeps;
      renderTokensSection(state, actions);
    }
  }
  if (allowedTabs.includes("logs") && activeTab === "logs") {
    const nextDeps = [state.logs, role];
    if (depsChanged(sectionMemo.logs, nextDeps)) {
      sectionMemo.logs = nextDeps;
      renderLogsSection(state, actions, syncSelects);
    }
  }
}

/* ---------------- Section 1: Rules ---------------- */
function renderRulesSection(
  state: AppState,
  actions: UiActions,
  pageSizeSelectSync: (val: 10 | 20 | 50) => void,
): void {
  if (state.auth.tag !== "authenticated") return;
  const isAdmin = state.auth.principal.role === "admin";
  $("rules-section-title").textContent = isAdmin ? "转发规则" : "授权邮箱规则";
  $("open-add-modal").hidden = !isAdmin;
  $("open-add-modal").innerHTML = `${ICONS.plus}<span>新增规则</span>`;

  setInputValueSafe(
    $<HTMLInputElement>("rule-search"),
    state.rules.searchQuery,
  );
  pageSizeSelectSync(state.rules.pageSize);

  const res = state.rules.resource;
  const tableWrap = $("rules-table-wrap");
  const stateHost = $("rules-state-host");
  const pagination = $("rules-pagination");
  const tbody = $("rules");

  if (res.status === "idle" || res.status === "loading") {
    tableWrap.hidden = false;
    stateHost.hidden = true;
    pagination.hidden = true;
    $("rule-count").textContent = "…";
    renderSkeletonRows(tbody, 4);
    return;
  }

  if (res.status === "error") {
    tableWrap.hidden = true;
    pagination.hidden = true;
    $("rule-count").textContent = "异常";
    renderResourceBlock(stateHost, {
      title: "转发规则加载失败",
      desc: res.error,
      isError: true,
      actionLabel: "重新加载",
      onAction: actions.onRetryRules,
    });
    return;
  }

  const model = selectRulesTableModel(state);
  const hasSearch = state.rules.searchQuery.trim().length > 0;
  $("rule-count").textContent = hasSearch
    ? `${model.totalFiltered} / ${model.totalAll}`
    : String(model.totalAll);

  if (model.items.length === 0) {
    tableWrap.hidden = true;
    pagination.hidden = true;
    if (hasSearch) {
      renderResourceBlock(stateHost, {
        title: "未找到匹配的转发规则",
        desc: `没有与「${state.rules.searchQuery.trim()}」匹配的收件地址、转发目标或租户名称。`,
        actionLabel: "清除搜索条件",
        onAction: actions.onClearRuleSearch,
      });
    } else if (isAdmin) {
      renderResourceBlock(stateHost, {
        title: "暂无转发规则",
        desc: "创建第一条前缀邮件路由规则，可将入站邮件并行转发至多个目标邮箱或暂存至临时收件箱。",
        actionLabel: "新增第一条规则",
        onAction: actions.onOpenAddRule,
      });
    } else {
      renderResourceBlock(stateHost, {
        title: "暂无已授权的邮箱规则",
        desc: "请联系全局管理员为当前访问令牌分配可管理的邮箱前缀。",
      });
    }
    return;
  }

  tableWrap.hidden = false;
  stateHost.hidden = true;
  pagination.hidden = false;

  const reloadErr = hasReloadBanner(res);
  $("page-summary").textContent = reloadErr
    ? `刷新失败 (${reloadErr}) · 显示第 ${model.startIndex + 1}–${model.endIndex} 条`
    : `显示第 ${model.startIndex + 1}–${model.endIndex} 条，共 ${model.totalFiltered} 条`;
  $("page-indicator").textContent = `${model.page} / ${model.totalPages}`;
  $<HTMLButtonElement>("page-prev").disabled = model.page <= 1;
  $<HTMLButtonElement>("page-next").disabled = model.page >= model.totalPages;

  tbody.innerHTML = "";
  for (const r of model.items) {
    const pendingOp = state.rules.pendingByAddress[r.address];
    const rowBusy = pendingOp !== undefined;

    const tr = document.createElement("tr");

    // Col 1: Copyable Address + Linked Tenant Badges
    const tdAddr = document.createElement("td");
    tdAddr.setAttribute("data-label", "收件地址");
    tdAddr.appendChild(createCopyableAddressEl(r.address, "收件地址", actions));

    if (isAdmin) {
      const linked = model.linkedTokensMap.get(r.address) ?? [];
      if (linked.length > 0) {
        const sub = document.createElement("div");
        sub.className = "sub-badges";
        for (const lt of linked) {
          const b = document.createElement("span");
          const isExpired =
            lt.expiresAt !== undefined && lt.expiresAt <= Date.now();
          b.className =
            "badge " +
            (lt.enabled && !isExpired ? "badge-accent" : "badge-muted");
          b.innerHTML = `${ICONS.tag}<span>${escapeHtml(lt.name)}${
            !lt.enabled ? " · 已暂停" : isExpired ? " · 已过期" : ""
          }</span>`;
          sub.appendChild(b);
        }
        tdAddr.appendChild(sub);
      }
    }

    // Col 2: Routing Strategy & Hover-Copy Destination Capsules (Toggle stays in Edit Modal)
    const tdDests = document.createElement("td");
    tdDests.setAttribute("data-label", "投递目标与模式");
    const flow = document.createElement("div");
    flow.className = "chip-flow";

    if (r.inboxEnabled) {
      const ib = document.createElement("span");
      ib.className = "badge badge-ok";
      ib.innerHTML = `${ICONS.inbox}<span>临时收件箱</span>`;
      flow.appendChild(ib);
    }
    if (Array.isArray(r.allowedSenders) && r.allowedSenders.length > 0) {
      const sb = document.createElement("span");
      sb.className = "badge badge-muted badge-wrap";
      sb.innerHTML = `${ICONS.shield}<span>限 ${escapeHtml(
        r.allowedSenders.join(", "),
      )}</span>`;
      flow.appendChild(sb);
    }

    const targets = getRuleTargets(r);
    for (const t of targets) {
      flow.appendChild(
        createCopyableDestPill(
          {
            address: t.address,
            enabled: t.enabled,
            disabled: rowBusy,
            pausedHint: true,
          },
          actions,
        ),
      );
    }

    if (!r.inboxEnabled && targets.length === 0) {
      const empty = document.createElement("span");
      empty.className = "badge badge-muted";
      empty.textContent = "暂停投递（无启用目标）";
      flow.appendChild(empty);
    }
    tdDests.appendChild(flow);

    // Col 3: Tabular Timestamp
    const tdTime = document.createElement("td");
    tdTime.setAttribute("data-label", "更新时间");
    tdTime.className = "timestamp-cell";
    tdTime.textContent = formatTimestamp(r.updatedAt);

    // Col 4: Streamlined Actions
    const tdAct = document.createElement("td");
    tdAct.className = "col-actions";
    const actRow = document.createElement("div");
    actRow.className = "row-actions";

    if (r.inboxEnabled && r.inboxKey) {
      const linkBtn = document.createElement("button");
      linkBtn.type = "button";
      linkBtn.className = "btn btn-secondary btn-sm";
      linkBtn.disabled = rowBusy;
      linkBtn.innerHTML = `${ICONS.copy}<span>直达链接</span>`;
      linkBtn.title = "复制终端用户免输直达收件箱链接";
      linkBtn.onclick = () =>
        actions.onCopy(
          buildQuickLink(r.inboxKey!),
          `已复制 ${r.address} 的直达收件箱链接`,
        );
      actRow.appendChild(linkBtn);
    }

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-secondary btn-sm";
    editBtn.setAttribute("data-focus-key", `rule-edit:${r.address}`);
    editBtn.disabled = rowBusy;
    editBtn.textContent = "编辑";
    editBtn.onclick = () => actions.onOpenEditRule(r);
    actRow.appendChild(editBtn);

    if (isAdmin) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-danger btn-sm";
      delBtn.setAttribute("data-focus-key", `rule-del:${r.address}`);
      delBtn.disabled = rowBusy;
      delBtn.textContent = pendingOp?.tag === "deleting" ? "删除中…" : "删除";
      delBtn.onclick = () => actions.onDeleteRule(r);
      actRow.appendChild(delBtn);
    }

    tdAct.appendChild(actRow);
    tr.append(tdAddr, tdDests, tdTime, tdAct);
    tbody.appendChild(tr);
  }
}

/* ---------------- Section 2: Temporary Inbox & Active Watch Slots ---------------- */
function renderInboxSection(state: AppState, actions: UiActions): void {
  if (state.auth.tag !== "authenticated") return;
  const isUser = state.auth.principal.role === "user";
  const isAdmin = state.auth.principal.role === "admin";
  const nowMs = Date.now();

  $("inbox-filter-wrap").hidden = isUser;
  $("inbox-refresh").hidden = isUser;

  const openWatchBtn = $<HTMLButtonElement>("open-watch-modal");
  openWatchBtn.hidden = !isAdmin;
  if (isAdmin) {
    openWatchBtn.innerHTML = `${ICONS.plus}<span>临时监听</span>`;
  }

  // Active Watch Slots Strip (Admin only; hidden when empty)
  const watchesBar = $("active-watches-bar");
  const watchesList = $("watches-list");
  if (
    isAdmin &&
    state.watches.resource.status === "ready" &&
    state.watches.resource.data.length > 0
  ) {
    const activeWatches = state.watches.resource.data.filter(
      (w) => w.expiresAt > nowMs,
    );
    if (activeWatches.length > 0) {
      watchesBar.hidden = false;
      $("watches-count").textContent = String(activeWatches.length);
      watchesList.innerHTML = "";
      for (const w of activeWatches) {
        const unwatching = Boolean(
          state.watches.pendingUnwatchByAddr[w.address],
        );
        const pill = document.createElement("div");
        pill.className = "watch-pill";

        const addrBtn = document.createElement("button");
        addrBtn.type = "button";
        addrBtn.className = "watch-addr-btn";
        addrBtn.textContent = w.address;
        addrBtn.title = `点击筛选 ${w.address} 的收件箱邮件`;
        addrBtn.onclick = () => actions.onFilterInboxByWatch(w.address);
        pill.appendChild(addrBtn);

        if (w.allowedSenders && w.allowedSenders.length > 0) {
          const sb = document.createElement("span");
          sb.className = "badge badge-muted";
          sb.textContent = `限 ${w.allowedSenders.join(", ")}`;
          pill.appendChild(sb);
        }

        const ttlSpan = document.createElement("span");
        ttlSpan.className = "watch-ttl";
        ttlSpan.title = `到期时间：${formatTimestamp(w.expiresAt)}`;
        ttlSpan.textContent = formatRemainingTtl(w.expiresAt, nowMs);
        pill.appendChild(ttlSpan);

        const stopBtn = document.createElement("button");
        stopBtn.type = "button";
        stopBtn.className = "btn btn-danger btn-sm";
        stopBtn.disabled = unwatching;
        stopBtn.textContent = unwatching ? "关闭中…" : "关闭";
        stopBtn.onclick = () => actions.onUnwatchSlot(w);
        pill.appendChild(stopBtn);

        watchesList.appendChild(pill);
      }
    } else {
      watchesBar.hidden = true;
      watchesList.innerHTML = "";
    }
  } else {
    watchesBar.hidden = true;
    watchesList.innerHTML = "";
  }

  if (!isUser) {
    setInputValueSafe(
      $<HTMLInputElement>("inbox-filter"),
      state.inbox.filterInput,
    );
  }
  $<HTMLInputElement>("inbox-unread-only").checked = state.inbox.unreadOnly;

  const res = state.inbox.resource;
  const tableWrap = $("inbox-table-wrap");
  const stateHost = $("inbox-state-host");
  const moreBar = $("inbox-more-bar");
  const tbody = $("inbox-rows");

  if (res.status === "idle" || res.status === "loading") {
    tableWrap.hidden = false;
    stateHost.hidden = true;
    moreBar.hidden = true;
    $("inbox-count-badge").textContent = "…";
    renderSkeletonRows(tbody, 5);
    return;
  }

  if (res.status === "error") {
    tableWrap.hidden = true;
    moreBar.hidden = true;
    $("inbox-count-badge").textContent = "异常";
    renderResourceBlock(stateHost, {
      title: "收件箱加载失败",
      desc: res.error,
      isError: true,
      actionLabel: "重新加载",
      onAction: actions.onRetryInbox,
    });
    return;
  }

  const model = selectInboxModel(state);
  const totalLabel = state.inbox.hasMore
    ? `${model.totalLoaded}+`
    : String(model.totalLoaded);
  $("inbox-count-badge").textContent =
    model.unreadCount > 0
      ? `${model.unreadCount} 未读 / 已载入 ${totalLabel}`
      : totalLabel;

  if (model.items.length === 0) {
    tableWrap.hidden = true;
    moreBar.hidden = true;
    if (state.inbox.unreadOnly && model.totalLoaded > 0) {
      renderResourceBlock(stateHost, {
        title: "没有未读邮件",
        desc: `当前已加载的 ${model.totalLoaded} 封邮件均为已读状态。`,
        actionLabel: "显示全部邮件",
        onAction: actions.onShowAllInboxMessages,
      });
    } else if (!isUser && state.inbox.appliedFilter.trim()) {
      renderResourceBlock(stateHost, {
        title: "未找到匹配的暂存邮件",
        desc: `收件地址「${state.inbox.appliedFilter}」当前没有暂存邮件。`,
        actionLabel: "清除筛选条件",
        onAction: actions.onClearInboxFilter,
      });
    } else {
      renderResourceBlock(stateHost, {
        title: "收件箱暂无邮件",
        desc: "新到达的验证码与登录邮件将在此处实时显示，并保留 30 分钟。",
      });
    }
    return;
  }

  tableWrap.hidden = false;
  stateHost.hidden = true;
  tbody.innerHTML = "";

  for (const m of model.items) {
    const pendingOp = state.inbox.pendingById[m.id];
    const busy = pendingOp !== undefined;

    const tr = document.createElement("tr");

    // Col 1: 收件人
    const tdTo = document.createElement("td");
    tdTo.setAttribute("data-label", "收件人");
    tdTo.appendChild(createCopyableAddressEl(m.to, "收件人", actions));

    // Col 2: 发件人
    const tdFrom = document.createElement("td");
    tdFrom.setAttribute("data-label", "发件人");
    tdFrom.className = "inbox-sender-cell";
    tdFrom.appendChild(
      createCopyableAddressEl(m.from, "发件人", actions, "inbox-sender-text"),
    );

    // Col 3: 主题 (Accessible Subject Button + Extracted OTP / Link Pills)
    const tdContent = document.createElement("td");
    tdContent.setAttribute("data-label", "主题");

    const subjBtn = document.createElement("button");
    subjBtn.type = "button";
    subjBtn.className = "subj-btn" + (m.read ? " is-read" : "");
    subjBtn.setAttribute("data-focus-key", `msg-subj:${m.id}`);
    subjBtn.textContent = (m.subject || "(无主题)").slice(0, 96);
    subjBtn.onclick = () => actions.onOpenMessage(m);
    tdContent.appendChild(subjBtn);

    const hasCodes = Array.isArray(m.codes) && m.codes.length > 0;
    const hasLinks = Array.isArray(m.links) && m.links.length > 0;
    if (hasCodes || hasLinks) {
      const bar = document.createElement("div");
      bar.className = "extracted-bar";
      if (hasCodes) {
        for (const code of m.codes) {
          const otpBtn = document.createElement("button");
          otpBtn.type = "button";
          otpBtn.className = "otp-btn";
          otpBtn.innerHTML = `${ICONS.copy}<span>验证码</span><span class="otp-code">${escapeHtml(
            code,
          )}</span>`;
          otpBtn.onclick = () =>
            actions.onCopy(code, `已复制验证码 ${code}`);
          bar.appendChild(otpBtn);
        }
      }
      if (hasLinks) {
        const firstLink = m.links[0];
        const lkBtn = document.createElement("button");
        lkBtn.type = "button";
        lkBtn.className = "btn btn-secondary btn-sm";
        lkBtn.title = firstLink;
        lkBtn.innerHTML = `${ICONS.copy}<span>复制验证链接</span>`;
        lkBtn.onclick = () =>
          actions.onCopy(firstLink, "已复制首条验证链接");
        bar.appendChild(lkBtn);
      }
      tdContent.appendChild(bar);
    }

    // Col 4: 状态 (Read/Unread Badge + Remaining TTL + Tabular Arrival Timestamp)
    const tdStatus = document.createElement("td");
    tdStatus.setAttribute("data-label", "状态");
    tdStatus.className = "inbox-status-cell";
    const statusBadge = m.read
      ? `<span class="badge badge-muted">已读</span>`
      : `<span class="badge badge-ok">未读</span>`;
    const ttlLabel = m.expiresAt
      ? `<span class="timestamp-cell">${escapeHtml(
          formatRemainingTtl(m.expiresAt, nowMs),
        )}</span>`
      : "";
    tdStatus.innerHTML = `<div class="inbox-status-row">${statusBadge}${ttlLabel}</div><div class="timestamp-cell" style="margin-top:4px">${escapeHtml(
      formatTimestamp(m.ts),
    )}</div>`;

    // Col 5: 操作
    const tdAct = document.createElement("td");
    tdAct.className = "col-actions";
    const actRow = document.createElement("div");
    actRow.className = "row-actions";

    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "btn btn-secondary btn-sm";
    viewBtn.setAttribute("data-focus-key", `msg-view:${m.id}`);
    viewBtn.textContent = "详情";
    viewBtn.onclick = () => actions.onOpenMessage(m);
    actRow.appendChild(viewBtn);

    if (isUser && !m.read) {
      const ackBtn = document.createElement("button");
      ackBtn.type = "button";
      ackBtn.className = "btn btn-secondary btn-sm";
      ackBtn.disabled = busy;
      ackBtn.textContent = pendingOp === "acking" ? "标记中…" : "标为已读";
      ackBtn.onclick = () => actions.onAckMessage(m);
      actRow.appendChild(ackBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-danger btn-sm";
    delBtn.disabled = busy;
    delBtn.textContent = pendingOp === "deleting" ? "删除中…" : "删除";
    delBtn.onclick = () => actions.onDeleteMessage(m);
    actRow.appendChild(delBtn);

    tdAct.appendChild(actRow);
    tr.append(tdTo, tdFrom, tdContent, tdStatus, tdAct);
    tbody.appendChild(tr);
  }

  // Cursor Load-More Footer
  const loadingMore = state.inbox.loadingMoreReqId !== undefined;
  if (state.inbox.hasMore || loadingMore) {
    moreBar.hidden = false;
    $("inbox-more-summary").textContent = `已加载 ${model.totalLoaded} 封暂存邮件`;
    const moreBtn = $<HTMLButtonElement>("inbox-load-more");
    moreBtn.disabled = loadingMore;
    moreBtn.textContent = loadingMore ? "加载中…" : "加载更多邮件";
  } else {
    moreBar.hidden = true;
  }
}

/* ---------------- Section 3: Tenant Access Tokens ---------------- */
function renderTokensSection(state: AppState, actions: UiActions): void {
  $("open-token-modal").innerHTML = `${ICONS.plus}<span>新增访问令牌</span>`;
  setInputValueSafe(
    $<HTMLInputElement>("token-search"),
    state.tokens.searchQuery,
  );

  const bannerEl = $("token-issued-banner");
  const banner = state.tokens.newlyIssuedBanner;
  if (banner) {
    bannerEl.hidden = false;
    bannerEl.innerHTML = "";
    const info = document.createElement("div");
    info.className = "issued-banner-info";
    info.innerHTML = `
      <div class="issued-banner-title">${
        banner.action === "created" ? "访问令牌已创建" : "访问令牌密钥已重置"
      } · ${escapeHtml(banner.name)}</div>
      <div><code class="code-pill">${escapeHtml(banner.token)}</code></div>
    `;
    const acts = document.createElement("div");
    acts.className = "issued-banner-actions";

    const cpTok = document.createElement("button");
    cpTok.type = "button";
    cpTok.className = "btn btn-secondary btn-sm";
    cpTok.innerHTML = `${ICONS.copy}<span>复制令牌</span>`;
    cpTok.onclick = () =>
      actions.onCopy(banner.token, `已复制「${banner.name}」的访问令牌`);

    const cpLink = document.createElement("button");
    cpLink.type = "button";
    cpLink.className = "btn btn-secondary btn-sm";
    cpLink.innerHTML = `${ICONS.copy}<span>复制直达链接</span>`;
    cpLink.onclick = () =>
      actions.onCopy(
        buildQuickLink(banner.token),
        `已复制「${banner.name}」的直达链接`,
      );

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "btn btn-ghost btn-sm";
    dismiss.textContent = "收起";
    dismiss.onclick = actions.onDismissTokenBanner;

    acts.append(cpTok, cpLink, dismiss);
    bannerEl.append(info, acts);
  } else {
    bannerEl.hidden = true;
    bannerEl.innerHTML = "";
  }

  const res = state.tokens.resource;
  const tableWrap = $("tokens-table-wrap");
  const stateHost = $("tokens-state-host");
  const tbody = $("tokens-rows");

  if (res.status === "idle" || res.status === "loading") {
    tableWrap.hidden = false;
    stateHost.hidden = true;
    $("token-count").textContent = "…";
    renderSkeletonRows(tbody, 4);
    return;
  }

  if (res.status === "error") {
    tableWrap.hidden = true;
    $("token-count").textContent = "异常";
    renderResourceBlock(stateHost, {
      title: "访问令牌加载失败",
      desc: res.error,
      isError: true,
      actionLabel: "重新加载",
      onAction: actions.onRetryTokens,
    });
    return;
  }

  const filtered = selectFilteredTokens(state);
  const totalAll = res.data.length;
  const hasSearch = state.tokens.searchQuery.trim().length > 0;
  $("token-count").textContent = hasSearch
    ? `${filtered.length} / ${totalAll}`
    : String(totalAll);

  if (filtered.length === 0) {
    tableWrap.hidden = true;
    if (hasSearch) {
      renderResourceBlock(stateHost, {
        title: "未找到匹配的访问令牌",
        desc: `没有匹配「${state.tokens.searchQuery.trim()}」的租户备注或邮箱。`,
        actionLabel: "清除搜索条件",
        onAction: actions.onClearTokenSearch,
      });
    } else {
      renderResourceBlock(stateHost, {
        title: "暂无租户访问令牌",
        desc: "创建 cfmt_ 访问令牌可将指定邮箱前缀的转发规则管理权限安全委派给团队或客户。",
        actionLabel: "新增访问令牌",
        onAction: actions.onOpenAddToken,
      });
    }
    return;
  }

  tableWrap.hidden = false;
  stateHost.hidden = true;
  tbody.innerHTML = "";

  for (const tok of filtered) {
    const pendingOp = state.tokens.pendingById[tok.id];
    const busy = pendingOp !== undefined;
    const isExpired =
      tok.expiresAt !== undefined && tok.expiresAt <= Date.now();

    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.setAttribute("data-label", "租户备注 / 标识");
    const nameDiv = document.createElement("div");
    nameDiv.className = "tok-tenant-name";
    nameDiv.textContent = tok.name;

    const credRow = document.createElement("div");
    credRow.className = "tok-cred-row copyable-addr";
    const credCode = document.createElement("code");
    credCode.className = "tok-cred-code";
    credCode.textContent = `${tok.token.slice(0, 12)}…`;
    credCode.title = "点击右侧图标复制完整访问令牌";
    const credCopyBtn = document.createElement("button");
    credCopyBtn.type = "button";
    credCopyBtn.className = "hover-copy-btn";
    credCopyBtn.disabled = busy;
    credCopyBtn.title = "复制访问令牌";
    credCopyBtn.setAttribute("aria-label", `复制「${tok.name}」的访问令牌`);
    credCopyBtn.innerHTML = ICONS.copy;
    let credTimer: ReturnType<typeof setTimeout> | null = null;
    credCopyBtn.onclick = () => {
      actions.onCopy(tok.token, `已复制「${tok.name}」的访问令牌`);
      if (credTimer !== null) clearTimeout(credTimer);
      credCopyBtn.classList.add("is-copied");
      credCopyBtn.innerHTML = ICONS.checkInline;
      credTimer = setTimeout(() => {
        credTimer = null;
        credCopyBtn.classList.remove("is-copied");
        credCopyBtn.innerHTML = ICONS.copy;
      }, 1200);
    };
    credRow.append(credCode, credCopyBtn);
    tdName.append(nameDiv, credRow);

    const tdAddrs = document.createElement("td");
    tdAddrs.setAttribute("data-label", "已授权邮箱");
    const addrs = tok.addresses ?? [];
    if (addrs.length === 0) {
      const emptyBadge = document.createElement("span");
      emptyBadge.className = "badge badge-muted";
      emptyBadge.textContent = "未分配邮箱";
      tdAddrs.appendChild(emptyBadge);
    } else {
      const MAX_INLINE_ADDRS = 2;
      const inlineWrap = document.createElement("div");
      inlineWrap.className = "tok-addrs-inline";
      for (const addr of addrs.slice(0, MAX_INLINE_ADDRS)) {
        inlineWrap.appendChild(
          createCopyableDestPill(
            { address: addr, enabled: true, disabled: busy },
            actions,
          ),
        );
      }
      if (addrs.length > MAX_INLINE_ADDRS) {
        const moreBtn = document.createElement("button");
        moreBtn.type = "button";
        moreBtn.className = "addr-more-btn";
        moreBtn.setAttribute("data-focus-key", `tok-addrs:${tok.id}`);
        moreBtn.title = `查看全部 ${addrs.length} 个已授权邮箱`;
        moreBtn.setAttribute(
          "aria-label",
          `查看「${tok.name}」全部 ${addrs.length} 个已授权邮箱`,
        );
        moreBtn.textContent = `... +${addrs.length - MAX_INLINE_ADDRS}`;
        moreBtn.onclick = () => actions.onOpenTokenAddrsModal(tok);
        inlineWrap.appendChild(moreBtn);
      }
      tdAddrs.appendChild(inlineWrap);
    }

    const tdStatus = document.createElement("td");
    tdStatus.setAttribute("data-label", "状态与有效期");
    tdStatus.className = "tok-status-cell";

    const statusLine = document.createElement("div");
    statusLine.className = "status-inline";

    const swLabel = document.createElement("label");
    swLabel.className = "switch";
    swLabel.setAttribute("aria-label", `切换令牌 ${tok.name} 启用状态`);
    const swInput = document.createElement("input");
    swInput.type = "checkbox";
    swInput.checked = tok.enabled;
    swInput.disabled = busy;
    swInput.onchange = () =>
      actions.onToggleTokenEnabled(tok, swInput.checked);
    const swSlider = document.createElement("span");
    swSlider.className = "slider";
    swLabel.append(swInput, swSlider);

    const stateTag = document.createElement("span");
    if (!tok.enabled) {
      stateTag.className = "badge badge-muted";
      stateTag.textContent = "已暂停";
    } else if (isExpired) {
      stateTag.className = "badge badge-danger";
      stateTag.textContent = "已过期";
    } else {
      stateTag.className = "badge badge-ok";
      stateTag.textContent = "启用中";
    }
    statusLine.append(swLabel, stateTag);
    tdStatus.appendChild(statusLine);

    const expDiv = document.createElement("div");
    expDiv.className = "timestamp-cell";
    expDiv.style.marginTop = "6px";
    expDiv.textContent = tok.expiresAt
      ? `${isExpired ? "过期于 " : "有效至 "}${formatTimestamp(tok.expiresAt)}`
      : "永不过期";
    tdStatus.appendChild(expDiv);

    const tdAct = document.createElement("td");
    tdAct.className = "col-actions";
    const actRow = document.createElement("div");
    actRow.className = "row-actions";

    const cpBtn = document.createElement("button");
    cpBtn.type = "button";
    cpBtn.className = "btn btn-secondary btn-sm";
    cpBtn.disabled = busy;
    cpBtn.innerHTML = `${ICONS.copy}<span>令牌</span>`;
    cpBtn.title = "复制访问令牌 (cfmt_...)";
    cpBtn.onclick = () =>
      actions.onCopy(tok.token, `已复制「${tok.name}」的访问令牌`);

    const linkBtn = document.createElement("button");
    linkBtn.type = "button";
    linkBtn.className = "btn btn-secondary btn-sm";
    linkBtn.disabled = busy;
    linkBtn.innerHTML = `${ICONS.copy}<span>链接</span>`;
    linkBtn.title = "复制免输直达管理链接";
    linkBtn.onclick = () =>
      actions.onCopy(
        buildQuickLink(tok.token),
        `已复制「${tok.name}」的直达链接`,
      );

    const rotBtn = document.createElement("button");
    rotBtn.type = "button";
    rotBtn.className = "btn btn-secondary btn-sm";
    rotBtn.setAttribute("data-focus-key", `tok-rot:${tok.id}`);
    rotBtn.disabled = busy;
    rotBtn.textContent = pendingOp?.tag === "rotating" ? "重置中…" : "重置密钥";
    rotBtn.onclick = () => actions.onRotateToken(tok);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-secondary btn-sm";
    editBtn.setAttribute("data-focus-key", `tok-edit:${tok.id}`);
    editBtn.disabled = busy;
    editBtn.textContent = "编辑";
    editBtn.onclick = () => actions.onOpenEditToken(tok);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-danger btn-sm";
    delBtn.setAttribute("data-focus-key", `tok-del:${tok.id}`);
    delBtn.disabled = busy;
    delBtn.textContent = pendingOp?.tag === "deleting" ? "删除中…" : "删除";
    delBtn.onclick = () => actions.onDeleteToken(tok);

    actRow.append(cpBtn, linkBtn, rotBtn, editBtn, delBtn);
    tdAct.appendChild(actRow);

    tr.append(tdName, tdAddrs, tdStatus, tdAct);
    tbody.appendChild(tr);
  }
}

/* ---------------- Section 4: Delivery Logs ---------------- */
function renderLogsSection(
  state: AppState,
  actions: UiActions,
  syncSelects: SelectSyncCallbacks,
): void {
  if (state.auth.tag !== "authenticated") return;
  const isTenant = state.auth.principal.role === "tenant";

  $("logs-subtitle").textContent = isTenant
    ? "仅展示当前令牌已授权邮箱的投递记录（邮件主题已由服务端脱敏隐藏）"
    : "按时间倒序展示入站邮件的转发目标与投递状态";

  $("logs-subject-th").hidden = isTenant;
  const logSearchEl = $<HTMLInputElement>("log-search");
  logSearchEl.placeholder = isTenant
    ? "搜索收件人、发件人或状态…"
    : "搜索收件人、发件人或主题…";
  setInputValueSafe(logSearchEl, state.logs.searchQuery);
  syncSelects.logStatus(state.logs.statusFilter);
  syncSelects.logsPageSize(state.logs.pageSize);

  const res = state.logs.resource;
  const tableWrap = $("logs-table-wrap");
  const stateHost = $("logs-state-host");
  const pagination = $("logs-pagination");
  const tbody = $("logs");

  if (res.status === "idle" || res.status === "loading") {
    tableWrap.hidden = false;
    stateHost.hidden = true;
    pagination.hidden = true;
    $("logs-count").textContent = "…";
    renderSkeletonRows(tbody, isTenant ? 4 : 5);
    return;
  }

  if (res.status === "error") {
    tableWrap.hidden = true;
    pagination.hidden = true;
    $("logs-count").textContent = "异常";
    renderResourceBlock(stateHost, {
      title: "投递日志加载失败",
      desc: res.error,
      isError: true,
      actionLabel: "重新加载",
      onAction: actions.onRetryLogs,
    });
    return;
  }

  const model = selectLogsTableModel(state);
  const hasFilters =
    state.logs.searchQuery.trim().length > 0 ||
    state.logs.statusFilter !== "all";
  $("logs-count").textContent = hasFilters
    ? `${model.totalFiltered} / ${model.totalAll}`
    : String(model.totalAll);

  if (model.items.length === 0) {
    tableWrap.hidden = true;
    pagination.hidden = true;
    if (hasFilters) {
      renderResourceBlock(stateHost, {
        title: "未找到匹配的投递日志",
        desc: "当前搜索关键词或状态筛选下没有匹配的邮件记录。",
        actionLabel: "重置日志筛选",
        onAction: actions.onClearLogFilters,
      });
    } else {
      renderResourceBlock(stateHost, {
        title: "暂无投递记录",
        desc: "当外部邮件发往你的域名时，转发结果或拒收原因将实时记录在此。",
      });
    }
    return;
  }

  tableWrap.hidden = false;
  stateHost.hidden = true;
  pagination.hidden = false;

  const reloadErr = hasReloadBanner(res);
  $("logs-page-summary").textContent = reloadErr
    ? `刷新失败 (${reloadErr}) · 显示第 ${model.startIndex + 1}–${model.endIndex} 条`
    : `显示第 ${model.startIndex + 1}–${model.endIndex} 条，共 ${model.totalFiltered} 条`;
  $("logs-page-indicator").textContent = `${model.page} / ${model.totalPages}`;
  $<HTMLButtonElement>("logs-page-prev").disabled = model.page <= 1;
  $<HTMLButtonElement>("logs-page-next").disabled =
    model.page >= model.totalPages;

  tbody.innerHTML = "";

  for (const item of model.items) {
    const l = item.entry;
    const tr = document.createElement("tr");

    // Col 1: 收件人
    const tdTo = document.createElement("td");
    tdTo.setAttribute("data-label", "收件人");
    tdTo.appendChild(createCopyableAddressEl(l.to, "收件人", actions));

    // Col 2: 发件人
    const tdFrom = document.createElement("td");
    tdFrom.setAttribute("data-label", "发件人");
    tdFrom.className = "inbox-sender-cell";
    tdFrom.appendChild(
      createCopyableAddressEl(l.from, "发件人", actions, "inbox-sender-text"),
    );

    tr.append(tdTo, tdFrom);

    // Col 3: 主题 (Hidden for Tenant due to server-side privacy redaction)
    if (!isTenant) {
      const tdSubj = document.createElement("td");
      tdSubj.setAttribute("data-label", "主题");
      tdSubj.className = "log-subject-cell";
      const subjDiv = document.createElement("div");
      subjDiv.className = "log-subject-text";
      const subjText = l.subject || "(无主题)";
      subjDiv.textContent = subjText;
      subjDiv.title = subjText;
      tdSubj.appendChild(subjDiv);
      tr.appendChild(tdSubj);
    }

    // Col 4: 状态 (Status Badge + Copyable Forwarded Targets + Diagnostic Reason)
    const tdStatus = document.createElement("td");
    tdStatus.setAttribute("data-label", "状态");
    const flow = document.createElement("div");
    flow.className = "chip-flow";

    if (item.category === "inbox") {
      const ib = document.createElement("span");
      ib.className = "badge badge-accent";
      ib.innerHTML = `${ICONS.inbox}<span>已存入收件箱</span>`;
      flow.appendChild(ib);
    } else if (item.category === "delivered") {
      const mainBadge = document.createElement("span");
      mainBadge.className = "badge badge-ok";
      mainBadge.textContent = "已转发";
      flow.appendChild(mainBadge);
      if (item.inboxCaptured) {
        const ib = document.createElement("span");
        ib.className = "badge badge-ok";
        ib.innerHTML = `${ICONS.inbox}<span>临时收件箱</span>`;
        flow.appendChild(ib);
      }
    } else {
      const mainBadge = document.createElement("span");
      mainBadge.className = `badge badge-${item.statusBadge.variant}`;
      mainBadge.textContent = item.statusBadge.label;
      flow.appendChild(mainBadge);
      if (item.inboxCaptured) {
        const ib = document.createElement("span");
        ib.className = "badge badge-ok";
        ib.innerHTML = `${ICONS.inbox}<span>临时收件箱</span>`;
        flow.appendChild(ib);
      }
    }

    for (const dest of item.forwardedEmails) {
      flow.appendChild(
        createCopyableDestPill({ address: dest, enabled: true }, actions),
      );
    }
    tdStatus.appendChild(flow);

    if (item.reasonDisplay) {
      const reasonEl = document.createElement("div");
      reasonEl.className =
        "log-reason" + (item.category === "rejected" ? " is-danger" : "");
      reasonEl.title = l.reason ?? item.reasonDisplay;
      const short =
        item.reasonDisplay.length > 96
          ? item.reasonDisplay.slice(0, 96) + "…"
          : item.reasonDisplay;
      reasonEl.innerHTML = `${ICONS.alert}<span>${escapeHtml(short)}</span>`;
      tdStatus.appendChild(reasonEl);
    }

    // Col 5: 时间
    const tdTime = document.createElement("td");
    tdTime.setAttribute("data-label", "时间");
    tdTime.className = "timestamp-cell";
    tdTime.textContent = formatTimestamp(l.ts);

    tr.append(tdStatus, tdTime);
    tbody.appendChild(tr);
  }
}

/* ---------------- Modals Renderer ---------------- */
function renderPrimaryModals(
  state: AppState,
  actions: UiActions,
  syncSelects: SelectSyncCallbacks,
): void {
  const ruleBackdrop = $("rule-modal");
  const tokBackdrop = $("token-modal");
  const tokAddrsBackdrop = $("tok-addrs-modal");
  const watchBackdrop = $("watch-modal");
  const msgBackdrop = $("msg-modal");

  const isRule = state.primaryModal.tag === "rule";
  const isTok = state.primaryModal.tag === "token";
  const isTokAddrs = state.primaryModal.tag === "tokenAddrs";
  const isWatch = state.primaryModal.tag === "watch";
  const isMsg = state.primaryModal.tag === "message";

  ruleBackdrop.classList.toggle("open", isRule);
  ruleBackdrop.setAttribute("aria-hidden", String(!isRule));

  tokBackdrop.classList.toggle("open", isTok);
  tokBackdrop.setAttribute("aria-hidden", String(!isTok));

  tokAddrsBackdrop.classList.toggle("open", isTokAddrs);
  tokAddrsBackdrop.setAttribute("aria-hidden", String(!isTokAddrs));

  watchBackdrop.classList.toggle("open", isWatch);
  watchBackdrop.setAttribute("aria-hidden", String(!isWatch));

  msgBackdrop.classList.toggle("open", isMsg);
  msgBackdrop.setAttribute("aria-hidden", String(!isMsg));

  if (state.primaryModal.tag !== "token") {
    tokenDropdownListMemo = null;
  }
  if (state.primaryModal.tag !== "message" && renderedIframeMessageId !== null) {
    $<HTMLIFrameElement>("msg-modal-iframe").srcdoc = "";
    renderedIframeMessageId = null;
  }

  if (state.primaryModal.tag === "rule") {
    renderRuleModalContent(state, state.primaryModal.modal, actions);
  } else if (state.primaryModal.tag === "token") {
    renderTokenModalContent(state, state.primaryModal.modal, actions);
  } else if (state.primaryModal.tag === "tokenAddrs") {
    renderTokenAddrsModalContent(state, state.primaryModal.modal, actions);
  } else if (state.primaryModal.tag === "watch") {
    renderWatchModalContent(state.primaryModal.modal, syncSelects.watchTtl);
  } else if (state.primaryModal.tag === "message") {
    renderMessageModalContent(state.primaryModal.modal, actions);
  }
}

function renderTokenAddrsModalContent(
  state: AppState,
  modal: Extract<AppState["primaryModal"], { tag: "tokenAddrs" }>["modal"],
  actions: UiActions,
): void {
  $("tok-addrs-modal-title").textContent = `已授权邮箱 · ${modal.tokenName}`;
  setInputValueSafe($<HTMLInputElement>("tok-addrs-search"), modal.searchQuery);

  const q = modal.searchQuery.trim().toLowerCase();
  const filtered = q
    ? modal.addresses.filter((a) => a.toLowerCase().includes(q))
    : modal.addresses;

  $("tok-addrs-modal-count").textContent = q
    ? `${filtered.length} / ${modal.addresses.length}`
    : String(modal.addresses.length);
  $<HTMLButtonElement>("tok-addrs-copy-all").textContent = `复制全部 (${modal.addresses.length})`;
  $<HTMLButtonElement>("tok-addrs-copy-all").disabled =
    modal.addresses.length === 0;

  const rulesByAddr = new Map<string, ForwardRule>();
  if (state.rules.resource.status === "ready") {
    for (const r of state.rules.resource.data) {
      rulesByAddr.set(r.address, r);
    }
  }

  const listHost = $("tok-addrs-modal-list");
  listHost.innerHTML = "";
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mselect-empty";
    empty.textContent = q
      ? `没有匹配「${modal.searchQuery.trim()}」的授权邮箱`
      : "当前令牌尚未关联任何授权邮箱";
    listHost.appendChild(empty);
    return;
  }

  for (const addr of filtered) {
    const row = document.createElement("div");
    row.className = "tok-addrs-row";
    row.appendChild(createCopyableAddressEl(addr, "授权邮箱", actions));

    const rule = rulesByAddr.get(addr);
    const metaBadge = document.createElement("span");
    if (rule) {
      metaBadge.className = "badge badge-muted";
      metaBadge.textContent = summarizeRuleMeta(rule);
    } else {
      metaBadge.className = "badge badge-muted";
      metaBadge.textContent = "已授权";
    }
    row.appendChild(metaBadge);
    listHost.appendChild(row);
  }
}

function renderWatchModalContent(
  modal: Extract<AppState["primaryModal"], { tag: "watch" }>["modal"],
  watchTtlSync: (val: WatchTtlOption) => void,
): void {
  const submitting = modal.status === "submitting";
  const errEl = $("watch-form-error");
  if (modal.validationError) {
    errEl.hidden = false;
    errEl.innerHTML = `${ICONS.alert}<span>${escapeHtml(modal.validationError)}</span>`;
  } else {
    errEl.hidden = true;
  }

  const addrInput = $<HTMLInputElement>("watch-modal-addr");
  addrInput.disabled = submitting;
  $("watch-addr-group").classList.toggle("is-disabled", submitting);
  setInputValueSafe(addrInput, modal.draft.addressPrefix);

  watchTtlSync(modal.draft.ttlSeconds);

  const sendersInput = $<HTMLInputElement>("watch-modal-senders");
  sendersInput.disabled = submitting;
  setInputValueSafe(sendersInput, modal.draft.allowedSendersRaw);

  $<HTMLButtonElement>("watch-modal-close").disabled = submitting;
  $<HTMLButtonElement>("watch-modal-cancel").disabled = submitting;
  const saveBtn = $<HTMLButtonElement>("watch-modal-save");
  saveBtn.disabled = submitting;
  saveBtn.textContent = submitting ? "开启中…" : "开启监听";
}

function renderRuleModalContent(
  state: AppState,
  modal: Extract<AppState["primaryModal"], { tag: "rule" }>["modal"],
  actions: UiActions,
): void {
  const isTenant =
    state.auth.tag === "authenticated" &&
    state.auth.principal.role === "tenant";
  const submitting = modal.status === "submitting";

  $("modal-title").textContent =
    modal.mode.kind === "add" ? "新增转发规则" : "编辑转发规则";

  const errEl = $("modal-form-error");
  if (modal.validationError) {
    errEl.hidden = false;
    errEl.innerHTML = `${ICONS.alert}<span>${escapeHtml(modal.validationError)}</span>`;
  } else {
    errEl.hidden = true;
  }

  const addrInput = $<HTMLInputElement>("modal-addr");
  const addrLocked = isTenant || submitting;
  addrInput.disabled = addrLocked;
  $("modal-addr-group").classList.toggle("is-disabled", addrLocked);
  setInputValueSafe(addrInput, modal.draft.addressPrefix);

  const newTargetInput = $<HTMLInputElement>("modal-new-target");
  newTargetInput.disabled = submitting;
  setInputValueSafe(newTargetInput, modal.draft.newTargetInput);
  $<HTMLButtonElement>("modal-add-target").disabled = submitting;

  const inboxCheck = $<HTMLInputElement>("modal-inbox-enabled");
  inboxCheck.disabled = submitting;
  inboxCheck.checked = modal.draft.inboxEnabled;

  const sendersInput = $<HTMLInputElement>("modal-allowed-senders");
  sendersInput.disabled = submitting;
  setInputValueSafe(sendersInput, modal.draft.allowedSendersRaw);

  const targetList = $("modal-target-list");
  targetList.innerHTML = "";
  if (modal.draft.targets.length === 0) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.style.marginTop = "4px";
    hint.textContent = modal.draft.inboxEnabled
      ? "未添加转发目标：入站邮件将仅暂存至临时收件箱，不向外转发。"
      : "尚未添加转发目标邮箱（请添加至少一个目标邮箱，或开启下方临时收件箱）。";
    targetList.appendChild(hint);
  } else {
    modal.draft.targets.forEach((t, idx) => {
      const row = document.createElement("div");
      row.className = "target-row" + (t.enabled ? "" : " is-off");

      const swLabel = document.createElement("label");
      swLabel.className = "switch";
      swLabel.setAttribute(
        "aria-label",
        `${t.enabled ? "暂停" : "启用"}目标 ${t.address}`,
      );
      const sw = document.createElement("input");
      sw.type = "checkbox";
      sw.checked = t.enabled;
      sw.disabled = submitting;
      sw.onchange = () => actions.onRuleModalToggleTarget(idx, sw.checked);
      const slider = document.createElement("span");
      slider.className = "slider";
      swLabel.append(sw, slider);

      const addrSpan = document.createElement("span");
      addrSpan.className = "addr-text";
      addrSpan.textContent = t.address;
      addrSpan.title = t.address;

      row.append(swLabel, addrSpan);

      const vState = modal.verificationByAddr[t.address];
      if (vState) {
        if (vState.tag === "checking") {
          const b = document.createElement("span");
          b.className = "badge badge-muted";
          b.textContent = "检查中…";
          row.appendChild(b);
        } else if (vState.tag === "sending") {
          const b = document.createElement("span");
          b.className = "badge badge-warn";
          b.textContent =
            vState.prevStatus === "missing" ? "未添加" : "待验证";
          const vbtn = document.createElement("button");
          vbtn.type = "button";
          vbtn.className = "btn btn-secondary btn-sm";
          vbtn.disabled = true;
          vbtn.textContent = "发送中…";
          row.append(b, vbtn);
        } else if (vState.tag === "checked") {
          const labelMap = {
            verified: "已验证",
            pending: "待验证",
            missing: "未添加",
            unknown: "未知",
          } as const;
          const variantMap = {
            verified: "badge-ok",
            pending: "badge-warn",
            missing: "badge-danger",
            unknown: "badge-muted",
          } as const;
          const b = document.createElement("span");
          b.className = `badge ${variantMap[vState.status]}`;
          b.textContent = labelMap[vState.status];
          if (vState.message) b.title = vState.message;
          row.appendChild(b);

          if (vState.status === "pending" || vState.status === "missing") {
            const vbtn = document.createElement("button");
            vbtn.type = "button";
            vbtn.className = "btn btn-secondary btn-sm";
            vbtn.disabled = submitting;
            vbtn.textContent =
              vState.status === "pending" ? "重发验证" : "发送验证";
            vbtn.onclick = () => actions.onRuleModalSendVerify(t.address);
            row.appendChild(vbtn);
          }
        }
      }

      const rmBtn = document.createElement("button");
      rmBtn.type = "button";
      rmBtn.className = "btn btn-danger btn-sm";
      rmBtn.disabled = submitting;
      rmBtn.textContent = "移除";
      rmBtn.onclick = () => actions.onRuleModalRemoveTarget(idx);
      row.appendChild(rmBtn);

      targetList.appendChild(row);
    });
  }

  const keySection = $("modal-key-section");
  const keyContent = $("modal-key-content");
  const keyPanel = deriveRuleKeyPanel(modal);

  switch (keyPanel.kind) {
    case "hidden": {
      keySection.hidden = true;
      keyContent.innerHTML = "";
      break;
    }
    case "will_generate_on_save": {
      keySection.hidden = false;
      keyContent.innerHTML = `<p class="hint">保存规则后将自动签发专属 <code>cfmk_</code> 收件箱访问密钥。</p>`;
      break;
    }
    case "revoked_no_key": {
      keySection.hidden = false;
      keyContent.innerHTML = "";
      const row = document.createElement("div");
      row.className = "key-bar-row";
      const note = document.createElement("span");
      note.className = "hint";
      note.textContent =
        "当前专属密钥已吊销（保存时不会自动重签）；如需恢复用户访问可手动生成。";
      const genBtn = document.createElement("button");
      genBtn.type = "button";
      genBtn.className = "btn btn-secondary btn-sm";
      genBtn.disabled = submitting;
      genBtn.textContent = "生成新 Key";
      genBtn.onclick = actions.onRuleModalRotateKey;
      row.append(note, genBtn);
      keyContent.appendChild(row);
      break;
    }
    case "dormant_when_disabled": {
      keySection.hidden = false;
      keyContent.innerHTML = `<p class="hint">已关闭临时收件箱开关：保存后原专属密钥将暂停生效（重新开启可恢复）。</p>`;
      break;
    }
    case "active": {
      keySection.hidden = false;
      keyContent.innerHTML = "";
      const keyBusy = submitting || keyPanel.op !== "idle";
      const bar = document.createElement("div");
      bar.className = "key-bar-row";

      const codeEl = document.createElement("code");
      codeEl.className = "code-pill";
      codeEl.textContent = keyPanel.revealed
        ? keyPanel.key
        : maskSecret(keyPanel.key);

      const revBtn = document.createElement("button");
      revBtn.type = "button";
      revBtn.className = "btn btn-secondary btn-sm";
      revBtn.disabled = keyBusy;
      revBtn.textContent = keyPanel.revealed ? "隐藏" : "显示";
      revBtn.onclick = actions.onRuleModalToggleKeyReveal;

      const cpKey = document.createElement("button");
      cpKey.type = "button";
      cpKey.className = "btn btn-secondary btn-sm";
      cpKey.disabled = keyBusy;
      cpKey.textContent = "复制 Key";
      cpKey.onclick = () =>
        actions.onCopy(keyPanel.key, "已复制专属收件箱 Key");

      const cpLink = document.createElement("button");
      cpLink.type = "button";
      cpLink.className = "btn btn-secondary btn-sm";
      cpLink.disabled = keyBusy;
      cpLink.textContent = "复制直达链接";
      cpLink.onclick = () =>
        actions.onCopy(buildQuickLink(keyPanel.key), "已复制用户直达链接");

      const cpCurl = document.createElement("button");
      cpCurl.type = "button";
      cpCurl.className = "btn btn-secondary btn-sm";
      cpCurl.disabled = keyBusy;
      cpCurl.textContent = "复制 curl";
      cpCurl.onclick = () =>
        actions.onCopy(buildPollCurl(keyPanel.key), "已复制轮询 curl 命令");

      const rotBtn = document.createElement("button");
      rotBtn.type = "button";
      rotBtn.className = "btn btn-secondary btn-sm";
      rotBtn.disabled = keyBusy;
      rotBtn.textContent =
        keyPanel.op === "rotating" ? "重置中…" : "重置 Key";
      rotBtn.onclick = actions.onRuleModalRotateKey;

      const revokeBtn = document.createElement("button");
      revokeBtn.type = "button";
      revokeBtn.className = "btn btn-danger btn-sm";
      revokeBtn.disabled = keyBusy;
      revokeBtn.textContent =
        keyPanel.op === "revoking" ? "吊销中…" : "吊销 Key";
      revokeBtn.onclick = actions.onRuleModalRevokeKey;

      bar.append(codeEl, revBtn, cpKey, cpLink, cpCurl, rotBtn, revokeBtn);
      keyContent.appendChild(bar);
      break;
    }
    default:
      assertNever(keyPanel);
  }

  $<HTMLButtonElement>("modal-close").disabled = submitting;
  $<HTMLButtonElement>("modal-cancel").disabled = submitting;
  const saveBtn = $<HTMLButtonElement>("modal-save");
  saveBtn.disabled = submitting;
  saveBtn.textContent = submitting
    ? "保存中…"
    : modal.mode.kind === "add"
      ? "添加规则"
      : "保存修改";
}

function renderTokenModalContent(
  state: AppState,
  modal: Extract<AppState["primaryModal"], { tag: "token" }>["modal"],
  actions: UiActions,
): void {
  const submitting = modal.status === "submitting";
  $("tok-modal-title").textContent =
    modal.mode.kind === "add" ? "新增访问令牌" : "编辑访问令牌";

  const errEl = $("tok-form-error");
  if (modal.validationError) {
    errEl.hidden = false;
    errEl.innerHTML = `${ICONS.alert}<span>${escapeHtml(modal.validationError)}</span>`;
  } else {
    errEl.hidden = true;
  }

  const nameInput = $<HTMLInputElement>("tok-modal-name");
  nameInput.disabled = submitting;
  setInputValueSafe(nameInput, modal.draft.name);

  const enabledCheck = $<HTMLInputElement>("tok-modal-enabled");
  enabledCheck.disabled = submitting;
  enabledCheck.checked = modal.draft.enabled;

  const expInput = $<HTMLInputElement>("tok-modal-expires");
  expInput.disabled = submitting;
  setInputValueSafe(expInput, modal.draft.expiresLocalIso);
  $<HTMLButtonElement>("tok-modal-clear-expires").disabled = submitting;

  // Filterable & Creatable Multi-Select Combobox (#tok-addr-mselect)
  const ddModel = selectTokenDropdownModel(state);
  const isOpen = modal.dropdown.open && !submitting;
  const mselectRoot = $("tok-addr-mselect");
  const triggerEl = $("tok-mselect-trigger");
  const popoverEl = $("tok-mselect-popover");
  const tagsHost = $("tok-mselect-tags");
  const countBadge = $("tok-mselect-count");
  const searchInput = $<HTMLInputElement>("tok-mselect-search");
  const listHost = $("tok-mselect-list");
  const summaryEl = $("tok-mselect-summary");
  const selectAllBtn = $<HTMLButtonElement>("tok-mselect-select-all");
  const clearBtn = $<HTMLButtonElement>("tok-mselect-clear");

  mselectRoot.classList.toggle("open", isOpen);
  mselectRoot.classList.toggle("is-disabled", submitting);
  popoverEl.hidden = !isOpen;
  triggerEl.setAttribute("aria-expanded", String(isOpen));
  triggerEl.tabIndex = submitting ? -1 : 0;

  // Render compact single-line selected mailbox tags inside trigger (overflow collapses to "... +N")
  tagsHost.innerHTML = "";
  const selectedAddrs = modal.draft.addresses;
  if (selectedAddrs.length === 0) {
    const ph = document.createElement("span");
    ph.className = "mselect-placeholder";
    ph.textContent = "点击选择或搜索授权邮箱…";
    tagsHost.appendChild(ph);
    countBadge.hidden = true;
  } else {
    const MAX_TRIGGER_TAGS = 2;
    countBadge.hidden = false;
    countBadge.textContent = String(selectedAddrs.length);
    for (const addr of selectedAddrs.slice(0, MAX_TRIGGER_TAGS)) {
      const isNew =
        ddModel.knownRuleSet !== null && !ddModel.knownRuleSet.has(addr);
      const tag = document.createElement("span");
      tag.className = "mselect-tag" + (isNew ? " is-new" : "");
      tag.title = isNew ? `${addr}（保存时新建空规则）` : addr;

      const txt = document.createElement("span");
      txt.className = "mselect-tag-text";
      txt.textContent = addr;

      const rmBtn = document.createElement("button");
      rmBtn.type = "button";
      rmBtn.className = "mselect-tag-rm";
      rmBtn.disabled = submitting;
      rmBtn.setAttribute("aria-label", `移除授权邮箱 ${addr}`);
      rmBtn.innerHTML = ICONS.close;
      rmBtn.onclick = (e) => {
        e.stopPropagation();
        actions.onTokenModalRemoveAddr(addr);
      };

      tag.append(txt, rmBtn);
      tagsHost.appendChild(tag);
    }
    if (selectedAddrs.length > MAX_TRIGGER_TAGS) {
      const moreSpan = document.createElement("span");
      moreSpan.className = "mselect-more-tag";
      moreSpan.title = `共已选 ${selectedAddrs.length} 个邮箱，点击展开查看或管理`;
      moreSpan.textContent = `... +${selectedAddrs.length - MAX_TRIGGER_TAGS}`;
      tagsHost.appendChild(moreSpan);
    }
  }

  // Sync IME-safe filter input & listbox options (patch in place to preserve scroll & prevent DOM thrash on click/hover)
  searchInput.disabled = submitting;
  setInputValueSafe(searchInput, modal.dropdown.filterQuery);

  if (!isOpen) {
    tokenDropdownListMemo = null;
  }

  if (ddModel.options.length === 0) {
    tokenDropdownListMemo = null;
    listHost.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "mselect-empty";
    empty.textContent =
      state.rules.resource.status !== "ready"
        ? "规则列表加载中，可直接输入新邮箱前缀回车创建…"
        : modal.dropdown.filterQuery.trim()
          ? "未匹配到已有规则；输入合法邮箱前缀可直接新建并授权"
          : "暂无已有转发规则，在上方输入新邮箱前缀即可创建并授权";
    listHost.appendChild(empty);
    searchInput.removeAttribute("aria-activedescendant");
  } else {
    const structureKey = ddModel.options
      .map((opt) =>
        opt.kind === "create"
          ? `create:${opt.label}`
          : `${opt.kind}:${opt.address}:${opt.metaLabel}`,
      )
      .join("\n");

    const canPatchInPlace =
      tokenDropdownListMemo !== null &&
      tokenDropdownListMemo.structureKey === structureKey &&
      listHost.children.length === ddModel.options.length;

    if (canPatchInPlace) {
      ddModel.options.forEach((opt, idx) => {
        const row = listHost.children[idx] as HTMLElement | undefined;
        if (!row) return;
        const isActive = isOpen && idx === ddModel.activeIndex;
        if (opt.kind === "create") {
          row.classList.toggle("is-active", isActive);
        } else {
          row.classList.toggle("is-selected", opt.selected);
          row.classList.toggle("is-active", isActive);
          row.setAttribute("aria-selected", String(opt.selected));
        }
      });
    } else {
      const keepScroll =
        tokenDropdownListMemo !== null &&
        tokenDropdownListMemo.filterQuery === modal.dropdown.filterQuery;
      const prevScrollTop = keepScroll ? listHost.scrollTop : 0;

      listHost.innerHTML = "";
      ddModel.options.forEach((opt, idx) => {
        const row = document.createElement("div");
        const isActive = isOpen && idx === ddModel.activeIndex;
        const optId = `tok-mselect-opt-${idx}`;
        row.id = optId;
        row.dataset.idx = String(idx);
        row.setAttribute("role", "option");

        if (opt.kind === "create") {
          row.className =
            "mselect-option is-create" + (isActive ? " is-active" : "");
          row.setAttribute("aria-selected", "false");
          row.innerHTML = `
            <span class="mselect-option-left">
              <span class="mselect-create-plus" aria-hidden="true">${ICONS.plus}</span>
              <span class="mselect-option-addr">新建并授权 ${escapeHtml(opt.label)}</span>
            </span>
            <span class="mselect-option-meta">保存时初始化空规则</span>
          `;
        } else {
          row.className =
            "mselect-option" +
            (opt.selected ? " is-selected" : "") +
            (isActive ? " is-active" : "");
          row.setAttribute("aria-selected", String(opt.selected));
          row.innerHTML = `
            <span class="mselect-option-left">
              <span class="mselect-check-box" aria-hidden="true">${ICONS.checkInline}</span>
              <span class="mselect-option-addr">${escapeHtml(opt.address)}</span>
            </span>
            <span class="mselect-option-meta">${escapeHtml(opt.metaLabel)}</span>
          `;
        }

        listHost.appendChild(row);
      });

      listHost.scrollTop = prevScrollTop;
      if (isOpen) {
        tokenDropdownListMemo = {
          structureKey,
          filterQuery: modal.dropdown.filterQuery,
        };
      }
    }

    if (isOpen && ddModel.activeIndex >= 0) {
      searchInput.setAttribute(
        "aria-activedescendant",
        `tok-mselect-opt-${ddModel.activeIndex}`,
      );
    } else {
      searchInput.removeAttribute("aria-activedescendant");
    }
  }

  const hasFilter = modal.dropdown.filterQuery.trim().length > 0;
  summaryEl.textContent = hasFilter
    ? `匹配 ${ddModel.filteredSelectableAddresses.length} / ${ddModel.totalAvailable} 条 · 已选 ${selectedAddrs.length}`
    : `共 ${ddModel.totalAvailable} 条可选 · 已选 ${selectedAddrs.length}`;
  selectAllBtn.textContent = hasFilter ? "全选筛选" : "全选全部";
  selectAllBtn.disabled =
    submitting ||
    ddModel.filteredSelectableAddresses.length === 0 ||
    ddModel.allFilteredSelected;
  clearBtn.disabled = submitting || selectedAddrs.length === 0;

  $<HTMLButtonElement>("tok-modal-close").disabled = submitting;
  $<HTMLButtonElement>("tok-modal-cancel").disabled = submitting;
  const saveBtn = $<HTMLButtonElement>("tok-modal-save");
  saveBtn.disabled = submitting;
  saveBtn.textContent = submitting
    ? "保存中…"
    : modal.mode.kind === "add"
      ? "创建令牌"
      : "保存修改";
}

function renderMessageModalContent(
  modal: Extract<AppState["primaryModal"], { tag: "message" }>["modal"],
  actions: UiActions,
): void {
  const m = modal.snapshot;
  $("msg-modal-title").textContent = m.subject || "(无主题)";
  $("msg-modal-meta").innerHTML = `
    <span class="msg-meta-key">发件人</span>
    <span class="msg-meta-val">${escapeHtml(m.from)}</span>
    <span class="msg-meta-key">收件人</span>
    <span class="msg-meta-val">${escapeHtml(m.to)}</span>
    <span class="msg-meta-key">到达时间</span>
    <span class="msg-meta-val tabular">${escapeHtml(formatTimestamp(m.ts))}</span>
  `;

  const codesBox = $("msg-modal-codes");
  if (Array.isArray(m.codes) && m.codes.length > 0) {
    codesBox.hidden = false;
    codesBox.innerHTML = `<span class="field-label">验证码</span>`;
    const bar = document.createElement("div");
    bar.className = "extracted-bar";
    for (const c of m.codes) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "otp-btn";
      btn.innerHTML = `${ICONS.copy}<span>复制验证码</span><span class="otp-code">${escapeHtml(
        c,
      )}</span>`;
      btn.onclick = () => actions.onCopy(c, `已复制验证码 ${c}`);
      bar.appendChild(btn);
    }
    codesBox.appendChild(bar);
  } else {
    codesBox.hidden = true;
    codesBox.innerHTML = "";
  }

  const hasHtml = Boolean(m.html && m.html.trim().length > 0);
  const showHtml = hasHtml && modal.viewMode === "html";

  const viewTabs = $("msg-modal-view-tabs");
  viewTabs.hidden = !hasHtml;
  const htmlBtn = $<HTMLButtonElement>("msg-view-html");
  const textBtn = $<HTMLButtonElement>("msg-view-text");
  htmlBtn.classList.toggle("is-active", showHtml);
  htmlBtn.setAttribute("aria-pressed", String(showHtml));
  textBtn.classList.toggle("is-active", !showHtml);
  textBtn.setAttribute("aria-pressed", String(!showHtml));

  $("msg-modal-body-label").textContent =
    hasHtml && !showHtml ? "纯文本正文" : "邮件内容";

  const htmlWrap = $("msg-modal-html-wrap");
  const iframe = $<HTMLIFrameElement>("msg-modal-iframe");
  const plainBody = $("msg-modal-body");

  if (showHtml) {
    htmlWrap.hidden = false;
    plainBody.hidden = true;
    if (renderedIframeMessageId !== m.id) {
      iframe.srcdoc = buildEmailPreviewSrcdoc(m.html!);
      renderedIframeMessageId = m.id;
    }
  } else {
    htmlWrap.hidden = true;
    plainBody.hidden = false;
    renderPlainTextWithLinks(plainBody, m.text || "");
  }
}

function renderConfirmModal(confirm: AppState["confirmDialog"]): void {
  const backdrop = $("confirm-modal");
  const isOpen = confirm.tag === "open";
  backdrop.classList.toggle("open", isOpen);
  backdrop.setAttribute("aria-hidden", String(!isOpen));

  if (confirm.tag !== "open") return;
  const executing = confirm.status === "executing";
  $("confirm-title").textContent = confirm.title;
  $("confirm-message").textContent = confirm.message;

  const cancelBtn = $<HTMLButtonElement>("confirm-cancel");
  cancelBtn.textContent = confirm.cancelText;
  cancelBtn.disabled = executing;

  const okBtn = $<HTMLButtonElement>("confirm-ok");
  okBtn.className = confirm.danger ? "btn btn-danger-solid" : "btn";
  okBtn.disabled = executing;
  okBtn.textContent = executing ? "处理中…" : confirm.confirmText;
}

function renderToast(toast: AppState["toast"]): void {
  const el = $("toast");
  if (toast.tag === "hidden") {
    el.className = "toast";
    return;
  }
  const toneCls =
    toast.tone === "error"
      ? " toast-error"
      : toast.tone === "ok"
        ? " toast-ok"
        : "";
  el.textContent = toast.message;
  el.className = `toast show${toneCls}`;
}
