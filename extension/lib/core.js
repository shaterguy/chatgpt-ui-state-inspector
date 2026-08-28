(() => {
  "use strict";

  const REDACTED = "[redacted]";
  const SENSITIVE_HREF = /^\/(?:c|g|share)\//i;
  const CONTROL_ROLES = new Set([
    "button", "menuitem", "menuitemradio", "menuitemcheckbox", "option",
    "radio", "switch", "tab", "checkbox", "combobox", "listbox"
  ]);
  const SAFE_ATTRS = [
    "id", "role", "type", "name", "title", "aria-label", "aria-labelledby",
    "aria-describedby", "aria-checked", "aria-selected", "aria-pressed",
    "aria-expanded", "aria-current", "aria-haspopup", "aria-controls",
    "data-testid", "data-state", "data-value", "disabled", "checked"
  ];

  function cleanWhitespace(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function sanitizeText(value, maxLength = 140) {
    const text = cleanWhitespace(value);
    if (!text) return null;
    if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) return REDACTED;
    if (/https?:\/\/|www\./i.test(text)) return REDACTED;
    if (/\b(?:\+?\d[\d .()-]{7,}\d)\b/.test(text)) return REDACTED;
    if (text.length > maxLength) return "[redacted:long-text]";
    return text;
  }

  function isLikelySensitiveHref(href) {
    if (!href) return false;
    try {
      const url = new URL(href, "https://chatgpt.com");
      return url.origin === "https://chatgpt.com" && SENSITIVE_HREF.test(url.pathname);
    } catch {
      return true;
    }
  }

  function stableClassTokens(className) {
    return cleanWhitespace(className)
      .split(" ")
      .filter(Boolean)
      .filter((token) => token.length <= 48)
      .filter((token) => !/^(?:css-|sc-|__|_)/i.test(token))
      .filter((token) => !/[a-f0-9]{8,}/i.test(token))
      .filter((token) => !/\d{4,}/.test(token))
      .slice(0, 5);
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => "\\" + char);
  }

  function isSensitiveSurface(element) {
    if (!element?.closest) return true;
    if (element.matches("input, textarea, [contenteditable='true'], [contenteditable='plaintext-only']")) return true;
    if (element.closest("input, textarea, [contenteditable='true'], [data-message-author-role], article")) return true;
    if (element.matches("a[href]") && isLikelySensitiveHref(element.getAttribute("href"))) return true;
    return false;
  }

  function safeControlText(element, role) {
    if (isSensitiveSurface(element)) return null;
    if (element.closest("nav, aside") && !element.closest("[role='menu'], [role='listbox'], [role='dialog']")) return null;
    const tag = element.tagName?.toLowerCase();
    const isControl = tag === "button" || tag === "option" || CONTROL_ROLES.has(role);
    if (!isControl) return null;
    return sanitizeText(element.innerText || element.textContent, 100);
  }

  function getRole(element) {
    return cleanWhitespace(element.getAttribute?.("role")) ||
      ({BUTTON: "button", SELECT: "combobox", OPTION: "option", INPUT: "input", A: "link"}[element.tagName] ?? null);
  }

  function attributeSnapshot(element) {
    const attrs = {};
    const sensitive = isSensitiveSurface(element);
    const sensitiveAttributes = new Set([
      "name", "title", "aria-label", "aria-labelledby", "aria-describedby", "data-value"
    ]);
    for (const name of SAFE_ATTRS) {
      if (!element.hasAttribute?.(name)) continue;
      if (sensitive && sensitiveAttributes.has(name)) continue;
      const raw = element.getAttribute(name);
      if (name === "title" || name === "aria-label") {
        attrs[name] = sanitizeText(raw, 100);
      } else if (name === "id" && /\d{6,}|[a-f0-9]{12,}/i.test(raw || "")) {
        attrs[name] = "[dynamic-id]";
      } else {
        attrs[name] = cleanWhitespace(raw).slice(0, 160);
      }
    }
    const classes = stableClassTokens(element.getAttribute?.("class"));
    if (classes.length) attrs.classTokens = classes;
    return attrs;
  }

  function nthOfType(element) {
    if (!element?.parentElement) return "";
    const tag = element.tagName.toLowerCase();
    const siblings = [...element.parentElement.children].filter((node) => node.tagName === element.tagName);
    if (siblings.length <= 1) return tag;
    return `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`;
  }

  function locatorCandidates(element) {
    if (!element?.tagName) return [];
    const tag = element.tagName.toLowerCase();
    const attrs = attributeSnapshot(element);
    const result = [];
    const push = (kind, selector, score) => {
      if (selector && !result.some((item) => item.selector === selector)) result.push({kind, selector, score});
    };

    const rawId = element.getAttribute("id");
    if (rawId && attrs.id !== "[dynamic-id]") push("id", `#${cssEscape(rawId)}`, 0.98);
    const testId = element.getAttribute("data-testid");
    if (testId) push("data-testid", `[data-testid="${cssEscape(testId)}"]`, 0.96);
    const ariaLabel = isSensitiveSurface(element)
      ? null
      : sanitizeText(element.getAttribute("aria-label"), 100);
    if (ariaLabel && ariaLabel !== REDACTED) {
      push("aria-label", `${tag}[aria-label="${cssEscape(ariaLabel)}"]`, 0.9);
    }
    const role = getRole(element);
    const text = safeControlText(element, role);
    if (role && text && text !== REDACTED) {
      push("role+name", `[role="${cssEscape(role)}"] :: name="${text}"`, 0.88);
    }
    const state = element.getAttribute("data-state");
    if (role && state) push("role+state", `[role="${cssEscape(role)}"][data-state="${cssEscape(state)}"]`, 0.72);
    const classes = stableClassTokens(element.getAttribute("class"));
    if (classes.length) push("class", `${tag}.${classes.map(cssEscape).join(".")}`, 0.55);

    const path = [];
    let current = element;
    for (let depth = 0; current?.tagName && depth < 6; depth += 1) {
      const currentId = current.getAttribute("id");
      if (currentId && !/\d{6,}|[a-f0-9]{12,}/i.test(currentId)) {
        path.unshift(`#${cssEscape(currentId)}`);
        break;
      }
      const currentTestId = current.getAttribute("data-testid");
      if (currentTestId) {
        path.unshift(`[data-testid="${cssEscape(currentTestId)}"]`);
        break;
      }
      path.unshift(nthOfType(current));
      current = current.parentElement;
    }
    push("structural-path", path.join(" > "), 0.35);
    return result.slice(0, 6);
  }

  function xpath(element) {
    if (!element?.tagName) return null;
    const parts = [];
    let current = element;
    for (let depth = 0; current?.nodeType === 1 && depth < 8; depth += 1) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((node) => node.tagName === current.tagName)
        : [current];
      const index = siblings.length > 1 ? `[${siblings.indexOf(current) + 1}]` : "";
      parts.unshift(tag + index);
      current = current.parentElement;
    }
    return "/" + parts.join("/");
  }

  function describeElement(element) {
    if (!element?.tagName) return null;
    const rect = element.getBoundingClientRect?.();
    const style = globalThis.getComputedStyle ? globalThis.getComputedStyle(element) : null;
    const visible = Boolean(rect && rect.width > 0 && rect.height > 0 &&
      style?.visibility !== "hidden" && style?.display !== "none");
    const role = getRole(element);
    const sensitive = isSensitiveSurface(element);
    const ariaLabel = sensitive ? null : sanitizeText(element.getAttribute("aria-label"), 100);
    return {
      tag: element.tagName.toLowerCase(),
      role,
      accessibleName: ariaLabel,
      text: safeControlText(element, role),
      attributes: attributeSnapshot(element),
      state: {
        checked: element.getAttribute("aria-checked") ?? (typeof element.checked === "boolean" ? element.checked : null),
        selected: element.getAttribute("aria-selected"),
        pressed: element.getAttribute("aria-pressed"),
        expanded: element.getAttribute("aria-expanded"),
        current: element.getAttribute("aria-current"),
        disabled: element.matches?.(":disabled") || element.getAttribute("aria-disabled") === "true",
        dataState: element.getAttribute("data-state")
      },
      rect: rect ? {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height)
      } : null,
      visible,
      sensitiveSurface: sensitive,
      locators: locatorCandidates(element),
      xpath: xpath(element)
    };
  }

  function describeNode(node) {
    if (node?.nodeType === 1) return describeElement(node);
    return {nodeType: node?.nodeType ?? null};
  }

  const api = {
    REDACTED,
    sanitizeText,
    isLikelySensitiveHref,
    stableClassTokens,
    isSensitiveSurface,
    attributeSnapshot,
    locatorCandidates,
    describeElement,
    describeNode
  };
  globalThis.UiStateInspectorCore = Object.freeze(api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
