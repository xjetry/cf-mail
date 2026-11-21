import {
  assertNever,
  type AppState,
  type AsyncResource,
  type DeliveryLogEntry,
  type DestinationStatus,
  type DestinationTarget,
  type ForwardRule,
  type InboxMessage,
  type LoginError,
  type LogStatusFilter,
  type OpenRuleModalState,
  type OpenWatchModalState,
  type SessionPrincipal,
  type TenantToken,
  type ThemeMode,
  type ToastTone,
  type WatchSlot,
  type WorkspaceTab,
} from "./types.ts";

/* ==========================================================================
   Domain Address Helpers & Validators
   ========================================================================== */
export function normalizePrefixInput(raw: string, mailDomain: string): string {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return "";
  const suffix = "@" + mailDomain.toLowerCase();
  if (v.endsWith(suffix)) return v;
  if (v.includes("@")) return v;
  return v + suffix;
}

export function stripDomainSuffix(address: string, mailDomain: string): string {
  const v = String(address ?? "").trim().toLowerCase();
  const suffix = "@" + mailDomain.toLowerCase();
  return v.endsWith(suffix) ? v.slice(0, -suffix.length) : v;
}

export function isValidEmailAddress(addr: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr.trim());
}

export function getRuleTargets(r: ForwardRule): DestinationTarget[] {
  if (Array.isArray(r.targets) && r.targets.length > 0) {
    return r.targets.map((t) => ({
      address: t.address,
      enabled: t.enabled !== false,
    }));
  }
  return (r.destinations ?? []).map((d) => ({ address: d, enabled: true }));
}

export function getAllowedTabsForRole(
  role: SessionPrincipal["role"],
): readonly WorkspaceTab[] {
  switch (role) {
    case "admin":
      return ["rules", "inbox", "tokens", "logs"];
    case "tenant":
      return ["rules", "logs"];
    case "user":
      return ["inbox"];
    default:
      return assertNever(role);
  }
}

export function resolveTabForRole(
  role: SessionPrincipal["role"],
  preferred?: string | null,
): WorkspaceTab {
  const allowed = getAllowedTabsForRole(role);
  if (preferred && (allowed as readonly string[]).includes(preferred)) {
    return preferred as WorkspaceTab;
  }
  return allowed[0];
}

/* ==========================================================================
   AsyncResource Pure Transitions (Request-ID Sequenced + Stale-While-Revalidate)
   ========================================================================== */
export function startResourceLoad<T>(
  prev: AsyncResource<T>,
  requestId: number,
): AsyncResource<T> {
  if (prev.status === "ready") {
    return {
      ...prev,
      reloadingId: requestId,
      reloadError: undefined,
    };
  }
  return { status: "loading", requestId };
}

export function completeResourceLoad<T>(
  prev: AsyncResource<T>,
  requestId: number,
  data: T,
): AsyncResource<T> {
  // Discard out-of-order stale responses
  if (prev.status === "loading" && prev.requestId !== requestId) return prev;
  if (
    prev.status === "ready" &&
    prev.reloadingId !== undefined &&
    prev.reloadingId !== requestId
  ) {
    return prev;
  }
  if (prev.status === "error" && prev.requestId > requestId) return prev;
  return {
    status: "ready",
    data,
    requestId,
  };
}

export function failResourceLoad<T>(
  prev: AsyncResource<T>,
  requestId: number,
  error: string,
): AsyncResource<T> {
  if (prev.status === "loading") {
    if (prev.requestId !== requestId) return prev;
    return { status: "error", error, requestId };
  }
  if (prev.status === "ready") {
    if (prev.reloadingId !== requestId) return prev;
    return {
      ...prev,
      reloadingId: undefined,
      reloadError: error,
    };
  }
  return prev;
}

/* ==========================================================================
   Initial State Factory
   ========================================================================== */
export function createEmptySlices(): Pick<
  AppState,
  | "rules"
  | "tokens"
  | "inbox"
  | "watches"
  | "logs"
  | "primaryModal"
  | "confirmDialog"
  | "globalRefreshing"
> {
  return {
    globalRefreshing: false,
    rules: {
      resource: { status: "idle" },
      searchQuery: "",
      page: 1,
      pageSize: 10,
      pendingByAddress: {},
    },
    tokens: {
      resource: { status: "idle" },
      searchQuery: "",
      pendingById: {},
      newlyIssuedBanner: undefined,
    },
    inbox: {
      resource: { status: "idle" },
      filterInput: "",
      appliedFilter: "",
      unreadOnly: false,
      pendingById: {},
      nextCursor: null,
      hasMore: false,
    },
    watches: {
      resource: { status: "idle" },
      pendingUnwatchByAddr: {},
    },
    logs: {
      resource: { status: "idle" },
      searchQuery: "",
      statusFilter: "all",
      page: 1,
      pageSize: 10,
      nextCursor: null,
      hasMore: false,
    },
    primaryModal: { tag: "none" },
    confirmDialog: { tag: "closed" },
  };
}

export function createInitialAppState(opts?: {
  theme?: ThemeMode;
  initialCredential?: string;
  credentialSource?: "url" | "storage";
}): AppState {
  const cred = (opts?.initialCredential ?? "").trim();
  const theme = opts?.theme ?? "system";
  return {
    theme,
    mailDomain: "example.com",
    activeTab: "rules",
    auth: cred
      ? {
          tag: "booting",
          epoch: 1,
          candidateCredential: cred,
          source: opts?.credentialSource ?? "storage",
        }
      : {
          tag: "unauthenticated",
          epoch: 1,
          passwordRevealed: false,
          login: { status: "idle" },
        },
    ...createEmptySlices(),
    toast: { tag: "hidden", nextId: 1 },
    nextInstanceId: 1,
  };
}

/* ==========================================================================
   Events Discriminated Union
   ========================================================================== */
