/**
 * tests/unit/ui/browser/a11y-audit.ts - a Lighthouse-style accessibility score for one page state (WP7·2, TASKS v1.1
 * WP7 acceptance 4), without the `lighthouse` package (not a dependency; no agent installs one).
 *
 * It re-implements the axe rules Lighthouse's accessibility category scores that apply to the console, with
 * Lighthouse's weights, and scores the same way: sum(weight of passing applicable audits) / sum(weight of applicable
 * audits). Colour contrast follows axe's method (text over the composited background stack under it). It is a proxy: the integrator can confirm with the Lighthouse panel in Chrome DevTools (docs/notes/wp7.md).
 */
import type { Page } from "@playwright/test";

export interface AuditResult {
  id: string;
  weight: number;
  applicable: boolean;
  pass: boolean;
  items: string[];
}

/** Lighthouse 12 accessibility weights for the audits implemented here. */
export const WEIGHTS: Record<string, number> = {
  "aria-allowed-attr": 10, "aria-dialog-name": 7, "aria-hidden-body": 10, "aria-hidden-focus": 7, "aria-prohibited-attr": 7,
  "aria-required-children": 10, "aria-required-parent": 10, "aria-roles": 7, "aria-toggle-field-name": 7, "aria-valid-attr-value": 10,
  "aria-valid-attr": 10, "button-name": 10, bypass: 7, "color-contrast": 7, "definition-list": 7, dlitem: 7, "document-title": 7,
  "duplicate-id-aria": 10, "heading-order": 3, "html-has-lang": 7, "image-alt": 10, label: 7, "landmark-one-main": 3, "link-name": 7,
  list: 7, listitem: 7, "meta-viewport": 10, "select-name": 7, tabindex: 7, "target-size": 7,
};

type Raw = Record<string, { applicable: boolean; items: string[] }>;

