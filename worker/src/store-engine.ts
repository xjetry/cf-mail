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
  /** 是否允许转发目标为空且未开启临时收件箱（用于管理员预分配初始规则或租户关闭收件箱） */
  allowEmptyTargets?: boolean;
};

export type TenantToken = {
  id: string;
  name: string;
  /** 明文 cfmt_<32hex>，供管理员随时复制分发 */
  token: string;
  /** 授权管理的收件地址列表（小写规范化） */
  addresses: string[];
  enabled: boolean;
  /** 可选过期时间（epoch ms） */
  expiresAt?: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateTenantTokenInput = {
  name: string;
  addresses: string[];
  enabled?: boolean;
  expiresAt?: number;
};

export type UpdateTenantTokenInput = {
  name?: string;
  addresses?: string[];
  enabled?: boolean;
  expiresAt?: number | null;
};

export type ListLogsOptions = {
  allowedAddresses?: string[];
  redactSubject?: boolean;
  cursor?: string;
};

export type PaginatedInboxResult = {
  messages: InboxMessage[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type PaginatedLogsResult = {
  logs: DeliveryLogEntry[];
  nextCursor: string | null;
  hasMore: boolean;
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
const TOKEN_PREFIX = "token:";
const TKEY_PREFIX = "tkey:";
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

function tokenRecordKey(id: string): string {
  return TOKEN_PREFIX + id.trim();
}

function tkeyKey(token: string): string {
  return TKEY_PREFIX + token.trim();
}

function inboxPrefixFor(address: string): string {
  return `${INBOX_PREFIX}${normalizeAddress(address)}:`;
}

function generateRandomToken(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

function generateInboxKey(): string {
  return generateRandomToken("cfmk");
}

function generateTenantSecret(): string {
  return generateRandomToken("cfmt");
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

    const parsed = normalizeTargets(
      destinations,
      inboxEnabled || Boolean(options?.allowEmptyTargets),
    );
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
      allowEmptyTargets: options?.allowEmptyTargets,
    };

    const saved = await this.setRule(newNorm, destinations, domain, mergedOpts);
    if ("error" in saved) return saved;

    if (oldNorm !== newNorm) {
      if (oldRule?.inboxKey && oldRule.inboxKey !== saved.inboxKey) {
        await this.storage.delete(ikeyKey(oldRule.inboxKey));
      }
      await this.storage.delete(ruleKey(oldNorm, domain));
      // 同步重命名所有关联租户令牌中的邮箱地址
      const tokenEntries = await this.storage.list<TenantToken>({
        prefix: TOKEN_PREFIX,
      });
      const nowIso = new Date(this.nowFn()).toISOString();
      for (const [key, tok] of tokenEntries.entries()) {
        if (Array.isArray(tok.addresses) && tok.addresses.includes(oldNorm)) {
          const nextAddrs = [
            ...new Set(tok.addresses.map((a) => (a === oldNorm ? newNorm : a))),
          ].sort((a, b) => a.localeCompare(b));
          await this.storage.put(key, {
            ...tok,
            addresses: nextAddrs,
            updatedAt: nowIso,
          });
        }
      }
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
    const normalized = normalizeRecipient(address, domain);
    const existing = await this.getRule(normalized, domain);
    if (existing?.inboxKey) {
      await this.storage.delete(ikeyKey(existing.inboxKey));
    }
    const deleted = Boolean(
      await this.storage.delete(ruleKey(normalized, domain)),
    );
    if (deleted) {
      // 清理该邮箱下残留的临时收件箱邮件
      const inboxEntries = await this.storage.list({
        prefix: inboxPrefixFor(normalized),
      });
      if (inboxEntries.size > 0) {
        await this.storage.delete([...inboxEntries.keys()]);
      }
      // 级联从所有租户令牌的授权列表中移除该地址
      const tokenEntries = await this.storage.list<TenantToken>({
        prefix: TOKEN_PREFIX,
      });
      const nowIso = new Date(this.nowFn()).toISOString();
      for (const [key, tok] of tokenEntries.entries()) {
        if (
          Array.isArray(tok.addresses) &&
          tok.addresses.includes(normalized)
        ) {
          await this.storage.put(key, {
            ...tok,
            addresses: tok.addresses.filter((a) => a !== normalized),
            updatedAt: nowIso,
          });
        }
      }
    }
    return deleted;
  }

  // ---------------- tenant tokens (cfmt_...) ----------------

  private normalizeAuthorizedAddresses(
    inputs: string[],
    domain = DEFAULT_DOMAIN,
  ): { addresses: string[] } | { error: string } {
    const set = new Set<string>();
    for (const raw of inputs) {
      const trimmed = String(raw ?? "").trim();
      if (!trimmed) continue;
      const norm = normalizeRecipient(trimmed, domain);
      if (!isValidAddress(norm)) {
        return { error: `invalid address: ${raw}` };
      }
      set.add(norm);
    }
    return { addresses: [...set].sort((a, b) => a.localeCompare(b)) };
  }

  private async ensurePlaceholderRules(
    addresses: string[],
    domain = DEFAULT_DOMAIN,
  ): Promise<void> {
    const nowIso = new Date(this.nowFn()).toISOString();
    for (const addr of addresses) {
      const existing = await this.getRule(addr, domain);
      if (!existing) {
        const placeholder: ForwardRule = {
          address: addr,
          destinations: [],
          targets: [],
          updatedAt: nowIso,
        };
        await this.storage.put(ruleKey(addr, domain), placeholder);
      }
    }
  }

  async listTenantTokens(): Promise<TenantToken[]> {
    const entries = await this.storage.list<TenantToken>({
      prefix: TOKEN_PREFIX,
    });
    const list = [...entries.values()];
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return list;
  }

  async getTenantToken(id: string): Promise<TenantToken | null> {
    if (!id.trim()) return null;
    const tok = await this.storage.get<TenantToken>(tokenRecordKey(id));
    return tok ?? null;
  }

  async createTenantToken(
    input: CreateTenantTokenInput,
    domain = DEFAULT_DOMAIN,
  ): Promise<TenantToken | { error: string }> {
    const name = String(input.name ?? "").trim();
    if (!name) {
      return { error: "name is required" };
    }
    if (!Array.isArray(input.addresses)) {
      return { error: "addresses (array) is required" };
    }
    const parsed = this.normalizeAuthorizedAddresses(input.addresses, domain);
    if ("error" in parsed) return parsed;

    if (
      input.expiresAt !== undefined &&
      (!Number.isFinite(input.expiresAt) || input.expiresAt <= 0)
    ) {
      return { error: "invalid expiresAt" };
    }

    await this.ensurePlaceholderRules(parsed.addresses, domain);

    const nowIso = new Date(this.nowFn()).toISOString();
    const id = crypto.randomUUID();
    const secret = generateTenantSecret();
    const record: TenantToken = {
      id,
      name,
      token: secret,
      addresses: parsed.addresses,
      enabled: input.enabled !== false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    if (input.expiresAt !== undefined) {
      record.expiresAt = input.expiresAt;
    }

    await this.storage.put(tokenRecordKey(id), record);
    await this.storage.put(tkeyKey(secret), id);
    return record;
  }

  async updateTenantToken(
    id: string,
    patch: UpdateTenantTokenInput,
    domain = DEFAULT_DOMAIN,
  ): Promise<TenantToken | { error: string }> {
    const existing = await this.getTenantToken(id);
    if (!existing) {
      return { error: "not found" };
    }

    let name = existing.name;
    if (patch.name !== undefined) {
      const trimmed = String(patch.name).trim();
      if (!trimmed) return { error: "name must not be empty" };
      name = trimmed;
    }

    let addresses = existing.addresses;
    if (patch.addresses !== undefined) {
      if (!Array.isArray(patch.addresses)) {
        return { error: "addresses must be an array" };
      }
      const parsed = this.normalizeAuthorizedAddresses(patch.addresses, domain);
      if ("error" in parsed) return parsed;
      addresses = parsed.addresses;
      await this.ensurePlaceholderRules(addresses, domain);
    }

    const enabled =
      patch.enabled !== undefined ? Boolean(patch.enabled) : existing.enabled;

    let expiresAt = existing.expiresAt;
    if (patch.expiresAt === null) {
      expiresAt = undefined;
    } else if (patch.expiresAt !== undefined) {
      if (!Number.isFinite(patch.expiresAt) || patch.expiresAt <= 0) {
        return { error: "invalid expiresAt" };
      }
      expiresAt = patch.expiresAt;
    }

    const { expiresAt: _oldExp, ...rest } = existing;
    const updated: TenantToken = {
      ...rest,
      name,
      addresses,
      enabled,
      updatedAt: new Date(this.nowFn()).toISOString(),
    };
    if (expiresAt !== undefined) {
      updated.expiresAt = expiresAt;
    }

    await this.storage.put(tokenRecordKey(existing.id), updated);
    return updated;
  }

  async rotateTenantToken(
    id: string,
  ): Promise<TenantToken | { error: string }> {
    const existing = await this.getTenantToken(id);
    if (!existing) {
      return { error: "not found" };
    }
    if (existing.token) {
      await this.storage.delete(tkeyKey(existing.token));
    }
    const nextSecret = generateTenantSecret();
    const updated: TenantToken = {
      ...existing,
      token: nextSecret,
      updatedAt: new Date(this.nowFn()).toISOString(),
    };
    await this.storage.put(tkeyKey(nextSecret), existing.id);
    await this.storage.put(tokenRecordKey(existing.id), updated);
    return updated;
  }

  async deleteTenantToken(id: string): Promise<boolean> {
    const existing = await this.getTenantToken(id);
    if (!existing) return false;
    if (existing.token) {
      await this.storage.delete(tkeyKey(existing.token));
    }
    return Boolean(await this.storage.delete(tokenRecordKey(existing.id)));
  }

  async resolveTenantToken(rawToken: string): Promise<TenantToken | null> {
    const clean = rawToken.trim();
    if (!clean.startsWith("cfmt_")) return null;
    const id = await this.storage.get<string>(tkeyKey(clean));
    if (!id) return null;
    const tok = await this.getTenantToken(id);
    if (!tok || tok.token !== clean || !tok.enabled) {
      return null;
    }
    if (tok.expiresAt !== undefined && tok.expiresAt <= this.nowFn()) {
      return null;
    }
    return tok;
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

  async listWatches(): Promise<WatchSlot[]> {
    const now = this.nowFn();
    const entries = await this.storage.list<WatchSlot>({
      prefix: WATCH_PREFIX,
    });
    const expiredKeys: string[] = [];
    const active: WatchSlot[] = [];
    for (const [key, slot] of entries.entries()) {
      if (slot.expiresAt <= now) {
        expiredKeys.push(key);
      } else {
        active.push(slot);
      }
    }
    if (expiredKeys.length > 0) {
      await this.storage.delete(expiredKeys);
    }
    active.sort((a, b) => a.address.localeCompare(b.address));
    return active;
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
    cursor?: string;
  }): Promise<InboxMessage[]> {
    const page = await this.queryInboxPage(opts);
    return page.messages;
  }

  async queryInboxPage(opts: {
    address?: string;
    unreadOnly?: boolean;
    sinceMs?: number;
    consume?: boolean;
    limit?: number;
    includeHtml?: boolean;
    cursor?: string;
  }): Promise<PaginatedInboxResult> {
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

    // Total descending order on (ts, id) for deterministic cursor pagination
    matched.sort(
      (a, b) =>
        b.msg.ts.localeCompare(a.msg.ts) || b.msg.id.localeCompare(a.msg.id),
    );

    let afterCursor = matched;
    if (opts.cursor) {
      const sep = opts.cursor.indexOf("|");
      if (sep > 0) {
        const curTs = opts.cursor.slice(0, sep);
        const curId = opts.cursor.slice(sep + 1);
        afterCursor = matched.filter(
          ({ msg }) =>
            msg.ts < curTs || (msg.ts === curTs && msg.id < curId),
        );
      }
    }

    const hasMore = afterCursor.length > maxLimit;
    const sliced = afterCursor.slice(0, maxLimit);
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

    const last = result[result.length - 1];
    const nextCursor = hasMore && last ? `${last.ts}|${last.id}` : null;

    return { messages: result, nextCursor, hasMore };
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

  async listLogs(
    limit = 50,
    opts?: ListLogsOptions,
  ): Promise<DeliveryLogEntry[]> {
    const page = await this.listLogsPage(limit, opts);
    return page.logs;
  }

  async listLogsPage(
    limit = 50,
    opts?: ListLogsOptions,
  ): Promise<PaginatedLogsResult> {
    const clampedLimit = Math.min(Math.max(limit, 1), 200);
    const hasFilter = opts?.allowedAddresses !== undefined;
    const allowedSet = hasFilter
      ? new Set(opts!.allowedAddresses!.map(normalizeAddress))
      : null;

    if (allowedSet && allowedSet.size === 0) {
      return { logs: [], nextCursor: null, hasMore: false };
    }

    let curTs = "";
    let curId = "";
    if (opts?.cursor) {
      const sep = opts.cursor.indexOf("|");
      if (sep > 0) {
        curTs = opts.cursor.slice(0, sep);
        curId = opts.cursor.slice(sep + 1);
      }
    }

    const entries = await this.storage.list<DeliveryLogEntry>({
      prefix: LOG_PREFIX,
      limit: LOG_MAX,
      reverse: true,
    });

    const out: DeliveryLogEntry[] = [];
    for (const entry of entries.values()) {
      if (allowedSet && !allowedSet.has(normalizeAddress(entry.to))) {
        continue;
      }
      if (
        curTs &&
        !(entry.ts < curTs || (entry.ts === curTs && entry.id < curId))
      ) {
        continue;
      }
      out.push({
        ...entry,
        subject: opts?.redactSubject
          ? ""
          : decodeMimeWords(entry.subject ?? ""),
      });
      if (out.length > clampedLimit) break;
    }

    const hasMore = out.length > clampedLimit;
    const logs = hasMore ? out.slice(0, clampedLimit) : out;
    const last = logs[logs.length - 1];
    const nextCursor = hasMore && last ? `${last.ts}|${last.id}` : null;

    return { logs, nextCursor, hasMore };
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