export type AppEvent =
  | { type: "THEME_SET"; theme: ThemeMode }
  | { type: "TAB_SELECT"; tab: WorkspaceTab }
  | { type: "GLOBAL_REFRESH_START" }
  | { type: "GLOBAL_REFRESH_END" }
  // SM-1: Auth & Session
  | {
      type: "BOOT_VERIFY_OK";
      epoch: number;
      principal: SessionPrincipal;
      preferredTab?: string | null;
    }
  | {
      type: "BOOT_VERIFY_FAIL";
      epoch: number;
      reason: "unauthorized" | "network";
      message?: string;
    }
  | { type: "GATE_TOGGLE_PASSWORD" }
  | { type: "GATE_INPUT_CHANGED" }
  | { type: "LOGIN_SUBMIT"; rawCredential: string }
  | {
      type: "LOGIN_OK";
      epoch: number;
      principal: SessionPrincipal;
      preferredTab?: string | null;
    }
  | { type: "LOGIN_FAIL"; epoch: number; error: LoginError }
  | { type: "HTTP_401_RECEIVED"; epoch: number; usedCredential: string }
  | { type: "LOGOUT" }
  | { type: "USER_TOGGLE_API_DRAWER" }
  | { type: "USER_TOGGLE_SECRET_REVEAL" }
  | { type: "USER_ROTATE_KEY_START" }
  | { type: "USER_ROTATE_KEY_OK"; epoch: number; nextKey: string }
  | { type: "USER_ROTATE_KEY_FAIL"; epoch: number }
  // SM-3: Rules Slice
  | { type: "RULES_LOAD_START"; requestId: number }
  | {
      type: "RULES_LOAD_OK";
      requestId: number;
      domain?: string;
      rules: readonly ForwardRule[];
    }
  | { type: "RULES_LOAD_ERR"; requestId: number; error: string }
  | { type: "RULES_SEARCH_SET"; query: string }
  | { type: "RULES_PAGE_SET"; page: number }
  | { type: "RULES_PAGE_SIZE_SET"; pageSize: 10 | 20 | 50 }
  | { type: "RULE_DELETE_START"; address: string }
  | { type: "RULE_DELETE_OK"; address: string }
  | { type: "RULE_DELETE_ERR"; address: string }
  // SM-4: Rule Modal
  | { type: "RULE_MODAL_OPEN_ADD" }
  | { type: "RULE_MODAL_OPEN_EDIT"; rule: ForwardRule }
  | { type: "RULE_MODAL_CLOSE" }
  | {
      type: "RULE_MODAL_DRAFT_PATCH";
      patch: Partial<OpenRuleModalState["draft"]>;
    }
  | { type: "RULE_MODAL_ADD_TARGETS"; addresses: readonly string[] }
  | { type: "RULE_MODAL_TOGGLE_TARGET"; index: number; enabled: boolean }
  | { type: "RULE_MODAL_REMOVE_TARGET"; index: number }
  | { type: "RULE_MODAL_SET_ERROR"; message?: string }
  | { type: "RULE_MODAL_SUBMIT_START"; instanceId: number }
  | { type: "RULE_MODAL_SUBMIT_ERR"; instanceId: number; message: string }
  | { type: "RULE_MODAL_SUBMIT_OK"; instanceId: number }
  | {
      type: "RULE_MODAL_VERIFY_CHECK_START";
      instanceId: number;
      verifyReqId: number;
      addresses: readonly string[];
    }
  | {
      type: "RULE_MODAL_VERIFY_CHECK_OK";
      instanceId: number;
      verifyReqId: number;
      results: ReadonlyArray<{
        address: string;
        status: DestinationStatus;
        message?: string;
      }>;
    }
  | {
      type: "RULE_MODAL_VERIFY_CHECK_ERR";
      instanceId: number;
      verifyReqId: number;
    }
  | {
      type: "RULE_MODAL_SEND_VERIFY_START";
      instanceId: number;
      address: string;
    }
  | {
      type: "RULE_MODAL_SEND_VERIFY_DONE";
      instanceId: number;
      address: string;
      nextStatus: DestinationStatus;
      message?: string;
    }
  | { type: "RULE_MODAL_KEY_TOGGLE_REVEAL" }
  | {
      type: "RULE_MODAL_KEY_OP_START";
      instanceId: number;
      op: "rotating" | "revoking";
    }
  | {
      type: "RULE_MODAL_KEY_ROTATE_OK";
      instanceId: number;
      inboxKey: string;
    }
  | { type: "RULE_MODAL_KEY_REVOKE_OK"; instanceId: number }
  | { type: "RULE_MODAL_KEY_OP_ERR"; instanceId: number }
  // SM-5 & SM-6: Tokens Slice & Token Modal
  | { type: "TOKENS_LOAD_START"; requestId: number }
  | {
      type: "TOKENS_LOAD_OK";
      requestId: number;
      tokens: readonly TenantToken[];
    }
  | { type: "TOKENS_LOAD_ERR"; requestId: number; error: string }
  | { type: "TOKENS_SEARCH_SET"; query: string }
  | { type: "TOKENS_DISMISS_BANNER" }
  | {
      type: "TOKEN_ROW_OP_START";
      id: string;
      op:
        | { tag: "toggling"; desired: boolean }
        | { tag: "rotating" }
        | { tag: "deleting" };
    }
  | { type: "TOKEN_ROW_TOGGLE_OK"; id: string; updated: TenantToken }
  | { type: "TOKEN_ROW_ROTATE_OK"; id: string; updated: TenantToken }
  | { type: "TOKEN_ROW_DELETE_OK"; id: string }
  | { type: "TOKEN_ROW_OP_ERR"; id: string }
  | { type: "TOKEN_MODAL_OPEN_ADD" }
  | { type: "TOKEN_MODAL_OPEN_EDIT"; token: TenantToken }
  | { type: "TOKEN_MODAL_CLOSE" }
  | {
      type: "TOKEN_MODAL_DRAFT_PATCH";
      patch: Partial<{
        name: string;
        enabled: boolean;
        expiresLocalIso: string;
      }>;
    }
  | { type: "TOKEN_MODAL_DROPDOWN_TOGGLE"; open?: boolean }
  | { type: "TOKEN_MODAL_FILTER_SET"; query: string }
  | { type: "TOKEN_MODAL_ACTIVE_INDEX_SET"; index: number }
  | { type: "TOKEN_MODAL_TOGGLE_ADDRESS"; address: string }
  | { type: "TOKEN_MODAL_ADD_ADDRESSES"; addresses: readonly string[] }
  | { type: "TOKEN_MODAL_SELECT_MANY"; addresses: readonly string[] }
  | { type: "TOKEN_MODAL_CLEAR_ADDRESSES" }
  | { type: "TOKEN_MODAL_REMOVE_ADDRESS"; address: string }
  | { type: "TOKEN_MODAL_SET_ERROR"; message?: string }
  | { type: "TOKEN_MODAL_SUBMIT_START"; instanceId: number }
  | { type: "TOKEN_MODAL_SUBMIT_ERR"; instanceId: number; message: string }
  | {
      type: "TOKEN_MODAL_SUBMIT_OK";
      instanceId: number;
      createdBanner?: { name: string; token: string };
    }
  | { type: "TOKEN_ADDRS_MODAL_OPEN"; token: TenantToken }
  | { type: "TOKEN_ADDRS_MODAL_SEARCH_SET"; query: string }
  | { type: "TOKEN_ADDRS_MODAL_CLOSE" }
  // SM-7: Inbox Slice, Watch Slots & Message Modal
  | { type: "INBOX_LOAD_START"; requestId: number; appliedFilter: string }
  | {
      type: "INBOX_LOAD_OK";
      requestId: number;
      messages: readonly InboxMessage[];
      nextCursor?: string | null;
      hasMore?: boolean;
    }
  | { type: "INBOX_LOAD_ERR"; requestId: number; error: string }
  | { type: "INBOX_LOAD_MORE_START"; requestId: number }
  | {
      type: "INBOX_LOAD_MORE_OK";
      requestId: number;
      messages: readonly InboxMessage[];
      nextCursor: string | null;
      hasMore: boolean;
    }
  | { type: "INBOX_LOAD_MORE_ERR"; requestId: number }
  | { type: "INBOX_FILTER_INPUT_SET"; value: string }
  | { type: "INBOX_UNREAD_TOGGLE"; unreadOnly: boolean }
  | { type: "INBOX_ROW_OP_START"; id: string; op: "acking" | "deleting" }
  | { type: "INBOX_ROW_ACK_OK"; id: string }
  | { type: "INBOX_ROW_DELETE_OK"; id: string }
  | { type: "INBOX_ROW_GONE_404"; id: string }
  | { type: "INBOX_ROW_OP_ERR"; id: string }
  | { type: "WATCHES_LOAD_START"; requestId: number }
  | {
      type: "WATCHES_LOAD_OK";
      requestId: number;
      watches: readonly WatchSlot[];
    }
  | { type: "WATCHES_LOAD_ERR"; requestId: number; error: string }
  | { type: "WATCH_UNWATCH_START"; address: string }
  | { type: "WATCH_UNWATCH_OK"; address: string }
  | { type: "WATCH_UNWATCH_ERR"; address: string }
  | { type: "WATCH_MODAL_OPEN" }
  | { type: "WATCH_MODAL_CLOSE" }
  | {
      type: "WATCH_MODAL_DRAFT_PATCH";
      patch: Partial<OpenWatchModalState["draft"]>;
    }
  | { type: "WATCH_MODAL_SET_ERROR"; message?: string }
  | { type: "WATCH_MODAL_SUBMIT_START"; instanceId: number }
  | { type: "WATCH_MODAL_SUBMIT_ERR"; instanceId: number; message: string }
  | { type: "WATCH_MODAL_SUBMIT_OK"; instanceId: number; watch: WatchSlot }
  | { type: "MESSAGE_MODAL_OPEN"; message: InboxMessage }
  | { type: "MESSAGE_MODAL_VIEW_MODE_SET"; viewMode: "html" | "text" }
  | { type: "MESSAGE_MODAL_CLOSE" }
  // SM-8: Logs Slice
  | { type: "LOGS_LOAD_START"; requestId: number }
  | {
      type: "LOGS_LOAD_OK";
      requestId: number;
      logs: readonly DeliveryLogEntry[];
      nextCursor?: string | null;
      hasMore?: boolean;
    }
  | { type: "LOGS_LOAD_ERR"; requestId: number; error: string }
  | { type: "LOGS_LOAD_MORE_START"; requestId: number }
  | {
      type: "LOGS_LOAD_MORE_OK";
      requestId: number;
      logs: readonly DeliveryLogEntry[];
      nextCursor: string | null;
      hasMore: boolean;
    }
  | { type: "LOGS_LOAD_MORE_ERR"; requestId: number }
  | { type: "LOGS_SEARCH_SET"; query: string }
  | { type: "LOGS_STATUS_FILTER_SET"; filter: LogStatusFilter }
  | { type: "LOGS_PAGE_SET"; page: number }
  | { type: "LOGS_PAGE_SIZE_SET"; pageSize: 10 | 20 | 50 }
  // SM-9: Confirm Dialog & Toast
  | {
      type: "CONFIRM_OPEN";
      title: string;
      message: string;
      confirmText: string;
      cancelText: string;
      danger: boolean;
    }
  | { type: "CONFIRM_EXEC_START"; instanceId: number }
  | { type: "CONFIRM_CLOSE"; instanceId?: number }
  | { type: "TOAST_SHOW"; message: string; tone: ToastTone }
  | { type: "TOAST_HIDE"; id: number };

/* ==========================================================================
   Pure State Machine Reducer
   ========================================================================== */
