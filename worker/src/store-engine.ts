import { matchesAllowedSenders } from "./mime.ts";

export interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keyOrKeys: string | string[]): Promise<boolean | number>;
  list<T>(options?: {
    prefix?: string;
    limit?: number;
    reverse?: boolean;
  }): Promise<Map<string, T>>;
}

export type DestinationTarget = {
  address: string;
  enabled: boolean;
};

export type DestinationInput =
  | string
  | {
      address: string;
      enabled?: boolean;
    };

export type RuleInboxOptions = {
  inboxEnabled?: boolean;
  allowedSenders?: string[];
  /** 显式指定是否生成 key（默认当 inboxEnabled=true 且尚无 key 时自动生成） */
  generateKey?: boolean;
};

export type ForwardRule = {
  /** 收件地址（小写规范化后作为存储 key） */
  address: string;
  /** 目标地址列表（小写，包含全部目标，保持向后兼容；inboxEnabled=true 时可为空） */
  destinations: string[];
  /** 目标地址及各自的启用开关状态 */
  targets: DestinationTarget[];
  /** 是否启用临时收件箱暂存（支持不转发仅收件箱） */
  inboxEnabled?: boolean;
  /** 可选发件人白名单（域名如 anthropic.com 含子域，或完整邮箱；空表示不限） */
  allowedSenders?: string[];
  /** 该前缀专属收件箱查询凭证 cfmk_<32hex> */
  inboxKey?: string;
  /** 规则创建/更新时间（ISO 字符串） */
  updatedAt: string;
};

export type WatchSlot = {
  address: string;
  createdAt: string;
  expiresAt: number;
  allowedSenders?: string[];
};

export type InboxMessage = {
  id: string;
  ts: string;
  expiresAt: number;
  read: boolean;
  readAt?: string;
  from: string;
  to: string;
  subject: string;
  messageId: string;
  text: string;
  html?: string;
  links: string[];
  codes: string[];
};

export type DeliveryPlan =
  | {
      action: "reject";
      reason: "no rule" | "sender not allowed" | "all destinations disabled";
    }
  | {
      action: "accept";
      captureInbox: boolean;
      forwardTo: string[];
    };

export type DeliveryLogEntry = {
  id: string;
  ts: string;
  from: string;
  to: string;
  subject: string;
  messageId: string;
  forwardedTo: string[];
  rejected?: boolean;
  reason?: string;
};

const RULE_PREFIX = "rule:";
const IKEY_PREFIX = "ikey:";
const WATCH_PREFIX = "watch:";
const INBOX_PREFIX = "inbox:";
const LOG_PREFIX = "log:";
const LOG_MAX = 200;
const INBOX_PER_ADDR_MAX = 20;
export const DEFAULT_INBOX_TTL_SEC = 1800; // 30 分钟
const DEFAULT_DOMAIN = "example.com";

export function decodeMimeWords(input: string): string {
  if (!input || !input.includes("=?")) return input;
  const joined = input.replace(/\?=\s+=\?/g, "?==?");
  return joined.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (full, charsetRaw: string, encodingRaw: string, text: string) => {
      try {
        const charset = charsetRaw.trim().toLowerCase();
        const enc = encodingRaw.toUpperCase();
        let bytes: Uint8Array;
        if (enc === "B") {
          const bin = atob(text.replace(/\s+/g, ""));
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i);
          }
        } else {
          const q = text.replace(/_/g, " ");
          const arr: number[] = [];
          for (let i = 0; i < q.length; i++) {
            if (
              q[i] === "=" &&
              i + 2 < q.length &&
              /^[0-9a-fA-F]{2}$/.test(q.slice(i + 1, i + 3))
            ) {
              arr.push(parseInt(q.slice(i + 1, i + 3), 16));
              i += 2;
            } else {
              arr.push(q.charCodeAt(i));
            }
          }
          bytes = new Uint8Array(arr);
        }
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return full;
      }
    },
  );
}

