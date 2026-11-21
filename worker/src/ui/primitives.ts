import { ICONS } from "./icons.ts";

export function escapeHtml(str: unknown): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Fixed-width YYYY-MM-DD HH:mm:ss formatter for crisp tabular-nums alignment.
 */
export function formatTimestamp(input: string | number | undefined | null): string {
  if (input === undefined || input === null || input === "") return "—";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 14) return "••••••••";
  return `${secret.slice(0, 9)}••••••••${secret.slice(-4)}`;
}

/**
 * Formats remaining TTL into concise tabular text.
 */
export function formatRemainingTtl(
  expiresAtMs: number,
  nowMs = Date.now(),
): string {
  const diff = expiresAtMs - nowMs;
  if (diff <= 0) return "已到期";
  if (diff < 60_000) return "即将过期";
  if (diff < 3_600_000) {
    return `剩余 ${Math.ceil(diff / 60_000)} 分钟`;
  }
  const hours = Math.round((diff / 3_600_000) * 10) / 10;
  return `剩余 ${hours} 小时`;
}

/**
 * Privacy/sandbox-safe Web Storage adapter (prevents SecurityError script crashes).
 */
export const safeStorage = {
  getSession(key: string): string {
    try {
      return window.sessionStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  },
  setSession(key: string, value: string): void {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  removeSession(key: string): void {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
  getLocal(key: string): string {
    try {
      return window.localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  },
  setLocal(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  removeLocal(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/**
 * Safe clipboard writer with synchronous <textarea> fallback for post-await Safari / HTTP contexts.
 */
export async function copyTextSafe(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ==========================================================================
   Accessible Custom Select (Full ARIA Listbox + Keyboard Navigation)
   ========================================================================== */
export interface SelectOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  readonly icon?: string;
}

export interface CustomSelectInstance<T extends string | number> {
  setValue(nextVal: T, notify?: boolean): void;
  close(): void;
}

const openSelectRegistry = new Set<{ close: () => void }>();
let globalSelectListenerBound = false;

export function closeAllSelects(): void {
  for (const inst of openSelectRegistry) {
    inst.close();
  }
}

export function createCustomSelect<T extends string | number>(
  container: HTMLElement,
  config: {
    options: readonly SelectOption<T>[];
    value: T;
    ariaLabel: string;
    size?: "sm" | "md";
    direction?: "down" | "up";
    onChange?: (val: T) => void;
  },
): CustomSelectInstance<T> {
  if (!globalSelectListenerBound) {
    globalSelectListenerBound = true;
    document.addEventListener("click", () => closeAllSelects());
  }

  const { options, ariaLabel, size = "md", direction = "down", onChange } = config;
  let currentValue = config.value;
  let isOpen = false;
  let activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === currentValue),
  );

  const uid = `csel-${Math.random().toString(36).slice(2, 8)}`;
  const root = document.createElement("div");
  root.className = "cselect" + (size === "sm" ? " cselect-sm" : "");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cselect-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", ariaLabel);
  trigger.setAttribute("aria-controls", `${uid}-menu`);

  const labelSpan = document.createElement("span");
  labelSpan.className = "cselect-label";
  trigger.appendChild(labelSpan);
  trigger.insertAdjacentHTML("beforeend", ICONS.chevron);

  const menu = document.createElement("div");
  menu.id = `${uid}-menu`;
  menu.className = `cselect-menu ${direction}`;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", ariaLabel);
  menu.tabIndex = -1;

  function syncActiveHighlight(): void {
    const items = menu.querySelectorAll<HTMLElement>(".cselect-option");
    items.forEach((el, idx) => {
      el.classList.toggle("active", isOpen && idx === activeIndex);
    });
    if (isOpen && items[activeIndex]) {
      trigger.setAttribute("aria-activedescendant", items[activeIndex].id);
    } else {
      trigger.removeAttribute("aria-activedescendant");
    }
  }

  function render(): void {
    const selectedOpt = options.find((o) => o.value === currentValue) ?? options[0];
    labelSpan.innerHTML = `${selectedOpt.icon ?? ""}<span>${escapeHtml(selectedOpt.label)}</span>`;
    menu.innerHTML = "";
    options.forEach((opt, idx) => {
      const item = document.createElement("div");
      const isSelected = opt.value === currentValue;
      item.id = `${uid}-opt-${idx}`;
      item.className = "cselect-option" + (isSelected ? " selected" : "");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(isSelected));
      item.innerHTML = `
        <span class="cselect-option-left">${opt.icon ?? ""}<span>${escapeHtml(opt.label)}</span></span>
        ${ICONS.check}
      `;
      item.addEventListener("mouseenter", () => {
        activeIndex = idx;
        syncActiveHighlight();
      });
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        close(true);
        if (currentValue !== opt.value) {
          setValue(opt.value, true);
        }
      });
      menu.appendChild(item);
    });
    syncActiveHighlight();
  }

  function open(): void {
    for (const other of openSelectRegistry) {
      if (other !== apiObj) other.close();
    }
    isOpen = true;
    activeIndex = Math.max(
      0,
      options.findIndex((o) => o.value === currentValue),
    );
    root.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    openSelectRegistry.add(apiObj);
    syncActiveHighlight();
  }

  function close(restoreTriggerFocus = false): void {
    if (!isOpen) return;
    isOpen = false;
    root.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    openSelectRegistry.delete(apiObj);
    syncActiveHighlight();
    if (restoreTriggerFocus) {
      trigger.focus();
    }
  }

  function setValue(nextVal: T, notify = true): void {
    currentValue = nextVal;
    activeIndex = Math.max(
      0,
      options.findIndex((o) => o.value === currentValue),
    );
    render();
    if (notify && onChange) onChange(currentValue);
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isOpen) close(false);
    else open();
  });

  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!isOpen) {
        open();
      } else {
        activeIndex = (activeIndex + 1) % options.length;
        syncActiveHighlight();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen) {
        open();
      } else {
        activeIndex = (activeIndex - 1 + options.length) % options.length;
        syncActiveHighlight();
      }
    } else if (e.key === "Home" && isOpen) {
      e.preventDefault();
      activeIndex = 0;
      syncActiveHighlight();
    } else if (e.key === "End" && isOpen) {
      e.preventDefault();
      activeIndex = options.length - 1;
      syncActiveHighlight();
    } else if ((e.key === "Enter" || e.key === " ") && isOpen) {
      e.preventDefault();
      const chosen = options[activeIndex];
      close(true);
      if (chosen && currentValue !== chosen.value) {
        setValue(chosen.value, true);
      }
    } else if (e.key === "Escape" && isOpen) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab" && isOpen) {
      close(false);
    }
  });

  root.appendChild(trigger);
  root.appendChild(menu);
  container.innerHTML = "";
  container.appendChild(root);

  const apiObj: CustomSelectInstance<T> = {
    setValue,
    close: () => close(false),
  };
  render();
  return apiObj;
}