export function reduceAppState(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case "THEME_SET":
      return { ...state, theme: event.theme };

    case "TAB_SELECT": {
      if (state.auth.tag !== "authenticated") return state;
      const allowed = getAllowedTabsForRole(state.auth.principal.role);
      if (!allowed.includes(event.tab)) return state;
      return { ...state, activeTab: event.tab };
    }

    case "GLOBAL_REFRESH_START":
      return { ...state, globalRefreshing: true };

    case "GLOBAL_REFRESH_END":
      return { ...state, globalRefreshing: false };

    /* ---------------- SM-1: Auth & Session ---------------- */
    case "BOOT_VERIFY_OK": {
      if (state.auth.tag !== "booting" || state.auth.epoch !== event.epoch) {
        return state;
      }
      return {
        ...state,
        ...createEmptySlices(),
        mailDomain: event.principal.domain || state.mailDomain,
        activeTab: resolveTabForRole(
          event.principal.role,
          event.preferredTab,
        ),
        auth: {
          tag: "authenticated",
          epoch: state.auth.epoch,
          principal: event.principal,
        },
      };
    }

    case "BOOT_VERIFY_FAIL": {
      if (state.auth.tag !== "booting" || state.auth.epoch !== event.epoch) {
        return state;
      }
      const gateNotice =
        event.reason === "network"
          ? event.message || "无法连接服务器验证会话，请检查网络后重试"
          : state.auth.source === "url"
            ? "直达链接中的访问密钥无效、已重置或已吊销"
            : undefined;
      return {
        ...state,
        ...createEmptySlices(),
        auth: {
          tag: "unauthenticated",
          epoch: state.auth.epoch + 1,
          gateNotice,
          passwordRevealed: false,
          login: { status: "idle" },
        },
      };
    }

    case "GATE_TOGGLE_PASSWORD": {
      if (state.auth.tag !== "unauthenticated") return state;
      return {
        ...state,
        auth: {
          ...state.auth,
          passwordRevealed: !state.auth.passwordRevealed,
        },
      };
    }

    case "GATE_INPUT_CHANGED": {
      if (
        state.auth.tag !== "unauthenticated" ||
        state.auth.login.status !== "idle" ||
        !state.auth.login.error
      ) {
        return state;
      }
      return {
        ...state,
        auth: {
          ...state.auth,
          login: { status: "idle" },
        },
      };
    }

    case "LOGIN_SUBMIT": {
      // Guard: prevent double submit when already submitting
      if (
        state.auth.tag === "unauthenticated" &&
        state.auth.login.status === "submitting"
      ) {
        return state;
      }
      const cred = event.rawCredential.trim();
      const nextEpoch = state.auth.epoch + 1;
      if (!cred) {
        return {
          ...state,
          auth: {
            tag: "unauthenticated",
            epoch: nextEpoch,
            passwordRevealed:
              state.auth.tag === "unauthenticated"
                ? state.auth.passwordRevealed
                : false,
            login: {
              status: "idle",
              error: { kind: "empty_input", message: "请输入访问凭证" },
            },
          },
        };
      }
      return {
        ...state,
        ...createEmptySlices(),
        auth: {
          tag: "unauthenticated",
          epoch: nextEpoch,
          passwordRevealed:
            state.auth.tag === "unauthenticated"
              ? state.auth.passwordRevealed
              : false,
          login: { status: "submitting", credential: cred },
        },
      };
    }

    case "LOGIN_OK": {
      if (
        state.auth.tag !== "unauthenticated" ||
        state.auth.epoch !== event.epoch ||
        state.auth.login.status !== "submitting"
      ) {
        return state;
      }
      return {
        ...state,
        ...createEmptySlices(),
        mailDomain: event.principal.domain || state.mailDomain,
        activeTab: resolveTabForRole(
          event.principal.role,
          event.preferredTab,
        ),
        auth: {
          tag: "authenticated",
          epoch: state.auth.epoch,
          principal: event.principal,
        },
      };
    }

    case "LOGIN_FAIL": {
      if (
        state.auth.tag !== "unauthenticated" ||
        state.auth.epoch !== event.epoch
      ) {
        return state;
      }
      return {
        ...state,
        auth: {
          ...state.auth,
          login: { status: "idle", error: event.error },
        },
      };
    }

    case "HTTP_401_RECEIVED": {
      if (
        state.auth.tag !== "authenticated" ||
        state.auth.epoch !== event.epoch
      ) {
        return state;
      }
      const p = state.auth.principal;
      // Guard: Ignore 401 from old key during or right after self-key-rotation!
      if (p.credential !== event.usedCredential) {
        return state;
      }
      if (p.role === "user" && p.keyRotation === "rotating") {
        return state;
      }
      return {
        ...state,
        ...createEmptySlices(),
        auth: {
          tag: "unauthenticated",
          epoch: state.auth.epoch + 1,
          gateNotice: "当前会话凭证已过期、被重置或已暂停，请重新验证",
          passwordRevealed: false,
          login: { status: "idle" },
        },
      };
    }

    case "LOGOUT": {
      return {
        ...state,
        ...createEmptySlices(),
        auth: {
          tag: "unauthenticated",
          epoch: state.auth.epoch + 1,
          passwordRevealed: false,
          login: { status: "idle" },
        },
      };
    }

    case "USER_TOGGLE_API_DRAWER": {
      if (
        state.auth.tag !== "authenticated" ||
        state.auth.principal.role !== "user"
      ) {
        return state;
      }
      return {
        ...state,
        auth: {
          ...state.auth,
          principal: {
            ...state.auth.principal,
            apiDrawerOpen: !state.auth.principal.apiDrawerOpen,
          },
        },
      };
    }

    case "USER_TOGGLE_SECRET_REVEAL": {
      if (
        state.auth.tag !== "authenticated" ||
        state.auth.principal.role !== "user"
      ) {
        return state;
      }
      return {
        ...state,
        auth: {
          ...state.auth,
          principal: {
            ...state.auth.principal,
            secretRevealed: !state.auth.principal.secretRevealed,
          },
        },
      };
    }

    case "USER_ROTATE_KEY_START": {
      if (
        state.auth.tag !== "authenticated" ||
        state.auth.principal.role !== "user" ||
        state.auth.principal.keyRotation === "rotating"
      ) {
        return state;
      }
      return {
        ...state,
        auth: {
          ...state.auth,
          principal: {
            ...state.auth.principal,
            keyRotation: "rotating",
          },
        },
      };
    }

    case "USER_ROTATE_KEY_OK": {
      if (
        state.auth.tag !== "authenticated" ||
        state.auth.epoch !== event.epoch ||
        state.auth.principal.role !== "user"
      ) {
        return state;
      }
      return {
        ...state,
        auth: {
          ...state.auth,
          principal: {
            ...state.auth.principal,
            credential: event.nextKey,
            keyRotation: "idle",
          },
        },
      };
    }

    case "USER_ROTATE_KEY_FAIL": {
      if (
        state.auth.tag !== "authenticated" ||
        state.auth.epoch !== event.epoch ||
        state.auth.principal.role !== "user"
      ) {
        return state;
      }
      return {
        ...state,
        auth: {
          ...state.auth,
          principal: {
            ...state.auth.principal,
            keyRotation: "idle",
          },
        },
      };
    }

    /* ---------------- SM-3: Rules Slice ---------------- */
    case "RULES_LOAD_START":
      return {
        ...state,
        rules: {
          ...state.rules,
          resource: startResourceLoad(state.rules.resource, event.requestId),
        },
      };

    case "RULES_LOAD_OK":
      return {
        ...state,
        mailDomain: event.domain || state.mailDomain,
        rules: {
          ...state.rules,
          resource: completeResourceLoad(
            state.rules.resource,
            event.requestId,
            event.rules,
          ),
        },
      };

    case "RULES_LOAD_ERR":
      return {
        ...state,
        rules: {
          ...state.rules,
          resource: failResourceLoad(
            state.rules.resource,
            event.requestId,
            event.error,
          ),
        },
      };

    case "RULES_SEARCH_SET":
      return {
        ...state,
        rules: {
          ...state.rules,
          searchQuery: event.query,
          page: 1,
        },
      };

    case "RULES_PAGE_SET":
      return {
        ...state,
        rules: {
          ...state.rules,
          page: Math.max(1, event.page),
        },
      };

    case "RULES_PAGE_SIZE_SET":
      return {
        ...state,
        rules: {
          ...state.rules,
          pageSize: event.pageSize,
          page: 1,
        },
      };

    case "RULE_DELETE_ERR": {
      const nextPending = { ...state.rules.pendingByAddress };
      delete nextPending[event.address];
      return {
        ...state,
        rules: { ...state.rules, pendingByAddress: nextPending },
      };
    }

    case "RULE_DELETE_START": {
      if (state.rules.pendingByAddress[event.address]) return state;
      return {
        ...state,
        rules: {
          ...state.rules,
          pendingByAddress: {
            ...state.rules.pendingByAddress,
            [event.address]: { tag: "deleting" },
          },
        },
      };
    }

    case "RULE_DELETE_OK": {
      const nextPending = { ...state.rules.pendingByAddress };
      delete nextPending[event.address];
      const res = state.rules.resource;
      const nextRes =
        res.status === "ready"
          ? {
              ...res,
              data: res.data.filter((r) => r.address !== event.address),
            }
          : res;
      return {
        ...state,
        rules: {
          ...state.rules,
          resource: nextRes,
          pendingByAddress: nextPending,
        },
      };
    }

    /* ---------------- SM-4: Rule Modal ---------------- */
    case "RULE_MODAL_OPEN_ADD": {
      if (
        state.auth.tag !== "authenticated" ||
        state.auth.principal.role !== "admin"
      ) {
        return state;
      }
      const instanceId = state.nextInstanceId;
      return {
        ...state,
        nextInstanceId: instanceId + 1,
        primaryModal: {
          tag: "rule",
          modal: {
            instanceId,
            mode: { kind: "add" },
            draft: {
              addressPrefix: "",
              inboxEnabled: false,
              allowedSendersRaw: "",
              targets: [],
              newTargetInput: "",
            },
            status: "editing",
            verifyReqId: 0,
            verificationByAddr: {},
          },
        },
      };
    }

    case "RULE_MODAL_OPEN_EDIT": {
      if (
        state.auth.tag !== "authenticated" ||
        state.auth.principal.role === "user"
      ) {
        return state;
      }
      if (state.rules.pendingByAddress[event.rule.address]) return state;
      const instanceId = state.nextInstanceId;
      const targets = getRuleTargets(event.rule);
      const verificationByAddr: Record<string, { tag: "unchecked" }> = {};
      for (const t of targets) {
        verificationByAddr[t.address] = { tag: "unchecked" };
      }
      return {
        ...state,
        nextInstanceId: instanceId + 1,
        primaryModal: {
          tag: "rule",
          modal: {
            instanceId,
            mode: {
              kind: "edit",
              originalAddress: event.rule.address,
              keySlice: event.rule.inboxKey
                ? {
                    tag: "present",
                    key: event.rule.inboxKey,
                    revealed: false,
                    op: "idle",
                  }
                : { tag: "none", revokedInSession: false },
            },
            draft: {
              addressPrefix: stripDomainSuffix(
                event.rule.address,
                state.mailDomain,
              ),
              inboxEnabled: Boolean(event.rule.inboxEnabled),
              allowedSendersRaw: Array.isArray(event.rule.allowedSenders)
                ? event.rule.allowedSenders.join(", ")
                : "",
              targets,
              newTargetInput: "",
            },
            status: "editing",
            verifyReqId: 0,
            verificationByAddr,
          },
        },
      };
    }

    case "RULE_MODAL_CLOSE": {
      if (state.primaryModal.tag !== "rule") return state;
      if (state.primaryModal.modal.status === "submitting") return state;
      return { ...state, primaryModal: { tag: "none" } };
    }

    case "RULE_MODAL_DRAFT_PATCH": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.status === "submitting") return state;
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: {
            ...m,
            validationError: undefined,
            draft: { ...m.draft, ...event.patch },
          },
        },
      };
    }

    case "RULE_MODAL_ADD_TARGETS": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.status === "submitting") return state;
      const nextTargets = [...m.draft.targets];
      const nextVerify = { ...m.verificationByAddr };
      for (const raw of event.addresses) {
        const addr = raw.trim().toLowerCase();
        if (!addr) continue;
        if (!nextTargets.some((t) => t.address === addr)) {
          nextTargets.push({ address: addr, enabled: true });
          if (!nextVerify[addr]) {
            nextVerify[addr] = { tag: "unchecked" };
          }
        }
      }
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: {
            ...m,
            validationError: undefined,
            draft: { ...m.draft, targets: nextTargets, newTargetInput: "" },
            verificationByAddr: nextVerify,
          },
        },
      };
    }

    case "RULE_MODAL_TOGGLE_TARGET": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.status === "submitting") return state;
      const nextTargets = m.draft.targets.map((t, idx) =>
        idx === event.index ? { ...t, enabled: event.enabled } : t,
      );
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: {
            ...m,
            draft: { ...m.draft, targets: nextTargets },
          },
        },
      };
    }

    case "RULE_MODAL_REMOVE_TARGET": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.status === "submitting") return state;
      const nextTargets = m.draft.targets.filter((_, idx) => idx !== event.index);
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: {
            ...m,
            draft: { ...m.draft, targets: nextTargets },
          },
        },
      };
    }

    case "RULE_MODAL_SET_ERROR": {
      if (state.primaryModal.tag !== "rule") return state;
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: {
            ...state.primaryModal.modal,
            validationError: event.message,
          },
        },
      };
    }

    case "RULE_MODAL_SUBMIT_START": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.instanceId !== event.instanceId || m.status === "submitting") {
        return state;
      }
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: { ...m, status: "submitting", validationError: undefined },
        },
      };
    }

    case "RULE_MODAL_SUBMIT_ERR": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.instanceId !== event.instanceId) return state;
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: { ...m, status: "editing", validationError: event.message },
        },
      };
    }

    case "RULE_MODAL_SUBMIT_OK": {
      if (state.primaryModal.tag !== "rule") return state;
      if (state.primaryModal.modal.instanceId !== event.instanceId) return state;
      return { ...state, primaryModal: { tag: "none" } };
    }

    case "RULE_MODAL_VERIFY_CHECK_START": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.instanceId !== event.instanceId) return state;
      const nextMap = { ...m.verificationByAddr };
      for (const addr of event.addresses) {
        const cur = nextMap[addr];
        // Never overwrite an active per-target "sending" lock!
        if (!cur || cur.tag !== "sending") {
          nextMap[addr] = { tag: "checking" };
        }
      }
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: {
            ...m,
            verifyReqId: event.verifyReqId,
            verificationByAddr: nextMap,
          },
        },
      };
    }

    case "RULE_MODAL_VERIFY_CHECK_OK": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (
        m.instanceId !== event.instanceId ||
        m.verifyReqId !== event.verifyReqId
      ) {
        return state;
      }
      const nextMap = { ...m.verificationByAddr };
      for (const item of event.results) {
        const cur = nextMap[item.address];
        if (!cur || cur.tag !== "sending") {
          nextMap[item.address] = {
            tag: "checked",
            status: item.status,
            message: item.message,
          };
        }
      }
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: { ...m, verificationByAddr: nextMap },
        },
      };
    }

    case "RULE_MODAL_VERIFY_CHECK_ERR": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (
        m.instanceId !== event.instanceId ||
        m.verifyReqId !== event.verifyReqId
      ) {
        return state;
      }
      const nextMap = { ...m.verificationByAddr };
      for (const [addr, cur] of Object.entries(nextMap)) {
        if (cur.tag === "checking") {
          nextMap[addr] = { tag: "checked", status: "unknown" };
        }
      }
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: { ...m, verificationByAddr: nextMap },
        },
      };
    }

    case "RULE_MODAL_SEND_VERIFY_START": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.instanceId !== event.instanceId) return state;
      const cur = m.verificationByAddr[event.address];
      if (cur?.tag === "sending") return state;
      const prevStatus: "pending" | "missing" =
        cur?.tag === "checked" && cur.status === "missing"
          ? "missing"
          : "pending";
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: {
            ...m,
            verificationByAddr: {
              ...m.verificationByAddr,
              [event.address]: { tag: "sending", prevStatus },
            },
          },
        },
      };
    }

    case "RULE_MODAL_SEND_VERIFY_DONE": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.instanceId !== event.instanceId) return state;
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: {
            ...m,
            verificationByAddr: {
              ...m.verificationByAddr,
              [event.address]: {
                tag: "checked",
                status: event.nextStatus,
                message: event.message,
              },
            },
          },
        },
      };
    }

    case "RULE_MODAL_KEY_TOGGLE_REVEAL": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.mode.kind !== "edit" || m.mode.keySlice.tag !== "present") {
        return state;
      }
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: {
            ...m,
            mode: {
              ...m.mode,
              keySlice: {
                ...m.mode.keySlice,
                revealed: !m.mode.keySlice.revealed,
              },
            },
          },
        },
      };
    }

    case "RULE_MODAL_KEY_OP_START": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.instanceId !== event.instanceId || m.mode.kind !== "edit") {
        return state;
      }
      if (m.mode.keySlice.tag === "present") {
        if (m.mode.keySlice.op !== "idle") return state;
        return {
          ...state,
          primaryModal: {
            tag: "rule",
            modal: {
              ...m,
              mode: {
                ...m.mode,
                keySlice: { ...m.mode.keySlice, op: event.op },
              },
            },
          },
        };
      }
      // Allow rotating/generating a fresh key when keySlice.tag === "none"
      if (event.op === "rotating") {
        return {
          ...state,
          primaryModal: {
            tag: "rule",
            modal: {
              ...m,
              mode: {
                ...m.mode,
                keySlice: {
                  tag: "present",
                  key: "",
                  revealed: true,
                  op: "rotating",
                },
              },
            },
          },
        };
      }
      return state;
    }

    case "RULE_MODAL_KEY_ROTATE_OK": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.instanceId !== event.instanceId || m.mode.kind !== "edit") {
        return state;
      }
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: {
            ...m,
            draft: { ...m.draft, inboxEnabled: true },
            mode: {
              ...m.mode,
              keySlice: {
                tag: "present",
                key: event.inboxKey,
                revealed: true,
                op: "idle",
              },
            },
          },
        },
      };
    }

    case "RULE_MODAL_KEY_REVOKE_OK": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.instanceId !== event.instanceId || m.mode.kind !== "edit") {
        return state;
      }
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: {
            ...m,
            mode: {
              ...m.mode,
              // Mark revokedInSession=true so saving with inboxEnabled=true sends generateKey:false!
              keySlice: { tag: "none", revokedInSession: true },
            },
          },
        },
      };
    }

    case "RULE_MODAL_KEY_OP_ERR": {
      if (state.primaryModal.tag !== "rule") return state;
      const m = state.primaryModal.modal;
      if (m.instanceId !== event.instanceId || m.mode.kind !== "edit") {
        return state;
      }
      const ks = m.mode.keySlice;
      const nextKs =
        ks.tag === "present"
          ? ks.key
            ? { ...ks, op: "idle" as const }
            : { tag: "none" as const, revokedInSession: true }
          : ks;
      return {
        ...state,
        primaryModal: {
          tag: "rule",
          modal: {
            ...m,
            mode: { ...m.mode, keySlice: nextKs },
          },
        },
      };
    }

    /* ---------------- SM-5 & SM-6: Tokens Slice & Modal ---------------- */
    case "TOKENS_LOAD_START":
      return {
        ...state,
        tokens: {
          ...state.tokens,
          resource: startResourceLoad(state.tokens.resource, event.requestId),
        },
      };

    case "TOKENS_LOAD_OK":
      return {
        ...state,
        tokens: {
          ...state.tokens,
          resource: completeResourceLoad(
            state.tokens.resource,
            event.requestId,
            event.tokens,
          ),
        },
      };

    case "TOKENS_LOAD_ERR":
      return {
        ...state,
        tokens: {
          ...state.tokens,
          resource: failResourceLoad(
            state.tokens.resource,
            event.requestId,
            event.error,
          ),
        },
      };

    case "TOKENS_SEARCH_SET":
      return {
        ...state,
        tokens: { ...state.tokens, searchQuery: event.query },
      };

    case "TOKENS_DISMISS_BANNER":
      return {
        ...state,
        tokens: { ...state.tokens, newlyIssuedBanner: undefined },
      };

    case "TOKEN_ROW_OP_START": {
      if (state.tokens.pendingById[event.id]) return state;
      return {
        ...state,
        tokens: {
          ...state.tokens,
          pendingById: {
            ...state.tokens.pendingById,
            [event.id]: event.op,
          },
        },
      };
    }

    case "TOKEN_ROW_TOGGLE_OK": {
      const nextPending = { ...state.tokens.pendingById };
      delete nextPending[event.id];
      const res = state.tokens.resource;
      const nextRes =
        res.status === "ready"
          ? {
              ...res,
              data: res.data.map((t) =>
                t.id === event.id ? event.updated : t,
              ),
            }
          : res;
      return {
        ...state,
        tokens: {
          ...state.tokens,
          resource: nextRes,
          pendingById: nextPending,
        },
      };
    }

    case "TOKEN_ROW_ROTATE_OK": {
      const nextPending = { ...state.tokens.pendingById };
      delete nextPending[event.id];
      const res = state.tokens.resource;
      const nextRes =
        res.status === "ready"
          ? {
              ...res,
              data: res.data.map((t) =>
                t.id === event.id ? event.updated : t,
              ),
            }
          : res;
      return {
        ...state,
        tokens: {
          ...state.tokens,
          resource: nextRes,
          pendingById: nextPending,
          newlyIssuedBanner: {
            name: event.updated.name,
            token: event.updated.token,
            action: "rotated",
          },
        },
      };
    }

    case "TOKEN_ROW_DELETE_OK": {
      const nextPending = { ...state.tokens.pendingById };
      delete nextPending[event.id];
      const res = state.tokens.resource;
      const nextRes =
        res.status === "ready"
          ? {
              ...res,
              data: res.data.filter((t) => t.id !== event.id),
            }
          : res;
      return {
        ...state,
        tokens: {
          ...state.tokens,
          resource: nextRes,
          pendingById: nextPending,
        },
      };
    }

    case "TOKEN_ROW_OP_ERR": {
      const nextPending = { ...state.tokens.pendingById };
      delete nextPending[event.id];
      return {
        ...state,
        tokens: { ...state.tokens, pendingById: nextPending },
      };
    }

    case "TOKEN_MODAL_OPEN_ADD": {
      if (
        state.auth.tag !== "authenticated" ||
        state.auth.principal.role !== "admin"
      ) {
        return state;
      }
      const instanceId = state.nextInstanceId;
      return {
        ...state,
        nextInstanceId: instanceId + 1,
        primaryModal: {
          tag: "token",
          modal: {
            instanceId,
            mode: { kind: "add" },
            draft: {
              name: "",
              enabled: true,
              expiresLocalIso: "",
              addresses: [],
            },
            dropdown: {
              open: false,
              filterQuery: "",
              activeIndex: 0,
            },
            status: "editing",
          },
        },
      };
    }

    case "TOKEN_MODAL_OPEN_EDIT": {
      if (
        state.auth.tag !== "authenticated" ||
        state.auth.principal.role !== "admin"
      ) {
        return state;
      }
      if (state.tokens.pendingById[event.token.id]) return state;
      const instanceId = state.nextInstanceId;
      return {
        ...state,
        nextInstanceId: instanceId + 1,
        primaryModal: {
          tag: "token",
          modal: {
            instanceId,
            mode: { kind: "edit", tokenId: event.token.id },
            draft: {
              name: event.token.name,
              enabled: event.token.enabled !== false,
              expiresLocalIso: toDatetimeLocalValue(event.token.expiresAt),
              addresses: [...(event.token.addresses ?? [])],
            },
            dropdown: {
              open: false,
              filterQuery: "",
              activeIndex: 0,
            },
            status: "editing",
          },
        },
      };
    }

    case "TOKEN_MODAL_CLOSE": {
      if (state.primaryModal.tag !== "token") return state;
      if (state.primaryModal.modal.status === "submitting") return state;
      return { ...state, primaryModal: { tag: "none" } };
    }

    case "TOKEN_MODAL_DRAFT_PATCH": {
      if (state.primaryModal.tag !== "token") return state;
      const m = state.primaryModal.modal;
      if (m.status === "submitting") return state;
      return {
        ...state,
        primaryModal: {
          tag: "token",
          modal: {
            ...m,
            validationError: undefined,
            draft: { ...m.draft, ...event.patch },
          },
        },
      };
    }

    case "TOKEN_MODAL_DROPDOWN_TOGGLE": {
      if (state.primaryModal.tag !== "token") return state;
      const m = state.primaryModal.modal;
      if (m.status === "submitting") return state;
      const nextOpen = event.open ?? !m.dropdown.open;
      if (nextOpen === m.dropdown.open) return state;
      return {
        ...state,
        primaryModal: {
          tag: "token",
          modal: {
            ...m,
            dropdown: nextOpen
              ? { ...m.dropdown, open: true, activeIndex: 0 }
              : { open: false, filterQuery: "", activeIndex: 0 },
          },
        },
      };
    }

    case "TOKEN_MODAL_FILTER_SET": {
      if (state.primaryModal.tag !== "token") return state;
      const m = state.primaryModal.modal;
      if (m.status === "submitting") return state;
      return {
        ...state,
        primaryModal: {
          tag: "token",
          modal: {
            ...m,
            dropdown: {
              open: true,
              filterQuery: event.query,
              activeIndex: 0,
            },
          },
        },
      };
    }

    case "TOKEN_MODAL_ACTIVE_INDEX_SET": {
      if (state.primaryModal.tag !== "token") return state;
      const m = state.primaryModal.modal;
      if (!m.dropdown.open || m.dropdown.activeIndex === event.index) {
        return state;
      }
      return {
        ...state,
        primaryModal: {
          tag: "token",
          modal: {
            ...m,
            dropdown: { ...m.dropdown, activeIndex: Math.max(0, event.index) },
          },
        },
      };
    }

    case "TOKEN_MODAL_TOGGLE_ADDRESS": {
      if (state.primaryModal.tag !== "token") return state;
      const m = state.primaryModal.modal;
      if (m.status === "submitting") return state;
      const has = m.draft.addresses.includes(event.address);
      const next = has
        ? m.draft.addresses.filter((a) => a !== event.address)
        : [...m.draft.addresses, event.address].sort((a, b) =>
            a.localeCompare(b),
          );
      return {
        ...state,
        primaryModal: {
          tag: "token",
          modal: {
            ...m,
            validationError: undefined,
            draft: { ...m.draft, addresses: next },
          },
        },
      };
    }

    case "TOKEN_MODAL_ADD_ADDRESSES": {
      if (state.primaryModal.tag !== "token") return state;
      const m = state.primaryModal.modal;
      if (m.status === "submitting") return state;
      const set = new Set(m.draft.addresses);
      for (const raw of event.addresses) {
        const norm = normalizePrefixInput(raw, state.mailDomain);
        if (norm && isValidEmailAddress(norm)) set.add(norm);
      }
      const next = [...set].sort((a, b) => a.localeCompare(b));
      return {
        ...state,
        primaryModal: {
          tag: "token",
          modal: {
            ...m,
            validationError: undefined,
            draft: { ...m.draft, addresses: next },
            dropdown: { ...m.dropdown, filterQuery: "", activeIndex: 0 },
          },
        },
      };
    }

    case "TOKEN_MODAL_SELECT_MANY": {
      if (state.primaryModal.tag !== "token") return state;
      const m = state.primaryModal.modal;
      if (m.status === "submitting") return state;
      const set = new Set(m.draft.addresses);
      for (const addr of event.addresses) {
        if (addr) set.add(addr);
      }
      const next = [...set].sort((a, b) => a.localeCompare(b));
      return {
        ...state,
        primaryModal: {
          tag: "token",
          modal: {
            ...m,
            validationError: undefined,
            draft: { ...m.draft, addresses: next },
          },
        },
      };
    }

    case "TOKEN_MODAL_CLEAR_ADDRESSES": {
      if (state.primaryModal.tag !== "token") return state;
      const m = state.primaryModal.modal;
      if (m.status === "submitting" || m.draft.addresses.length === 0) {
        return state;
      }
      return {
        ...state,
        primaryModal: {
          tag: "token",
          modal: {
            ...m,
            validationError: undefined,
            draft: { ...m.draft, addresses: [] },
          },
        },
      };
    }

    case "TOKEN_MODAL_REMOVE_ADDRESS": {
      if (state.primaryModal.tag !== "token") return state;
      const m = state.primaryModal.modal;
      if (m.status === "submitting") return state;
      return {
        ...state,
        primaryModal: {
          tag: "token",
          modal: {
            ...m,
            draft: {
              ...m.draft,
              addresses: m.draft.addresses.filter((a) => a !== event.address),
            },
          },
        },
      };
    }

    case "TOKEN_MODAL_SET_ERROR": {
      if (state.primaryModal.tag !== "token") return state;
      return {
        ...state,
        primaryModal: {
          tag: "token",
          modal: {
            ...state.primaryModal.modal,
            validationError: event.message,
          },
        },
      };
    }

    case "TOKEN_MODAL_SUBMIT_START": {
      if (state.primaryModal.tag !== "token") return state;
      const m = state.primaryModal.modal;
      if (m.instanceId !== event.instanceId || m.status === "submitting") {
        return state;
      }
      return {
        ...state,
        primaryModal: {
          tag: "token",
          modal: {
            ...m,
            status: "submitting",
            validationError: undefined,
            dropdown: { open: false, filterQuery: "", activeIndex: 0 },
          },
        },
      };
    }

    case "TOKEN_MODAL_SUBMIT_ERR": {
      if (state.primaryModal.tag !== "token") return state;
      const m = state.primaryModal.modal;
      if (m.instanceId !== event.instanceId) return state;
      return {
        ...state,
        primaryModal: {
          tag: "token",
          modal: { ...m, status: "editing", validationError: event.message },
        },
      };
    }

    case "TOKEN_MODAL_SUBMIT_OK": {
      if (state.primaryModal.tag !== "token") return state;
      if (state.primaryModal.modal.instanceId !== event.instanceId) {
        return state;
      }
      return {
        ...state,
        primaryModal: { tag: "none" },
        tokens: event.createdBanner
          ? {
              ...state.tokens,
              newlyIssuedBanner: {
                name: event.createdBanner.name,
                token: event.createdBanner.token,
                action: "created",
              },
            }
          : state.tokens,
      };
    }

    case "TOKEN_ADDRS_MODAL_OPEN": {
      if (
        state.auth.tag !== "authenticated" ||
        state.auth.principal.role !== "admin"
      ) {
        return state;
      }
      return {
        ...state,
        primaryModal: {
          tag: "tokenAddrs",
          modal: {
            tokenId: event.token.id,
            tokenName: event.token.name,
            addresses: [...(event.token.addresses ?? [])],
            searchQuery: "",
          },
        },
      };
    }

    case "TOKEN_ADDRS_MODAL_SEARCH_SET": {
      if (state.primaryModal.tag !== "tokenAddrs") return state;
      return {
        ...state,
        primaryModal: {
          tag: "tokenAddrs",
          modal: {
            ...state.primaryModal.modal,
            searchQuery: event.query,
          },
        },
      };
    }

    case "TOKEN_ADDRS_MODAL_CLOSE": {
      if (state.primaryModal.tag !== "tokenAddrs") return state;
      return { ...state, primaryModal: { tag: "none" } };
    }

    /* ---------------- SM-7: Inbox Slice, Watch Slots & Message Modal ---------------- */
    case "INBOX_LOAD_START":
      return {
        ...state,
        inbox: {
          ...state.inbox,
          appliedFilter: event.appliedFilter,
          loadingMoreReqId: undefined,
          resource: startResourceLoad(state.inbox.resource, event.requestId),
        },
      };

    case "INBOX_LOAD_OK": {
      const nextRes = completeResourceLoad(
        state.inbox.resource,
        event.requestId,
        event.messages,
      );
      if (nextRes === state.inbox.resource) return state;
      return {
        ...state,
        inbox: {
          ...state.inbox,
          resource: nextRes,
          nextCursor: event.nextCursor ?? null,
          hasMore: Boolean(event.hasMore),
          loadingMoreReqId: undefined,
        },
      };
    }

    case "INBOX_LOAD_ERR":
      return {
        ...state,
        inbox: {
          ...state.inbox,
          loadingMoreReqId: undefined,
          resource: failResourceLoad(
            state.inbox.resource,
            event.requestId,
            event.error,
          ),
        },
      };

    case "INBOX_LOAD_MORE_START": {
      if (
        state.inbox.resource.status !== "ready" ||
        !state.inbox.hasMore ||
        !state.inbox.nextCursor ||
        state.inbox.loadingMoreReqId !== undefined
      ) {
        return state;
      }
      return {
        ...state,
        inbox: {
          ...state.inbox,
          loadingMoreReqId: event.requestId,
        },
      };
    }

    case "INBOX_LOAD_MORE_OK": {
      if (
        state.inbox.resource.status !== "ready" ||
        state.inbox.loadingMoreReqId !== event.requestId
      ) {
        return state;
      }
      const seen = new Set(state.inbox.resource.data.map((m) => m.id));
      const merged = [
        ...state.inbox.resource.data,
        ...event.messages.filter((m) => !seen.has(m.id)),
      ];
      return {
        ...state,
        inbox: {
          ...state.inbox,
          resource: { ...state.inbox.resource, data: merged },
          nextCursor: event.nextCursor,
          hasMore: event.hasMore,
          loadingMoreReqId: undefined,
        },
      };
    }

    case "INBOX_LOAD_MORE_ERR": {
      if (state.inbox.loadingMoreReqId !== event.requestId) return state;
      return {
        ...state,
        inbox: { ...state.inbox, loadingMoreReqId: undefined },
      };
    }

    case "INBOX_FILTER_INPUT_SET":
      return {
        ...state,
        inbox: { ...state.inbox, filterInput: event.value },
      };

    case "INBOX_UNREAD_TOGGLE":
      return {
        ...state,
        inbox: { ...state.inbox, unreadOnly: event.unreadOnly },
      };

    case "INBOX_ROW_OP_START": {
      if (state.inbox.pendingById[event.id]) return state;
      return {
        ...state,
        inbox: {
          ...state.inbox,
          pendingById: {
            ...state.inbox.pendingById,
            [event.id]: event.op,
          },
        },
      };
    }

    case "INBOX_ROW_ACK_OK": {
      const nextPending = { ...state.inbox.pendingById };
      delete nextPending[event.id];
      const res = state.inbox.resource;
      const nextRes =
        res.status === "ready"
          ? {
              ...res,
              data: res.data.map((m) =>
                m.id === event.id ? { ...m, read: true } : m,
              ),
            }
          : res;
      return {
        ...state,
        inbox: {
          ...state.inbox,
          resource: nextRes,
          pendingById: nextPending,
        },
      };
    }

    case "INBOX_ROW_DELETE_OK":
    case "INBOX_ROW_GONE_404": {
      const nextPending = { ...state.inbox.pendingById };
      delete nextPending[event.id];
      const res = state.inbox.resource;
      const nextRes =
        res.status === "ready"
          ? {
              ...res,
              data: res.data.filter((m) => m.id !== event.id),
            }
          : res;
      const nextModal =
        state.primaryModal.tag === "message" &&
        state.primaryModal.modal.messageId === event.id
          ? { tag: "none" as const }
          : state.primaryModal;
      return {
        ...state,
        primaryModal: nextModal,
        inbox: {
          ...state.inbox,
          resource: nextRes,
          pendingById: nextPending,
        },
      };
    }

    case "INBOX_ROW_OP_ERR": {
      const nextPending = { ...state.inbox.pendingById };
      delete nextPending[event.id];
      return {
        ...state,
        inbox: { ...state.inbox, pendingById: nextPending },
      };
    }

    case "WATCHES_LOAD_START":
      return {
        ...state,
        watches: {
          ...state.watches,
          resource: startResourceLoad(state.watches.resource, event.requestId),
        },
      };

    case "WATCHES_LOAD_OK":
      return {
        ...state,
        watches: {
          ...state.watches,
          resource: completeResourceLoad(
            state.watches.resource,
            event.requestId,
            event.watches,
          ),
        },
      };

    case "WATCHES_LOAD_ERR":
      return {
        ...state,
        watches: {
          ...state.watches,
          resource: failResourceLoad(
            state.watches.resource,
            event.requestId,
            event.error,
          ),
        },
      };

    case "WATCH_UNWATCH_START": {
      if (state.watches.pendingUnwatchByAddr[event.address]) return state;
      return {
        ...state,
        watches: {
          ...state.watches,
          pendingUnwatchByAddr: {
            ...state.watches.pendingUnwatchByAddr,
            [event.address]: true,
          },
        },
      };
    }

    case "WATCH_UNWATCH_OK": {
      const nextPending = { ...state.watches.pendingUnwatchByAddr };
      delete nextPending[event.address];
      const res = state.watches.resource;
      const nextRes =
        res.status === "ready"
          ? {
              ...res,
              data: res.data.filter((w) => w.address !== event.address),
            }
          : res;
      return {
        ...state,
        watches: {
          resource: nextRes,
          pendingUnwatchByAddr: nextPending,
        },
      };
    }

    case "WATCH_UNWATCH_ERR": {
      const nextPending = { ...state.watches.pendingUnwatchByAddr };
      delete nextPending[event.address];
      return {
        ...state,
        watches: {
          ...state.watches,
          pendingUnwatchByAddr: nextPending,
        },
      };
    }

    case "WATCH_MODAL_OPEN": {
      if (
        state.auth.tag !== "authenticated" ||
        state.auth.principal.role !== "admin"
      ) {
        return state;
      }
      const instanceId = state.nextInstanceId;
      return {
        ...state,
        nextInstanceId: instanceId + 1,
        primaryModal: {
          tag: "watch",
          modal: {
            instanceId,
            draft: {
              addressPrefix: "",
              ttlSeconds: 1800,
              allowedSendersRaw: "",
            },
            status: "editing",
          },
        },
      };
    }

    case "WATCH_MODAL_CLOSE": {
      if (state.primaryModal.tag !== "watch") return state;
      if (state.primaryModal.modal.status === "submitting") return state;
      return { ...state, primaryModal: { tag: "none" } };
    }

    case "WATCH_MODAL_DRAFT_PATCH": {
      if (state.primaryModal.tag !== "watch") return state;
      const m = state.primaryModal.modal;
      if (m.status === "submitting") return state;
      return {
        ...state,
        primaryModal: {
          tag: "watch",
          modal: {
            ...m,
            validationError: undefined,
            draft: { ...m.draft, ...event.patch },
          },
        },
      };
    }

    case "WATCH_MODAL_SET_ERROR": {
      if (state.primaryModal.tag !== "watch") return state;
      return {
        ...state,
        primaryModal: {
          tag: "watch",
          modal: {
            ...state.primaryModal.modal,
            validationError: event.message,
          },
        },
      };
    }

    case "WATCH_MODAL_SUBMIT_START": {
      if (state.primaryModal.tag !== "watch") return state;
      const m = state.primaryModal.modal;
      if (m.instanceId !== event.instanceId || m.status === "submitting") {
        return state;
      }
      return {
        ...state,
        primaryModal: {
          tag: "watch",
          modal: { ...m, status: "submitting", validationError: undefined },
        },
      };
    }

    case "WATCH_MODAL_SUBMIT_ERR": {
      if (state.primaryModal.tag !== "watch") return state;
      const m = state.primaryModal.modal;
      if (m.instanceId !== event.instanceId) return state;
      return {
        ...state,
        primaryModal: {
          tag: "watch",
          modal: { ...m, status: "editing", validationError: event.message },
        },
      };
    }

    case "WATCH_MODAL_SUBMIT_OK": {
      if (state.primaryModal.tag !== "watch") return state;
      if (state.primaryModal.modal.instanceId !== event.instanceId) {
        return state;
      }
      const res = state.watches.resource;
      const nextWatchesRes =
        res.status === "ready"
          ? {
              ...res,
              data: [
                ...res.data.filter((w) => w.address !== event.watch.address),
                event.watch,
              ].sort((a, b) => a.address.localeCompare(b.address)),
            }
          : {
              status: "ready" as const,
              data: [event.watch],
              requestId: 1,
            };
      return {
        ...state,
        primaryModal: { tag: "none" },
        watches: {
          ...state.watches,
          resource: nextWatchesRes,
        },
      };
    }

    case "MESSAGE_MODAL_OPEN": {
      const hasHtml = Boolean(
        event.message.html && event.message.html.trim().length > 0,
      );
      return {
        ...state,
        primaryModal: {
          tag: "message",
          modal: {
            messageId: event.message.id,
            snapshot: event.message,
            viewMode: hasHtml ? "html" : "text",
          },
        },
      };
    }

    case "MESSAGE_MODAL_VIEW_MODE_SET": {
      if (state.primaryModal.tag !== "message") return state;
      const m = state.primaryModal.modal;
      const hasHtml = Boolean(
        m.snapshot.html && m.snapshot.html.trim().length > 0,
      );
      if (event.viewMode === "html" && !hasHtml) return state;
      if (m.viewMode === event.viewMode) return state;
      return {
        ...state,
        primaryModal: {
          tag: "message",
          modal: {
            ...m,
            viewMode: event.viewMode,
          },
        },
      };
    }

    case "MESSAGE_MODAL_CLOSE":
      if (state.primaryModal.tag !== "message") return state;
      return { ...state, primaryModal: { tag: "none" } };

    /* ---------------- SM-8: Logs Slice ---------------- */
    case "LOGS_LOAD_START":
      return {
        ...state,
        logs: {
          ...state.logs,
          loadingMoreReqId: undefined,
          resource: startResourceLoad(state.logs.resource, event.requestId),
        },
      };

    case "LOGS_LOAD_OK": {
      const nextRes = completeResourceLoad(
        state.logs.resource,
        event.requestId,
        event.logs,
      );
      if (nextRes === state.logs.resource) return state;
      return {
        ...state,
        logs: {
          ...state.logs,
          resource: nextRes,
          nextCursor: event.nextCursor ?? null,
          hasMore: Boolean(event.hasMore),
          loadingMoreReqId: undefined,
        },
      };
    }

    case "LOGS_LOAD_ERR":
      return {
        ...state,
        logs: {
          ...state.logs,
          loadingMoreReqId: undefined,
          resource: failResourceLoad(
            state.logs.resource,
            event.requestId,
            event.error,
          ),
        },
      };

    case "LOGS_LOAD_MORE_START": {
      if (
        state.logs.resource.status !== "ready" ||
        !state.logs.hasMore ||
        !state.logs.nextCursor ||
        state.logs.loadingMoreReqId !== undefined
      ) {
        return state;
      }
      return {
        ...state,
        logs: {
          ...state.logs,
          loadingMoreReqId: event.requestId,
        },
      };
    }

    case "LOGS_LOAD_MORE_OK": {
      if (
        state.logs.resource.status !== "ready" ||
        state.logs.loadingMoreReqId !== event.requestId
      ) {
        return state;
      }
      const seen = new Set(state.logs.resource.data.map((l) => l.id));
      const merged = [
        ...state.logs.resource.data,
        ...event.logs.filter((l) => !seen.has(l.id)),
      ];
      return {
        ...state,
        logs: {
          ...state.logs,
          resource: { ...state.logs.resource, data: merged },
          nextCursor: event.nextCursor,
          hasMore: event.hasMore,
          loadingMoreReqId: undefined,
        },
      };
    }

    case "LOGS_LOAD_MORE_ERR": {
      if (state.logs.loadingMoreReqId !== event.requestId) return state;
      return {
        ...state,
        logs: { ...state.logs, loadingMoreReqId: undefined },
      };
    }

    case "LOGS_SEARCH_SET":
      return {
        ...state,
        logs: { ...state.logs, searchQuery: event.query, page: 1 },
      };

    case "LOGS_STATUS_FILTER_SET":
      return {
        ...state,
        logs: { ...state.logs, statusFilter: event.filter, page: 1 },
      };

    case "LOGS_PAGE_SET":
      return {
        ...state,
        logs: { ...state.logs, page: Math.max(1, event.page) },
      };

    case "LOGS_PAGE_SIZE_SET":
      return {
        ...state,
        logs: { ...state.logs, pageSize: event.pageSize, page: 1 },
      };

    /* ---------------- SM-9: Confirm Dialog & Toast ---------------- */
    case "CONFIRM_OPEN": {
      if (state.confirmDialog.tag === "open") return state;
      const instanceId = state.nextInstanceId;
      return {
        ...state,
        nextInstanceId: instanceId + 1,
        confirmDialog: {
          tag: "open",
          instanceId,
          title: event.title,
          message: event.message,
          confirmText: event.confirmText,
          cancelText: event.cancelText,
          danger: event.danger,
          status: "awaiting_decision",
        },
      };
    }

    case "CONFIRM_EXEC_START": {
      if (state.confirmDialog.tag !== "open") return state;
      if (
        state.confirmDialog.instanceId !== event.instanceId ||
        state.confirmDialog.status === "executing"
      ) {
        return state;
      }
      return {
        ...state,
        confirmDialog: {
          ...state.confirmDialog,
          status: "executing",
        },
      };
    }

    case "CONFIRM_CLOSE": {
      if (state.confirmDialog.tag !== "open") return state;
      if (
        event.instanceId !== undefined &&
        state.confirmDialog.instanceId !== event.instanceId
      ) {
        return state;
      }
      return {
        ...state,
        confirmDialog: { tag: "closed" },
      };
    }

    case "TOAST_SHOW": {
      const id = state.toast.nextId;
      return {
        ...state,
        toast: {
          tag: "visible",
          id,
          nextId: id + 1,
          message: event.message,
          tone: event.tone,
        },
      };
    }

    case "TOAST_HIDE": {
      if (state.toast.tag !== "visible" || state.toast.id !== event.id) {
        return state;
      }
      return {
        ...state,
        toast: { tag: "hidden", nextId: state.toast.nextId },
      };
    }

    default:
      return assertNever(event);
  }
}

