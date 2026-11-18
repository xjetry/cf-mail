import { DurableObject } from "cloudflare:workers";
import {
  ForwardStoreEngine,
  decodeMimeWords,
  normalizeRecipient,
  DEFAULT_INBOX_TTL_SEC,
  type DestinationTarget,
  type DestinationInput,
  type RuleInboxOptions,
  type ForwardRule,
  type WatchSlot,
  type InboxMessage,
  type DeliveryPlan,
  type DeliveryLogEntry,
} from "./store-engine.ts";

export {
  decodeMimeWords,
  normalizeRecipient,
  DEFAULT_INBOX_TTL_SEC,
  type DestinationTarget,
  type DestinationInput,
  type RuleInboxOptions,
  type ForwardRule,
  type WatchSlot,
  type InboxMessage,
  type DeliveryPlan,
  type DeliveryLogEntry,
};

export class ForwardStore extends DurableObject {
  private get engine(): ForwardStoreEngine {
    return new ForwardStoreEngine(this.ctx.storage);
  }

  async getRule(address: string, domain?: string): Promise<ForwardRule | null> {
    return await this.engine.getRule(address, domain);
  }

  async listRules(): Promise<ForwardRule[]> {
    return await this.engine.listRules();
  }

  async setRule(
    address: string,
    destinations: DestinationInput[],
    domain?: string,
    options?: RuleInboxOptions,
  ): Promise<ForwardRule | { error: string }> {
    return await this.engine.setRule(address, destinations, domain, options);
  }

  async updateRule(
    oldAddress: string,
    newAddress: string,
    destinations: DestinationInput[],
    domain?: string,
    options?: RuleInboxOptions,
  ): Promise<ForwardRule | { error: string }> {
    return await this.engine.updateRule(
      oldAddress,
      newAddress,
      destinations,
      domain,
      options,
    );
  }

  async setTargetEnabled(
    address: string,
    targetAddress: string,
    enabled: boolean,
    domain?: string,
  ): Promise<ForwardRule | { error: string }> {
    return await this.engine.setTargetEnabled(
      address,
      targetAddress,
      enabled,
      domain,
    );
  }

  async rotateInboxKey(
    address: string,
    domain?: string,
  ): Promise<ForwardRule | { error: string }> {
    return await this.engine.rotateInboxKey(address, domain);
  }

  async revokeInboxKey(
    address: string,
    domain?: string,
  ): Promise<ForwardRule | { error: string }> {
    return await this.engine.revokeInboxKey(address, domain);
  }

  async resolveAddressByInboxKey(token: string): Promise<string | null> {
    return await this.engine.resolveAddressByInboxKey(token);
  }

  async deleteRule(address: string, domain?: string): Promise<boolean> {
    return await this.engine.deleteRule(address, domain);
  }

  async getDestinations(address: string): Promise<string[] | null> {
    return await this.engine.getDestinations(address);
  }

  async watchAddress(
    address: string,
    domain?: string,
    ttlSeconds?: number,
    allowedSenders?: string[],
  ): Promise<WatchSlot | { error: string }> {
    return await this.engine.watchAddress(
      address,
      domain,
      ttlSeconds,
      allowedSenders,
    );
  }

  async unwatchAddress(address: string, domain?: string): Promise<boolean> {
    return await this.engine.unwatchAddress(address, domain);
  }

  async resolveDeliveryPlan(
    toAddress: string,
    fromHeader: string,
  ): Promise<DeliveryPlan> {
    return await this.engine.resolveDeliveryPlan(toAddress, fromHeader);
  }

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
    ttlSeconds?: number,
  ): Promise<InboxMessage> {
    return await this.engine.saveInboxMessage(entry, ttlSeconds);
  }

  async queryInbox(opts: {
    address?: string;
    unreadOnly?: boolean;
    sinceMs?: number;
    consume?: boolean;
    limit?: number;
    includeHtml?: boolean;
  }): Promise<InboxMessage[]> {
    return await this.engine.queryInbox(opts);
  }

  async ackInboxMessage(address: string, id: string): Promise<boolean> {
    return await this.engine.ackInboxMessage(address, id);
  }

  async deleteInboxMessage(
    address: string | undefined,
    id: string,
  ): Promise<boolean> {
    return await this.engine.deleteInboxMessage(address, id);
  }

  async logDelivery(entry: {
    from: string;
    to: string;
    subject: string;
    messageId: string;
    forwardedTo: string[];
    rejected?: boolean;
    reason?: string;
  }): Promise<void> {
    await this.engine.logDelivery(entry);
  }

  async listLogs(limit = 50): Promise<DeliveryLogEntry[]> {
    return await this.engine.listLogs(limit);
  }
}
