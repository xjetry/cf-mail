import { DurableObject } from "cloudflare:workers";

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

export type ForwardRule = {
  /** 收件地址（小写规范化后作为存储 key） */
  address: string;
  /** 目标地址列表（小写，包含全部目标，保持向后兼容） */
  destinations: string[];
  /** 目标地址及各自的启用开关状态 */
  targets: DestinationTarget[];
  /** 规则创建/更新时间（ISO 字符串） */
  updatedAt: string;
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
const LOG_PREFIX = "log:";
const LOG_MAX = 200;
const DEFAULT_DOMAIN = "example.com";

/**
 * 解码邮件头 RFC 2047 Encoded-Word（如 =?utf-8?q?=E6=B5=8B=E8=AF=95?= 或 =?UTF-8?B?...?=）
 */
export function decodeMimeWords(input: string): string {
  if (!input || !input.includes("=?")) return input;
  // 相邻的 encoded-word 之间的空白按 RFC 2047 忽略
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
          // Q-encoding: '_' 表示空格 (0x20)，'=XX' 表示十六进制字节
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
  return {
    address: normalizeAddress(raw.address),
    destinations: targets.map((t) => t.address),
    targets,
    updatedAt: raw.updatedAt,
  };
}

function normalizeTargets(
  inputs: DestinationInput[],
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
  if (map.size === 0) {
    return { error: "destinations must not be empty" };
  }
  const targets: DestinationTarget[] = [];
  for (const [address, enabled] of map.entries()) {
    targets.push({ address, enabled });
  }
  return { targets };
}

export class ForwardStore extends DurableObject {
  // ---------------- rules ----------------

  async getRule(
    address: string,
    domain = DEFAULT_DOMAIN,
  ): Promise<ForwardRule | null> {
    const key = ruleKey(address, domain);
    const rule = await this.ctx.storage.get<ForwardRule>(key);
    return rule ? hydrateRule(rule) : null;
  }

  async listRules(): Promise<ForwardRule[]> {
    const entries = await this.ctx.storage.list<ForwardRule>({
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
  ): Promise<ForwardRule | { error: string }> {
    const normalized = normalizeRecipient(address, domain);
    if (!isValidAddress(normalized)) {
      return { error: `invalid address: ${address}` };
    }
    const parsed = normalizeTargets(destinations);
    if ("error" in parsed) return parsed;

    const rule: ForwardRule = {
      address: normalized,
      destinations: parsed.targets.map((t) => t.address),
      targets: parsed.targets,
      updatedAt: new Date().toISOString(),
    };
    await this.ctx.storage.put(ruleKey(normalized, domain), rule);
    return rule;
  }

  async updateRule(
    oldAddress: string,
    newAddress: string,
    destinations: DestinationInput[],
    domain = DEFAULT_DOMAIN,
  ): Promise<ForwardRule | { error: string }> {
    const oldNorm = normalizeRecipient(oldAddress, domain);
    const newNorm = normalizeRecipient(newAddress, domain);
    const saved = await this.setRule(newNorm, destinations, domain);
    if ("error" in saved) return saved;
    if (oldNorm !== newNorm) {
      await this.ctx.storage.delete(ruleKey(oldNorm, domain));
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

  async deleteRule(
    address: string,
    domain = DEFAULT_DOMAIN,
  ): Promise<boolean> {
    return await this.ctx.storage.delete(ruleKey(address, domain));
  }

  /**
   * email handler 专用：
   * - 未配置规则返回 null
   * - 已配置规则返回仅 enabled=true 的目标地址列表
   */
  async getDestinations(address: string): Promise<string[] | null> {
    const rule = await this.getRule(address);
    if (!rule) return null;
    return rule.targets.filter((t) => t.enabled).map((t) => t.address);
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
    const now = new Date();
    const record: DeliveryLogEntry = {
      ...entry,
      subject: decodeMimeWords(entry.subject ?? ""),
      id,
      ts: now.toISOString(),
    };
    // key 带零填充时间戳，使字典序 = 时间序，便于倒序分页与清理
    const key = `${LOG_PREFIX}${String(now.getTime()).padStart(15, "0")}:${id}`;
    await this.ctx.storage.put(key, record);
    await this.pruneLogs();
  }

  async listLogs(limit = 50): Promise<DeliveryLogEntry[]> {
    const entries = await this.ctx.storage.list<DeliveryLogEntry>({
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
    const entries = await this.ctx.storage.list({
      prefix: LOG_PREFIX,
      reverse: true,
    });
    const keys = [...entries.keys()];
    const excess = keys.slice(LOG_MAX);
    if (excess.length > 0) {
      await this.ctx.storage.delete(excess);
    }
  }
}