/* ==========================================================================
   Pure View Selectors & Derived State Calculators
   ========================================================================== */
export function toDatetimeLocalValue(epochMs?: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return "";
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function selectTokensByRuleAddress(
  state: AppState,
): ReadonlyMap<string, TenantToken[]> {
  const map = new Map<string, TenantToken[]>();
  if (
    state.auth.tag !== "authenticated" ||
    state.auth.principal.role !== "admin" ||
    state.tokens.resource.status !== "ready"
  ) {
    return map;
  }
  for (const tok of state.tokens.resource.data) {
    for (const addr of tok.addresses ?? []) {
      const list = map.get(addr) ?? [];
      list.push(tok);
      map.set(addr, list);
    }
  }
  return map;
}

export function selectRulesTableModel(state: AppState): {
  readonly items: readonly ForwardRule[];
  readonly totalAll: number;
  readonly totalFiltered: number;
  readonly page: number;
  readonly totalPages: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly linkedTokensMap: ReadonlyMap<string, TenantToken[]>;
} {
  const linkedTokensMap = selectTokensByRuleAddress(state);
  if (state.rules.resource.status !== "ready") {
    return {
      items: [],
      totalAll: 0,
      totalFiltered: 0,
      page: 1,
      totalPages: 1,
      startIndex: 0,
      endIndex: 0,
      linkedTokensMap,
    };
  }
  const all = state.rules.resource.data;
  const q = state.rules.searchQuery.trim().toLowerCase();
  const filtered = !q
    ? all
    : all.filter((r) => {
        if (r.address.toLowerCase().includes(q)) return true;
        const targets = getRuleTargets(r);
        if (targets.some((t) => t.address.toLowerCase().includes(q))) {
          return true;
        }
        const linked = linkedTokensMap.get(r.address) ?? [];
        return linked.some((t) => t.name.toLowerCase().includes(q));
      });

  const totalFiltered = filtered.length;
  const pageSize = state.rules.pageSize;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  const page = Math.min(Math.max(1, state.rules.page), totalPages);
  const startIndex = (page - 1) * pageSize;
  const items = filtered.slice(startIndex, startIndex + pageSize);
  const endIndex = Math.min(startIndex + pageSize, totalFiltered);

  return {
    items,
    totalAll: all.length,
    totalFiltered,
    page,
    totalPages,
    startIndex,
    endIndex,
    linkedTokensMap,
  };
}

export function selectFilteredTokens(state: AppState): readonly TenantToken[] {
  if (state.tokens.resource.status !== "ready") return [];
  const q = state.tokens.searchQuery.trim().toLowerCase();
  if (!q) return state.tokens.resource.data;
  return state.tokens.resource.data.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.addresses.some((a) => a.toLowerCase().includes(q)),
  );
}

