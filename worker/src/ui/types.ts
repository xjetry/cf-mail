/**
 * Shared Domain & Discriminated Union State Models for cf-mail Web UI (Batch B).
 * Pure TypeScript — zero DOM globals so state logic runs identically in browser & Node tests.
 */

export type ThemeMode = "system" | "light" | "dark";

export type WorkspaceTab = "rules" | "inbox" | "tokens" | "logs";

export interface DestinationTarget {
  readonly address: string;
  readonly enabled: boolean;
}

export interface ForwardRule {
  readonly address: string;
  readonly destinations: readonly string[];
  readonly targets: readonly DestinationTarget[];
  readonly inboxEnabled?: boolean;
  readonly allowedSenders?: readonly string[];
  readonly inboxKey?: string;
  readonly updatedAt: string;
}

export interface TenantToken {
  readonly id: string;
  readonly name: string;
  readonly token: string;
  readonly addresses: readonly string[];
  readonly enabled: boolean;
  readonly expiresAt?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InboxMessage {
  readonly id: string;
  readonly ts: string;
  readonly expiresAt: number;
  readonly read: boolean;
  readonly readAt?: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly messageId: string;
  readonly text: string;
  readonly html?: string;
  readonly links: readonly string[];
  readonly codes: readonly string[];
}

export interface WatchSlot {
  readonly address: string;
  readonly createdAt: string;
  readonly expiresAt: number;
  readonly allowedSenders?: readonly string[];
}

export interface DeliveryLogEntry {
  readonly id: string;
  readonly ts: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly messageId: string;
  readonly forwardedTo: readonly string[];
  readonly rejected?: boolean;
  readonly reason?: string;
}

export type DestinationStatus = "verified" | "pending" | "missing" | "unknown";

/* ==========================================================================
   SM-1: Authentication, Session & Role Identity
   ========================================================================== */
export type SessionPrincipal =
  | {
      readonly role: "admin";
      readonly domain: string;
      readonly credential: string;
    }
  | {
      readonly role: "tenant";
      readonly domain: string;
      readonly credential: string;
      readonly tokenMeta: {
        readonly id: string;
        readonly name: string;
        readonly addresses: readonly string[];
        readonly expiresAt?: number;
      };
    }
  | {
      readonly role: "user";
      readonly domain: string;
      readonly credential: string;
      readonly address: string;
      readonly keyRotation: "idle" | "rotating";
      readonly apiDrawerOpen: boolean;
      readonly secretRevealed: boolean;
    };

export type LoginError =
  | { readonly kind: "empty_input"; readonly message: string }
  | { readonly kind: "invalid_credential"; readonly message: string }
  | { readonly kind: "network_or_server"; readonly message: string };

export type AuthState =
  | {
      readonly tag: "booting";
      readonly epoch: number;
      readonly candidateCredential: string;
      readonly source: "url" | "storage";
    }
  | {
      readonly tag: "unauthenticated";
      readonly epoch: number;
      readonly gateNotice?: string;
      readonly passwordRevealed: boolean;
      readonly login:
        | { readonly status: "idle"; readonly error?: LoginError }
        | { readonly status: "submitting"; readonly credential: string };
    }
  | {
      readonly tag: "authenticated";
      readonly epoch: number;
      readonly principal: SessionPrincipal;
    };

/* ==========================================================================
   SM-2: Generic Async Collection Resource (Stale-While-Revalidate + Race Guard)
   ========================================================================== */
export type AsyncResource<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly requestId: number }
  | {
      readonly status: "ready";
      readonly data: T;
      readonly requestId: number;
      readonly reloadingId?: number;
      readonly reloadError?: string;
    }
  | {
      readonly status: "error";
      readonly error: string;
      readonly requestId: number;
    };

/* ==========================================================================
   SM-3, SM-5, SM-7, SM-8: Workspace Slices
   ========================================================================== */
export type RuleRowPendingOp = { readonly tag: "deleting" };

export interface RulesSlice {
  readonly resource: AsyncResource<readonly ForwardRule[]>;
  readonly searchQuery: string;
  readonly page: number;
  readonly pageSize: 10 | 20 | 50;
  readonly pendingByAddress: Readonly<Record<string, RuleRowPendingOp>>;
}

export type TokenRowPendingOp =
  | { readonly tag: "toggling"; readonly desired: boolean }
  | { readonly tag: "rotating" }
  | { readonly tag: "deleting" };

export interface TokensSlice {
  readonly resource: AsyncResource<readonly TenantToken[]>;
  readonly searchQuery: string;
  readonly pendingById: Readonly<Record<string, TokenRowPendingOp>>;
  readonly newlyIssuedBanner?: {
    readonly name: string;
    readonly token: string;
    readonly action: "created" | "rotated";
  };
}

export type InboxRowPendingOp = "acking" | "deleting";

export interface InboxSlice {
  readonly resource: AsyncResource<readonly InboxMessage[]>;
  readonly filterInput: string;
  readonly appliedFilter: string;
  readonly unreadOnly: boolean;
  readonly pendingById: Readonly<Record<string, InboxRowPendingOp>>;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly loadingMoreReqId?: number;
}

export interface WatchesSlice {
  readonly resource: AsyncResource<readonly WatchSlot[]>;
  readonly pendingUnwatchByAddr: Readonly<Record<string, true>>;
}