function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

export function normalizeRecipient(
  addr: string,
  domain = DEFAULT_DOMAIN,
): string {
  const raw = normalizeAddress(addr);
  if (!raw) return "";
  if (!raw.includes("@")) {
    return `${raw}@${normalizeAddress(domain)}`;
  }
  return raw;
}

function isValidAddress(addr: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

function ruleKey(address: string, domain = DEFAULT_DOMAIN): string {
  return RULE_PREFIX + normalizeRecipient(address, domain);
}

function watchKey(address: string, domain = DEFAULT_DOMAIN): string {
  return WATCH_PREFIX + normalizeRecipient(address, domain);
}

function ikeyKey(token: string): string {
  return IKEY_PREFIX + token.trim();
}

function inboxPrefixFor(address: string): string {
  return `${INBOX_PREFIX}${normalizeAddress(address)}:`;
}

function generateInboxKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `cfmk_${hex}`;
}

function normalizeSenders(senders?: string[]): string[] | undefined {
  if (!senders) return undefined;
  const list = [
    ...new Set(
      senders
        .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean),
    ),
  ];
  if (list.includes("*")) return undefined;
  return list.length > 0 ? list : undefined;
}

function hydrateRule(raw: ForwardRule): ForwardRule {
  const targets: DestinationTarget[] =
    Array.isArray(raw.targets) && raw.targets.length > 0
      ? raw.targets.map((t) => ({
          address: normalizeAddress(t.address),
          enabled: t.enabled !== false,
        }))
      : (raw.destinations ?? []).map((d) => ({
          address: normalizeAddress(d),
          enabled: true,
        }));
  const rule: ForwardRule = {
    address: normalizeAddress(raw.address),
    destinations: targets.map((t) => t.address),
    targets,
    updatedAt: raw.updatedAt,
  };
  if (raw.inboxEnabled) rule.inboxEnabled = true;
  if (raw.allowedSenders && raw.allowedSenders.length > 0) {
    rule.allowedSenders = raw.allowedSenders;
  }
  if (raw.inboxKey) rule.inboxKey = raw.inboxKey;
  return rule;
}

function normalizeTargets(
  inputs: DestinationInput[],
  allowEmpty: boolean,
): { targets: DestinationTarget[] } | { error: string } {
  const map = new Map<string, boolean>();
  for (const item of inputs) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      const disabledPrefix =
        trimmed.startsWith("-") || trimmed.startsWith("!");
      const addr = normalizeAddress(
        disabledPrefix ? trimmed.slice(1) : trimmed,
      );
      if (!addr) continue;
      if (!isValidAddress(addr)) {
        return { error: `invalid destination: ${item}` };
      }
      if (!map.has(addr)) {
        map.set(addr, !disabledPrefix);
      }
    } else if (
      item &&
      typeof item === "object" &&
      typeof item.address === "string"
    ) {
      const addr = normalizeAddress(item.address);
      if (!addr) continue;
      if (!isValidAddress(addr)) {
        return { error: `invalid destination: ${item.address}` };
      }
      if (!map.has(addr)) {
        map.set(addr, item.enabled !== false);
      }
    } else {
      return { error: "invalid destination item" };
    }
  }
  if (map.size === 0 && !allowEmpty) {
    return { error: "destinations must not be empty unless inboxEnabled is true" };
  }
  const targets: DestinationTarget[] = [];
  for (const [address, enabled] of map.entries()) {
    targets.push({ address, enabled });
  }
  return { targets };
}

export class ForwardStoreEngine {
  private storage: StorageLike;
  private nowFn: () => number;

  constructor(storage: StorageLike, nowFn: () => number = () => Date.now()) {
    this.storage = storage;
    this.nowFn = nowFn;
  }

  // ---------------- rules & inboxKey ----------------