export function selectInboxModel(state: AppState): {
  readonly items: readonly InboxMessage[];
  readonly unreadCount: number;
  readonly totalLoaded: number;
} {
  if (state.inbox.resource.status !== "ready") {
    return { items: [], unreadCount: 0, totalLoaded: 0 };
  }
  const all = state.inbox.resource.data;
  const unreadCount = all.filter((m) => !m.read).length;
  const items = state.inbox.unreadOnly ? all.filter((m) => !m.read) : all;
  return { items, unreadCount, totalLoaded: all.length };
}

/* ==========================================================================
   Semantic Delivery Log Classifier (Fixes False Red "未转发" on Inbox Captures)
   ========================================================================== */
export type LogCategory = "delivered" | "inbox" | "warning" | "rejected";

export interface ClassifiedLogEntry {
  readonly entry: DeliveryLogEntry;
  readonly category: LogCategory;
  readonly statusBadge: {
    readonly label: string;
    readonly variant: "ok" | "accent" | "warn" | "danger";
  };
  readonly inboxCaptured: boolean;
  readonly forwardedEmails: readonly string[];
  readonly reasonDisplay?: string;
}

const REJECT_REASON_LABELS: Record<string, string> = {
  "no rule": "未配置匹配规则",
  "sender not allowed": "非白名单发件人",
  "all destinations disabled": "全部转发目标已暂停",
  "all destinations failed": "全部转发目标投递失败",
};

