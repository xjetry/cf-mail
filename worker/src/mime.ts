/**
 * 零依赖轻量 MIME 邮件解析器 + 链接/验证码提取 + 发件人白名单校验
 * 仅使用 Web 标准 API (TextDecoder / atob)，兼容 Cloudflare Workers 与 Node.js。
 */

const MAX_BODY_CHARS = 65536;

export type ParsedEmailContent = {
  text: string;
  html: string;
  links: string[];
  codes: string[];
};

function splitHeaderBody(raw: string): { headers: Map<string, string>; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  const headerRaw = match ? raw.slice(0, match.index) : raw;
  const body = match ? raw.slice(match.index + match[0].length) : "";

  // 展开 RFC 5322 折行头（CRLF + 空白）
  const unfolded = headerRaw.replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    if (!headers.has(key)) {
      headers.set(key, val);
    }
  }
  return { headers, body };
}

function parseParam(headerVal: string, paramName: string): string | undefined {
  const re = new RegExp(`${paramName}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i");
  const m = headerVal.match(re);
  return (m?.[1] ?? m?.[2])?.trim();
}

function decodeQuotedPrintable(input: string, charset: string): string {
  // 移除软换行 =\r\n 或 =\n
  const stripped = input.replace(/=[ \t]*\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < stripped.length; i++) {
    if (
      stripped[i] === "=" &&
      i + 2 < stripped.length &&
      /^[0-9a-fA-F]{2}$/.test(stripped.slice(i + 1, i + 3))
    ) {
      bytes.push(parseInt(stripped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(stripped.charCodeAt(i) & 0xff);
    }
  }
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }
}

function decodeBase64(input: string, charset: string): string {
  try {
    const clean = input.replace(/[^A-Za-z0-9+/=]/g, "");
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  } catch {
    return input;
  }
}

function decodeTransferBody(body: string, encoding: string, charset: string): string {
  const enc = encoding.trim().toLowerCase();
  if (enc === "quoted-printable") {
    return decodeQuotedPrintable(body, charset);
  }
  if (enc === "base64") {
    return decodeBase64(body, charset);
  }
  return body;
}

function unescapeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#x26;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, " ");
}

function htmlToPlainText(html: string): string {
  return unescapeHtmlEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseMimePart(raw: string, out: { texts: string[]; htmls: string[] }, depth = 0): void {
  if (depth > 8) return;
  const { headers, body } = splitHeaderBody(raw);
  const ct = headers.get("content-type") ?? "text/plain; charset=utf-8";
  const cte = headers.get("content-transfer-encoding") ?? "7bit";
  const mimeType = ct.split(";")[0].trim().toLowerCase();
  const charset = (parseParam(ct, "charset") ?? "utf-8").toLowerCase();

  if (mimeType.startsWith("multipart/")) {
    const boundary = parseParam(ct, "boundary");
    if (!boundary) return;
    const delim = `--${boundary}`;
    const chunks = body.split(delim);
    // 第一个 chunk 是 preamble，遇到 `--` 开头的是结束标记
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk.startsWith("--")) break;
      const partRaw = chunk.replace(/^[ \t]*\r?\n/, "").replace(/\r?\n$/, "");
      if (partRaw.trim()) {
        parseMimePart(partRaw, out, depth + 1);
      }
    }
    return;
  }

  // 跳过附件
  const disp = (headers.get("content-disposition") ?? "").toLowerCase();
  if (disp.startsWith("attachment")) return;

  if (mimeType === "text/plain") {
    out.texts.push(decodeTransferBody(body, cte, charset));
  } else if (mimeType === "text/html") {
    out.htmls.push(decodeTransferBody(body, cte, charset));
  }
}

function linkPriorityRank(url: string): number {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host === "claude.ai" || host.endsWith(".claude.ai")) {
      if (
        path.startsWith("/join") ||
        path.startsWith("/magic-link") ||
        path.startsWith("/accept-invite") ||
        path.startsWith("/invites") ||
        path.startsWith("/login")
      ) {
        return 0;
      }
      return 1;
    }
    if (host.endsWith(".mail.anthropic.com")) {
      return 3;
    }
    if (host === "anthropic.com" || host.endsWith(".anthropic.com")) {
      return 2;
    }
    return 4;
  } catch {
    return 5;
  }
}

function extractLinks(text: string, html: string): string[] {
  const candidates: string[] = [];

  // 1. 先从 HTML <a href="..."> 精确提取
  const hrefRe = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const rawHref = unescapeHtmlEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    if (rawHref.startsWith("https://") || rawHref.startsWith("http://")) {
      candidates.push(rawHref);
    }
  }

  // 2. 再从纯文本提取裸 URL
  const urlRe = /https?:\/\/[^\s<>"'`)\]]+/gi;
  while ((m = urlRe.exec(text)) !== null) {
    const cleaned = unescapeHtmlEntities(m[0]).replace(/[.,;:!?]+$/, "");
    candidates.push(cleaned);
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of candidates) {
    if (!seen.has(url)) {
      seen.add(url);
      unique.push(url);
    }
  }

  // 按优先级稳定排序：claude.ai 登录/入组动作链接置顶
  return unique
    .map((u, idx) => ({ u, idx, rank: linkPriorityRank(u) }))
    .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
    .map((x) => x.u);
}