  async getRule(
    address: string,
    domain = DEFAULT_DOMAIN,
  ): Promise<ForwardRule | null> {
    const rule = await this.storage.get<ForwardRule>(ruleKey(address, domain));
    return rule ? hydrateRule(rule) : null;
  }

  async listRules(): Promise<ForwardRule[]> {
    const entries = await this.storage.list<ForwardRule>({
      prefix: RULE_PREFIX,
    });
    const rules = [...entries.values()].map(hydrateRule);
    rules.sort((a, b) => a.address.localeCompare(b.address));
    return rules;
  }

  async setRule(
    address: string,
    destinations: DestinationInput[],
    domain = DEFAULT_DOMAIN,
    options?: RuleInboxOptions,
  ): Promise<ForwardRule | { error: string }> {
    const normalized = normalizeRecipient(address, domain);
    if (!isValidAddress(normalized)) {
      return { error: `invalid address: ${address}` };
    }
    const existing = await this.getRule(normalized, domain);

    const inboxEnabled =
      options?.inboxEnabled !== undefined
        ? Boolean(options.inboxEnabled)
        : Boolean(existing?.inboxEnabled);

    const parsed = normalizeTargets(destinations, inboxEnabled);
    if ("error" in parsed) return parsed;

    const allowedSenders =
      options && "allowedSenders" in options
        ? normalizeSenders(options.allowedSenders)
        : existing?.allowedSenders;

    let inboxKey = existing?.inboxKey;
    const shouldGenerateKey =
      options?.generateKey === true || (inboxEnabled && !inboxKey);
    if (shouldGenerateKey) {
      if (inboxKey) {
        await this.storage.delete(ikeyKey(inboxKey));
      }
      inboxKey = generateInboxKey();
      await this.storage.put(ikeyKey(inboxKey), normalized);
    } else if (!inboxEnabled && inboxKey) {
      // 关闭收件箱时保留或同步索引：索引仍指向当前地址，但 resolveAddressByInboxKey 会检查 inboxEnabled
      await this.storage.put(ikeyKey(inboxKey), normalized);
    } else if (inboxKey) {
      await this.storage.put(ikeyKey(inboxKey), normalized);
    }

    const rule: ForwardRule = {
      address: normalized,
      destinations: parsed.targets.map((t) => t.address),
      targets: parsed.targets,
      updatedAt: new Date(this.nowFn()).toISOString(),
    };
    if (inboxEnabled) rule.inboxEnabled = true;
    if (allowedSenders && allowedSenders.length > 0) {
      rule.allowedSenders = allowedSenders;
    }
    if (inboxKey) rule.inboxKey = inboxKey;

    await this.storage.put(ruleKey(normalized, domain), rule);
    return rule;
  }

  async updateRule(
    oldAddress: string,
    newAddress: string,
    destinations: DestinationInput[],
    domain = DEFAULT_DOMAIN,
    options?: RuleInboxOptions,
  ): Promise<ForwardRule | { error: string }> {
    const oldNorm = normalizeRecipient(oldAddress, domain);
    const newNorm = normalizeRecipient(newAddress, domain);
    const oldRule =
      oldNorm !== newNorm ? await this.getRule(oldNorm, domain) : null;

    const mergedOpts: RuleInboxOptions = {
      inboxEnabled:
        options?.inboxEnabled !== undefined
          ? options.inboxEnabled
          : oldRule?.inboxEnabled,
      allowedSenders:
        options && "allowedSenders" in options
          ? options.allowedSenders
          : oldRule?.allowedSenders,
      generateKey: options?.generateKey,
    };

    const saved = await this.setRule(newNorm, destinations, domain, mergedOpts);
    if ("error" in saved) return saved;

    if (oldNorm !== newNorm) {
      if (oldRule?.inboxKey && oldRule.inboxKey !== saved.inboxKey) {
        await this.storage.delete(ikeyKey(oldRule.inboxKey));
      }
      await this.storage.delete(ruleKey(oldNorm, domain));
    }
    return saved;
  }