export function classifyDeliveryLog(
  entry: DeliveryLogEntry,
): ClassifiedLogEntry {
  const rawTargets = entry.forwardedTo ?? [];
  const hasInboxToken = rawTargets.includes("[inbox]");
  const forwardedEmails = rawTargets.filter((d) => d !== "[inbox]");
  const rawReason = (entry.reason ?? "").trim();

  // Also detect legacy/seeded inbox-only capture logs where forwardedTo=[] and rejected=false
  const isImplicitInboxCapture =
    !entry.rejected &&
    forwardedEmails.length === 0 &&
    (hasInboxToken || /inbox/i.test(rawReason));

  if (entry.rejected) {
    return {
      entry,
      category: "rejected",
      statusBadge: { label: "已拒收", variant: "danger" },
      inboxCaptured: false,
      forwardedEmails: [],
      reasonDisplay: REJECT_REASON_LABELS[rawReason] ?? (rawReason || "拒收"),
    };
  }

  if (isImplicitInboxCapture) {
    return {
      entry,
      category: "inbox",
      statusBadge: { label: "已存入收件箱", variant: "accent" },
      inboxCaptured: true,
      forwardedEmails: [],
      reasonDisplay: undefined,
    };
  }

  if (forwardedEmails.length > 0 && rawReason) {
    return {
      entry,
      category: "warning",
      statusBadge: { label: "部分投递异常", variant: "warn" },
      inboxCaptured: hasInboxToken,
      forwardedEmails,
      reasonDisplay: rawReason,
    };
  }

  if (forwardedEmails.length > 0) {
    return {
      entry,
      category: "delivered",
      statusBadge: {
        label: hasInboxToken ? "已转发 + 收件箱" : "已转发",
        variant: "ok",
      },
      inboxCaptured: hasInboxToken,
      forwardedEmails,
      reasonDisplay: undefined,
    };
  }

  return {
    entry,
    category: "warning",
    statusBadge: { label: "无启用目标", variant: "warn" },
    inboxCaptured: false,
    forwardedEmails: [],
    reasonDisplay: rawReason || undefined,
  };
}

