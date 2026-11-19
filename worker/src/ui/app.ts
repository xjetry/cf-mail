import { ApiClientError, RequestCoordinator, requestJson } from "./effects.ts";
import { ICONS } from "./icons.ts";
import {
  bindSafeBackdropDismiss,
  closeAllSelects,
  copyTextSafe,
  createCustomSelect,
  ModalFocusStack,
  safeStorage,
} from "./primitives.ts";
import {
  $,
  buildPollCurl,
  buildQuickLink,
  mountStaticIcons,
  renderApp,
  type SelectSyncCallbacks,
  type UiActions,
} from "./render.ts";
import {
  buildValidatedRuleSave,
  createInitialAppState,
  detectRuleCollision,
  getAllowedTabsForRole,
  isValidEmailAddress,
  normalizePrefixInput,
  reduceAppState,
  selectLogsTableModel,
  selectRulesTableModel,
  selectTokenDropdownModel,
  type AppEvent,
} from "./state.ts";
import type {
  AppState,
  DeliveryLogEntry,
  DestinationStatus,
  ForwardRule,
  InboxMessage,
  LogStatusFilter,
  SessionPrincipal,
  TenantToken,
  ThemeMode,
  ToastTone,
  WatchSlot,
  WatchTtlOption,
  WorkspaceTab,
} from "./types.ts";

/* ==========================================================================
   URL Credential Bootstrap (Tab-Scoped Without Premature Unverified Storage)
   ========================================================================== */
function extractBootstrapCredential(): {
  credential: string;
  source: "url" | "storage";
} {
  const params = new URLSearchParams(location.search);
  const urlCred = (params.get("key") ?? params.get("token") ?? "").trim();
  if (urlCred) {
    const cleanUrl = location.pathname + location.hash;
    history.replaceState(null, "", cleanUrl);
    return { credential: urlCred, source: "url" };
  }
  const stored =
    safeStorage.getSession("cfm_session_token") ||
    safeStorage.getLocal("cfm_token") ||
    "";
  return { credential: stored.trim(), source: "storage" };
}