export type LogStatusFilter = "all" | "delivered" | "inbox" | "warning" | "rejected";

export interface LogsSlice {
  readonly resource: AsyncResource<readonly DeliveryLogEntry[]>;
  readonly searchQuery: string;
  readonly statusFilter: LogStatusFilter;
  readonly page: number;
  readonly pageSize: 10 | 20 | 50;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly loadingMoreReqId?: number;
}

/* ==========================================================================
   SM-4, SM-6, SM-7: Mutually Exclusive Primary Modal State Machines
   ========================================================================== */
export type DestVerifyState =
  | { readonly tag: "unchecked" }
  | { readonly tag: "checking" }
  | {
      readonly tag: "checked";
      readonly status: DestinationStatus;
      readonly message?: string;
    }
  | {
      readonly tag: "sending";
      readonly prevStatus: "pending" | "missing";
    };

export type ModalInboxKeySlice =
  | { readonly tag: "none"; readonly revokedInSession: boolean }
  | {
      readonly tag: "present";
      readonly key: string;
      readonly revealed: boolean;
      readonly op: "idle" | "rotating" | "revoking";
    };

export interface RuleDraft {
  readonly addressPrefix: string;
  readonly inboxEnabled: boolean;
  readonly allowedSendersRaw: string;
  readonly targets: readonly DestinationTarget[];
  readonly newTargetInput: string;
}

export type RuleModalMode =
  | { readonly kind: "add" }
  | {
      readonly kind: "edit";
      readonly originalAddress: string;
      readonly keySlice: ModalInboxKeySlice;
    };

export interface OpenRuleModalState {
  readonly instanceId: number;
  readonly mode: RuleModalMode;
  readonly draft: RuleDraft;
  readonly status: "editing" | "submitting";
  readonly validationError?: string;
  readonly verifyReqId: number;
  readonly verificationByAddr: Readonly<Record<string, DestVerifyState>>;
}

export type TokenModalMode =
  | { readonly kind: "add" }
  | { readonly kind: "edit"; readonly tokenId: string };

export interface OpenTokenModalState {
  readonly instanceId: number;
  readonly mode: TokenModalMode;
  readonly draft: {
    readonly name: string;
    readonly enabled: boolean;
    readonly expiresLocalIso: string;
    readonly addresses: readonly string[];
  };
  readonly dropdown: {
    readonly open: boolean;
    readonly filterQuery: string;
    readonly activeIndex: number;
  };
  readonly status: "editing" | "submitting";
  readonly validationError?: string;
}

export type WatchTtlOption = 600 | 1800 | 3600 | 21600 | 86400;

export interface OpenWatchModalState {
  readonly instanceId: number;
  readonly draft: {
    readonly addressPrefix: string;
    readonly ttlSeconds: WatchTtlOption;
    readonly allowedSendersRaw: string;
  };
  readonly status: "editing" | "submitting";
  readonly validationError?: string;
}

export type MessageViewMode = "html" | "text";

export interface OpenMessageModalState {
  readonly messageId: string;
  readonly snapshot: InboxMessage;
  readonly viewMode: MessageViewMode;
}

export interface OpenTokenAddrsModalState {
  readonly tokenId: string;
  readonly tokenName: string;
  readonly addresses: readonly string[];
  readonly searchQuery: string;
}

export type PrimaryModalState =
  | { readonly tag: "none" }
  | { readonly tag: "rule"; readonly modal: OpenRuleModalState }
  | { readonly tag: "token"; readonly modal: OpenTokenModalState }
  | { readonly tag: "tokenAddrs"; readonly modal: OpenTokenAddrsModalState }
  | { readonly tag: "watch"; readonly modal: OpenWatchModalState }
  | { readonly tag: "message"; readonly modal: OpenMessageModalState };

/* ==========================================================================
   SM-9: Confirm Dialog & Toast Notification Machines
   ========================================================================== */
export type ConfirmDialogState =
  | { readonly tag: "closed" }
  | {
      readonly tag: "open";
      readonly instanceId: number;
      readonly title: string;
      readonly message: string;
      readonly confirmText: string;
      readonly cancelText: string;
      readonly danger: boolean;
      readonly status: "awaiting_decision" | "executing";
    };

export type ToastTone = "neutral" | "ok" | "error";

export type ToastState =
  | { readonly tag: "hidden"; readonly nextId: number }
  | {
      readonly tag: "visible";
      readonly id: number;
      readonly nextId: number;
      readonly message: string;
      readonly tone: ToastTone;
    };

/* ==========================================================================
   Unified Root Application State
   ========================================================================== */
export interface AppState {
  readonly theme: ThemeMode;
  readonly mailDomain: string;
  readonly activeTab: WorkspaceTab;
  readonly globalRefreshing: boolean;
  readonly auth: AuthState;
  readonly rules: RulesSlice;
  readonly tokens: TokensSlice;
  readonly inbox: InboxSlice;
  readonly watches: WatchesSlice;
  readonly logs: LogsSlice;
  readonly primaryModal: PrimaryModalState;
  readonly confirmDialog: ConfirmDialogState;
  readonly toast: ToastState;
  readonly nextInstanceId: number;
}

export function assertNever(value: never, msg?: string): never {
  throw new Error(msg ?? `Unhandled discriminated union variant: ${JSON.stringify(value)}`);
}