export function selectFilteredLogs(
  state: AppState,
): readonly ClassifiedLogEntry[] {
  if (state.logs.resource.status !== "ready") return [];
  const classified = state.logs.resource.data.map(classifyDeliveryLog);
  const q = state.logs.searchQuery.trim().toLowerCase();
  const filter = state.logs.statusFilter;

  return classified.filter((item) => {
    if (filter !== "all" && item.category !== filter) return false;
    if (!q) return true;
    const e = item.entry;
    return (
      e.from.toLowerCase().includes(q) ||
      e.to.toLowerCase().includes(q) ||
      (e.subject ?? "").toLowerCase().includes(q) ||
      item.forwardedEmails.some((d) => d.toLowerCase().includes(q)) ||
      (item.reasonDisplay ?? "").toLowerCase().includes(q)
    );
  });
}

export function selectLogsTableModel(state: AppState): {
  readonly items: readonly ClassifiedLogEntry[];
  readonly totalAll: number;
  readonly totalFiltered: number;
  readonly page: number;
  readonly totalPages: number;
  readonly startIndex: number;
  readonly endIndex: number;
} {
  if (state.logs.resource.status !== "ready") {
    return {
      items: [],
      totalAll: 0,
      totalFiltered: 0,
      page: 1,
      totalPages: 1,
      startIndex: 0,
      endIndex: 0,
    };
  }
  const totalAll = state.logs.resource.data.length;
  const filtered = selectFilteredLogs(state);
  const totalFiltered = filtered.length;
  const pageSize = state.logs.pageSize;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  const page = Math.min(Math.max(1, state.logs.page), totalPages);
  const startIndex = (page - 1) * pageSize;
  const items = filtered.slice(startIndex, startIndex + pageSize);
  const endIndex = Math.min(startIndex + pageSize, totalFiltered);

  return {
    items,
    totalAll,
    totalFiltered,
    page,
    totalPages,
    startIndex,
    endIndex,
  };
}