function extractCodes(plainText: string): string[] {
  // 剔除 URL 和常见十六进制颜色（如 #123456），避免误提取链接参数或 CSS 色值
  const sanitized = plainText
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/#[0-9a-fA-F]{6}\b/g, " ");

  const seen = new Set<string>();
  const codes: string[] = [];
  const re = /(?:^|[^0-9A-Za-z#-])(\d{6})(?=$|[^0-9A-Za-z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sanitized)) !== null) {
    const code = m[1];
    // 排除明显年份范围开头的纯日期数字不是必须，但保留真实 6 位验证码顺序
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  return codes;
}

export function parseEmailContent(rawInput: Uint8Array | ArrayBuffer | string): ParsedEmailContent {
  let rawStr: string;
  if (typeof rawInput === "string") {
    rawStr = rawInput;
  } else {
    const bytes = rawInput instanceof Uint8Array ? rawInput : new Uint8Array(rawInput);
    // 顶层 MIME 结构按 latin1 单字节无损读取，各 part 内部再按各自 charset 解码
    rawStr = new TextDecoder("latin1").decode(bytes);
  }

  const parts = { texts: [] as string[], htmls: [] as string[] };
  parseMimePart(rawStr, parts);

  const html = parts.htmls.join("\n").slice(0, MAX_BODY_CHARS);
  const rawText = parts.texts.join("\n").trim();
  const text = (rawText || (html ? htmlToPlainText(html) : "")).slice(0, MAX_BODY_CHARS);

  const links = extractLinks(text, html);
  const codes = extractCodes(rawText || htmlToPlainText(html));

  return { text, html, links, codes };
}

/**
 * 提取发件人纯邮箱地址（支持 `Name <user@domain.com>` 或 `user@domain.com`）
 */
export function extractEmailAddress(fromHeader: string): string {
  const trimmed = fromHeader.trim();
  const angle = trimmed.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (angle) return angle[1].toLowerCase();
  const bare = trimmed.match(/([^\s<>@]+@[^\s<>@]+)/);
  return (bare ? bare[1] : trimmed).toLowerCase();
}

/**
 * 校验发件人是否命中规则白名单：
 * - allowedSenders 为空或包含 "*" 时允许所有发件人
 * - 条目含 "@" 时按精确邮箱匹配
 * - 条目为域名（如 "anthropic.com"）时匹配 `@anthropic.com` 及任意子域 `@*.anthropic.com`
 */
export function matchesAllowedSenders(
  fromHeader: string,
  allowedSenders?: string[],
): boolean {
  if (!allowedSenders || allowedSenders.length === 0) return true;
  const cleaned = allowedSenders
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  if (cleaned.length === 0 || cleaned.includes("*")) return true;

  const senderEmail = extractEmailAddress(fromHeader);
  const atIdx = senderEmail.lastIndexOf("@");
  if (atIdx === -1) return false;
  const senderDomain = senderEmail.slice(atIdx + 1);

  for (const rule of cleaned) {
    if (rule.includes("@")) {
      if (senderEmail === rule) return true;
    } else {
      if (senderDomain === rule || senderDomain.endsWith(`.${rule}`)) {
        return true;
      }
    }
  }
  return false;
}