function readHashTab(): string | null {
  const h = location.hash.replace(/^#/, "").trim().toLowerCase();
  return h || null;
}

/* ==========================================================================
   Main Application Bootstrap
   ========================================================================== */
function initApp(): void {
  mountStaticIcons();

  const bootCred = extractBootstrapCredential();
  const initialThemeRaw = safeStorage.getLocal("cfm_theme");
  const initialTheme: ThemeMode =
    initialThemeRaw === "light" ||
    initialThemeRaw === "dark" ||
    initialThemeRaw === "system"
      ? initialThemeRaw
      : "system";

  let state: AppState = createInitialAppState({
    theme: initialTheme,
    initialCredential: bootCred.credential,
    credentialSource: bootCred.source,
  });

  const coordinator = new RequestCoordinator();
  const focusStack = new ModalFocusStack();
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let inboxFilterDebounce: ReturnType<typeof setTimeout> | null = null;

  let confirmHandler:
    | { kind: "action"; run: () => Promise<void> }
    | { kind: "decision"; resolve: (ok: boolean) => void }
    | null = null;

  /* ---------------- Theme Synchronization ---------------- */
  const systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  function resolveEffectiveTheme(mode: ThemeMode): "light" | "dark" {
    if (mode === "light" || mode === "dark") return mode;
    return systemDarkQuery.matches ? "dark" : "light";
  }

  const THEME_OPTIONS = [
    { value: "system" as const, label: "跟随系统", icon: ICONS.system },
    { value: "light" as const, label: "浅色外观", icon: ICONS.sun },
    { value: "dark" as const, label: "深色外观", icon: ICONS.moon },
  ];

  const gateThemeSelect = createCustomSelect<ThemeMode>(
    $("gate-theme-select"),
    {
      options: THEME_OPTIONS,
      value: state.theme,
      ariaLabel: "切换界面外观主题",
      size: "md",
      direction: "down",
      onChange: (val) => setTheme(val),
    },
  );

  const headerThemeSelect = createCustomSelect<ThemeMode>(
    $("header-theme-select"),
    {
      options: THEME_OPTIONS,
      value: state.theme,
      ariaLabel: "切换界面外观主题",
      size: "md",
      direction: "down",
      onChange: (val) => setTheme(val),
    },
  );

  function syncThemeDom(mode: ThemeMode): void {
    const effective = resolveEffectiveTheme(mode);
    document.documentElement.setAttribute("data-theme", effective);
    document.documentElement.setAttribute("data-theme-mode", mode);
    gateThemeSelect.setValue(mode, false);
    headerThemeSelect.setValue(mode, false);
  }

  function setTheme(mode: ThemeMode): void {
    safeStorage.setLocal("cfm_theme", mode);
    dispatch({ type: "THEME_SET", theme: mode });
    syncThemeDom(mode);
  }

  systemDarkQuery.addEventListener("change", () => {
    if (state.theme === "system") {
      syncThemeDom("system");
    }
  });
  syncThemeDom(state.theme);

  /* ---------------- Custom Selects in Toolbars, Pagination & Watch Modal ---------------- */
  const pageSizeSelect = createCustomSelect<10 | 20 | 50>(
    $("page-size-select"),
    {
      options: [
        { value: 10, label: "10 条" },
        { value: 20, label: "20 条" },
        { value: 50, label: "50 条" },
      ],
      value: 10,
      ariaLabel: "每页显示规则条数",
      size: "sm",
      direction: "up",
      onChange: (val) =>
        dispatch({ type: "RULES_PAGE_SIZE_SET", pageSize: val }),
    },
  );

  const logsPageSizeSelect = createCustomSelect<10 | 20 | 50>(
    $("logs-page-size-select"),
    {
      options: [
        { value: 10, label: "10 条" },
        { value: 20, label: "20 条" },
        { value: 50, label: "50 条" },
      ],
      value: 10,
      ariaLabel: "每页显示日志条数",
      size: "sm",
      direction: "up",
      onChange: (val) =>
        dispatch({ type: "LOGS_PAGE_SIZE_SET", pageSize: val }),
    },
  );

  const logStatusSelect = createCustomSelect<LogStatusFilter>(
    $("log-status-select"),
    {
      options: [
        { value: "all", label: "全部状态" },
        { value: "delivered", label: "已转发" },
        { value: "inbox", label: "已存入收件箱" },
        { value: "warning", label: "部分投递异常" },
        { value: "rejected", label: "已拒收" },
      ],
      value: "all",
      ariaLabel: "筛选投递结果状态",
      size: "md",
      direction: "down",
      onChange: (val) =>
        dispatch({ type: "LOGS_STATUS_FILTER_SET", filter: val }),
    },
  );

  const watchTtlSelect = createCustomSelect<WatchTtlOption>(
    $("watch-ttl-select"),
    {
      options: [
        { value: 600, label: "10 分钟" },
        { value: 1800, label: "30 分钟（默认）" },
        { value: 3600, label: "1 小时" },
        { value: 21600, label: "6 小时" },
        { value: 86400, label: "24 小时" },
      ],
      value: 1800,
      ariaLabel: "选择临时监听保留时长",
      size: "md",
      direction: "down",
      onChange: (val) =>
        dispatch({
          type: "WATCH_MODAL_DRAFT_PATCH",
          patch: { ttlSeconds: val },
        }),
    },
  );

  const selectSyncCallbacks: SelectSyncCallbacks = {
    pageSize: (sz) => pageSizeSelect.setValue(sz, false),
    logsPageSize: (sz) => logsPageSizeSelect.setValue(sz, false),
    logStatus: (flt) => logStatusSelect.setValue(flt, false),
    watchTtl: (ttl) => watchTtlSelect.setValue(ttl, false),
  };

  /* ---------------- Central State Dispatcher & Focus Sync ---------------- */
  const BACKDROP_BY_MODAL_TAG: Record<
    Exclude<AppState["primaryModal"]["tag"], "none">,
    string
  > = {
    rule: "rule-modal",
    token: "token-modal",
    tokenAddrs: "tok-addrs-modal",
    watch: "watch-modal",
    message: "msg-modal",
  };

  function dispatch(event: AppEvent): void {
    const prevAuthTag = state.auth.tag;
    const prevModalTag = state.primaryModal.tag;
    const prevTokDropdownOpen =
      state.primaryModal.tag === "token" &&
      state.primaryModal.modal.dropdown.open;
    const prevConfirmOpen = state.confirmDialog.tag === "open";
    const activeBeforeRender =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    state = reduceAppState(state, event);

    renderApp(state, uiActions, selectSyncCallbacks);

    if (prevAuthTag === "authenticated" && state.auth.tag !== "authenticated") {
      focusStack.closeAll();
      closeAllSelects();
      queueMicrotask(() => $("token").focus());
      return;
    }

    const nowTokDropdownOpen =
      state.primaryModal.tag === "token" &&
      state.primaryModal.modal.dropdown.open;
    if (!prevTokDropdownOpen && nowTokDropdownOpen) {
      queueMicrotask(() => {
        const inp = $("tok-mselect-search");
        void inp.offsetWidth;
        inp.focus();
      });
    }

    if (prevModalTag !== state.primaryModal.tag) {
      if (prevModalTag !== "none") {
        focusStack.onClose(BACKDROP_BY_MODAL_TAG[prevModalTag]);
      }
      if (state.primaryModal.tag === "rule") {
        const isTenant =
          state.auth.tag === "authenticated" &&
          state.auth.principal.role === "tenant";
        focusStack.onOpen(
          "rule-modal",
          isTenant ? $("modal-new-target") : $("modal-addr"),
          activeBeforeRender,
        );
      } else if (state.primaryModal.tag === "token") {
        focusStack.onOpen(
          "token-modal",
          $("tok-modal-name"),
          activeBeforeRender,
        );
      } else if (state.primaryModal.tag === "tokenAddrs") {
        focusStack.onOpen(
          "tok-addrs-modal",
          $("tok-addrs-search"),
          activeBeforeRender,
        );
      } else if (state.primaryModal.tag === "watch") {
        focusStack.onOpen(
          "watch-modal",
          $("watch-modal-addr"),
          activeBeforeRender,
        );
      } else if (state.primaryModal.tag === "message") {
        focusStack.onOpen(
          "msg-modal",
          $("msg-modal-close"),
          activeBeforeRender,
        );
      }
    }

    const nowConfirmOpen = state.confirmDialog.tag === "open";
    if (
      !prevConfirmOpen &&
      nowConfirmOpen &&
      state.confirmDialog.tag === "open"
    ) {
      focusStack.onOpen(
        "confirm-modal",
        state.confirmDialog.danger ? $("confirm-cancel") : $("confirm-ok"),
        activeBeforeRender,
      );
    } else if (prevConfirmOpen && !nowConfirmOpen) {
      focusStack.onClose("confirm-modal");
    }
  }

  /* ---------------- Toast & Clipboard Helpers ---------------- */
  function showToast(
    message: string,
    tone: ToastTone = "neutral",
    durationMs = 2800,
  ): void {
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    dispatch({ type: "TOAST_SHOW", message, tone });
    if (state.toast.tag === "visible") {
      const activeId = state.toast.id;
      toastTimer = setTimeout(() => {
        toastTimer = null;
        dispatch({ type: "TOAST_HIDE", id: activeId });
      }, durationMs);
    }
  }

  async function handleCopy(
    text: string,
    successMessage: string,
  ): Promise<void> {
    const ok = await copyTextSafe(text);
    if (ok) {
      showToast(successMessage, "ok");
    } else {
      showToast("浏览器限制了自动复制，请手动选择复制", "error", 4000);
    }
  }

  /* ---------------- Confirm Dialog Orchestration ---------------- */
  function openAsyncConfirm(opts: {
    title: string;
    message: string;
    confirmText: string;
    cancelText?: string;
    danger?: boolean;
    run: () => Promise<void>;
  }): void {
    if (state.confirmDialog.tag === "open") return;
    confirmHandler = { kind: "action", run: opts.run };
    dispatch({
      type: "CONFIRM_OPEN",
      title: opts.title,
      message: opts.message,
      confirmText: opts.confirmText,
      cancelText: opts.cancelText ?? "取消",
      danger: opts.danger ?? true,
    });
  }

  function askConfirmDecision(opts: {
    title: string;
    message: string;
    confirmText: string;
    cancelText?: string;
    danger?: boolean;
  }): Promise<boolean> {
    if (state.confirmDialog.tag === "open") return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      confirmHandler = { kind: "decision", resolve };
      dispatch({
        type: "CONFIRM_OPEN",
        title: opts.title,
        message: opts.message,
        confirmText: opts.confirmText,
        cancelText: opts.cancelText ?? "取消",
        danger: opts.danger ?? false,
      });
    });
  }

  async function onConfirmOkClick(): Promise<void> {
    if (
      state.confirmDialog.tag !== "open" ||
      state.confirmDialog.status === "executing" ||
      !confirmHandler
    ) {
      return;
    }
    const instId = state.confirmDialog.instanceId;
    const handler = confirmHandler;

    if (handler.kind === "decision") {
      confirmHandler = null;
      dispatch({ type: "CONFIRM_CLOSE", instanceId: instId });
      handler.resolve(true);
      return;
    }

    dispatch({ type: "CONFIRM_EXEC_START", instanceId: instId });
    try {
      await handler.run();
    } finally {
      if (confirmHandler === handler) confirmHandler = null;
      dispatch({ type: "CONFIRM_CLOSE", instanceId: instId });
    }
  }

  function onConfirmCancel(): void {
    if (
      state.confirmDialog.tag !== "open" ||
      state.confirmDialog.status === "executing"
    ) {
      return;
    }
    const instId = state.confirmDialog.instanceId;
    const handler = confirmHandler;
    confirmHandler = null;
    dispatch({ type: "CONFIRM_CLOSE", instanceId: instId });
    if (handler?.kind === "decision") {
      handler.resolve(false);
    }
  }

  /* ---------------- Authenticated HTTP Wrapper ---------------- */
  function handleGlobal401(info: {
    epoch: number;
    usedCredential: string;
  }): void {
    const prevEpoch = state.auth.epoch;
    dispatch({
      type: "HTTP_401_RECEIVED",
      epoch: info.epoch,
      usedCredential: info.usedCredential,
    });
    if (state.auth.tag === "unauthenticated" && state.auth.epoch !== prevEpoch) {
      coordinator.resetSession();
      purgeStoredCredential(info.usedCredential);
    }
  }

  function purgeStoredCredential(deadCred: string): void {
    if (safeStorage.getSession("cfm_session_token") === deadCred) {
      safeStorage.removeSession("cfm_session_token");
    }
    if (safeStorage.getLocal("cfm_token") === deadCred) {
      safeStorage.removeLocal("cfm_token");
    }
  }

  async function authedApi<T>(
    path: string,
    opts?: { method?: string; body?: unknown; signal?: AbortSignal },
  ): Promise<T> {
    if (state.auth.tag !== "authenticated") {
      throw new ApiClientError({ message: "未登录", status: 401 });
    }
    const credential = state.auth.principal.credential;
    const epoch = state.auth.epoch;
    return await requestJson<T>(path, {
      credential,
      epoch,
      method: opts?.method,
      body: opts?.body,
      signal: opts?.signal ?? coordinator.sessionSignal,
      onUnauthorized: handleGlobal401,
    });
  }

  /* ---------------- Session Verification & Login ---------------- */
  interface SessionApiPayload {
    role: "admin" | "tenant" | "user";
    domain: string;
    token?: {
      id: string;
      name: string;
      addresses: string[];
      expiresAt?: number;
    };
    address?: string;
  }

  function toPrincipal(
    sess: SessionApiPayload,
    credential: string,
  ): SessionPrincipal {
    if (sess.role === "admin") {
      return { role: "admin", domain: sess.domain, credential };
    }
    if (sess.role === "tenant") {
      return {
        role: "tenant",
        domain: sess.domain,
        credential,
        tokenMeta: {
          id: sess.token?.id ?? "",
          name: sess.token?.name ?? "租户",
          addresses: sess.token?.addresses ?? [],
          expiresAt: sess.token?.expiresAt,
        },
      };
    }
    return {
      role: "user",
      domain: sess.domain,
      credential,
      address: sess.address ?? "",
      keyRotation: "idle",
      apiDrawerOpen: false,
      secretRevealed: false,
    };
  }

  async function verifyBootSession(
    credential: string,
    source: "url" | "storage",
    epoch: number,
  ): Promise<void> {
    try {
      const sess = await requestJson<SessionApiPayload>("/api/session", {
        credential,
        epoch,
        signal: coordinator.sessionSignal,
      });
      if (state.auth.tag !== "booting" || state.auth.epoch !== epoch) return;

      if (source === "url") {
        safeStorage.setSession("cfm_session_token", credential);
        if (!safeStorage.getLocal("cfm_token")) {
          safeStorage.setLocal("cfm_token", credential);
        }
      }
      const principal = toPrincipal(sess, credential);
      dispatch({
        type: "BOOT_VERIFY_OK",
        epoch,
        principal,
        preferredTab: readHashTab(),
      });
      await loadWorkspaceData(false);
    } catch (err) {
      if (err instanceof ApiClientError && err.isAborted) return;
      if (err instanceof ApiClientError && err.status === 401) {
        purgeStoredCredential(credential);
        dispatch({ type: "BOOT_VERIFY_FAIL", epoch, reason: "unauthorized" });
      } else {
        dispatch({
          type: "BOOT_VERIFY_FAIL",
          epoch,
          reason: "network",
          message: err instanceof Error ? err.message : undefined,
        });
      }
    }
  }

  async function submitManualLogin(): Promise<void> {
    const raw = $<HTMLInputElement>("token").value;
    coordinator.resetSession();
    dispatch({ type: "LOGIN_SUBMIT", rawCredential: raw });
    if (
      state.auth.tag !== "unauthenticated" ||
      state.auth.login.status !== "submitting"
    ) {
      return;
    }
    const { epoch } = state.auth;
    const credential = state.auth.login.credential;

    try {
      const sess = await requestJson<SessionApiPayload>("/api/session", {
        credential,
        epoch,
        signal: coordinator.sessionSignal,
      });
      if (state.auth.epoch !== epoch) return;

      safeStorage.removeSession("cfm_session_token");
      safeStorage.setLocal("cfm_token", credential);
      $<HTMLInputElement>("token").value = "";

      const principal = toPrincipal(sess, credential);
      dispatch({
        type: "LOGIN_OK",
        epoch,
        principal,
        preferredTab: readHashTab(),
      });
      showToast("已通过凭证验证", "ok");
      await loadWorkspaceData(false);
    } catch (err) {
      if (err instanceof ApiClientError && err.isAborted) return;
      if (err instanceof ApiClientError && err.status === 401) {
        dispatch({
          type: "LOGIN_FAIL",
          epoch,
          error: {
            kind: "invalid_credential",
            message: "访问凭证无效、已暂停或已过期",
          },
        });
      } else {
        dispatch({
          type: "LOGIN_FAIL",
          epoch,
          error: {
            kind: "network_or_server",
            message:
              err instanceof Error
                ? err.message
                : "连接服务器失败，请稍后重试",
          },
        });
      }
    }
  }

  function logout(): void {
    const activeCred =
      state.auth.tag === "authenticated"
        ? state.auth.principal.credential
        : "";
    const hadSessionOnly = Boolean(safeStorage.getSession("cfm_session_token"));
    safeStorage.removeSession("cfm_session_token");
    if (!hadSessionOnly || safeStorage.getLocal("cfm_token") === activeCred) {
      safeStorage.removeLocal("cfm_token");
    }
    coordinator.resetSession();
    if (location.hash) {
      history.replaceState(null, "", location.pathname + location.search);
    }
    dispatch({ type: "LOGOUT" });
  }

  /* ---------------- Sequenced Slice Data Loaders & Cursor Pagination ---------------- */
  async function loadRules(): Promise<boolean> {
    if (
      state.auth.tag !== "authenticated" ||
      (state.auth.principal.role !== "admin" &&
        state.auth.principal.role !== "tenant")
    ) {
      return true;
    }
    const { requestId, signal } = coordinator.startChannel("rules");
    dispatch({ type: "RULES_LOAD_START", requestId });
    try {
      const data = await authedApi<{ domain?: string; rules?: ForwardRule[] }>(
        "/admin/api/rules",
        { signal },
      );
      dispatch({
        type: "RULES_LOAD_OK",
        requestId,
        domain: data.domain,
        rules: data.rules ?? [],
      });
      return true;
    } catch (err) {
      if (err instanceof ApiClientError && err.isAborted) return true;
      dispatch({
        type: "RULES_LOAD_ERR",
        requestId,
        error: err instanceof Error ? err.message : "加载转发规则失败",
      });
      return false;
    }
  }

  async function loadTokens(): Promise<boolean> {
    if (
      state.auth.tag !== "authenticated" ||
      state.auth.principal.role !== "admin"
    ) {
      return true;
    }
    const { requestId, signal } = coordinator.startChannel("tokens");
    dispatch({ type: "TOKENS_LOAD_START", requestId });
    try {
      const data = await authedApi<{ tokens?: TenantToken[] }>(
        "/admin/api/tokens",
        { signal },
      );
      dispatch({
        type: "TOKENS_LOAD_OK",
        requestId,
        tokens: data.tokens ?? [],
      });
      return true;
    } catch (err) {
      if (err instanceof ApiClientError && err.isAborted) return true;
      dispatch({
        type: "TOKENS_LOAD_ERR",
        requestId,
        error: err instanceof Error ? err.message : "加载访问令牌失败",
      });
      return false;
    }
  }

  async function loadWatches(): Promise<boolean> {
    if (
      state.auth.tag !== "authenticated" ||
      state.auth.principal.role !== "admin"
    ) {
      return true;
    }
    const { requestId, signal } = coordinator.startChannel("watches");
    dispatch({ type: "WATCHES_LOAD_START", requestId });
    try {
      const data = await authedApi<{ watches?: WatchSlot[] }>(
        "/admin/api/inbox/watches",
        { signal },
      );
      dispatch({
        type: "WATCHES_LOAD_OK",
        requestId,
        watches: data.watches ?? [],
      });
      return true;
    } catch (err) {
      if (err instanceof ApiClientError && err.isAborted) return true;
      dispatch({
        type: "WATCHES_LOAD_ERR",
        requestId,
        error: err instanceof Error ? err.message : "加载监听槽位失败",
      });
      return false;
    }
  }

  async function loadInbox(overrideFilter?: string): Promise<boolean> {
    if (
      state.auth.tag !== "authenticated" ||
      (state.auth.principal.role !== "admin" &&
        state.auth.principal.role !== "user")
    ) {
      return true;
    }
    const isUser = state.auth.principal.role === "user";
    const filterVal = (overrideFilter ?? state.inbox.filterInput).trim();
    const { requestId, signal } = coordinator.startChannel("inbox");
    dispatch({
      type: "INBOX_LOAD_START",
      requestId,
      appliedFilter: isUser ? "" : filterVal,
    });

    const url = isUser
      ? "/api/inbox?limit=20"
      : "/admin/api/inbox?limit=20" +
        (filterVal ? "&to=" + encodeURIComponent(filterVal) : "");

    try {
      const data = await authedApi<{
        messages?: InboxMessage[];
        nextCursor?: string | null;
        hasMore?: boolean;
      }>(url, { signal });
      dispatch({
        type: "INBOX_LOAD_OK",
        requestId,
        messages: data.messages ?? [],
        nextCursor: data.nextCursor ?? null,
        hasMore: Boolean(data.hasMore),
      });
      return true;
    } catch (err) {
      if (err instanceof ApiClientError && err.isAborted) return true;
      dispatch({
        type: "INBOX_LOAD_ERR",
        requestId,
        error: err instanceof Error ? err.message : "加载收件箱失败",
      });
      return false;
    }
  }

  async function loadMoreInbox(): Promise<void> {
    if (
      state.auth.tag !== "authenticated" ||
      state.inbox.resource.status !== "ready" ||
      !state.inbox.hasMore ||
      !state.inbox.nextCursor ||
      state.inbox.loadingMoreReqId !== undefined
    ) {
      return;
    }
    const isUser = state.auth.principal.role === "user";
    const cursor = state.inbox.nextCursor;
    const filterVal = state.inbox.appliedFilter.trim();
    const { requestId, signal } = coordinator.startChannel("inbox-more");
    dispatch({ type: "INBOX_LOAD_MORE_START", requestId });

    const q = new URLSearchParams({ limit: "20", cursor });
    if (!isUser && filterVal) q.set("to", filterVal);
    const url = (isUser ? "/api/inbox?" : "/admin/api/inbox?") + q.toString();

    try {
      const data = await authedApi<{
        messages?: InboxMessage[];
        nextCursor?: string | null;
        hasMore?: boolean;
      }>(url, { signal });
      dispatch({
        type: "INBOX_LOAD_MORE_OK",
        requestId,
        messages: data.messages ?? [],
        nextCursor: data.nextCursor ?? null,
        hasMore: Boolean(data.hasMore),
      });
    } catch (err) {
      dispatch({ type: "INBOX_LOAD_MORE_ERR", requestId });
      if (!(err instanceof ApiClientError && err.isAborted)) {
        showToast(
          err instanceof Error ? err.message : "加载更多邮件失败",
          "error",
        );
      }
    }
  }

  async function loadLogs(): Promise<boolean> {
    if (
      state.auth.tag !== "authenticated" ||
      (state.auth.principal.role !== "admin" &&
        state.auth.principal.role !== "tenant")
    ) {
      return true;
    }
    const { requestId, signal } = coordinator.startChannel("logs");
    dispatch({ type: "LOGS_LOAD_START", requestId });
    try {
      const data = await authedApi<{
        logs?: DeliveryLogEntry[];
        nextCursor?: string | null;
        hasMore?: boolean;
      }>("/admin/api/logs?limit=200", { signal });
      dispatch({
        type: "LOGS_LOAD_OK",
        requestId,
        logs: data.logs ?? [],
        nextCursor: data.nextCursor ?? null,
        hasMore: Boolean(data.hasMore),
      });
      return true;
    } catch (err) {
      if (err instanceof ApiClientError && err.isAborted) return true;
      dispatch({
        type: "LOGS_LOAD_ERR",
        requestId,
        error: err instanceof Error ? err.message : "加载投递日志失败",
      });
      return false;
    }
  }

  async function loadWorkspaceData(manual: boolean): Promise<void> {
    if (state.auth.tag !== "authenticated") return;
    if (manual && state.globalRefreshing) return;

    const epochAtStart = state.auth.epoch;
    dispatch({ type: "GLOBAL_REFRESH_START" });

    const role = state.auth.principal.role;
    let results: boolean[] = [];
    try {
      if (role === "admin") {
        results = await Promise.all([
          loadTokens(),
          loadRules(),
          loadWatches(),
          loadInbox(),
          loadLogs(),
        ]);
      } else if (role === "tenant") {
        results = await Promise.all([loadRules(), loadLogs()]);
      } else {
        results = [await loadInbox()];
      }
    } finally {
      if (state.auth.epoch === epochAtStart) {
        dispatch({ type: "GLOBAL_REFRESH_END" });
      }
    }

    if (
      manual &&
      state.auth.tag === "authenticated" &&
      state.auth.epoch === epochAtStart
    ) {
      const allOk = results.every(Boolean);
      if (allOk) {
        showToast("数据已刷新", "ok");
      } else {
        showToast("部分模块刷新失败，请检查提示重试", "error", 4000);
      }
    }
  }

  /* ---------------- Rule Modal & Server-Backed 409 Overwrite Guard ---------------- */
  async function refreshModalVerification(): Promise<void> {
    if (state.primaryModal.tag !== "rule") return;
    const modal = state.primaryModal.modal;
    const addresses = [
      ...new Set(modal.draft.targets.map((t) => t.address)),
    ].filter(isValidEmailAddress);
    if (addresses.length === 0) return;

    const instanceId = modal.instanceId;
    const { requestId: verifyReqId, signal } =
      coordinator.startChannel("dest-verify");
    dispatch({
      type: "RULE_MODAL_VERIFY_CHECK_START",
      instanceId,
      verifyReqId,
      addresses,
    });

    try {
      const data = await authedApi<{
        destinations?: Array<{
          address: string;
          status: DestinationStatus;
          message?: string;
        }>;
      }>(
        "/admin/api/destinations/status?addresses=" +
          encodeURIComponent(addresses.join(",")),
        { signal },
      );
      dispatch({
        type: "RULE_MODAL_VERIFY_CHECK_OK",
        instanceId,
        verifyReqId,
        results: data.destinations ?? [],
      });
    } catch (err) {
      if (err instanceof ApiClientError && err.isAborted) return;
      dispatch({
        type: "RULE_MODAL_VERIFY_CHECK_ERR",
        instanceId,
        verifyReqId,
      });
    }
  }

  async function sendTargetVerification(address: string): Promise<void> {
    if (state.primaryModal.tag !== "rule") return;
    const instanceId = state.primaryModal.modal.instanceId;
    dispatch({ type: "RULE_MODAL_SEND_VERIFY_START", instanceId, address });
    try {
      const res = await authedApi<{
        destination?: { status: DestinationStatus; message?: string };
        message: string;
      }>("/admin/api/destinations/verify", {
        method: "POST",
        body: { address },
      });
      dispatch({
        type: "RULE_MODAL_SEND_VERIFY_DONE",
        instanceId,
        address,
        nextStatus: res.destination?.status ?? "pending",
        message: res.destination?.message ?? res.message,
      });
      showToast(res.message, "ok", 5500);
    } catch (err) {
      if (err instanceof ApiClientError && err.isAborted) return;
      dispatch({
        type: "RULE_MODAL_SEND_VERIFY_DONE",
        instanceId,
        address,
        nextStatus: "missing",
      });
      showToast(
        err instanceof Error ? err.message : "发送验证邮件失败",
        "error",
        5500,
      );
    }
  }

  function addTargetsFromInput(): void {
    if (state.primaryModal.tag !== "rule") return;
    const raw = state.primaryModal.modal.draft.newTargetInput;
    const parts = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) return;

    const invalid = parts.find((p) => !isValidEmailAddress(p));
    if (invalid) {
      dispatch({
        type: "RULE_MODAL_SET_ERROR",
        message: `邮箱地址格式无效：${invalid}`,
      });
      return;
    }
    dispatch({ type: "RULE_MODAL_ADD_TARGETS", addresses: parts });
    void refreshModalVerification();
  }

  async function saveRuleModal(forceOverwrite = false): Promise<void> {
    if (
      state.primaryModal.tag !== "rule" ||
      state.auth.tag !== "authenticated" ||
      state.auth.principal.role === "user"
    ) {
      return;
    }
    const modal = state.primaryModal.modal;
    if (modal.status === "submitting") return;

    let overwriteApproved = forceOverwrite;
    const preCheck = buildValidatedRuleSave(
      modal,
      state.auth.principal.role,
      state.mailDomain,
      overwriteApproved,
    );
    if (!preCheck.ok) {
      dispatch({ type: "RULE_MODAL_SET_ERROR", message: preCheck.error });
      return;
    }

    // 1. Fast client-side collision check
    if (!overwriteApproved) {
      const collidingRule = detectRuleCollision(
        state,
        preCheck.normalizedAddress,
      );
      if (collidingRule) {
        const proceed = await askConfirmDecision({
          title: "目标收件地址已存在规则",
          message: `收件地址 ${collidingRule.address} 已存在配置。继续保存将覆盖其现有转发目标与白名单设置，确定覆盖吗？`,
          confirmText: "确认覆盖",
          cancelText: "返回修改",
          danger: true,
        });
        if (!proceed) return;
        if (
          state.primaryModal.tag !== "rule" ||
          state.primaryModal.modal.instanceId !== modal.instanceId
        ) {
          return;
        }
        overwriteApproved = true;
      }
    }

    const validated = buildValidatedRuleSave(
      state.primaryModal.modal,
      state.auth.principal.role,
      state.mailDomain,
      overwriteApproved,
    );
    if (!validated.ok) return;

    const instanceId = modal.instanceId;
    const wasEdit = modal.mode.kind === "edit";
    dispatch({ type: "RULE_MODAL_SUBMIT_START", instanceId });

    try {
      const data = await authedApi<{
        rule: ForwardRule;
        verification?: {
          destinations?: Array<{ address: string; status: DestinationStatus }>;
        };
      }>("/admin/api/rules/" + encodeURIComponent(validated.targetUrlAddr), {
        method: "PUT",
        body: validated.payload,
      });

      dispatch({ type: "RULE_MODAL_SUBMIT_OK", instanceId });

      const unverified = (data.verification?.destinations ?? []).filter(
        (d) => d.status === "pending" || d.status === "missing",
      );
      if (unverified.length > 0) {
        showToast(
          `规则已保存，但 ${unverified
            .map((d) => d.address)
            .join("、")} 尚未完成 Cloudflare 验证，请在编辑弹窗中发送验证邮件`,
          "error",
          7000,
        );
      } else {
        showToast(wasEdit ? "转发规则已更新" : "转发规则已创建并生效", "ok");
      }
      await loadWorkspaceData(false);
    } catch (err) {
      if (err instanceof ApiClientError && err.isAborted) return;

      // 2. Server-side 409 TOCTOU conflict check (another admin created rule concurrently!)
      if (err instanceof ApiClientError && err.status === 409) {
        dispatch({
          type: "RULE_MODAL_SUBMIT_ERR",
          instanceId,
          message: "",
        });
        dispatch({ type: "RULE_MODAL_SET_ERROR", message: undefined });
        const proceed = await askConfirmDecision({
          title: "远端已存在同名规则",
          message: `服务端检测到收件地址 ${validated.normalizedAddress} 已被创建。是否覆盖远端现有规则？`,
          confirmText: "确认覆盖",
          cancelText: "返回修改",
          danger: true,
        });
        if (
          proceed &&
          state.primaryModal.tag === "rule" &&
          state.primaryModal.modal.instanceId === instanceId
        ) {
          await saveRuleModal(true);
        }
        return;
      }

      dispatch({
        type: "RULE_MODAL_SUBMIT_ERR",
        instanceId,
        message: err instanceof Error ? err.message : "保存规则失败",
      });
    }
  }

  /* ---------------- Watch Modal Save ---------------- */
  async function saveWatchModal(): Promise<void> {
    if (state.primaryModal.tag !== "watch") return;
    const modal = state.primaryModal.modal;
    if (modal.status === "submitting") return;

    const normalized = normalizePrefixInput(
      modal.draft.addressPrefix,
      state.mailDomain,
    );
    if (!normalized || !isValidEmailAddress(normalized)) {
      dispatch({
        type: "WATCH_MODAL_SET_ERROR",
        message: "请填写有效的临时收件地址前缀",
      });
      return;
    }

    const allowedSenders = modal.draft.allowedSendersRaw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const instanceId = modal.instanceId;
    dispatch({ type: "WATCH_MODAL_SUBMIT_START", instanceId });

    try {
      const res = await authedApi<{ watch: WatchSlot }>(
        "/admin/api/inbox/watch",
        {
          method: "POST",
          body: {
            address: normalized,
            ttlSeconds: modal.draft.ttlSeconds,
            ...(allowedSenders.length > 0 ? { allowedSenders } : {}),
          },
        },
      );
      dispatch({
        type: "WATCH_MODAL_SUBMIT_OK",
        instanceId,
        watch: res.watch,
      });
      showToast(`已开启临时监听：${res.watch.address}`, "ok");
    } catch (err) {
      if (err instanceof ApiClientError && err.isAborted) return;
      dispatch({
        type: "WATCH_MODAL_SUBMIT_ERR",
        instanceId,
        message: err instanceof Error ? err.message : "开启临时监听失败",
      });
    }
  }

  /* ---------------- Token Modal Save ---------------- */
  async function saveTokenModal(): Promise<void> {
    if (state.primaryModal.tag !== "token") return;
    const modal = state.primaryModal.modal;
    if (modal.status === "submitting") return;

    const name = modal.draft.name.trim();
    if (!name) {
      dispatch({
        type: "TOKEN_MODAL_SET_ERROR",
        message: "请填写租户或团队备注名称",
      });
      return;
    }

    const expRaw = modal.draft.expiresLocalIso.trim();
    const expiresAt = expRaw ? Date.parse(expRaw) : null;
    if (expRaw && (expiresAt === null || !Number.isFinite(expiresAt))) {
      dispatch({
        type: "TOKEN_MODAL_SET_ERROR",
        message: "到期时间格式无效",
      });
      return;
    }
    if (
      modal.mode.kind === "add" &&
      expiresAt !== null &&
      expiresAt <= Date.now()
    ) {
      dispatch({
        type: "TOKEN_MODAL_SET_ERROR",
        message: "新增令牌的到期时间必须晚于当前时间",
      });
      return;
    }

    const instanceId = modal.instanceId;
    dispatch({ type: "TOKEN_MODAL_SUBMIT_START", instanceId });

    try {
      if (modal.mode.kind === "add") {
        const res = await authedApi<{ token: TenantToken }>(
          "/admin/api/tokens",
          {
            method: "POST",
            body: {
              name,
              addresses: modal.draft.addresses,
              enabled: modal.draft.enabled,
              ...(expiresAt ? { expiresAt } : {}),
            },
          },
        );
        dispatch({
          type: "TOKEN_MODAL_SUBMIT_OK",
          instanceId,
          createdBanner: { name: res.token.name, token: res.token.token },
        });
        const copied = await copyTextSafe(res.token.token);
        showToast(
          copied
            ? `已创建令牌「${res.token.name}」并复制到剪贴板`
            : `已创建令牌「${res.token.name}」，请在上方横幅中点击复制`,
          "ok",
          4000,
        );
      } else {
        await authedApi(
          "/admin/api/tokens/" + encodeURIComponent(modal.mode.tokenId),
          {
            method: "PUT",
            body: {
              name,
              addresses: modal.draft.addresses,
              enabled: modal.draft.enabled,
              expiresAt,
            },
          },
        );
        dispatch({ type: "TOKEN_MODAL_SUBMIT_OK", instanceId });
        showToast("访问令牌配置已更新", "ok");
      }
      await loadWorkspaceData(false);
    } catch (err) {
      if (err instanceof ApiClientError && err.isAborted) return;
      dispatch({
        type: "TOKEN_MODAL_SUBMIT_ERR",
        instanceId,
        message: err instanceof Error ? err.message : "保存访问令牌失败",
      });
    }
  }

  /* ---------------- UI Actions Implementation ---------------- */
  const uiActions: UiActions = {
    onCopy: (text, msg) => void handleCopy(text, msg),

    onSelectTab: (tab) => {
      dispatch({ type: "TAB_SELECT", tab });
      if (
        state.auth.tag === "authenticated" &&
        getAllowedTabsForRole(state.auth.principal.role).length > 1
      ) {
        history.replaceState(null, "", `${location.pathname}#${tab}`);
      }
    },

    // Rules
    onClearRuleSearch: () =>
      dispatch({ type: "RULES_SEARCH_SET", query: "" }),

    onOpenAddRule: () => dispatch({ type: "RULE_MODAL_OPEN_ADD" }),

    onOpenEditRule: (rule) => {
      dispatch({ type: "RULE_MODAL_OPEN_EDIT", rule });
      void refreshModalVerification();
    },

    onDeleteRule: (rule) => {
      openAsyncConfirm({
        title: "删除转发规则",
        message: `确定删除收件地址 ${rule.address} 的路由规则吗？删除后发往该地址的邮件将被拒收，并从关联租户令牌中同步移除。`,
        confirmText: "确认删除",
        danger: true,
        run: async () => {
          dispatch({ type: "RULE_DELETE_START", address: rule.address });
          try {
            await authedApi(
              "/admin/api/rules/" + encodeURIComponent(rule.address),
              { method: "DELETE" },
            );
            dispatch({ type: "RULE_DELETE_OK", address: rule.address });
            showToast(`已删除规则 ${rule.address}`, "ok");
            await loadWorkspaceData(false);
          } catch (err) {
            dispatch({ type: "RULE_DELETE_ERR", address: rule.address });
            if (!(err instanceof ApiClientError && err.isAborted)) {
              showToast(
                err instanceof Error ? err.message : "删除规则失败",
                "error",
              );
            }
          }
        },
      });
    },

    onRetryRules: () => void loadRules(),

    // Rule Modal
    onRuleModalToggleTarget: (index, enabled) =>
      dispatch({ type: "RULE_MODAL_TOGGLE_TARGET", index, enabled }),

    onRuleModalRemoveTarget: (index) =>
      dispatch({ type: "RULE_MODAL_REMOVE_TARGET", index }),

    onRuleModalSendVerify: (address) => void sendTargetVerification(address),

    onRuleModalToggleKeyReveal: () =>
      dispatch({ type: "RULE_MODAL_KEY_TOGGLE_REVEAL" }),

    onRuleModalRotateKey: () => {
      if (
        state.primaryModal.tag !== "rule" ||
        state.primaryModal.modal.mode.kind !== "edit"
      ) {
        return;
      }
      const { instanceId } = state.primaryModal.modal;
      const { originalAddress, keySlice } = state.primaryModal.modal.mode;
      const isFirstGen = keySlice.tag === "none";

      const execRotate = async () => {
        dispatch({
          type: "RULE_MODAL_KEY_OP_START",
          instanceId,
          op: "rotating",
        });
        try {
          const res = await authedApi<{ inboxKey: string }>(
            "/admin/api/rules/" +
              encodeURIComponent(originalAddress) +
              "/inbox-key",
            { method: "POST" },
          );
          dispatch({
            type: "RULE_MODAL_KEY_ROTATE_OK",
            instanceId,
            inboxKey: res.inboxKey,
          });
          await loadRules();
          showToast(
            isFirstGen ? "已生成新的收件箱专属密钥" : "专属密钥已重置生效",
            "ok",
          );
        } catch (err) {
          dispatch({ type: "RULE_MODAL_KEY_OP_ERR", instanceId });
          if (!(err instanceof ApiClientError && err.isAborted)) {
            showToast(
              err instanceof Error ? err.message : "重置密钥失败",
              "error",
            );
          }
        }
      };

      if (isFirstGen) {
        void execRotate();
        return;
      }

      openAsyncConfirm({
        title: "重置专属收件箱 Key",
        message: `确定立即重置 ${originalAddress} 的专属 Key 吗？此操作立即在服务端生效，旧 Key 与旧直达链接将立即作废。`,
        confirmText: "立即重置",
        danger: true,
        run: execRotate,
      });
    },

    onRuleModalRevokeKey: () => {
      if (
        state.primaryModal.tag !== "rule" ||
        state.primaryModal.modal.mode.kind !== "edit"
      ) {
        return;
      }
      const { instanceId } = state.primaryModal.modal;
      const { originalAddress } = state.primaryModal.modal.mode;

      openAsyncConfirm({
        title: "吊销专属收件箱 Key",
        message: `确定立即吊销 ${originalAddress} 的专属 Key 吗？吊销后终端用户将无法通过 Key 访问该收件箱。`,
        confirmText: "立即吊销",
        danger: true,
        run: async () => {
          dispatch({
            type: "RULE_MODAL_KEY_OP_START",
            instanceId,
            op: "revoking",
          });
          try {
            await authedApi(
              "/admin/api/rules/" +
                encodeURIComponent(originalAddress) +
                "/inbox-key",
              { method: "DELETE" },
            );
            dispatch({ type: "RULE_MODAL_KEY_REVOKE_OK", instanceId });
            await loadRules();
            showToast("专属收件箱 Key 已吊销", "ok");
          } catch (err) {
            dispatch({ type: "RULE_MODAL_KEY_OP_ERR", instanceId });
            if (!(err instanceof ApiClientError && err.isAborted)) {
              showToast(
                err instanceof Error ? err.message : "吊销密钥失败",
                "error",
              );
            }
          }
        },
      });
    },

    // Tokens
    onClearTokenSearch: () =>
      dispatch({ type: "TOKENS_SEARCH_SET", query: "" }),

    onOpenAddToken: () => dispatch({ type: "TOKEN_MODAL_OPEN_ADD" }),

    onOpenEditToken: (tok) =>
      dispatch({ type: "TOKEN_MODAL_OPEN_EDIT", token: tok }),

    onOpenTokenAddrsModal: (tok) =>
      dispatch({ type: "TOKEN_ADDRS_MODAL_OPEN", token: tok }),

    onToggleTokenEnabled: async (tok, enabled) => {
      if (state.tokens.pendingById[tok.id]) return;
      dispatch({
        type: "TOKEN_ROW_OP_START",
        id: tok.id,
        op: { tag: "toggling", desired: enabled },
      });
      try {
        const res = await authedApi<{ token: TenantToken }>(
          "/admin/api/tokens/" + encodeURIComponent(tok.id),
          {
            method: "PUT",
            body: { enabled },
          },
        );
        dispatch({
          type: "TOKEN_ROW_TOGGLE_OK",
          id: tok.id,
          updated: res.token,
        });
        showToast(`令牌「${tok.name}」已${enabled ? "启用" : "暂停"}`, "ok");
      } catch (err) {
        dispatch({ type: "TOKEN_ROW_OP_ERR", id: tok.id });
        if (!(err instanceof ApiClientError && err.isAborted)) {
          showToast(
            err instanceof Error ? err.message : "更新令牌状态失败",
            "error",
          );
        }
      }
    },

    onRotateToken: (tok) => {
      openAsyncConfirm({
        title: "重置访问令牌密钥",
        message: `确定重置租户令牌「${tok.name}」的 cfmt_ 密钥吗？旧密钥将立即失效。`,
        confirmText: "确认重置",
        danger: true,
        run: async () => {
          dispatch({
            type: "TOKEN_ROW_OP_START",
            id: tok.id,
            op: { tag: "rotating" },
          });
          try {
            const res = await authedApi<{ token: TenantToken }>(
              "/admin/api/tokens/" + encodeURIComponent(tok.id) + "/rotate",
              { method: "POST" },
            );
            dispatch({
              type: "TOKEN_ROW_ROTATE_OK",
              id: tok.id,
              updated: res.token,
            });
            const copied = await copyTextSafe(res.token.token);
            showToast(
              copied
                ? "新密钥已生成并复制到剪贴板"
                : "新密钥已生成，请在上方绿色横幅中点击复制",
              "ok",
              4000,
            );
          } catch (err) {
            dispatch({ type: "TOKEN_ROW_OP_ERR", id: tok.id });
            if (!(err instanceof ApiClientError && err.isAborted)) {
              showToast(
                err instanceof Error ? err.message : "重置令牌密钥失败",
                "error",
              );
            }
          }
        },
      });
    },

    onDeleteToken: (tok) => {
      openAsyncConfirm({
        title: "删除访问令牌",
        message: `确定删除租户访问令牌「${tok.name}」吗？（不会删除其关联的邮箱转发规则本身）`,
        confirmText: "确认删除",
        danger: true,
        run: async () => {
          dispatch({
            type: "TOKEN_ROW_OP_START",
            id: tok.id,
            op: { tag: "deleting" },
          });
          try {
            await authedApi(
              "/admin/api/tokens/" + encodeURIComponent(tok.id),
              { method: "DELETE" },
            );
            dispatch({ type: "TOKEN_ROW_DELETE_OK", id: tok.id });
            showToast(`已删除令牌「${tok.name}」`, "ok");
          } catch (err) {
            dispatch({ type: "TOKEN_ROW_OP_ERR", id: tok.id });
            if (!(err instanceof ApiClientError && err.isAborted)) {
              showToast(
                err instanceof Error ? err.message : "删除令牌失败",
                "error",
              );
            }
          }
        },
      });
    },

    onDismissTokenBanner: () => dispatch({ type: "TOKENS_DISMISS_BANNER" }),

    onRetryTokens: () => void loadTokens(),

    // Token Modal
    onTokenModalToggleAddr: (address) =>
      dispatch({ type: "TOKEN_MODAL_TOGGLE_ADDRESS", address }),

    onTokenModalAddAddresses: (addresses) =>
      dispatch({ type: "TOKEN_MODAL_ADD_ADDRESSES", addresses }),

    onTokenModalRemoveAddr: (address) =>
      dispatch({ type: "TOKEN_MODAL_REMOVE_ADDRESS", address }),

    onTokenModalSetActiveIndex: (index) =>
      dispatch({ type: "TOKEN_MODAL_ACTIVE_INDEX_SET", index }),

    // Inbox & Watch Slots
    onOpenWatchModal: () => dispatch({ type: "WATCH_MODAL_OPEN" }),

    onFilterInboxByWatch: (address) => {
      dispatch({ type: "INBOX_FILTER_INPUT_SET", value: address });
      void loadInbox(address);
    },

    onUnwatchSlot: async (slot) => {
      if (state.watches.pendingUnwatchByAddr[slot.address]) return;
      dispatch({ type: "WATCH_UNWATCH_START", address: slot.address });
      try {
        await authedApi(
          "/admin/api/inbox/watch/" + encodeURIComponent(slot.address),
          { method: "DELETE" },
        );
        dispatch({ type: "WATCH_UNWATCH_OK", address: slot.address });
        showToast(`已关闭临时监听：${slot.address}`, "ok");
      } catch (err) {
        dispatch({ type: "WATCH_UNWATCH_ERR", address: slot.address });
        if (!(err instanceof ApiClientError && err.isAborted)) {
          showToast(
            err instanceof Error ? err.message : "关闭临时监听失败",
            "error",
          );
        }
      }
    },

    onOpenMessage: (msg) =>
      dispatch({ type: "MESSAGE_MODAL_OPEN", message: msg }),

    onAckMessage: async (msg) => {
      if (state.inbox.pendingById[msg.id]) return;
      dispatch({ type: "INBOX_ROW_OP_START", id: msg.id, op: "acking" });
      try {
        await authedApi("/api/inbox/" + encodeURIComponent(msg.id) + "/ack", {
          method: "POST",
        });
        dispatch({ type: "INBOX_ROW_ACK_OK", id: msg.id });
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 404) {
          dispatch({ type: "INBOX_ROW_GONE_404", id: msg.id });
          showToast("该邮件已超过 30 分钟保留期并自动清理", "neutral");
          return;
        }
        dispatch({ type: "INBOX_ROW_OP_ERR", id: msg.id });
        if (!(err instanceof ApiClientError && err.isAborted)) {
          showToast(
            err instanceof Error ? err.message : "标记已读失败",
            "error",
          );
        }
      }
    },

    onDeleteMessage: async (msg) => {
      if (state.inbox.pendingById[msg.id]) return;
      const isUser =
        state.auth.tag === "authenticated" &&
        state.auth.principal.role === "user";
      dispatch({ type: "INBOX_ROW_OP_START", id: msg.id, op: "deleting" });
      try {
        const delPath = isUser
          ? "/api/inbox/" + encodeURIComponent(msg.id)
          : "/admin/api/inbox/" +
            encodeURIComponent(msg.id) +
            "?to=" +
            encodeURIComponent(msg.to);
        await authedApi(delPath, { method: "DELETE" });
        dispatch({ type: "INBOX_ROW_DELETE_OK", id: msg.id });
        showToast("邮件已删除", "ok");
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 404) {
          dispatch({ type: "INBOX_ROW_GONE_404", id: msg.id });
          showToast("邮件已被清理", "neutral");
          return;
        }
        dispatch({ type: "INBOX_ROW_OP_ERR", id: msg.id });
        if (!(err instanceof ApiClientError && err.isAborted)) {
          showToast(
            err instanceof Error ? err.message : "删除邮件失败",
            "error",
          );
        }
      }
    },

    onClearInboxFilter: () => {
      dispatch({ type: "INBOX_FILTER_INPUT_SET", value: "" });
      void loadInbox("");
    },

    onShowAllInboxMessages: () =>
      dispatch({ type: "INBOX_UNREAD_TOGGLE", unreadOnly: false }),

    onRetryInbox: () => void loadInbox(),

    onLoadMoreInbox: () => void loadMoreInbox(),

    // Logs
    onClearLogFilters: () => {
      dispatch({ type: "LOGS_SEARCH_SET", query: "" });
      dispatch({ type: "LOGS_STATUS_FILTER_SET", filter: "all" });
    },

    onRetryLogs: () => void loadLogs(),
  };

  /* ---------------- Static DOM Event Wiring ---------------- */
  $("login").addEventListener("click", () => void submitManualLogin());
  $("token").addEventListener("input", () =>
    dispatch({ type: "GATE_INPUT_CHANGED" }),
  );
  $("token").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submitManualLogin();
    }
  });
  $("gate-toggle-pwd").addEventListener("click", () =>
    dispatch({ type: "GATE_TOGGLE_PASSWORD" }),
  );

  $("refresh").addEventListener("click", () => void loadWorkspaceData(true));
  $("logout").addEventListener("click", logout);

  const tabBtnIds: Array<{ id: string; tab: WorkspaceTab }> = [
    { id: "tab-btn-rules", tab: "rules" },
    { id: "tab-btn-inbox", tab: "inbox" },
    { id: "tab-btn-tokens", tab: "tokens" },
    { id: "tab-btn-logs", tab: "logs" },
  ];
  for (const item of tabBtnIds) {
    $(item.id).addEventListener("click", () => uiActions.onSelectTab(item.tab));
  }

  $("workspace-tablist").addEventListener("keydown", (e) => {
    if (state.auth.tag !== "authenticated") return;
    const allowed = getAllowedTabsForRole(state.auth.principal.role);
    if (allowed.length <= 1) return;
    const curIdx = allowed.indexOf(state.activeTab);
    let nextIdx = -1;
    if (e.key === "ArrowRight") {
      nextIdx = (curIdx + 1) % allowed.length;
    } else if (e.key === "ArrowLeft") {
      nextIdx = (curIdx - 1 + allowed.length) % allowed.length;
    } else if (e.key === "Home") {
      nextIdx = 0;
    } else if (e.key === "End") {
      nextIdx = allowed.length - 1;
    }
    if (nextIdx >= 0) {
      e.preventDefault();
      const targetTab = allowed[nextIdx];
      uiActions.onSelectTab(targetTab);
      $(`tab-btn-${targetTab}`).focus();
    }
  });

  // Single-Mailbox User Bar
  $("user-toggle-api").addEventListener("click", () =>
    dispatch({ type: "USER_TOGGLE_API_DRAWER" }),
  );
  $("user-reveal-key").addEventListener("click", () =>
    dispatch({ type: "USER_TOGGLE_SECRET_REVEAL" }),
  );
  $("user-copy-key").addEventListener("click", () => {
    if (state.auth.tag === "authenticated") {
      void handleCopy(
        state.auth.principal.credential,
        "已复制当前邮箱专属 Key",
      );
    }
  });
  $("user-copy-link").addEventListener("click", () => {
    if (state.auth.tag === "authenticated") {
      void handleCopy(
        buildQuickLink(state.auth.principal.credential),
        "已复制当前邮箱直达链接",
      );
    }
  });
  $("user-copy-curl").addEventListener("click", () => {
    if (state.auth.tag === "authenticated") {
      void handleCopy(
        buildPollCurl(state.auth.principal.credential),
        "已复制轮询 curl 命令",
      );
    }
  });
  $("user-rotate-key").addEventListener("click", () => {
    if (
      state.auth.tag !== "authenticated" ||
      state.auth.principal.role !== "user"
    ) {
      return;
    }
    const addr = state.auth.principal.address;
    openAsyncConfirm({
      title: "重置收件箱专属 Key",
      message: `确定重置 ${addr} 的专属 Key 吗？旧 Key 与旧直达链接将立即失效，当前页面会自动无缝切换至新 Key。`,
      confirmText: "确认重置",
      danger: true,
      run: async () => {
        if (
          state.auth.tag !== "authenticated" ||
          state.auth.principal.role !== "user"
        ) {
          return;
        }
        const ep = state.auth.epoch;
        const oldCred = state.auth.principal.credential;
        dispatch({ type: "USER_ROTATE_KEY_START" });
        try {
          const data = await authedApi<{ inboxKey: string }>(
            "/api/inbox/rotate-key",
            { method: "POST" },
          );
          const nextKey = data.inboxKey;
          if (safeStorage.getSession("cfm_session_token")) {
            safeStorage.setSession("cfm_session_token", nextKey);
          }
          if (safeStorage.getLocal("cfm_token") === oldCred) {
            safeStorage.setLocal("cfm_token", nextKey);
          }
          dispatch({ type: "USER_ROTATE_KEY_OK", epoch: ep, nextKey });
          const copied = await copyTextSafe(buildQuickLink(nextKey));
          showToast(
            copied
              ? "Key 已重置并自动切换，新直达链接已复制"
              : "Key 已重置并自动切换至当前会话",
            "ok",
            4000,
          );
        } catch (err) {
          dispatch({ type: "USER_ROTATE_KEY_FAIL", epoch: ep });
          if (!(err instanceof ApiClientError && err.isAborted)) {
            showToast(
              err instanceof Error ? err.message : "重置 Key 失败",
              "error",
            );
          }
        }
      },
    });
  });

  // Rules Toolbar & Pagination
  $("open-add-modal").addEventListener("click", uiActions.onOpenAddRule);
  $("rule-search").addEventListener("input", (e) => {
    dispatch({
      type: "RULES_SEARCH_SET",
      query: (e.target as HTMLInputElement).value,
    });
  });
  $("page-prev").addEventListener("click", () => {
    const model = selectRulesTableModel(state);
    if (model.page > 1) {
      dispatch({ type: "RULES_PAGE_SET", page: model.page - 1 });
    }
  });
  $("page-next").addEventListener("click", () => {
    const model = selectRulesTableModel(state);
    if (model.page < model.totalPages) {
      dispatch({ type: "RULES_PAGE_SET", page: model.page + 1 });
    }
  });

  // Inbox Toolbar, Watch Modal Open & Cursor Load-More
  const triggerDebouncedInboxFilter = (val: string, immediate: boolean) => {
    dispatch({ type: "INBOX_FILTER_INPUT_SET", value: val });
    if (inboxFilterDebounce !== null) {
      clearTimeout(inboxFilterDebounce);
      inboxFilterDebounce = null;
    }
    if (immediate) {
      void loadInbox(val);
    } else {
      inboxFilterDebounce = setTimeout(() => {
        inboxFilterDebounce = null;
        void loadInbox(val);
      }, 250);
    }
  };
  $("inbox-filter").addEventListener("input", (e) => {
    triggerDebouncedInboxFilter((e.target as HTMLInputElement).value, false);
  });
  $("inbox-filter").addEventListener("search", (e) => {
    triggerDebouncedInboxFilter((e.target as HTMLInputElement).value, true);
  });
  $("inbox-filter").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      triggerDebouncedInboxFilter(
        $<HTMLInputElement>("inbox-filter").value,
        true,
      );
    }
  });
  $("inbox-unread-only").addEventListener("change", (e) => {
    dispatch({
      type: "INBOX_UNREAD_TOGGLE",
      unreadOnly: (e.target as HTMLInputElement).checked,
    });
  });
  $("inbox-refresh").addEventListener("click", () => {
    void Promise.all([loadWatches(), loadInbox()]).then(([wOk, iOk]) => {
      if (wOk && iOk) showToast("收件箱已刷新", "ok");
    });
  });
  $("open-watch-modal").addEventListener("click", uiActions.onOpenWatchModal);
  $("inbox-load-more").addEventListener("click", uiActions.onLoadMoreInbox);

  // Tokens Toolbar
  $("open-token-modal").addEventListener("click", uiActions.onOpenAddToken);
  $("token-search").addEventListener("input", (e) => {
    dispatch({
      type: "TOKENS_SEARCH_SET",
      query: (e.target as HTMLInputElement).value,
    });
  });

  // Logs Toolbar & Pagination
  $("log-search").addEventListener("input", (e) => {
    dispatch({
      type: "LOGS_SEARCH_SET",
      query: (e.target as HTMLInputElement).value,
    });
  });
  $("logs-page-prev").addEventListener("click", () => {
    const model = selectLogsTableModel(state);
    if (model.page > 1) {
      dispatch({ type: "LOGS_PAGE_SET", page: model.page - 1 });
    }
  });
  $("logs-page-next").addEventListener("click", () => {
    const model = selectLogsTableModel(state);
    if (model.page < model.totalPages) {
      dispatch({ type: "LOGS_PAGE_SET", page: model.page + 1 });
    }
  });

  // Rule Modal Controls
  $("modal-close").addEventListener("click", () =>
    dispatch({ type: "RULE_MODAL_CLOSE" }),
  );
  $("modal-cancel").addEventListener("click", () =>
    dispatch({ type: "RULE_MODAL_CLOSE" }),
  );
  $("modal-save").addEventListener("click", () => void saveRuleModal(false));
  $("modal-addr").addEventListener("input", (e) =>
    dispatch({
      type: "RULE_MODAL_DRAFT_PATCH",
      patch: { addressPrefix: (e.target as HTMLInputElement).value },
    }),
  );
  $("modal-new-target").addEventListener("input", (e) =>
    dispatch({
      type: "RULE_MODAL_DRAFT_PATCH",
      patch: { newTargetInput: (e.target as HTMLInputElement).value },
    }),
  );
  $("modal-new-target").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTargetsFromInput();
    }
  });
  $("modal-add-target").addEventListener("click", addTargetsFromInput);
  $("modal-inbox-enabled").addEventListener("change", (e) =>
    dispatch({
      type: "RULE_MODAL_DRAFT_PATCH",
      patch: { inboxEnabled: (e.target as HTMLInputElement).checked },
    }),
  );
  $("modal-allowed-senders").addEventListener("input", (e) =>
    dispatch({
      type: "RULE_MODAL_DRAFT_PATCH",
      patch: { allowedSendersRaw: (e.target as HTMLInputElement).value },
    }),
  );
  bindSafeBackdropDismiss($("rule-modal"), () =>
    dispatch({ type: "RULE_MODAL_CLOSE" }),
  );

  // Token Modal Controls
  $("tok-modal-close").addEventListener("click", () =>
    dispatch({ type: "TOKEN_MODAL_CLOSE" }),
  );
  $("tok-modal-cancel").addEventListener("click", () =>
    dispatch({ type: "TOKEN_MODAL_CLOSE" }),
  );
  $("tok-modal-save").addEventListener("click", () => void saveTokenModal());
  $("tok-modal-name").addEventListener("input", (e) =>
    dispatch({
      type: "TOKEN_MODAL_DRAFT_PATCH",
      patch: { name: (e.target as HTMLInputElement).value },
    }),
  );
  $("tok-modal-enabled").addEventListener("change", (e) =>
    dispatch({
      type: "TOKEN_MODAL_DRAFT_PATCH",
      patch: { enabled: (e.target as HTMLInputElement).checked },
    }),
  );
  $("tok-modal-expires").addEventListener("input", (e) =>
    dispatch({
      type: "TOKEN_MODAL_DRAFT_PATCH",
      patch: { expiresLocalIso: (e.target as HTMLInputElement).value },
    }),
  );
  $("tok-modal-clear-expires").addEventListener("click", () =>
    dispatch({
      type: "TOKEN_MODAL_DRAFT_PATCH",
      patch: { expiresLocalIso: "" },
    }),
  );
  $("tok-mselect-trigger").addEventListener("click", (e) => {
    e.stopPropagation();
    dispatch({ type: "TOKEN_MODAL_DROPDOWN_TOGGLE" });
  });
  $("tok-mselect-trigger").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      dispatch({ type: "TOKEN_MODAL_DROPDOWN_TOGGLE", open: true });
    }
  });
  $("tok-mselect-popover").addEventListener("click", (e) => {
    e.stopPropagation();
  });
  $("tok-mselect-search").addEventListener("input", (e) => {
    dispatch({
      type: "TOKEN_MODAL_FILTER_SET",
      query: (e.target as HTMLInputElement).value,
    });
  });
  $("tok-mselect-search").addEventListener("keydown", (e) => {
    if (state.primaryModal.tag !== "token") return;
    const ddModel = selectTokenDropdownModel(state);
    const len = ddModel.options.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (len > 0) {
        const nextIdx = (ddModel.activeIndex + 1) % len;
        dispatch({ type: "TOKEN_MODAL_ACTIVE_INDEX_SET", index: nextIdx });
        document
          .getElementById(`tok-mselect-opt-${nextIdx}`)
          ?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (len > 0) {
        const nextIdx = (ddModel.activeIndex - 1 + len) % len;
        dispatch({ type: "TOKEN_MODAL_ACTIVE_INDEX_SET", index: nextIdx });
        document
          .getElementById(`tok-mselect-opt-${nextIdx}`)
          ?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Home" && len > 0) {
      e.preventDefault();
      dispatch({ type: "TOKEN_MODAL_ACTIVE_INDEX_SET", index: 0 });
    } else if (e.key === "End" && len > 0) {
      e.preventDefault();
      dispatch({ type: "TOKEN_MODAL_ACTIVE_INDEX_SET", index: len - 1 });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (ddModel.activeIndex >= 0 && ddModel.options[ddModel.activeIndex]) {
        const chosen = ddModel.options[ddModel.activeIndex];
        if (chosen.kind === "create") {
          dispatch({
            type: "TOKEN_MODAL_ADD_ADDRESSES",
            addresses: chosen.addresses,
          });
        } else {
          dispatch({
            type: "TOKEN_MODAL_TOGGLE_ADDRESS",
            address: chosen.address,
          });
        }
      }
    }
  });
  $("tok-mselect-select-all").addEventListener("click", () => {
    const ddModel = selectTokenDropdownModel(state);
    if (ddModel.filteredSelectableAddresses.length > 0) {
      dispatch({
        type: "TOKEN_MODAL_SELECT_MANY",
        addresses: ddModel.filteredSelectableAddresses,
      });
      $("tok-mselect-search").focus();
    }
  });
  $("tok-mselect-clear").addEventListener("click", () => {
    dispatch({ type: "TOKEN_MODAL_CLEAR_ADDRESSES" });
    $("tok-mselect-search").focus();
  });
  $("token-modal").addEventListener("click", (e) => {
    if (
      state.primaryModal.tag === "token" &&
      state.primaryModal.modal.dropdown.open &&
      e.target instanceof Node &&
      !$("tok-addr-mselect").contains(e.target)
    ) {
      dispatch({ type: "TOKEN_MODAL_DROPDOWN_TOGGLE", open: false });
    }
  });
  bindSafeBackdropDismiss($("token-modal"), () =>
    dispatch({ type: "TOKEN_MODAL_CLOSE" }),
  );

  // Token Authorized Mailboxes Inspection Modal Controls
  $("tok-addrs-modal-close").addEventListener("click", () =>
    dispatch({ type: "TOKEN_ADDRS_MODAL_CLOSE" }),
  );
  $("tok-addrs-done-btn").addEventListener("click", () =>
    dispatch({ type: "TOKEN_ADDRS_MODAL_CLOSE" }),
  );
  $("tok-addrs-search").addEventListener("input", (e) =>
    dispatch({
      type: "TOKEN_ADDRS_MODAL_SEARCH_SET",
      query: (e.target as HTMLInputElement).value,
    }),
  );
  $("tok-addrs-copy-all").addEventListener("click", () => {
    if (state.primaryModal.tag !== "tokenAddrs") return;
    const { tokenName, addresses } = state.primaryModal.modal;
    if (addresses.length > 0) {
      void handleCopy(
        addresses.join("\n"),
        `已复制「${tokenName}」全部 ${addresses.length} 个授权邮箱`,
      );
    }
  });
  $("tok-addrs-edit-btn").addEventListener("click", () => {
    if (
      state.primaryModal.tag !== "tokenAddrs" ||
      state.tokens.resource.status !== "ready"
    ) {
      return;
    }
    const targetId = state.primaryModal.modal.tokenId;
    const targetTok = state.tokens.resource.data.find((t) => t.id === targetId);
    if (targetTok) {
      dispatch({ type: "TOKEN_MODAL_OPEN_EDIT", token: targetTok });
    } else {
      dispatch({ type: "TOKEN_ADDRS_MODAL_CLOSE" });
    }
  });
  bindSafeBackdropDismiss($("tok-addrs-modal"), () =>
    dispatch({ type: "TOKEN_ADDRS_MODAL_CLOSE" }),
  );

  // Watch Modal Controls
  $("watch-modal-close").addEventListener("click", () =>
    dispatch({ type: "WATCH_MODAL_CLOSE" }),
  );
  $("watch-modal-cancel").addEventListener("click", () =>
    dispatch({ type: "WATCH_MODAL_CLOSE" }),
  );
  $("watch-modal-save").addEventListener("click", () => void saveWatchModal());
  $("watch-modal-addr").addEventListener("input", (e) =>
    dispatch({
      type: "WATCH_MODAL_DRAFT_PATCH",
      patch: { addressPrefix: (e.target as HTMLInputElement).value },
    }),
  );
  $("watch-modal-addr").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void saveWatchModal();
    }
  });
  $("watch-modal-senders").addEventListener("input", (e) =>
    dispatch({
      type: "WATCH_MODAL_DRAFT_PATCH",
      patch: { allowedSendersRaw: (e.target as HTMLInputElement).value },
    }),
  );
  bindSafeBackdropDismiss($("watch-modal"), () =>
    dispatch({ type: "WATCH_MODAL_CLOSE" }),
  );

  // Message Modal Controls
  $("msg-modal-close").addEventListener("click", () =>
    dispatch({ type: "MESSAGE_MODAL_CLOSE" }),
  );
  bindSafeBackdropDismiss($("msg-modal"), () =>
    dispatch({ type: "MESSAGE_MODAL_CLOSE" }),
  );

  // Confirm Modal Controls
  $("confirm-ok").addEventListener("click", () => void onConfirmOkClick());
  $("confirm-cancel").addEventListener("click", onConfirmCancel);
  bindSafeBackdropDismiss($("confirm-modal"), onConfirmCancel);

  // Global Escape Stack Handler
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.confirmDialog.tag === "open") {
      onConfirmCancel();
    } else if (state.primaryModal.tag === "message") {
      dispatch({ type: "MESSAGE_MODAL_CLOSE" });
    } else if (state.primaryModal.tag === "watch") {
      dispatch({ type: "WATCH_MODAL_CLOSE" });
    } else if (state.primaryModal.tag === "tokenAddrs") {
      dispatch({ type: "TOKEN_ADDRS_MODAL_CLOSE" });
    } else if (state.primaryModal.tag === "token") {
      if (state.primaryModal.modal.dropdown.open) {
        dispatch({ type: "TOKEN_MODAL_DROPDOWN_TOGGLE", open: false });
        $("tok-mselect-trigger").focus();
      } else {
        dispatch({ type: "TOKEN_MODAL_CLOSE" });
      }
    } else if (state.primaryModal.tag === "rule") {
      dispatch({ type: "RULE_MODAL_CLOSE" });
    } else {
      closeAllSelects();
    }
  });

  // Initial Paint + Boot Verification
  renderApp(state, uiActions, selectSyncCallbacks);

  if (state.auth.tag === "booting") {
    void verifyBootSession(
      state.auth.candidateCredential,
      state.auth.source,
      state.auth.epoch,
    );
  }
}

initApp();