/* ==========================================================================
   Rule Modal Derived Key Panel & Save Payload Validation
   ========================================================================== */
export type DerivedRuleKeyPanel =
  | { readonly kind: "hidden" }
  | { readonly kind: "will_generate_on_save" }
  | { readonly kind: "revoked_no_key" }
  | { readonly kind: "dormant_when_disabled"; readonly key: string }
  | {
      readonly kind: "active";
      readonly key: string;
      readonly revealed: boolean;
      readonly op: "idle" | "rotating" | "revoking";
    };

export function deriveRuleKeyPanel(
  modal: OpenRuleModalState,
): DerivedRuleKeyPanel {
  if (modal.mode.kind === "add") {
    return modal.draft.inboxEnabled
      ? { kind: "will_generate_on_save" }
      : { kind: "hidden" };
  }
  const ks = modal.mode.keySlice;
  if (modal.draft.inboxEnabled) {
    if (ks.tag === "present") {
      return {
        kind: "active",
        key: ks.key,
        revealed: ks.revealed,
        op: ks.op,
      };
    }
    return ks.revokedInSession
      ? { kind: "revoked_no_key" }
      : { kind: "will_generate_on_save" };
  }
  if (ks.tag === "present" && ks.key) {
    return { kind: "dormant_when_disabled", key: ks.key };
  }
  return { kind: "hidden" };
}

export function detectRuleCollision(
  state: AppState,
  targetNormalizedAddress: string,
): ForwardRule | undefined {
  if (
    state.primaryModal.tag !== "rule" ||
    state.rules.resource.status !== "ready"
  ) {
    return undefined;
  }
  const m = state.primaryModal.modal;
  if (
    m.mode.kind === "edit" &&
    m.mode.originalAddress.toLowerCase() ===
      targetNormalizedAddress.toLowerCase()
  ) {
    return undefined;
  }
  return state.rules.resource.data.find(
    (r) => r.address.toLowerCase() === targetNormalizedAddress.toLowerCase(),
  );
}

export function buildValidatedRuleSave(
  modal: OpenRuleModalState,
  role: "admin" | "tenant",
  mailDomain: string,
  overwriteConfirmed = false,
):
  | {
      readonly ok: true;
      readonly targetUrlAddr: string;
      readonly normalizedAddress: string;
      readonly targets: readonly DestinationTarget[];
      readonly payload: {
        readonly address: string;
        readonly targets: readonly DestinationTarget[];
        readonly inboxEnabled: boolean;
        readonly allowedSenders: readonly string[];
        readonly generateKey?: boolean;
        readonly overwrite?: boolean;
      };
    }
  | { readonly ok: false; readonly error: string } {
  // Fold any pending text in newTargetInput into targets without mutating draft prematurely
  const pendingParts = modal.draft.newTargetInput
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const mergedTargets: DestinationTarget[] = [...modal.draft.targets];
  for (const p of pendingParts) {
    if (!mergedTargets.some((t) => t.address === p)) {
      mergedTargets.push({ address: p, enabled: true });
    }
  }

  for (const t of mergedTargets) {
    if (!isValidEmailAddress(t.address)) {
      return { ok: false, error: `转发目标邮箱格式无效：${t.address}` };
    }
  }

  const normalizedAddress =
    role === "tenant" && modal.mode.kind === "edit"
      ? modal.mode.originalAddress
      : normalizePrefixInput(modal.draft.addressPrefix, mailDomain);

  if (!normalizedAddress || !isValidEmailAddress(normalizedAddress)) {
    return { ok: false, error: "请填写有效的收件地址前缀" };
  }

  if (
    modal.mode.kind === "add" &&
    !modal.draft.inboxEnabled &&
    mergedTargets.length === 0
  ) {
    return {
      ok: false,
      error: "新增规则请至少添加一个转发目标邮箱，或开启「临时收件箱」",
    };
  }

  const allowedSenders = modal.draft.allowedSendersRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // Prevent Zombie Key Regeneration if admin explicitly revoked inboxKey during this edit session!
  const preventAutoKey =
    modal.mode.kind === "edit" &&
    modal.mode.keySlice.tag === "none" &&
    modal.mode.keySlice.revokedInSession;

  const targetUrlAddr =
    modal.mode.kind === "edit"
      ? modal.mode.originalAddress
      : normalizedAddress;

  const isNewTargetAddress =
    modal.mode.kind === "add" ||
    modal.mode.originalAddress.toLowerCase() !==
      normalizedAddress.toLowerCase();

  return {
    ok: true,
    targetUrlAddr,
    normalizedAddress,
    targets: mergedTargets,
    payload: {
      address: normalizedAddress,
      targets: mergedTargets,
      inboxEnabled: modal.draft.inboxEnabled,
      allowedSenders,
      ...(preventAutoKey ? { generateKey: false } : {}),
      ...(isNewTargetAddress ? { overwrite: overwriteConfirmed } : {}),
    },
  };
}

/* ==========================================================================
   Token Modal Filterable + Creatable Multi-Select Dropdown Selector
   ========================================================================== */
export type TokenDropdownOption =
  | {
      readonly kind: "existing";
      readonly address: string;
      readonly selected: boolean;
      readonly metaLabel: string;
    }
  | {
      readonly kind: "custom";
      readonly address: string;
      readonly selected: boolean;
      readonly metaLabel: string;
    }
  | {
      readonly kind: "create";
      readonly addresses: readonly string[];
      readonly label: string;
    };

export function summarizeRuleMeta(r: ForwardRule): string {
  const targets = getRuleTargets(r);
  const enabledCount = targets.filter((t) => t.enabled).length;
  if (targets.length > 0 && r.inboxEnabled) {
    return `${enabledCount}/${targets.length} 目标 · 收件箱`;
  }
  if (targets.length > 0) {
    return enabledCount === targets.length
      ? `${targets.length} 个转发目标`
      : `${enabledCount}/${targets.length} 启用目标`;
  }
  if (r.inboxEnabled) return "仅临时收件箱";
  return "空规则";
}

export function selectTokenDropdownModel(state: AppState): {
  readonly options: readonly TokenDropdownOption[];
  readonly filteredSelectableAddresses: readonly string[];
  readonly allFilteredSelected: boolean;
  readonly totalAvailable: number;
  readonly activeIndex: number;
  readonly knownRuleSet: ReadonlySet<string> | null;
} {
  if (state.primaryModal.tag !== "token") {
    return {
      options: [],
      filteredSelectableAddresses: [],
      allFilteredSelected: false,
      totalAvailable: 0,
      activeIndex: -1,
      knownRuleSet: null,
    };
  }

  const modal = state.primaryModal.modal;
  const selectedSet = new Set(modal.draft.addresses);
  const rulesRes = state.rules.resource;
  const rulesList = rulesRes.status === "ready" ? rulesRes.data : [];
  const knownRuleSet =
    rulesRes.status === "ready"
      ? new Set(rulesList.map((r) => r.address))
      : null;

  const baseItems: Array<
    Extract<TokenDropdownOption, { kind: "existing" | "custom" }> & {
      searchHaystack: string;
    }
  > = [];

  for (const r of rulesList) {
    const targetsText = getRuleTargets(r)
      .map((t) => t.address.toLowerCase())
      .join(" ");
    baseItems.push({
      kind: "existing",
      address: r.address,
      selected: selectedSet.has(r.address),
      metaLabel: summarizeRuleMeta(r),
      searchHaystack: `${r.address.toLowerCase()} ${targetsText}`,
    });
  }

  for (const addr of modal.draft.addresses) {
    if (!knownRuleSet || !knownRuleSet.has(addr)) {
      baseItems.push({
        kind: "custom",
        address: addr,
        selected: true,
        metaLabel: knownRuleSet === null ? "已选邮箱" : "保存时新建规则",
        searchHaystack: addr.toLowerCase(),
      });
    }
  }

  const rawQuery = modal.dropdown.filterQuery.trim();
  const q = rawQuery.toLowerCase();

  const matchedBase = q
    ? baseItems.filter((item) => item.searchHaystack.includes(q))
    : baseItems;

  const options: TokenDropdownOption[] = matchedBase.map(
    ({ searchHaystack: _ignore, ...rest }) => rest,
  );
  const filteredSelectableAddresses = matchedBase.map((item) => item.address);

  // Offer explicit creatable option when filter input normalizes to valid unseen mailbox(es)
  if (rawQuery) {
    const creatableSet = new Set<string>();
    for (const part of rawQuery.split(",")) {
      const norm = normalizePrefixInput(part, state.mailDomain);
      if (
        norm &&
        isValidEmailAddress(norm) &&
        !selectedSet.has(norm) &&
        !(knownRuleSet && knownRuleSet.has(norm))
      ) {
        creatableSet.add(norm);
      }
    }
    if (creatableSet.size > 0) {
      const creatable = [...creatableSet];
      options.push({
        kind: "create",
        addresses: creatable,
        label: creatable.join(", "),
      });
    }
  }

  const allFilteredSelected =
    filteredSelectableAddresses.length > 0 &&
    filteredSelectableAddresses.every((a) => selectedSet.has(a));

  const activeIndex =
    options.length === 0
      ? -1
      : Math.min(Math.max(0, modal.dropdown.activeIndex), options.length - 1);

  return {
    options,
    filteredSelectableAddresses,
    allFilteredSelected,
    totalAvailable: baseItems.length,
    activeIndex,
    knownRuleSet,
  };
}
