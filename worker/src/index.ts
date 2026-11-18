import uiHtml from "./ui.html";
import adminApp from "./admin.ts";
import type { Env } from "./admin.ts";
import { handleIncomingEmail } from "./email-handler.ts";

export { ForwardStore } from "./forward-store.ts";

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
    await handleIncomingEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
