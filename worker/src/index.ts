import uiHtml from "./ui.html";
import adminApp from "./admin";
import type { Env } from "./admin";
import { decodeMimeWords, type ForwardStore } from "./forward-store";

export { ForwardStore } from "./forward-store";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Web UI（页面本身公开，数据接口仍需 Token）
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(uiHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return adminApp.fetch(request, env);
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const to = message.to.toLowerCase();
    const store: DurableObjectStub<ForwardStore> = env.FORWARD_STORE.get(
      env.FORWARD_STORE.idFromName("global"),
    );

    const destinations = await store.getDestinations(to);
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

    if (destinations === null) {
      message.setReject("No forward rule for this address");
      await log({ rejected: true, reason: "no rule", forwardedTo: [] });
      return;
    }

    if (destinations.length === 0) {
      message.setReject("All forward destinations are disabled");
      await log({
        rejected: true,
        reason: "all destinations disabled",
        forwardedTo: [],
      });
      return;
    }

    // 并行转发到所有目标；单个失败不影响其他目标
    const results = await Promise.allSettled(
      destinations.map((addr: string) => message.forward(addr)),
    );
    const forwardedTo: string[] = [];
    let lastError = "";
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        forwardedTo.push(destinations[i]);
      } else {
        lastError += `${destinations[i]}: ${String(r.reason)}; `;
      }
    });

    await log({ forwardedTo, reason: lastError || undefined });

    // 全部失败时拒信，让发件人收到退信
    if (forwardedTo.length === 0) {
      message.setReject("All forward destinations failed");
    }
  },
} satisfies ExportedHandler<Env>;