/** Runs in the page (serialised by Playwright): every structural rule. */
function pageRules(): Raw {
  const out: Raw = {};
  const add = (id: string, applicable: boolean, items: string[]) => (out[id] = { applicable, items: items.slice(0, 12) });
  const all = <T extends Element = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));
  const desc = (el: Element): string => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` "${txt}"` : ""}`;
  };
  const hiddenFromAT = (el: Element): boolean => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      if (e.getAttribute("aria-hidden") === "true") return true;
      if ((e as HTMLElement).hidden) return true;
      const s = getComputedStyle(e);
      if (s.display === "none" || s.visibility === "hidden") return true;
    }
    return false;
  };
  const textOf = (el: Element): string => {
    let s = "";
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) s += n.textContent ?? "";
      else if (n.nodeType === 1) {
        const e = n as Element;
        if (e.getAttribute("aria-hidden") === "true") continue;
        const cs = getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        if (e.tagName.toLowerCase() === "svg") s += e.getAttribute("aria-label") ?? "";
        else if (e.tagName === "IMG") s += (e as HTMLImageElement).alt ?? "";
        else s += ` ${e.getAttribute("aria-label") ?? textOf(e)} `;
      }
    }
    return s.replace(/\s+/g, " ").trim();
  };
  const accName = (el: Element): string => {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      if (t) return t;
    }
    const al = el.getAttribute("aria-label");
    if (al?.trim()) return al.trim();
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l?.textContent?.trim()) return l.textContent.trim();
    }
    const wrap = el.closest("label");
    if (wrap && wrap !== el && textOf(wrap)) return textOf(wrap);
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "select" && tag !== "textarea") {
      const t = textOf(el);
      if (t) return t;
    }
    const title = el.getAttribute("title");
    if (title?.trim()) return title.trim();
    if (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type) && el.value) return el.value;
    if (el instanceof HTMLInputElement && el.placeholder) return el.placeholder; // axe accepts a placeholder as a last resort
    return "";
  };
  const roleOf = (el: Element): string => {
    const r = el.getAttribute("role");
    if (r) return r.split(/\s+/)[0] ?? "";
    const tag = el.tagName.toLowerCase();
    const implicit: Record<string, string> = {
      button: "button", a: el.hasAttribute("href") ? "link" : "generic", nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
      aside: "complementary", section: el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : "generic", ul: "list", ol: "list",
      li: "listitem", dl: "generic", dt: "term", dd: "definition", h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
      p: "paragraph", div: "generic", span: "generic", b: "generic", i: "generic", small: "generic", strong: "strong", em: "emphasis", code: "code",
      sub: "subscript", sup: "superscript", del: "deletion", ins: "insertion", form: "form", table: "table", img: "img", svg: "graphics-document",
      input: "textbox", select: "combobox", textarea: "textbox", label: "generic", time: "time", figure: "figure", article: "article", dialog: "dialog",
    };
    return implicit[tag] ?? "generic";
  };
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const inert = (el: Element): boolean => !!el.closest("[inert]");

  add("document-title", true, document.title.trim() ? [] : ["<title> is empty"]);
  add("html-has-lang", true, document.documentElement.lang ? [] : ["<html> has no lang"]);
  const vp = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
  const maxScale = /maximum-scale\s*=\s*([\d.]+)/.exec(vp);
  add("meta-viewport", !!vp, /user-scalable\s*=\s*(no|0)/.test(vp) || (maxScale && Number(maxScale[1]) < 5) ? [vp] : []);

  const buttons = all('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]').filter((b) => !hiddenFromAT(b));
  add("button-name", buttons.length > 0, buttons.filter((b) => !accName(b)).map(desc));
  const links = all("a[href]").filter((a) => !hiddenFromAT(a));
  add("link-name", links.length > 0, links.filter((a) => !accName(a)).map(desc));
  const imgs = all("img").filter((i) => !hiddenFromAT(i));
  add("image-alt", imgs.length > 0, imgs.filter((i) => !i.hasAttribute("alt") && !i.getAttribute("aria-label")).map(desc));
  const fields = all('input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]), textarea').filter((f) => !hiddenFromAT(f));
  add("label", fields.length > 0, fields.filter((f) => !accName(f)).map(desc));
  const selects = all("select").filter((f) => !hiddenFromAT(f));
  add("select-name", selects.length > 0, selects.filter((f) => !accName(f)).map(desc));

  const VALID_ROLES = new Set(
    ("alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem").split(" "),
  );
  const roled = all("[role]");
  add("aria-roles", roled.length > 0, roled.filter((e) => !(e.getAttribute("role") ?? "").split(/\s+/).every((r) => VALID_ROLES.has(r))).map(desc));

  const VALID_ATTRS = new Set(
    ("activedescendant atomic autocomplete braillelabel brailleroledescription busy checked colcount colindex colindextext colspan controls current describedby description details disabled dropeffect errormessage expanded flowto grabbed haspopup hidden invalid keyshortcuts label labelledby level live modal multiline multiselectable orientation owns placeholder posinset pressed readonly relevant required roledescription rowcount rowindex rowindextext rowspan selected setsize sort valuemax valuemin valuenow valuetext").split(" "),
  );
  const ariaEls = all("*").filter((e) => Array.from(e.attributes).some((a) => a.name.startsWith("aria-")));
  add("aria-valid-attr", ariaEls.length > 0, ariaEls.filter((e) => Array.from(e.attributes).some((a) => a.name.startsWith("aria-") && !VALID_ATTRS.has(a.name.slice(5)))).map(desc));

  // aria-valid-attr-value: id references resolve; token values are valid.
  const bad: string[] = [];
  const TOKENS: Record<string, string[]> = {
    "aria-pressed": ["true", "false", "mixed", "undefined"], "aria-checked": ["true", "false", "mixed", "undefined"], "aria-selected": ["true", "false", "undefined"],
    "aria-expanded": ["true", "false", "undefined"], "aria-hidden": ["true", "false", "undefined"], "aria-live": ["off", "polite", "assertive"],
    "aria-modal": ["true", "false"], "aria-disabled": ["true", "false"], "aria-haspopup": ["true", "false", "menu", "listbox", "tree", "grid", "dialog"],
    "aria-current": ["page", "step", "location", "date", "time", "true", "false"], "aria-orientation": ["horizontal", "vertical", "undefined"],
  };
  for (const e of ariaEls) {
    for (const a of Array.from(e.attributes)) {
      if (["aria-labelledby", "aria-describedby"].includes(a.name)) {
        if (!a.value.split(/\s+/).some((id) => document.getElementById(id))) bad.push(`${a.name}="${a.value}" on ${desc(e)}`);
      } else if (["aria-controls", "aria-owns", "aria-activedescendant"].includes(a.name)) {
        if (a.value && !a.value.split(/\s+/).every((id) => document.getElementById(id))) bad.push(`${a.name}="${a.value}" on ${desc(e)}`);
      } else if (TOKENS[a.name] && !TOKENS[a.name]!.includes(a.value)) bad.push(`${a.name}="${a.value}" on ${desc(e)}`);
    }
  }
  add("aria-valid-attr-value", ariaEls.length > 0, bad);

  // aria-prohibited-attr: naming a generic / paragraph / strong … element.
  const PROHIBIT_NAME = new Set(["caption", "code", "deletion", "emphasis", "generic", "insertion", "paragraph", "presentation", "none", "strong", "subscript", "superscript"]);
  const named = all("[aria-label], [aria-labelledby]").filter((e) => !hiddenFromAT(e));
  add("aria-prohibited-attr", named.length > 0, named.filter((e) => PROHIBIT_NAME.has(roleOf(e))).map(desc));

  // aria-allowed-attr (the common cases): aria-pressed / aria-checked / aria-selected / aria-expanded on roles that do not support them.
  const allowed: Record<string, string[]> = {
    "aria-pressed": ["button"], "aria-checked": ["checkbox", "switch", "radio", "menuitemcheckbox", "menuitemradio", "option", "treeitem"],
    "aria-selected": ["tab", "option", "row", "gridcell", "treeitem", "columnheader", "rowheader"],
  };
  const disallowed: string[] = [];
  for (const [attr, roles] of Object.entries(allowed)) for (const e of all(`[${attr}]`)) if (!roles.includes(roleOf(e))) disallowed.push(`${attr} on ${roleOf(e)} ${desc(e)}`);
  add("aria-allowed-attr", ariaEls.length > 0, disallowed);

  add("aria-hidden-body", true, document.body.getAttribute("aria-hidden") === "true" ? ["body"] : []);
  const hid = all('[aria-hidden="true"]');
  // axe's focusable-modal-open: with a modal dialog open, focusables behind it are "needs review", not a failure.
  const modalOpen = all('[role="dialog"], [role="alertdialog"], dialog[open]').some((d) => getComputedStyle(d).display !== "none");
  add(
    "aria-hidden-focus",
    hid.length > 0 && !modalOpen,
    hid.flatMap((h) => [h, ...Array.from(h.querySelectorAll(FOCUSABLE))].filter((f) => f.matches(FOCUSABLE) && !inert(f) && getComputedStyle(f).display !== "none").map(desc)),
  );
  const pos = all("[tabindex]").filter((e) => Number(e.getAttribute("tabindex")) > 0);
  add("tabindex", all("[tabindex]").length > 0, pos.map(desc));

  const ids = new Map<string, number>();
  for (const e of all("[id]")) ids.set(e.id, (ids.get(e.id) ?? 0) + 1);
  const refd = new Set(all("[aria-labelledby],[aria-describedby],[aria-controls],[for]").flatMap((e) => ["aria-labelledby", "aria-describedby", "aria-controls", "for"].flatMap((a) => (e.getAttribute(a) ?? "").split(/\s+/)).filter(Boolean)));
  add("duplicate-id-aria", refd.size > 0, [...refd].filter((id) => (ids.get(id) ?? 0) > 1));

  const uls = all("ul, ol").filter((l) => !hiddenFromAT(l) && !l.getAttribute("role"));
  add("list", uls.length > 0, uls.filter((l) => Array.from(l.children).some((c) => !["LI", "SCRIPT", "TEMPLATE"].includes(c.tagName))).map(desc));
  const lis = all("li").filter((l) => !hiddenFromAT(l));
  add("listitem", lis.length > 0, lis.filter((l) => { const p = l.parentElement; return !p || !(["UL", "OL", "MENU"].includes(p.tagName) || p.getAttribute("role") === "list"); }).map(desc));
  const dls = all("dl").filter((l) => !hiddenFromAT(l));
  add("definition-list", dls.length > 0, dls.filter((l) => Array.from(l.children).some((c) => !["DT", "DD", "DIV", "SCRIPT", "TEMPLATE"].includes(c.tagName))).map(desc));
  const dts = all("dt, dd").filter((l) => !hiddenFromAT(l));
  add("dlitem", dts.length > 0, dts.filter((d) => { const p = d.parentElement; return !p || !(p.tagName === "DL" || (p.tagName === "DIV" && p.parentElement?.tagName === "DL")); }).map(desc));

  const heads = all("h1, h2, h3, h4, h5, h6, [role=heading]").filter((h) => !hiddenFromAT(h));
  const order: string[] = [];
  let prev = 0;
  for (const h of heads) {
    const lvl = h.getAttribute("role") === "heading" ? Number(h.getAttribute("aria-level") ?? 2) : Number(h.tagName[1]);
    if (prev && lvl > prev + 1) order.push(`h${prev} → h${lvl}: ${desc(h)}`);
    prev = lvl;
  }
  add("heading-order", heads.length > 1, order);

  const need: Record<string, string[]> = { tablist: ["tab"], list: ["listitem"], listbox: ["option", "group"], menu: ["menuitem", "menuitemcheckbox", "menuitemradio", "group"], radiogroup: ["radio"] };
  const reqKids: string[] = [];
  for (const [role, kids] of Object.entries(need)) for (const e of all(`[role="${role}"]`)) if (!Array.from(e.querySelectorAll("*")).some((c) => kids.includes(roleOf(c)))) reqKids.push(`${role}: ${desc(e)}`);
  add("aria-required-children", all("[role=tablist],[role=list],[role=listbox],[role=menu],[role=radiogroup]").length > 0, reqKids);
  const parents: Record<string, string[]> = { tab: ["tablist"], option: ["listbox", "group"], menuitem: ["menu", "menubar", "group"] };
  const reqPar: string[] = [];
  for (const [role, ps] of Object.entries(parents)) for (const e of all(`[role="${role}"]`)) { let p = e.parentElement; while (p && !ps.includes(roleOf(p))) p = p.parentElement; if (!p) reqPar.push(`${role}: ${desc(e)}`); }
  add("aria-required-parent", all("[role=tab],[role=option],[role=menuitem]").length > 0, reqPar);

  const dialogs = all('[role="dialog"], [role="alertdialog"], dialog').filter((d) => !hiddenFromAT(d));
  add("aria-dialog-name", dialogs.length > 0, dialogs.filter((d) => !d.getAttribute("aria-label") && !d.getAttribute("aria-labelledby")).map(desc));
  const toggles = all('[role="switch"], [role="checkbox"], input[type="checkbox"]').filter((d) => !hiddenFromAT(d));
  add("aria-toggle-field-name", toggles.length > 0, toggles.filter((t) => !accName(t)).map(desc));

  const mains = all('main, [role="main"]').filter((m) => !hiddenFromAT(m));
  add("landmark-one-main", true, mains.length === 1 ? [] : [`${mains.length} main landmarks`]);
  add("bypass", true, mains.length > 0 || heads.length > 0 ? [] : ["no main landmark, heading or skip link"]);

  // target-size (WCAG 2.2 AA, axe): a target under 24×24 CSS px needs a 24 px circle around its centre free of other targets.
  const targets = all("button, a[href], input:not([type=hidden]), select, [role=button], [role=tab], [role=switch], [tabindex='0']")
    .filter((t) => !hiddenFromAT(t) && !inert(t))
    .map((t) => ({ t, r: t.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0);
  const small: string[] = [];
  for (const { t, r } of targets) {
    if (r.width >= 24 && r.height >= 24) continue;
    // inline links inside a sentence are exempt
    if (t.tagName === "A" && getComputedStyle(t).display === "inline") continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const clash = targets.some(({ t: o, r: q }) => {
      if (o === t || o.contains(t) || t.contains(o)) return false;
      const dx = Math.max(q.left - cx, 0, cx - q.right);
      const dy = Math.max(q.top - cy, 0, cy - q.bottom);
      return Math.hypot(dx, dy) < 12;
    });
    if (clash) small.push(`${Math.round(r.width)}×${Math.round(r.height)} ${desc(t)}`);
  }
  add("target-size", targets.length > 0, small);
  return out;
}

/**
 * Runs in the page: WCAG AA text contrast the way axe's color-contrast rule measures it: the foreground over the
 * stack of backgrounds under the text's centre (document.elementsFromPoint), composited until opaque, over white;
 * ancestor opacity applied to the text. Colours are resolved by the browser itself (a 1×1 canvas), so oklch(),
 * color-mix() and color() all work. Text over an image or gradient is "needs review" (not a failure), like axe.
 * Disabled controls are exempt (WCAG 1.4.3).
 */
function contrastRule(): { applicable: boolean; items: string[] } {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  if (!cx) return { applicable: false, items: [] };
  const rgba = (css: string): [number, number, number, number] => {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = "#000";
    cx.fillStyle = css;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
  };
  const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] => [
    top[0] * top[3] + under[0] * (1 - top[3]), top[1] * top[3] + under[1] * (1 - top[3]), top[2] * top[3] + under[2] * (1 - top[3]),
  ];
  const lum = (c: [number, number, number]): number => {
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: [number, number, number], b: [number, number, number]) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m) as [number, number];
    return (x + 0.05) / (y + 0.05);
  };
  const items: string[] = [];
  let checked = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !(n.textContent ?? "").trim()) continue;
    seen.add(el);
    if (el.closest("script, style, noscript, svg, [disabled], [aria-disabled='true'], option")) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = Array.from(range.getClientRects()).find((q) => q.width > 1 && q.height > 1);
    if (!r) continue;
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue; // off-screen: axe scrolls; we audit what is visible
    // sr-only text (1 px clipped) is not rendered text
    if (r.width <= 1 || s.clip === "rect(0px, 0px, 0px, 0px)" || s.clipPath === "inset(50%)") continue;
    let opacity = 1;
    for (let e: Element | null = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
    if (opacity < 0.1) continue;
    const stack = document.elementsFromPoint(x, y);
    const i = stack.indexOf(el);
    if (i < 0) continue; // covered by another element (a modal overlay, the floating phone): axe marks it "needs review"
    let review = false;
    const layers: [number, number, number, number][] = [];
    for (const b of stack.slice(i)) {
      const bs = getComputedStyle(b);
      if (bs.backgroundImage && bs.backgroundImage !== "none") {
        review = true;
        break;
      }
      const c = rgba(bs.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    if (review) continue;
    let bg: [number, number, number] = [255, 255, 255];
    for (const l of layers.reverse()) bg = over(l, bg);
    const fgc = rgba(s.color);
    const fg = over([fgc[0], fgc[1], fgc[2], fgc[3] * opacity], bg);
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    checked++;
    if (got + 0.005 < need) {
      const txt = (n.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 36);
      items.push(`${got.toFixed(2)} < ${need} "${txt}" (${el.tagName.toLowerCase()}.${String(el.className).split(/\s+/).slice(0, 3).join(".")}, ${size}px)`);
    }
  }
  return { applicable: checked > 0, items: [...new Set(items)] };
}

export async function auditPage(page: Page): Promise<{ score: number; audits: AuditResult[] }> {
  const raw = await page.evaluate(pageRules);
  raw["color-contrast"] = await page.evaluate(contrastRule);
  const audits: AuditResult[] = Object.entries(raw).map(([id, r]) => ({ id, weight: WEIGHTS[id] ?? 0, applicable: r.applicable, pass: r.items.length === 0, items: r.items }));
  const scored = audits.filter((a) => a.applicable && a.weight > 0);
  const total = scored.reduce((s, a) => s + a.weight, 0);
  const got = scored.filter((a) => a.pass).reduce((s, a) => s + a.weight, 0);
  return { score: Math.round((100 * got) / Math.max(1, total)), audits };
}