/* ==========================================================================
   Modal Focus Stack & Pointer-Down-Safe Backdrop Dismissal
   ========================================================================== */
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

interface ModalLayerEntry {
  backdropId: string;
  returnFocusTo: HTMLElement | null;
  returnFocusKey: string | null;
}

export class ModalFocusStack {
  private stack: ModalLayerEntry[] = [];

  constructor() {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || this.stack.length === 0) return;
      const top = this.stack[this.stack.length - 1];
      const backdrop = document.getElementById(top.backdropId);
      const dialog = backdrop?.querySelector<HTMLElement>(".modal");
      if (!dialog) return;
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (!active || !dialog.contains(active) || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (!active || !dialog.contains(active) || active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  }

  onOpen(
    backdropId: string,
    preferredFocusEl?: HTMLElement | null,
    triggerBeforeRender?: HTMLElement | null,
  ): void {
    closeAllSelects();
    const existing = this.stack.find((s) => s.backdropId === backdropId);
    if (!existing) {
      const originEl =
        triggerBeforeRender ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
      const focusKey =
        originEl?.getAttribute("data-focus-key") ??
        (originEl?.id ? `#${originEl.id}` : null);
      this.stack.push({
        backdropId,
        returnFocusTo: originEl,
        returnFocusKey: focusKey,
      });
    }
    this.syncInert();
    requestAnimationFrame(() => {
      if (preferredFocusEl && !preferredFocusEl.hasAttribute("disabled")) {
        preferredFocusEl.focus();
        return;
      }
      const backdrop = document.getElementById(backdropId);
      const first = backdrop?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      first?.focus();
    });
  }

  onClose(backdropId: string): void {
    const idx = this.stack.findIndex((s) => s.backdropId === backdropId);
    if (idx === -1) return;
    const [removed] = this.stack.splice(idx, 1);
    // Blur focus inside closing modal BEFORE aria-hidden="true" takes effect
    const backdrop = document.getElementById(backdropId);
    if (
      backdrop &&
      document.activeElement instanceof HTMLElement &&
      backdrop.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }
    this.syncInert();
    queueMicrotask(() => {
      let target: HTMLElement | null =
        removed.returnFocusTo && removed.returnFocusTo.isConnected
          ? removed.returnFocusTo
          : null;
      if (!target && removed.returnFocusKey) {
        if (removed.returnFocusKey.startsWith("#")) {
          target = document.getElementById(removed.returnFocusKey.slice(1));
        } else {
          target = document.querySelector<HTMLElement>(
            `[data-focus-key="${CSS.escape(removed.returnFocusKey)}"]`,
          );
        }
      }
      if (target && !target.closest("[inert]") && !target.hasAttribute("disabled")) {
        target.focus();
      }
    });
  }

  closeAll(): void {
    while (this.stack.length > 0) {
      const top = this.stack.pop()!;
      const backdrop = document.getElementById(top.backdropId);
      if (
        backdrop &&
        document.activeElement instanceof HTMLElement &&
        backdrop.contains(document.activeElement)
      ) {
        document.activeElement.blur();
      }
    }
    this.syncInert();
  }

  private syncInert(): void {
    const topId =
      this.stack.length > 0 ? this.stack[this.stack.length - 1].backdropId : null;
    const shellTargets = ["gate", "ui"];
    for (const id of shellTargets) {
      const el = document.getElementById(id);
      if (el) el.toggleAttribute("inert", topId !== null);
    }
    for (const el of document.querySelectorAll<HTMLElement>(".modal-backdrop")) {
      const id = el.id;
      if (!id) continue;
      const isInStack = this.stack.some((s) => s.backdropId === id);
      el.toggleAttribute("inert", isInStack && id !== topId);
    }
  }
}

/**
 * Prevents accidental modal close when dragging text selection out onto backdrop.
 */
export function bindSafeBackdropDismiss(
  backdrop: HTMLElement,
  onDismiss: () => void,
): void {
  let pointerStartedOnBackdrop = false;
  backdrop.addEventListener("pointerdown", (e) => {
    pointerStartedOnBackdrop = e.target === backdrop;
  });
  backdrop.addEventListener("click", (e) => {
    if (pointerStartedOnBackdrop && e.target === backdrop) {
      onDismiss();
    }
    pointerStartedOnBackdrop = false;
  });
}

/* ==========================================================================
   Safe Real-Email HTML Srcdoc Builder & Plain-Text Link Renderer
   ========================================================================== */
const EMAIL_PREVIEW_HEAD_INJECT =
  `<meta charset="utf-8">` +
  `<meta name="referrer" content="no-referrer">` +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https: http:; font-src https: http: data:;">` +
  `<base target="_blank">` +
  `<style>` +
  `html,body{background-color:#ffffff;color:#1f2937;}` +
  `body{margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.6;overflow-wrap:break-word;}` +
  `img{max-width:100%;height:auto;}` +
  `table{max-width:100%;}` +
  `pre{white-space:pre-wrap;overflow-wrap:anywhere;}` +
  `</style>`;

/**
 * Sanitizes raw HTML email content for isolated <iframe sandbox="allow-popups allow-popups-to-escape-sandbox"> srcdoc rendering.
 * Strips active elements/meta-refresh/base tags and ensures all links open in a new tab with no referrer leakage.
 */
export function buildEmailPreviewSrcdoc(rawHtml: string): string {
  const cleaned = String(rawHtml ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[\s\S]*$/gi, "")
    .replace(/<(iframe|object|embed|applet)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(iframe|object|embed|applet)\b[^>]*\/?>/gi, "")
    .replace(
      /<meta\b[^>]*http-equiv\s*=\s*(?:"[^"]*refresh[^"]*"|'[^']*refresh[^']*'|[^\s>]*refresh[^\s>]*)[^>]*>/gi,
      "",
    )
    .replace(/<base\b[^>]*>/gi, "")
    .replace(
      /(<a\b[^>]*?)\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      "$1",
    );

  if (/<head\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(
      /<head\b[^>]*>/i,
      (match) => `${match}${EMAIL_PREVIEW_HEAD_INJECT}`,
    );
  }
  if (/<html\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(
      /<html\b[^>]*>/i,
      (match) => `${match}<head>${EMAIL_PREVIEW_HEAD_INJECT}</head>`,
    );
  }
  if (/<body\b[^>]*>/i.test(cleaned)) {
    return `<!doctype html><html><head>${EMAIL_PREVIEW_HEAD_INJECT}</head>${cleaned}</html>`;
  }
  return `<!doctype html><html><head>${EMAIL_PREVIEW_HEAD_INJECT}</head><body>${cleaned}</body></html>`;
}

/**
 * Safely renders plain-text email content into a container with clickable https/http links.
 */
export function renderPlainTextWithLinks(
  container: HTMLElement,
  text: string,
): void {
  container.textContent = "";
  const content = text || "(无正文内容)";
  const urlRe = /https?:\/\/[^\s<>"'`)\]]+/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(content)) !== null) {
    const start = match.index;
    const rawUrl = match[0].replace(/[.,;:!?]+$/, "");
    if (start > lastIndex) {
      container.appendChild(
        document.createTextNode(content.slice(lastIndex, start)),
      );
    }
    const a = document.createElement("a");
    a.href = rawUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = rawUrl;
    container.appendChild(a);
    lastIndex = start + rawUrl.length;
  }
  if (lastIndex < content.length) {
    container.appendChild(document.createTextNode(content.slice(lastIndex)));
  }
}