  async setTargetEnabled(
    address: string,
    targetAddress: string,
    enabled: boolean,
    domain = DEFAULT_DOMAIN,
  ): Promise<ForwardRule | { error: string }> {
    const existing = await this.getRule(address, domain);
    if (!existing) {
      return { error: "not found" };
    }
    const normTarget = normalizeAddress(targetAddress);
    let found = false;
    const updatedTargets = existing.targets.map((t) => {
      if (t.address === normTarget) {
        found = true;
        return { ...t, enabled };
      }
      return t;
    });
    if (!found) {
      return { error: `destination not found in rule: ${targetAddress}` };
    }
    return await this.setRule(existing.address, updatedTargets, domain);
  }

  async rotateInboxKey(
    address: string,
    domain = DEFAULT_DOMAIN,
  ): Promise<ForwardRule | { error: string }> {
    const existing = await this.getRule(address, domain);
    if (!existing) {
      return { error: "not found" };
    }
    if (existing.inboxKey) {
      await this.storage.delete(ikeyKey(existing.inboxKey));
    }
    const newKey = generateInboxKey();
    const updated: ForwardRule = {
      ...existing,
      inboxEnabled: true,
      inboxKey: newKey,
      updatedAt: new Date(this.nowFn()).toISOString(),
    };
    await this.storage.put(ikeyKey(newKey), existing.address);
    await this.storage.put(ruleKey(existing.address, domain), updated);
    return updated;
  }

  async revokeInboxKey(
    address: string,
    domain = DEFAULT_DOMAIN,
  ): Promise<ForwardRule | { error: string }> {
    const existing = await this.getRule(address, domain);
    if (!existing) {
      return { error: "not found" };
    }
    if (existing.inboxKey) {
      await this.storage.delete(ikeyKey(existing.inboxKey));
    }
    const { inboxKey: _, ...rest } = existing;
    const updated: ForwardRule = {
      ...rest,
      updatedAt: new Date(this.nowFn()).toISOString(),
    };
    await this.storage.put(ruleKey(existing.address, domain), updated);
    return updated;
  }

  async resolveAddressByInboxKey(token: string): Promise<string | null> {
    const clean = token.trim();
    if (!clean.startsWith("cfmk_")) return null;
    const address = await this.storage.get<string>(ikeyKey(clean));
    if (!address) return null;
    const rule = await this.getRule(address);
    if (!rule || !rule.inboxEnabled || rule.inboxKey !== clean) {
      return null;
    }
    return rule.address;
  }

  async deleteRule(
    address: string,
    domain = DEFAULT_DOMAIN,
  ): Promise<boolean> {
    const existing = await this.getRule(address, domain);
    if (existing?.inboxKey) {
      await this.storage.delete(ikeyKey(existing.inboxKey));
    }
    return Boolean(await this.storage.delete(ruleKey(address, domain)));
  }

  async getDestinations(address: string): Promise<string[] | null> {
    const rule = await this.getRule(address);
    if (!rule) return null;
    return rule.targets.filter((t) => t.enabled).map((t) => t.address);
  }

  // ---------------- watch slots ----------------

  async watchAddress(
    address: string,
    domain = DEFAULT_DOMAIN,
    ttlSeconds = DEFAULT_INBOX_TTL_SEC,
    allowedSenders?: string[],
  ): Promise<WatchSlot | { error: string }> {
    const normalized = normalizeRecipient(address, domain);
    if (!isValidAddress(normalized)) {
      return { error: `invalid address: ${address}` };
    }
    const now = this.nowFn();
    const clampedTtl = Math.min(Math.max(ttlSeconds, 60), 86400);
    const slot: WatchSlot = {
      address: normalized,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + clampedTtl * 1000,
    };
    const normSenders = normalizeSenders(allowedSenders);
    if (normSenders) slot.allowedSenders = normSenders;
    await this.storage.put(watchKey(normalized, domain), slot);
    return slot;
  }

