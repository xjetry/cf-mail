import type { Env } from "./admin.ts";
import type { ForwardStore } from "./forward-store.ts";
import { decodeMimeWords } from "./store-engine.ts";
import { parseEmailContent } from "./mime.ts";

const REJECT_MESSAGES = {
  "no rule": "No forward rule for this address",
  "sender not allowed": "Sender not allowed for this address",
  "all destinations disabled": "All forward destinations are disabled",
} as const;

export async function handleIncomingEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const to = message.to.toLowerCase();
  const store: DurableObjectStub<ForwardStore> = env.FORWARD_STORE.get(
    env.FORWARD_STORE.idFromName("global"),
  );

  const subject = decodeMimeWords(message.headers.get("subject") ?? "");
  const messageId = message.headers.get("message-id") ?? "";

  const log = (extra: {
    rejected?: boolean;
    reason?: string;
    forwardedTo: string[];
  }) =>
    store.logDelivery({
      from: message.from,
      to,
      subject,
      messageId,
      ...extra,
    });

  const plan = await store.resolveDeliveryPlan(to, message.from);
  if (plan.action === "reject") {
    message.setReject(REJECT_MESSAGES[plan.reason]);
    await log({ rejected: true, reason: plan.reason, forwardedTo: [] });
    return;
  }

  const forwardedTo: string[] = [];
  let lastError = "";

  if (plan.captureInbox) {
    try {
      const rawBuf = await new Response(message.raw).arrayBuffer();
      const parsed = parseEmailContent(rawBuf);
      await store.saveInboxMessage({
        from: message.from,
        to,
        subject,
        messageId,
        text: parsed.text,
        html: parsed.html,
        links: parsed.links,
        codes: parsed.codes,
      });
      forwardedTo.push("[inbox]");
    } catch (e) {
      lastError += `[inbox]: ${String(e)}; `;
    }
  }

  if (plan.forwardTo.length > 0) {
    const results = await Promise.allSettled(
      plan.forwardTo.map((addr: string) => message.forward(addr)),
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        forwardedTo.push(plan.forwardTo[i]);
      } else {
        lastError += `${plan.forwardTo[i]}: ${String(r.reason)}; `;
      }
    });
  }

  const allFailed = forwardedTo.length === 0;
  await log({
    forwardedTo,
    rejected: allFailed || undefined,
    reason: lastError || (allFailed ? "all destinations failed" : undefined),
  });
  if (allFailed) {
    message.setReject("All forward destinations failed");
  }
}