  async unwatchAddress(
    address: string,
    domain = DEFAULT_DOMAIN,
  ): Promise<boolean> {
    return Boolean(await this.storage.delete(watchKey(address, domain)));
  }

  async getActiveWatch(address: string): Promise<WatchSlot | null> {
    const key = watchKey(address);
    const slot = await this.storage.get<WatchSlot>(key);
    if (!slot) return null;
    if (slot.expiresAt <= this.nowFn()) {
      await this.storage.delete(key);
      return null;
    }
    return slot;
  }

  // ---------------- delivery resolution ----------------

  async resolveDeliveryPlan(
    toAddress: string,
    fromHeader: string,
  ): Promise<DeliveryPlan> {
    const to = normalizeAddress(toAddress);
    const [rule, watch] = await Promise.all([
      this.getRule(to),
      this.getActiveWatch(to),
    ]);

    if (!rule && !watch) {
      return { action: "reject", reason: "no rule" };
    }

    // 发件人白名单校验：若 rule 与 watch 任一允许即放行（仅存在的一方须通过自身白名单）
    const ruleAllows = rule
      ? matchesAllowedSenders(fromHeader, rule.allowedSenders)
      : false;
    const watchAllows = watch
      ? matchesAllowedSenders(fromHeader, watch.allowedSenders)
      : false;

    if (!ruleAllows && !watchAllows) {
      return { action: "reject", reason: "sender not allowed" };
    }

    const captureInbox =
      Boolean(rule && ruleAllows && rule.inboxEnabled) ||
      Boolean(watch && watchAllows);
    const forwardTo =
      rule && ruleAllows
        ? rule.targets.filter((t) => t.enabled).map((t) => t.address)
        : [];

    if (!captureInbox && forwardTo.length === 0) {
      return { action: "reject", reason: "all destinations disabled" };
    }

    return {
      action: "accept",
      captureInbox,
      forwardTo,
    };
  }

  // ---------------- partitioned ephemeral inbox ----------------

  async saveInboxMessage(
    entry: {
      from: string;
      to: string;
      subject: string;
      messageId: string;
      text: string;
      html?: string;
      links: string[];
      codes: string[];
    },
    ttlSeconds = DEFAULT_INBOX_TTL_SEC,
  ): Promise<InboxMessage> {
    const now = this.nowFn();
    const id = crypto.randomUUID();
    const to = normalizeAddress(entry.to);
    const record: InboxMessage = {
      id,
      ts: new Date(now).toISOString(),
      expiresAt: now + ttlSeconds * 1000,
      read: false,
      from: entry.from,
      to,
      subject: decodeMimeWords(entry.subject ?? ""),
      messageId: entry.messageId,
      text: entry.text,
      html: entry.html,
      links: entry.links,
      codes: entry.codes,
    };
    const key = `${inboxPrefixFor(to)}${String(now).padStart(15, "0")}:${id}`;
    await this.storage.put(key, record);
    await this.pruneAddressInbox(to);
    return record;
  }

  private async pruneAddressInbox(address: string): Promise<void> {
    const now = this.nowFn();
    const entries = await this.storage.list<InboxMessage>({
      prefix: inboxPrefixFor(address),
      reverse: true,
    });
    const toDelete: string[] = [];
    let kept = 0;
    for (const [k, msg] of entries.entries()) {
      if (msg.expiresAt <= now || kept >= INBOX_PER_ADDR_MAX) {
        toDelete.push(k);
      } else {
        kept++;
      }
    }
    if (toDelete.length > 0) {
      await this.storage.delete(toDelete);
    }
  }

  async queryInbox(opts: {
    address?: string;
    unreadOnly?: boolean;
    sinceMs?: number;
    consume?: boolean;
    limit?: number;
    includeHtml?: boolean;
  }): Promise<InboxMessage[]> {
    const now = this.nowFn();
    const maxLimit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const prefix = opts.address
      ? inboxPrefixFor(opts.address)
      : INBOX_PREFIX;

    const entries = await this.storage.list<InboxMessage>({
      prefix,
      reverse: true,
    });

    const expiredKeys: string[] = [];
    const matched: Array<{ key: string; msg: InboxMessage }> = [];

    for (const [key, msg] of entries.entries()) {
      if (msg.expiresAt <= now) {
        expiredKeys.push(key);
        continue;
      }
      if (opts.unreadOnly && msg.read) continue;
      if (opts.sinceMs !== undefined) {
        const msgMs = Date.parse(msg.ts);
        if (Number.isFinite(msgMs) && msgMs < opts.sinceMs) continue;
      }
      matched.push({ key, msg });
    }

    if (expiredKeys.length > 0) {
      await this.storage.delete(expiredKeys);
    }

    // 若跨多个邮箱查询（无 address），按时间倒序排列
    if (!opts.address) {
      matched.sort((a, b) => b.msg.ts.localeCompare(a.msg.ts));
    }

    const sliced = matched.slice(0, maxLimit);
    const readIso = new Date(now).toISOString();
    const result: InboxMessage[] = [];

    for (const { key, msg } of sliced) {
      let current = msg;
      if (opts.consume && !msg.read) {
        current = { ...msg, read: true, readAt: readIso };
        await this.storage.put(key, current);
      }
      if (opts.includeHtml) {
        result.push(current);
      } else {
        const { html: _, ...withoutHtml } = current;
        result.push(withoutHtml);
      }
    }

    return result;
  }

  async ackInboxMessage(address: string, id: string): Promise<boolean> {
    const entries = await this.storage.list<InboxMessage>({
      prefix: inboxPrefixFor(address),
    });
    for (const [key, msg] of entries.entries()) {
      if (msg.id === id) {
        if (msg.expiresAt <= this.nowFn()) {
          await this.storage.delete(key);
          return false;
        }
        if (!msg.read) {
          await this.storage.put(key, {
            ...msg,
            read: true,
            readAt: new Date(this.nowFn()).toISOString(),
          });
        }
        return true;
      }
    }
    return false;
  }

  async deleteInboxMessage(
    address: string | undefined,
    id: string,
  ): Promise<boolean> {
    const prefix = address ? inboxPrefixFor(address) : INBOX_PREFIX;
    const entries = await this.storage.list<InboxMessage>({ prefix });
    for (const [key, msg] of entries.entries()) {
      if (msg.id === id) {
        await this.storage.delete(key);
        return true;
      }
    }
    return false;
  }

  // ---------------- delivery log ----------------

  async logDelivery(entry: {
    from: string;
    to: string;
    subject: string;
    messageId: string;
    forwardedTo: string[];
    rejected?: boolean;
    reason?: string;
  }): Promise<void> {
    const id = crypto.randomUUID();
    const now = this.nowFn();
    const record: DeliveryLogEntry = {
      ...entry,
      subject: decodeMimeWords(entry.subject ?? ""),
      id,
      ts: new Date(now).toISOString(),
    };
    const key = `${LOG_PREFIX}${String(now).padStart(15, "0")}:${id}`;
    await this.storage.put(key, record);
    await this.pruneLogs();
  }

  async listLogs(limit = 50): Promise<DeliveryLogEntry[]> {
    const entries = await this.storage.list<DeliveryLogEntry>({
      prefix: LOG_PREFIX,
      limit: Math.min(Math.max(limit, 1), 200),
      reverse: true,
    });
    return [...entries.values()].map((entry) => ({
      ...entry,
      subject: decodeMimeWords(entry.subject ?? ""),
    }));
  }

  private async pruneLogs(): Promise<void> {
    const entries = await this.storage.list({
      prefix: LOG_PREFIX,
      reverse: true,
    });
    const keys = [...entries.keys()];
    const excess = keys.slice(LOG_MAX);
    if (excess.length > 0) {
      await this.storage.delete(excess);
    }
  }
}
