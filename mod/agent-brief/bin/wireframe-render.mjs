// @simonyam/wireframe-dsl — generated, do not edit. Run `npm run build`.
// Self-contained: node builtins only, no network, no child process, no eval.
// Bundled from src/cli.ts + wireframe.ts + render-svg.ts + wireframe-theme.ts.

// src/cli.ts
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// src/wireframe.ts
var WIREFRAME_SIZES = /* @__PURE__ */ new Set([
  "sm",
  "md",
  "lg",
  "page"
]);
function suggestClosest(value, candidates, maxDistance = 2) {
  const lower = value.toLowerCase();
  let best = null;
  for (const candidate of candidates) {
    const distance = levenshtein(lower, candidate.toLowerCase());
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { candidate, distance };
    }
  }
  return best?.candidate ?? null;
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}
function maybeSuggest(value, candidates) {
  const closest = suggestClosest(value, candidates);
  return closest ? ` Did you mean "${closest}"?` : "";
}
var FRAME_KINDS = /* @__PURE__ */ new Set([
  "browser",
  "doc",
  "dark-app",
  "terminal",
  "napkin",
  "panel",
  "none"
]);
var WIREFRAME_FENCE_RE = /^```wireframe[ \t]*$/;
function extractWireframeBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  let openLine = null;
  let buffer = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (openLine === null) {
      if (WIREFRAME_FENCE_RE.test(line.trim())) {
        openLine = i + 1;
        buffer = [];
      }
      continue;
    }
    if (line.trim() === "```") {
      blocks.push({ line: openLine, content: buffer.join("\n") });
      openLine = null;
      continue;
    }
    buffer.push(line);
  }
  return blocks;
}
function parseWireframe(source) {
  try {
    const lines = tokenize(source);
    if (lines.length === 0) return fail("Empty wireframe block.");
    droppedEntries = [];
    const root = parseBlock(lines, 0, 0).map;
    const wireframe = assembleWireframe(root);
    const dropped = droppedEntries.length > 0 ? droppedEntries : void 0;
    droppedEntries = [];
    return { ok: true, wireframe, dropped };
  } catch (error) {
    droppedEntries = [];
    return fail(error instanceof Error ? error.message : String(error));
  }
}
var droppedEntries = [];
function fail(error) {
  return { ok: false, error };
}
function tokenize(source) {
  const out = [];
  const allLines = source.split(/\r?\n/u);
  for (let i = 0; i < allLines.length; i += 1) {
    const raw = allLines[i];
    const lineNumber = i + 1;
    if (raw.includes("	")) {
      throw new Error(
        `Line ${lineNumber}: tabs are not allowed; use 2 spaces per indent level.`
      );
    }
    const stripped = raw.replace(/\s+$/u, "");
    if (!stripped.trim() || stripped.trim().startsWith("#")) continue;
    const indentMatch = /^( *)/u.exec(stripped);
    const indent = (indentMatch ? indentMatch[1].length : 0) / 2;
    if (!Number.isInteger(indent)) {
      throw new Error(
        `Line ${lineNumber}: indent must be a multiple of 2 spaces: "${stripped}".`
      );
    }
    out.push({ indent, text: stripped.trim(), raw: stripped, lineNumber });
  }
  return out;
}
function parseBlock(lines, start, indent) {
  const entries = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i].text;
    if (line.startsWith("- ")) break;
    const colonIndex = findKeyColon(line);
    if (colonIndex < 0) {
      throw new Error(
        `Line ${lines[i].lineNumber}: expected "key: value" but got "${line}".`
      );
    }
    const key = line.slice(0, colonIndex).trim();
    const rest = line.slice(colonIndex + 1).trim();
    if (rest.length === 0) {
      const nextLine = lines[i + 1];
      if (!nextLine || nextLine.indent <= indent) {
        entries[key] = { kind: "scalar", value: "" };
        i += 1;
        continue;
      }
      if (nextLine.text.startsWith("- ")) {
        const list = parseList(lines, i + 1, nextLine.indent);
        entries[key] = { kind: "list", items: list.items };
        i = list.next;
        continue;
      }
      const child = parseBlock(lines, i + 1, nextLine.indent);
      entries[key] = { kind: "map", entries: child.map };
      i = child.next;
      continue;
    }
    entries[key] = parseInlineValue(rest);
    i += 1;
  }
  return { map: entries, next: i };
}
function findKeyColon(line) {
  let inQuote = null;
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuote) {
      if (ch === inQuote && line[i - 1] !== "\\") inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}
function parseList(lines, start, indent) {
  const items = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
    const remainder = lines[i].text.slice(2).trim();
    const colonIndex = findKeyColon(remainder);
    if (colonIndex > 0 && !looksLikeInlineMap(remainder)) {
      const key = remainder.slice(0, colonIndex).trim();
      const rest = remainder.slice(colonIndex + 1).trim();
      const map = {};
      if (rest.length > 0) {
        map[key] = parseInlineValue(rest);
        i += 1;
      } else {
        const next2 = lines[i + 1];
        if (next2 && next2.indent > indent && next2.text.startsWith("- ")) {
          const nested = parseList(lines, i + 1, next2.indent);
          map[key] = { kind: "list", items: nested.items };
          i = nested.next;
        } else if (next2 && next2.indent > indent) {
          const child = parseBlock(lines, i + 1, next2.indent);
          map[key] = { kind: "map", entries: child.map };
          i = child.next;
        } else {
          map[key] = { kind: "scalar", value: "" };
          i += 1;
        }
      }
      const next = lines[i];
      if (next && next.indent > indent && !next.text.startsWith("- ")) {
        const more = parseBlock(lines, i, next.indent);
        for (const [k, v] of Object.entries(more.map)) map[k] = v;
        i = more.next;
      }
      items.push({ kind: "map", entries: map });
      continue;
    }
    items.push(parseInlineValue(remainder));
    i += 1;
  }
  return { items, next: i };
}
function looksLikeInlineMap(value) {
  return value.startsWith("{") && value.endsWith("}");
}
function parseInlineValue(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    const items = splitTopLevel(inner).map((part) => parseInlineValue(part));
    return { kind: "list", items };
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1);
    const entries = {};
    for (const part of splitTopLevel(inner)) {
      const colonIndex = findKeyColon(part);
      if (colonIndex < 0) continue;
      const key = part.slice(0, colonIndex).trim();
      const value = part.slice(colonIndex + 1).trim();
      entries[key] = parseInlineValue(value);
    }
    return { kind: "map", entries };
  }
  return { kind: "scalar", value: unquote(trimmed) };
}
function splitTopLevel(raw) {
  const out = [];
  let depth = 0;
  let inQuote = null;
  let buf = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inQuote) {
      buf += ch;
      if (ch === inQuote && raw[i - 1] !== "\\") inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      buf += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      if (buf.trim().length > 0) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}
function unquote(value) {
  if (value.length >= 2 && (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\(["'\\])/gu, "$1");
  }
  return value;
}
var KNOWN_ROOT_KEYS = [
  "layout",
  "size",
  "callouts",
  "frame",
  "label",
  "body",
  "sidebar",
  "topbar",
  "viewport",
  "grid",
  "overlay",
  "active",
  "left",
  "right",
  "arrow",
  "frames",
  "transitions"
];
function assembleWireframe(root) {
  const layout = (asScalar(root.layout) ?? "single").toLowerCase();
  const size = parseSize(asScalar(root.size));
  const callouts = parseCallouts(root.callouts);
  for (const key of Object.keys(root)) {
    if (!KNOWN_ROOT_KEYS.includes(key)) {
      droppedEntries.push(
        `Unknown top-level key "${key}:".${maybeSuggest(key, KNOWN_ROOT_KEYS)} Key (and everything under it) was dropped.`
      );
    }
  }
  if (layout === "single") {
    return { layout: "single", frame: buildFrame(root), size, callouts };
  }
  if (layout === "transformation") {
    const left = asMap(root.left);
    const right = asMap(root.right);
    if (!left || !right) {
      throw new Error("transformation layout requires `left:` and `right:` blocks.");
    }
    const arrow = asMap(root.arrow);
    return {
      layout: "transformation",
      left: buildFrame(left),
      right: buildFrame(right),
      arrow: arrow ? { top: asScalar(arrow.top) ?? void 0, bottom: asScalar(arrow.bottom) ?? void 0 } : void 0,
      size,
      callouts
    };
  }
  if (layout === "evolution") {
    const framesNode = root.frames;
    if (!framesNode || framesNode.kind !== "list") {
      throw new Error("evolution layout requires a `frames:` list.");
    }
    const frames = framesNode.items.map((item) => {
      if (item.kind !== "map") {
        throw new Error("Each `frames` entry must be a block with `frame:` and `body:`.");
      }
      return buildFrame(item.entries);
    });
    const transitionsNode = root.transitions;
    const transitions = transitionsNode?.kind === "list" ? transitionsNode.items.map((item) => item.kind === "scalar" ? item.value : "").filter((value) => value.length > 0) : void 0;
    return { layout: "evolution", frames, transitions, size, callouts };
  }
  throw new Error(
    `Unknown layout: "${layout}".${maybeSuggest(layout, LAYOUT_KINDS)} Use single | transformation | evolution.`
  );
}
var LAYOUT_KINDS = ["single", "transformation", "evolution"];
var OVERLAY_VARIANTS = ["modal", "drawer-right", "drawer-left"];
var SIZE_KINDS = ["sm", "md", "lg", "page"];
var VIEWPORT_KINDS = ["mobile", "tablet", "desktop"];
var FRAME_KIND_LIST = [
  "browser",
  "doc",
  "dark-app",
  "terminal",
  "napkin",
  "panel",
  "none"
];
function parseSize(raw) {
  if (!raw) return void 0;
  const value = raw.trim().toLowerCase();
  if (!value) return void 0;
  if (!WIREFRAME_SIZES.has(value)) {
    throw new Error(
      `Unknown size: "${raw}".${maybeSuggest(raw, SIZE_KINDS)} Use sm | md | lg | page.`
    );
  }
  return value;
}
function buildFrame(node) {
  const frame = (asScalar(node.frame) ?? "browser").toLowerCase();
  if (!FRAME_KINDS.has(frame)) {
    throw new Error(
      `Unknown frame: "${frame}".${maybeSuggest(frame, FRAME_KIND_LIST)} Use browser | doc | dark-app | terminal | napkin | panel | none.`
    );
  }
  const label = asScalar(node.label) ?? void 0;
  const size = parseSize(asScalar(node.size));
  const bodyNode = node.body;
  const body = bodyNode?.kind === "list" ? buildBodyEntries(bodyNode.items) : [];
  const sidebar = parseSidebar(node.sidebar, node.active);
  const topbar = parseTopbar(node.topbar);
  const viewport = parseViewport(asScalar(node.viewport));
  const grid = parseGrid(node.grid, viewport);
  const overlay = parseOverlay(node.overlay);
  return { frame, label, body, size, sidebar, topbar, viewport, grid, overlay };
}
function parseCallouts(node) {
  if (!node) return void 0;
  if (node.kind === "scalar") {
    return node.value.length > 0 ? [node.value] : void 0;
  }
  if (node.kind !== "list") return void 0;
  const items = node.items.map((item) => item.kind === "scalar" ? item.value : "").filter((value) => value.length > 0);
  return items.length > 0 ? items : void 0;
}
function parseOverlay(node) {
  if (!node) return void 0;
  if (node.kind !== "map") {
    throw new Error(
      "overlay must be a block with `variant:` (modal | drawer-right | drawer-left) and `body:`."
    );
  }
  const variantRaw = (asScalar(node.entries.variant) ?? "modal").toLowerCase();
  const variant = variantRaw === "modal" ? "modal" : variantRaw === "drawer-right" || variantRaw === "drawer" ? "drawer-right" : variantRaw === "drawer-left" ? "drawer-left" : null;
  if (!variant) {
    throw new Error(
      `Unknown overlay variant: "${variantRaw}".${maybeSuggest(variantRaw, OVERLAY_VARIANTS)} Use modal | drawer-right | drawer-left.`
    );
  }
  const label = asScalar(node.entries.label) ?? void 0;
  const bodyNode = node.entries.body;
  const body = bodyNode?.kind === "list" ? buildBodyEntries(bodyNode.items) : [];
  if (body.length === 0) {
    throw new Error("overlay requires a `body:` list with at least one entry.");
  }
  return { variant, label, body };
}
function parseViewport(raw) {
  if (!raw) return void 0;
  const value = raw.trim().toLowerCase();
  if (value === "mobile" || value === "tablet" || value === "desktop") {
    return value;
  }
  throw new Error(
    `Unknown viewport: "${raw}".${maybeSuggest(raw, VIEWPORT_KINDS)} Use mobile | tablet | desktop.`
  );
}
function parseGrid(node, viewport) {
  if (!node && !viewport) return void 0;
  const grid = {};
  if (viewport) grid.columns = defaultColumnsForViewport(viewport);
  if (!node) return grid;
  if (node.kind === "scalar" && node.value.length > 0) {
    const columns2 = parsePositiveInt(node.value);
    if (columns2) grid.columns = columns2;
    return grid;
  }
  if (node.kind !== "map") return grid;
  const columns = parsePositiveInt(asScalar(node.entries.columns));
  const gap = parsePositiveInt(asScalar(node.entries.gap));
  if (columns) grid.columns = columns;
  if (gap) grid.gap = gap;
  return Object.keys(grid).length > 0 ? grid : void 0;
}
function defaultColumnsForViewport(viewport) {
  if (viewport === "mobile") return 4;
  if (viewport === "tablet") return 8;
  return 12;
}
function parseSidebar(sidebarNode, activeNode) {
  if (!sidebarNode) return void 0;
  let rawItems = [];
  let activeFromMap = null;
  if (sidebarNode.kind === "list") {
    rawItems = sidebarNode.items;
  } else if (sidebarNode.kind === "map") {
    const itemsNode = sidebarNode.entries.items;
    if (itemsNode?.kind === "list") rawItems = itemsNode.items;
    const activeRaw2 = asScalar(sidebarNode.entries.active);
    if (activeRaw2 !== null) activeFromMap = activeRaw2;
  } else if (sidebarNode.kind === "scalar" && sidebarNode.value.length > 0) {
    return [{ label: sidebarNode.value }];
  }
  const items = rawItems.map(parseSidebarItem).filter((item) => item !== null);
  if (items.length === 0) return void 0;
  const activeRaw = activeFromMap ?? asScalar(activeNode);
  if (activeRaw !== null && activeRaw !== void 0) {
    const labels = items.map((item) => item.label);
    const activeIndex = resolveActiveByLabel(labels, activeRaw);
    items.forEach((item, index) => {
      item.active = index === activeIndex;
    });
  }
  return items;
}
function parseSidebarItem(node) {
  if (node.kind === "scalar") {
    return node.value.length > 0 ? { label: node.value } : null;
  }
  if (node.kind !== "map") return null;
  const label = asScalar(node.entries.label) ?? "";
  if (!label) return null;
  const item = { label };
  const activeRaw = asScalar(node.entries.active);
  if (activeRaw !== null && activeRaw !== void 0 && (activeRaw === "true" || activeRaw === label)) {
    item.active = true;
  }
  const badge = asScalar(node.entries.badge);
  if (badge) item.badge = badge;
  const nestedNode = node.entries.items;
  if (nestedNode?.kind === "list") {
    const nested = nestedNode.items.map(parseSidebarItem).filter((child) => child !== null);
    if (nested.length > 0) {
      item.items = nested;
      const subActive = asScalar(node.entries.active);
      if (subActive) {
        const labels = nested.map((sub) => sub.label);
        const idx = resolveActiveByLabel(labels, subActive);
        if (idx >= 0 && nested[idx] && nested[idx].label === subActive) {
          nested[idx].active = true;
        }
      }
    }
  }
  return item;
}
function resolveActiveByLabel(labels, raw) {
  if (raw === null || raw === void 0) return 0;
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  if (!text) return 0;
  const asNum = Number.parseInt(text, 10);
  if (Number.isFinite(asNum) && String(asNum) === text) {
    return clampIndex(asNum, labels.length);
  }
  const lower = text.toLowerCase();
  const match = labels.findIndex((label) => label.toLowerCase() === lower);
  return match >= 0 ? match : 0;
}
function parseTopbar(node) {
  if (!node) return void 0;
  if (node.kind === "scalar" && node.value.length > 0) {
    return { title: node.value };
  }
  if (node.kind !== "map") return void 0;
  const title = asScalar(node.entries.title) ?? void 0;
  const actionsNode = node.entries.actions;
  let actions;
  if (actionsNode?.kind === "list") {
    actions = actionsNode.items.map((item) => {
      if (item.kind === "scalar") {
        return item.value.length > 0 ? { label: item.value } : null;
      }
      if (item.kind === "map") {
        const label = asScalar(item.entries.label) ?? "";
        if (!label) return null;
        const badge = asScalar(item.entries.badge) ?? void 0;
        return badge ? { label, badge } : { label };
      }
      return null;
    }).filter((action) => action !== null);
    if (actions.length === 0) actions = void 0;
  } else if (actionsNode?.kind === "scalar" && actionsNode.value.length > 0) {
    actions = [{ label: actionsNode.value }];
  }
  if (!title && !actions) return void 0;
  return { title, actions };
}
var KNOWN_BODY_KEYS = [
  "heading",
  "para",
  "accent",
  "button",
  "buttons",
  "row",
  "chip",
  "tabs",
  "list",
  "field",
  "banner",
  "empty",
  "avatar",
  "avatar-stack",
  "stat",
  "table",
  "media",
  "card-grid",
  "steps",
  "columns",
  "popover",
  "breadcrumbs",
  "accordion",
  "meter",
  "pagination",
  "chrome",
  "divider",
  "spacer"
];
var BODY_SIBLING_KEYS = /* @__PURE__ */ new Set(["active", "marker"]);
function buildBodyEntries(items) {
  const out = [];
  for (const item of items) {
    const orphan = orphanSiblingEntries(item);
    if (orphan && out.length > 0) {
      adoptOrphanSibling(out[out.length - 1], orphan);
      continue;
    }
    const entry = buildBodyEntry(item);
    if (entry) out.push(entry);
  }
  return out;
}
function orphanSiblingEntries(node) {
  if (node.kind !== "map") return null;
  const keys = Object.keys(node.entries);
  if (keys.length === 0) return null;
  return keys.every((key) => BODY_SIBLING_KEYS.has(key)) ? node.entries : null;
}
function adoptOrphanSibling(prev, entries) {
  if (entries.active !== void 0) {
    if (prev.kind === "tabs") {
      prev.activeIndex = resolveActiveIndex(prev.labels, entries.active);
      droppedEntries.push(
        `"active:" was written as its own "- " item; applied to the previous tabs entry \u2014 write it as an indented sibling line.`
      );
    } else if (prev.kind === "steps") {
      prev.activeIndex = resolveActiveIndex(
        prev.steps.map((step) => step.label),
        entries.active
      );
      droppedEntries.push(
        `"active:" was written as its own "- " item; applied to the previous steps entry \u2014 write it as an indented sibling line.`
      );
    } else {
      droppedEntries.push(
        `"active:" must be an indented sibling line under a tabs/steps entry; the previous entry is "${prev.kind}". Entry was dropped.`
      );
    }
  }
  if (entries.marker !== void 0) {
    const marker = parsePositiveInt(asScalar(entries.marker));
    if (marker) {
      prev.marker = marker;
      droppedEntries.push(
        `"marker:" was written as its own "- " item; applied to the previous ${prev.kind} entry \u2014 write it as an indented sibling line.`
      );
    }
  }
}
function buildBodyEntry(node) {
  const entry = buildBodyEntryBase(node);
  if (entry === null) {
    recordDroppedEntry(node);
    return null;
  }
  if (node.kind !== "map") return entry;
  const marker = parsePositiveInt(asScalar(node.entries.marker));
  return marker ? { ...entry, marker } : entry;
}
function recordDroppedEntry(node) {
  if (node.kind === "scalar") {
    if (node.value.length === 0) return;
    droppedEntries.push(
      `Unknown body entry "${node.value}".${maybeSuggest(node.value, KNOWN_BODY_KEYS)} Entry was dropped.`
    );
    return;
  }
  if (node.kind !== "map") return;
  const allKeys = Object.keys(node.entries);
  const keys = allKeys.filter((key) => !BODY_SIBLING_KEYS.has(key));
  if (keys.length === 0) {
    if (allKeys.length > 0) {
      droppedEntries.push(
        `"${allKeys[0]}:" modifies the entry above it and must be an indented sibling line, not its own "- " list item. Entry was dropped.`
      );
    }
    return;
  }
  const known = keys.find((key) => KNOWN_BODY_KEYS.includes(key));
  if (known) {
    droppedEntries.push(
      `Body entry "${known}:" has an unusable shape and was dropped \u2014 check the documented form.`
    );
    return;
  }
  const first = keys[0];
  droppedEntries.push(
    `Unknown body entry key "${first}:".${maybeSuggest(first, KNOWN_BODY_KEYS)} Entry was dropped.`
  );
}
function buildBodyEntryBase(node) {
  if (node.kind === "scalar") {
    const key = node.value.trim().toLowerCase();
    if (key === "chrome") return { kind: "chrome" };
    if (key === "divider") return { kind: "divider" };
    if (key === "spacer") return { kind: "spacer" };
    return null;
  }
  if (node.kind !== "map") return null;
  const entries = node.entries;
  if (entries.heading) {
    return { kind: "heading", text: asScalar(entries.heading) ?? "" };
  }
  if (entries.accent) {
    const value = entries.accent;
    if (value.kind === "scalar") {
      const asNum = Number.parseInt(value.value, 10);
      if (Number.isFinite(asNum) && String(asNum) === value.value.trim()) {
        return { kind: "accent", count: asNum };
      }
      return { kind: "accent", text: value.value, count: 1 };
    }
  }
  if (entries.para !== void 0) {
    const value = entries.para;
    if (value.kind === "scalar") {
      const asNum = Number.parseInt(value.value, 10);
      if (Number.isFinite(asNum) && String(asNum) === value.value.trim()) {
        return { kind: "para", lines: asNum };
      }
      return { kind: "para", lines: 1, text: value.value };
    }
  }
  if (entries.button !== void 0) {
    const value = entries.button;
    if (value.kind === "scalar") {
      return { kind: "button", label: value.value, variant: "primary" };
    }
    if (value.kind === "list") {
      const label = value.items[0]?.kind === "scalar" ? value.items[0].value : "";
      const modifier = value.items[1]?.kind === "scalar" ? value.items[1].value : "";
      return {
        kind: "button",
        label,
        variant: modifier === "outlined" ? "outlined" : "primary"
      };
    }
  }
  if (entries.buttons !== void 0) {
    const value = entries.buttons;
    const items = [];
    if (value.kind === "list") {
      for (const item of value.items) {
        if (item.kind === "scalar") {
          items.push({ label: item.value, variant: "primary" });
        } else if (item.kind === "list") {
          const label = item.items[0]?.kind === "scalar" ? item.items[0].value : "";
          const modifier = item.items[1]?.kind === "scalar" ? item.items[1].value : "";
          items.push({
            label,
            variant: modifier === "outlined" ? "outlined" : "primary"
          });
        } else if (item.kind === "map") {
          const label = asScalar(item.entries.label) ?? "";
          const variant = (asScalar(item.entries.variant) ?? asScalar(item.entries.tone) ?? "primary").toLowerCase();
          items.push({
            label,
            variant: variant === "outlined" ? "outlined" : "primary"
          });
        }
      }
    }
    return { kind: "buttons", items };
  }
  if (entries.row) {
    const value = entries.row;
    if (value.kind === "list") {
      return { kind: "row", cells: value.items.map(toRowCell) };
    }
    if (value.kind === "scalar") {
      const cells = splitTopLevel(value.value).map((part) => toRowCell({ kind: "scalar", value: part }));
      return { kind: "row", cells };
    }
  }
  if (entries.chip) {
    const value = entries.chip;
    if (value.kind === "list") {
      const items = value.items.map((item) => parseChipItem(item)).filter((item) => item !== null);
      return items.length > 0 ? { kind: "chip", items } : null;
    }
    if (value.kind === "scalar") {
      return { kind: "chip", items: [{ label: value.value }] };
    }
    if (value.kind === "map") {
      const item = parseChipItem(value);
      return item ? { kind: "chip", items: [item] } : null;
    }
  }
  if (entries.tabs) {
    return buildTabsEntry(entries.tabs, entries.active);
  }
  if (entries.list) {
    return buildListEntry(entries.list);
  }
  if (entries.field) {
    return buildFieldEntry(entries.field);
  }
  if (entries.banner) {
    return buildBannerEntry(entries.banner);
  }
  if (entries.empty) {
    return buildEmptyEntry(entries.empty);
  }
  if (entries.avatar) {
    const value = entries.avatar;
    if (value.kind === "scalar") {
      return { kind: "avatar", initials: value.value.slice(0, 3).toUpperCase() };
    }
  }
  if (entries["avatar-stack"]) {
    return buildAvatarStackEntry(entries["avatar-stack"]);
  }
  if (entries.stat) {
    return buildStatEntry(entries.stat);
  }
  if (entries.table) {
    return buildTableEntry(entries.table);
  }
  if (entries.media) {
    return buildMediaEntry(entries.media);
  }
  if (entries["card-grid"]) {
    return buildCardGridEntry(entries["card-grid"]);
  }
  if (entries.steps) {
    return buildStepsEntry(entries.steps, entries.active);
  }
  if (entries.columns) {
    return buildColumnsEntry(entries.columns);
  }
  if (entries.popover) {
    return buildPopoverEntry(entries.popover);
  }
  if (entries.breadcrumbs) {
    return buildBreadcrumbsEntry(entries.breadcrumbs);
  }
  if (entries.accordion) {
    return buildAccordionEntry(entries.accordion);
  }
  if (entries.meter !== void 0) {
    return buildMeterEntry(entries.meter);
  }
  if (entries.pagination !== void 0) {
    return buildPaginationEntry(entries.pagination);
  }
  return null;
}
function buildBreadcrumbsEntry(node) {
  if (node.kind === "scalar") {
    return node.value.length > 0 ? { kind: "breadcrumbs", items: [node.value] } : null;
  }
  if (node.kind !== "list") return null;
  const items = node.items.map((item) => item.kind === "scalar" ? item.value : "").filter((value) => value.length > 0);
  return items.length > 0 ? { kind: "breadcrumbs", items } : null;
}
function buildAccordionEntry(node) {
  if (node.kind !== "list") return null;
  const items = [];
  for (const item of node.items) {
    if (item.kind === "scalar") {
      if (item.value.length > 0) items.push({ title: item.value, body: [] });
      continue;
    }
    if (item.kind !== "map") continue;
    const title = asScalar(item.entries.title) ?? "";
    if (!title) continue;
    const expandedRaw = asScalar(item.entries.expanded);
    const expanded = expandedRaw === "true";
    const bodyNode = item.entries.body;
    const body = bodyNode?.kind === "list" ? buildBodyEntries(bodyNode.items) : [];
    items.push({ title, expanded: expanded || void 0, body });
  }
  if (items.length === 0) return null;
  if (!items.some((item) => item.expanded)) {
    const firstWithBody = items.find((item) => item.body.length > 0);
    if (firstWithBody) firstWithBody.expanded = true;
  }
  return { kind: "accordion", items };
}
function buildMeterEntry(node) {
  if (node.kind === "scalar") {
    const value2 = parseMeterValue(node.value);
    return value2 === null ? null : { kind: "meter", value: value2, max: 100 };
  }
  if (node.kind !== "map") return null;
  const value = parseMeterValue(asScalar(node.entries.value));
  if (value === null) return null;
  const max = parsePositiveInt(asScalar(node.entries.max)) ?? 100;
  const label = asScalar(node.entries.label) ?? void 0;
  const caption = asScalar(node.entries.caption) ?? void 0;
  return { kind: "meter", value, max, label, caption };
}
function parseMeterValue(raw) {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/%$/u, "");
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}
function buildPaginationEntry(node) {
  if (node.kind === "scalar") {
    const pages2 = parsePositiveInt(node.value);
    return pages2 ? { kind: "pagination", page: 1, pages: pages2 } : null;
  }
  if (node.kind !== "map") return null;
  const pages = parsePositiveInt(asScalar(node.entries.pages));
  if (!pages) return null;
  const pageRaw = parsePositiveInt(asScalar(node.entries.page)) ?? 1;
  const page = Math.min(pageRaw, pages);
  return { kind: "pagination", page, pages };
}
function buildListEntry(node) {
  if (node.kind !== "list") {
    if (node.kind === "scalar" && node.value.length > 0) {
      return { kind: "list", items: [{ title: node.value }] };
    }
    return null;
  }
  const items = [];
  for (const item of node.items) {
    const parsed = parseListItem(item);
    if (parsed) items.push(parsed);
  }
  return items.length > 0 ? { kind: "list", items } : null;
}
function parseListItem(node) {
  if (node.kind === "scalar") {
    return node.value.length > 0 ? { title: node.value } : null;
  }
  if (node.kind === "map") {
    const title = asScalar(node.entries.title) ?? "";
    if (!title) return null;
    const leading = parseListLeading(asScalar(node.entries.leading));
    const meta = asScalar(node.entries.meta) ?? void 0;
    const trailing = asScalar(node.entries.trailing) ?? void 0;
    const badge = asScalar(node.entries.badge) ?? void 0;
    return { title, meta, trailing, leading, badge };
  }
  if (node.kind === "list") {
    const parts = node.items.map((item) => item.kind === "scalar" ? item.value : "").filter((part) => part.length > 0);
    if (parts.length === 0) return null;
    const leading = parseListLeading(parts[0]);
    if (leading) {
      return { leading, title: parts[1] ?? "", meta: parts[2], trailing: parts[3] };
    }
    return { title: parts[0], meta: parts[1], trailing: parts[2] };
  }
  return null;
}
function parseListLeading(value) {
  if (!value) return void 0;
  const lower = value.toLowerCase();
  if (lower === "icon") return "icon";
  if (lower === "avatar") return "avatar";
  if (lower === "none") return "none";
  return void 0;
}
function buildFieldEntry(node) {
  if (node.kind === "scalar") {
    return { kind: "field", label: node.value, variant: "input" };
  }
  if (node.kind !== "map") return null;
  const label = asScalar(node.entries.label) ?? void 0;
  const placeholder = asScalar(node.entries.placeholder) ?? void 0;
  const value = asScalar(node.entries.value) ?? void 0;
  const variantRaw = (asScalar(node.entries.variant) ?? "input").toLowerCase();
  const variant = variantRaw === "select" ? "select" : variantRaw === "search" ? "search" : variantRaw === "textarea" ? "textarea" : "input";
  if (!label && !placeholder && !value && variant === "input") return null;
  return { kind: "field", label, placeholder, value, variant };
}
function buildBannerEntry(node) {
  if (node.kind === "scalar") {
    return node.value.length > 0 ? { kind: "banner", variant: "info", text: node.value } : null;
  }
  if (node.kind !== "map") return null;
  const text = asScalar(node.entries.text) ?? "";
  if (!text) return null;
  const variantRaw = (asScalar(node.entries.variant) ?? "info").toLowerCase();
  const variant = variantRaw === "warning" ? "warning" : variantRaw === "error" ? "error" : variantRaw === "success" ? "success" : "info";
  return { kind: "banner", variant, text };
}
function buildEmptyEntry(node) {
  if (node.kind === "scalar") {
    return { kind: "empty", heading: node.value };
  }
  if (node.kind !== "map") return null;
  const heading = asScalar(node.entries.heading) ?? "";
  if (!heading) return null;
  const helper = asScalar(node.entries.helper) ?? void 0;
  const cta = asScalar(node.entries.cta) ?? void 0;
  return { kind: "empty", heading, helper, cta };
}
function buildAvatarStackEntry(node) {
  if (node.kind === "list") {
    const entries = [];
    for (const item of node.items) {
      if (item.kind === "scalar" && item.value.length > 0) {
        entries.push({ initials: item.value.slice(0, 2).toUpperCase() });
      }
    }
    if (entries.length === 0) return null;
    return { kind: "avatar-stack", entries };
  }
  if (node.kind === "map") {
    const countRaw = asScalar(node.entries.count);
    const count = countRaw ? Number.parseInt(countRaw, 10) : 0;
    const overflow = asScalar(node.entries.overflow) ?? void 0;
    if (!Number.isFinite(count) || count <= 0) return null;
    const entries = Array.from({ length: count }).map(() => ({}));
    if (overflow) entries.push({ overflow });
    return { kind: "avatar-stack", entries };
  }
  return null;
}
function buildStatEntry(node) {
  if (node.kind === "scalar") {
    return { kind: "stat", value: node.value };
  }
  if (node.kind !== "map") return null;
  const value = asScalar(node.entries.value) ?? "";
  if (!value) return null;
  const label = asScalar(node.entries.label) ?? void 0;
  const trend = asScalar(node.entries.trend) ?? void 0;
  const trendDirection = parseTrendDirection(asScalar(node.entries.direction), trend);
  return { kind: "stat", value, label, trend, trendDirection };
}
function parseTrendDirection(raw, trend) {
  if (raw) {
    const lower = raw.toLowerCase();
    if (lower === "up" || lower === "down" || lower === "flat") return lower;
  }
  if (trend) {
    if (trend.startsWith("+")) return "up";
    if (trend.startsWith("-") || trend.startsWith("\u2212") || trend.startsWith("\u2013")) return "down";
  }
  return void 0;
}
function buildTableEntry(node) {
  if (node.kind !== "map") return null;
  const columnsNode = node.entries.columns;
  const columns = columnsNode?.kind === "list" ? columnsNode.items.map((item) => item.kind === "scalar" ? item.value : "").filter((label) => label.length > 0) : [];
  const rowsNode = node.entries.rows;
  const rows = rowsNode?.kind === "list" ? rowsNode.items.map((row) => {
    if (row.kind === "list") {
      return row.items.map(parseTableCell);
    }
    if (row.kind === "scalar") return [row.value];
    return [];
  }).filter((cells) => cells.length > 0) : [];
  if (columns.length === 0 && rows.length === 0) return null;
  const weights = parseNumberList(node.entries.weights);
  return {
    kind: "table",
    columns,
    rows,
    weights: weights.length > 0 ? weights : void 0
  };
}
function parseTableCell(node) {
  if (node.kind === "scalar") return node.value;
  if (node.kind === "map") {
    const pill = asScalar(node.entries.pill);
    if (pill) return { pill, tone: parseTone(asScalar(node.entries.tone)) };
  }
  return "";
}
function parseChipItem(node) {
  if (node.kind === "scalar") {
    return node.value.length > 0 ? { label: node.value } : null;
  }
  if (node.kind === "map") {
    const label = asScalar(node.entries.label) ?? "";
    if (!label) return null;
    return { label, tone: parseTone(asScalar(node.entries.tone)) };
  }
  return null;
}
function parseTone(raw) {
  if (!raw) return void 0;
  const lower = raw.trim().toLowerCase();
  if (lower === "ok" || lower === "success" || lower === "good") return "ok";
  if (lower === "warn" || lower === "warning") return "warn";
  if (lower === "error" || lower === "danger") return "error";
  if (lower === "muted") return "muted";
  if (lower === "accent") return "accent";
  return void 0;
}
function buildMediaEntry(node) {
  if (node.kind === "scalar") {
    return { kind: "media", label: node.value || void 0, ratio: "16:9", variant: "image" };
  }
  if (node.kind !== "map") return null;
  const label = asScalar(node.entries.label) ?? void 0;
  const ratio = asScalar(node.entries.ratio) ?? "16:9";
  const variantRaw = (asScalar(node.entries.variant) ?? "image").toLowerCase();
  const variant = variantRaw === "video" ? "video" : variantRaw === "illustration" ? "illustration" : variantRaw === "chart" ? "chart" : "image";
  return { kind: "media", label, ratio, variant };
}
function buildCardGridEntry(node) {
  const columns = node.kind === "map" ? parsePositiveInt(asScalar(node.entries.columns)) ?? void 0 : void 0;
  const cardsNode = node.kind === "map" ? node.entries.cards : node;
  const cards = parseCards(cardsNode);
  return cards.length > 0 ? { kind: "card-grid", columns, cards } : null;
}
function parseCards(node) {
  if (!node) return [];
  if (node.kind === "scalar" && node.value.length > 0) return [{ title: node.value }];
  if (node.kind !== "list") return [];
  return node.items.map((item) => {
    if (item.kind === "scalar") {
      return item.value.length > 0 ? { title: item.value } : null;
    }
    if (item.kind !== "map") return null;
    const title = asScalar(item.entries.title) ?? "";
    if (!title) return null;
    const meta = asScalar(item.entries.meta) ?? void 0;
    return { title, meta };
  }).filter((card) => card !== null);
}
function buildStepsEntry(node, activeNode) {
  const stepsNode = node.kind === "map" ? node.entries.items ?? node.entries.steps : node;
  const steps = parseSteps(stepsNode);
  if (steps.length === 0) return null;
  const active = node.kind === "map" ? node.entries.active ?? activeNode : activeNode;
  const activeIndex = active ? resolveActiveIndex(steps.map((step) => step.label), active) : void 0;
  return { kind: "steps", steps, activeIndex };
}
function parseSteps(node) {
  if (!node) return [];
  if (node.kind === "scalar" && node.value.length > 0) return [{ label: node.value }];
  if (node.kind !== "list") return [];
  return node.items.map((item) => {
    if (item.kind === "scalar") {
      return item.value.length > 0 ? { label: item.value } : null;
    }
    if (item.kind !== "map") return null;
    const label = asScalar(item.entries.label) ?? asScalar(item.entries.title) ?? "";
    if (!label) return null;
    const meta = asScalar(item.entries.meta) ?? void 0;
    return { label, meta };
  }).filter((step) => step !== null);
}
function buildPopoverEntry(node) {
  if (node.kind !== "map") return null;
  const anchorRaw = (asScalar(node.entries.anchor) ?? "top").toLowerCase();
  const anchor = anchorRaw === "bottom" || anchorRaw === "left" || anchorRaw === "right" ? anchorRaw : "top";
  const width = parsePositiveInt(asScalar(node.entries.width)) ?? void 0;
  const bodyNode = node.entries.body;
  const body = bodyNode?.kind === "list" ? buildBodyEntries(bodyNode.items) : [];
  if (body.length === 0) return null;
  return { kind: "popover", anchor, body, width };
}
function buildColumnsEntry(node) {
  let columns;
  let gap;
  let regionsNode = node;
  let ratio = [];
  if (node.kind === "map") {
    columns = parsePositiveInt(asScalar(node.entries.columns)) ?? void 0;
    gap = parsePositiveInt(asScalar(node.entries.gap)) ?? void 0;
    ratio = parseNumberList(node.entries.ratio);
    regionsNode = node.entries.regions ?? node.entries.body;
  }
  const regions = parseRegions(regionsNode, ratio);
  return regions.length > 0 ? { kind: "columns", regions, gap, columns } : null;
}
function parseRegions(node, ratio) {
  if (!node || node.kind !== "list") return [];
  return node.items.map((item, index) => {
    if (item.kind !== "map") return null;
    const label = asScalar(item.entries.label) ?? asScalar(item.entries.title) ?? void 0;
    const span = parsePositiveInt(asScalar(item.entries.span)) ?? ratio[index] ?? void 0;
    const bodyNode = item.entries.body;
    const body = bodyNode?.kind === "list" ? buildBodyEntries(bodyNode.items) : [];
    return body.length > 0 ? { label, span, body } : null;
  }).filter((region) => region !== null);
}
function parseNumberList(node) {
  if (!node || node.kind !== "list") return [];
  return node.items.map((item) => item.kind === "scalar" ? parsePositiveInt(item.value) : null).filter((value) => value !== null);
}
function buildTabsEntry(tabsNode, activeNode) {
  const labels = tabsNode.kind === "list" ? tabsNode.items.map((item) => item.kind === "scalar" ? item.value : "").filter((label) => label.length > 0) : tabsNode.kind === "scalar" ? [tabsNode.value] : [];
  if (labels.length === 0) return null;
  const activeIndex = resolveActiveIndex(labels, activeNode);
  return { kind: "tabs", labels, activeIndex };
}
function resolveActiveIndex(labels, activeNode) {
  if (!activeNode || activeNode.kind !== "scalar") return 0;
  const raw = activeNode.value.trim();
  if (!raw) return 0;
  const asNum = Number.parseInt(raw, 10);
  if (Number.isFinite(asNum) && String(asNum) === raw) {
    return clampIndex(asNum, labels.length);
  }
  const lower = raw.toLowerCase();
  const match = labels.findIndex((label) => label.toLowerCase() === lower);
  return match >= 0 ? match : 0;
}
function clampIndex(index, length) {
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}
function parsePositiveInt(raw) {
  if (!raw) return null;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}
function toRowCell(node) {
  if (node.kind !== "scalar") return { type: "label", text: "" };
  const value = node.value.trim().toLowerCase();
  if (value === "toggle") return { type: "toggle" };
  if (value === "icon") return { type: "icon" };
  if (value === "checkbox") return { type: "checkbox" };
  return { type: "label", text: node.value };
}
function asScalar(node) {
  if (!node) return null;
  if (node.kind !== "scalar") return null;
  return node.value;
}
function asMap(node) {
  if (!node) return null;
  if (node.kind !== "map") return null;
  return node.entries;
}
function lintWireframe(wireframe) {
  const warnings = [];
  const frames = collectFramesForLint(wireframe);
  if (wireframe.layout === "transformation") {
    if (!wireframe.arrow?.top && !wireframe.arrow?.bottom) {
      warnings.push({
        severity: "info",
        message: "Transformation has no arrow labels. Consider adding arrow.top / arrow.bottom to communicate what changed."
      });
    }
  }
  if (wireframe.layout === "evolution") {
    const transitionCount = wireframe.transitions?.length ?? 0;
    if (transitionCount > 0 && transitionCount !== wireframe.frames.length - 1) {
      warnings.push({
        severity: "warning",
        message: `Evolution has ${wireframe.frames.length} frames but ${transitionCount} transition(s); expected ${Math.max(0, wireframe.frames.length - 1)}.`
      });
    }
  }
  for (const { frame, label } of frames) {
    const size = wireframe.size ?? frame.size ?? "md";
    const max = bodyCountForSize(size);
    if (frame.body.length === 0 && !frame.overlay && !frame.sidebar && !frame.topbar) {
      warnings.push({
        severity: "warning",
        context: label,
        message: `${label} has no body entries \u2014 it will render as an empty ${frame.frame} frame. Body entries may have been dropped (run pmos wireframe check) or the body: list is missing.`
      });
    }
    if (frame.body.length > max) {
      warnings.push({
        severity: "info",
        context: label,
        message: `${label} has ${frame.body.length} body entries; size: ${size} reads cleanly with up to ${max}. Consider splitting or trimming.`
      });
    }
    if (frame.sidebar && !frame.topbar && size === "page") {
      warnings.push({
        severity: "info",
        context: label,
        message: `${label}: page-size frame has a sidebar but no topbar \u2014 most app shells have both. Add a topbar or drop the sidebar.`
      });
    }
    if (frame.frame === "panel" && (frame.sidebar || frame.topbar)) {
      warnings.push({
        severity: "warning",
        context: label,
        message: `${label}: frame: panel with sidebar/topbar reads as a page inside a card. Use frame: browser for page chrome, frame: panel for modal/drawer content.`
      });
    }
    for (const table of collectTablesForLint(frame.body)) {
      if (table.columns.length >= 4 && size !== "page" && !table.weights) {
        warnings.push({
          severity: "warning",
          context: label,
          message: `${label}: table with ${table.columns.length} columns at size: ${size} splits the width evenly and will truncate cell text. Use size: page, add weights: [..] to widen the long columns, or switch to list: with meta.`
        });
      }
    }
    if (frame.overlay) {
      if (size === "sm") {
        warnings.push({
          severity: "warning",
          context: label,
          message: `${label}: overlay at size: sm leaves no room for the dimmed base page to read as context. Use size: lg or page.`
        });
      }
      if (frame.body.length === 0) {
        warnings.push({
          severity: "info",
          context: label,
          message: `${label}: overlay over an empty base body reads as a bare panel. Sketch a skeletal base (heading + para bars) so the overlay shows in context \u2014 or use frame: panel instead.`
        });
      }
      if (frame.overlay.body.length > 10) {
        warnings.push({
          severity: "info",
          context: label,
          message: `${label}: overlay has ${frame.overlay.body.length} body entries; an overlay reads cleanly with up to 10. A longer surface is usually a page, not a modal/drawer.`
        });
      }
    }
  }
  const markers = frames.flatMap(({ frame }) => collectMarkersForLint(frame));
  const calloutCount = wireframe.callouts?.length ?? 0;
  for (const marker of markers) {
    if (marker > calloutCount) {
      warnings.push({
        severity: "warning",
        message: calloutCount === 0 ? `marker: ${marker} has no matching entry \u2014 add a top-level callouts: list (entry ${marker} pairs with the badge).` : `marker: ${marker} exceeds the callouts: list (${calloutCount} entr${calloutCount === 1 ? "y" : "ies"}).`
      });
    }
  }
  if (calloutCount > 0 && markers.length === 0) {
    warnings.push({
      severity: "info",
      message: "callouts: is set but no body entry carries a marker:. Add marker: <n> to the entries the callouts describe."
    });
  }
  return warnings;
}
function collectMarkersForLint(frame) {
  const markers = [];
  const walk = (entries) => {
    for (const entry of entries) {
      if (entry.marker) markers.push(entry.marker);
      if (entry.kind === "columns") {
        for (const region of entry.regions) walk(region.body);
      }
      if (entry.kind === "popover") walk(entry.body);
      if (entry.kind === "accordion") {
        for (const item of entry.items) walk(item.body);
      }
    }
  };
  walk(frame.body);
  if (frame.overlay) walk(frame.overlay.body);
  return markers;
}
function collectTablesForLint(body) {
  const tables = [];
  for (const entry of body) {
    if (entry.kind === "table") tables.push(entry);
    if (entry.kind === "columns") {
      for (const region of entry.regions) tables.push(...collectTablesForLint(region.body));
    }
    if (entry.kind === "popover") tables.push(...collectTablesForLint(entry.body));
    if (entry.kind === "accordion") {
      for (const item of entry.items) tables.push(...collectTablesForLint(item.body));
    }
  }
  return tables;
}
function bodyCountForSize(size) {
  if (size === "sm") return 6;
  if (size === "lg") return 18;
  if (size === "page") return 28;
  return 12;
}
function collectFramesForLint(wireframe) {
  if (wireframe.layout === "single") {
    return [{ frame: wireframe.frame, label: "frame" }];
  }
  if (wireframe.layout === "transformation") {
    return [
      { frame: wireframe.left, label: "left frame" },
      { frame: wireframe.right, label: "right frame" }
    ];
  }
  return wireframe.frames.map((frame, index) => ({
    frame,
    label: `frame ${index + 1}`
  }));
}

// src/wireframe-theme.ts
var SIZE_BUCKETS = {
  sm: { frameWidth: 280, framePadX: 20, framePadY: 24, rowGap: 8 },
  md: { frameWidth: 360, framePadX: 24, framePadY: 28, rowGap: 10 },
  lg: { frameWidth: 540, framePadX: 28, framePadY: 32, rowGap: 10 },
  page: { frameWidth: 820, framePadX: 32, framePadY: 36, rowGap: 10 }
};
function applyWireframeSize(theme, size) {
  if (!size) return theme;
  const bucket = SIZE_BUCKETS[size];
  if (!bucket) return theme;
  return { ...theme, dimensions: { ...theme.dimensions, ...bucket } };
}
var DEFAULT_WIREFRAME_THEME = {
  colors: {
    bg: "#EEF2F9",
    panel: "#FFFFFF",
    panelDark: "#0F1B2E",
    border: "#D3DEEC",
    borderDark: "#26374E",
    ink: "#16243A",
    inkMuted: "#4A5C76",
    inkSubtle: "#7588A1",
    bar: "#CBD8EA",
    barDark: "#394D67",
    accent: "#2563EB",
    accentFaded: "#DBE7FC",
    chip: "#E1E9F5",
    chipText: "#28384F"
  },
  fonts: {
    sans: "Geist, ui-sans-serif, -apple-system, system-ui, sans-serif",
    mono: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace",
    serif: "Georgia, 'Times New Roman', serif"
  },
  dimensions: {
    frameWidth: 360,
    framePadX: 24,
    framePadY: 28,
    chromeHeight: 24,
    arrowWidth: 140,
    labelGap: 18,
    outerPad: 32,
    rowGap: 10,
    sidebarWidth: 92,
    topbarHeight: 36
  }
};
function mergeWireframeTheme(base, override) {
  if (!override) return base;
  return {
    colors: { ...base.colors, ...override.colors ?? {} },
    fonts: { ...base.fonts, ...override.fonts ?? {} },
    dimensions: { ...base.dimensions, ...override.dimensions ?? {} }
  };
}
var HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u;
function validateWireframeOverride(value) {
  if (value === null || value === void 0) return { ok: true, value: {} };
  if (typeof value !== "object") {
    return { ok: false, error: "Override must be an object with `colors`, `fonts`, or `dimensions`." };
  }
  const input = value;
  const out = {};
  if (input.colors !== void 0) {
    if (typeof input.colors !== "object" || input.colors === null) {
      return { ok: false, error: "`colors` must be an object." };
    }
    const colors = {};
    for (const [key, raw] of Object.entries(input.colors)) {
      if (!(key in DEFAULT_WIREFRAME_THEME.colors)) continue;
      if (typeof raw !== "string" || !HEX_RE.test(raw)) {
        return { ok: false, error: `colors.${key} must be a hex string like "#RRGGBB" (got ${JSON.stringify(raw)}).` };
      }
      colors[key] = raw;
    }
    out.colors = colors;
  }
  if (input.fonts !== void 0) {
    if (typeof input.fonts !== "object" || input.fonts === null) {
      return { ok: false, error: "`fonts` must be an object." };
    }
    const fonts = {};
    for (const [key, raw] of Object.entries(input.fonts)) {
      if (!(key in DEFAULT_WIREFRAME_THEME.fonts)) continue;
      if (typeof raw !== "string" || raw.trim().length === 0) {
        return { ok: false, error: `fonts.${key} must be a non-empty CSS font-family string.` };
      }
      fonts[key] = raw;
    }
    out.fonts = fonts;
  }
  if (input.dimensions !== void 0) {
    if (typeof input.dimensions !== "object" || input.dimensions === null) {
      return { ok: false, error: "`dimensions` must be an object." };
    }
    const dimensions = {};
    for (const [key, raw] of Object.entries(input.dimensions)) {
      if (!(key in DEFAULT_WIREFRAME_THEME.dimensions)) continue;
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
        return { ok: false, error: `dimensions.${key} must be a positive number.` };
      }
      dimensions[key] = raw;
    }
    out.dimensions = dimensions;
  }
  return { ok: true, value: out };
}

// src/render-svg.ts
var TEXT_FRAME_KINDS = /* @__PURE__ */ new Set(["browser", "dark-app"]);
function renderWireframeSvg(wireframe, theme) {
  const sizedTheme = applyWireframeSize(theme, wireframe.size);
  const callouts = wireframe.callouts ?? [];
  if (wireframe.layout === "single") {
    return renderCanvas([{ frame: wireframe.frame }], [], sizedTheme, callouts);
  }
  if (wireframe.layout === "transformation") {
    return renderCanvas(
      [{ frame: wireframe.left }, { frame: wireframe.right }],
      [
        {
          kind: "arrow",
          top: wireframe.arrow?.top,
          bottom: wireframe.arrow?.bottom
        }
      ],
      sizedTheme,
      callouts
    );
  }
  const transitions = (wireframe.transitions ?? []).map(
    (text) => ({ kind: "transition", text })
  );
  return renderCanvas(
    wireframe.frames.map((frame) => ({ frame })),
    transitions,
    sizedTheme,
    callouts
  );
}
function renderCanvas(frames, gaps, theme, callouts = []) {
  const { colors, fonts, dimensions } = theme;
  const frameThemes = frames.map(
    ({ frame }) => frame.size ? applyWireframeSize(theme, frame.size) : theme
  );
  const frameWidths = frameThemes.map((frameTheme) => frameTheme.dimensions.frameWidth);
  const frameHeights = frames.map(
    ({ frame }, index) => measureFrame(frame, frameThemes[index].dimensions)
  );
  const totalHeight = Math.max(...frameHeights, dimensions.framePadY * 4);
  const gapWidth = gaps.length > 0 ? gaps[0].kind === "arrow" ? dimensions.arrowWidth : dimensions.arrowWidth * 0.85 : 0;
  const totalWidth = frameWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, frames.length - 1) * gapWidth + dimensions.outerPad * 2;
  const calloutRowHeight = 20;
  const legendHeight = callouts.length > 0 ? callouts.length * calloutRowHeight + 14 : 0;
  const viewHeight = totalHeight + dimensions.outerPad * 2 + dimensions.labelGap + legendHeight;
  let body = `<rect width="${totalWidth}" height="${viewHeight}" fill="${colors.bg}" rx="4" />`;
  let cursorX = dimensions.outerPad;
  const topY = dimensions.outerPad + dimensions.labelGap;
  frames.forEach((slot, index) => {
    const frameHeight = frameHeights[index];
    body += renderFrameSvg(slot.frame, cursorX, topY, frameHeight, frameThemes[index]);
    cursorX += frameWidths[index];
    if (index < frames.length - 1) {
      const gap = gaps[index];
      const midY = topY + totalHeight / 2;
      if (gap?.kind === "arrow") {
        body += renderArrow(cursorX, midY, dimensions.arrowWidth, gap.top, gap.bottom, theme);
      } else if (gap?.kind === "transition") {
        body += renderTransitionLabel(cursorX + gapWidth / 2, midY, gap.text, theme);
      }
      cursorX += gapWidth;
    }
  });
  if (callouts.length > 0) {
    let legendY = topY + totalHeight + 18;
    callouts.forEach((text, index) => {
      body += renderMarkerBadge(index + 1, dimensions.outerPad + 8, legendY, theme);
      body += `<text x="${dimensions.outerPad + 22}" y="${legendY + 4}" font-family="${escapeAttr(fonts.sans)}" font-size="11" fill="${colors.inkMuted}">${escapeText(truncateText(text, totalWidth - dimensions.outerPad * 2 - 24, 5.8))}</text>`;
      legendY += calloutRowHeight;
    });
  }
  return [
    `<svg viewBox="0 0 ${totalWidth} ${viewHeight}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="presentation" style="max-width:100%;height:auto;display:block">`,
    body,
    `</svg>`
  ].join("");
}
function effectiveSidebarWidth(sidebar, dimensions) {
  if (!sidebar) return 0;
  const minWidth = dimensions.sidebarWidth;
  const maxWidth = 160;
  let longestTop = 0;
  let longestNested = 0;
  const walk = (list, depth) => {
    for (const item of list) {
      const extra = item.badge ? item.badge.length + 2 : 0;
      const len = item.label.length + extra;
      if (depth === 0) longestTop = Math.max(longestTop, len);
      else longestNested = Math.max(longestNested, len + 2);
      if (item.items) walk(item.items, depth + 1);
    }
  };
  walk(sidebar, 0);
  const widestEffective = Math.max(longestTop, longestNested);
  const computed = widestEffective * 5.8 + 38;
  return Math.max(minWidth, Math.min(maxWidth, Math.ceil(computed)));
}
function sidebarItemCount(sidebar) {
  let count = 0;
  const walk = (list) => {
    for (const item of list) {
      count += 1;
      if (item.items) walk(item.items);
    }
  };
  walk(sidebar);
  return count;
}
function measureFrame(frame, dimensions) {
  const showChrome = TEXT_FRAME_KINDS.has(frame.frame);
  const topbarHeight = frame.topbar ? dimensions.topbarHeight + 8 : 0;
  const sidebarWidth = effectiveSidebarWidth(frame.sidebar, dimensions);
  const bodyWidth = dimensions.frameWidth - dimensions.framePadX * 2 - sidebarWidth;
  const contentHeight = measureBodyEntries(frame.body, dimensions, bodyWidth, frame);
  const baseHeight = dimensions.framePadY * 2 + (showChrome ? dimensions.chromeHeight + 12 : 0) + topbarHeight + contentHeight;
  const sidebarHeight = frame.sidebar ? sidebarItemCount(frame.sidebar) * 24 + (showChrome ? dimensions.chromeHeight + 12 : 0) + topbarHeight + dimensions.framePadY * 2 : 0;
  const overlayHeight = frame.overlay ? overlayMetrics(frame, dimensions).minFrameHeight : 0;
  return Math.max(baseHeight, sidebarHeight, overlayHeight, 220);
}
var MODAL_TOP_GAP = 26;
function overlayMetrics(frame, dimensions) {
  const overlay = frame.overlay;
  if (!overlay) throw new Error("overlayMetrics requires frame.overlay");
  const chromeOffset = TEXT_FRAME_KINDS.has(frame.frame) ? dimensions.chromeHeight + 12 : 0;
  const panelPad = 14;
  const headerHeight = overlay.label ? 26 : 0;
  const panelWidth = overlay.variant === "modal" ? Math.max(
    200,
    Math.min(dimensions.frameWidth * 0.68, dimensions.frameWidth - dimensions.framePadX * 2 - 16)
  ) : Math.max(170, Math.min(dimensions.frameWidth * 0.46, 320));
  const innerWidth = panelWidth - panelPad * 2;
  const contentHeight = measureBodyEntries(overlay.body, dimensions, innerWidth, frame);
  const panelHeight = contentHeight + headerHeight + panelPad * 2;
  const minFrameHeight = overlay.variant === "modal" ? chromeOffset + MODAL_TOP_GAP * 2 + panelHeight : chromeOffset + panelHeight + 10;
  return {
    panelWidth,
    innerWidth,
    panelPad,
    headerHeight,
    contentHeight,
    panelHeight,
    chromeOffset,
    minFrameHeight
  };
}
function measureBodyEntries(entries, dimensions, width, frame) {
  if (entries.length === 0) return 0;
  return entries.reduce(
    (acc, entry, index) => acc + measureBodyEntry(entry, dimensions, width, frame) + (index < entries.length - 1 ? dimensions.rowGap : 0),
    0
  );
}
function measureBodyEntry(entry, dimensions, width, frame) {
  switch (entry.kind) {
    case "heading":
      return 18;
    case "accent":
      return entry.text ? 18 : 11;
    case "para":
      return entry.text ? Math.max(14, wrapText(entry.text, width, 5.6, 3).length * 14) : entry.lines * 6 + Math.max(0, entry.lines - 1) * 5;
    case "button":
      return 34;
    case "buttons":
      return 34;
    case "row":
      return 22;
    case "chip":
      return 22;
    case "tabs":
      return 26;
    case "list":
      return entry.items.reduce((total, item, index) => {
        const itemHeight = item.meta ? 34 : 22;
        return total + itemHeight + (index < entry.items.length - 1 ? 6 : 0);
      }, 0);
    case "field":
      return entry.variant === "textarea" ? 56 : entry.label ? 44 : 28;
    case "banner":
      return 36;
    case "empty": {
      const helperHeight = entry.helper ? 22 : 0;
      const ctaHeight = entry.cta ? 38 : 0;
      return 24 + helperHeight + ctaHeight + 20;
    }
    case "avatar":
      return 28;
    case "avatar-stack":
      return 24;
    case "stat":
      return entry.label || entry.trend ? 38 : 26;
    case "table":
      return 22 + entry.rows.length * 22;
    case "media":
      return Math.max(80, width / ratioToNumber(entry.ratio));
    case "card-grid": {
      const columns = boundedColumnCount(entry.columns ?? 3, entry.cards.length, width);
      const rows = Math.ceil(entry.cards.length / columns);
      return rows * 58 + Math.max(0, rows - 1) * 10;
    }
    case "steps":
      return shouldRenderStepsHorizontally(entry.steps.length, width) ? 42 : entry.steps.length * 30;
    case "columns":
      return layoutColumnRegions(entry, width, frame, dimensions).height;
    case "popover": {
      const popoverPad = 12;
      const arrowSize = 8;
      const popoverWidth = Math.min(width, entry.width ?? 220);
      const innerWidth = popoverWidth - popoverPad * 2;
      const contentHeight = measureBodyEntries(entry.body, dimensions, innerWidth, frame);
      const panelHeight = contentHeight + popoverPad * 2;
      const verticalExtra = entry.anchor === "top" || entry.anchor === "bottom" ? arrowSize : 0;
      return panelHeight + verticalExtra;
    }
    case "breadcrumbs":
      return 16;
    case "accordion":
      return entry.items.reduce((total, item, index) => {
        const headerHeight = 24;
        const bodyHeight = item.expanded && item.body.length > 0 ? measureBodyEntries(item.body, dimensions, width - 18, frame) + 8 : 0;
        return total + headerHeight + bodyHeight + (index < entry.items.length - 1 ? 4 : 0);
      }, 0);
    case "meter":
      return entry.label || entry.caption ? 30 : 14;
    case "pagination":
      return 24;
    case "chrome":
      return dimensions.chromeHeight;
    case "divider":
      return 1;
    case "spacer":
      return 16;
  }
}
function renderFrameSvg(frame, x, y, height, theme) {
  const { colors, fonts, dimensions } = theme;
  const dark = frame.frame === "dark-app" || frame.frame === "terminal";
  const napkin = frame.frame === "napkin";
  const none = frame.frame === "none";
  const panel = frame.frame === "panel";
  const showChrome = TEXT_FRAME_KINDS.has(frame.frame);
  const panelFill = none ? "transparent" : dark ? colors.panelDark : colors.panel;
  const borderColor = napkin ? colors.ink : dark ? colors.borderDark : colors.border;
  const labelColor = dark ? colors.bar : colors.inkMuted;
  const chromeOffset = showChrome ? dimensions.chromeHeight + 12 : 0;
  const topbarHeight = frame.topbar ? dimensions.topbarHeight : 0;
  const topbarOffset = frame.topbar ? dimensions.topbarHeight + 8 : 0;
  const sidebarWidth = effectiveSidebarWidth(frame.sidebar, dimensions);
  const bodyX = x + dimensions.framePadX + sidebarWidth;
  const bodyY = y + dimensions.framePadY + chromeOffset + topbarOffset;
  const bodyWidth = dimensions.frameWidth - dimensions.framePadX * 2 - sidebarWidth;
  let out = "<g>";
  if (frame.label) {
    out += `<text x="${x + 8}" y="${y - 8}" font-family="${escapeAttr(fonts.mono)}" font-size="10" letter-spacing="1.6" fill="${labelColor}">${escapeText(frame.label.toUpperCase())}</text>`;
  }
  if (!none) {
    out += `<rect x="${x}" y="${y}" width="${dimensions.frameWidth}" height="${height}" fill="${panelFill}" stroke="${borderColor}" stroke-width="${napkin ? 1.5 : panel ? 1 : 1}" rx="${napkin ? 2 : panel ? 6 : 4}" />`;
  }
  if (showChrome) {
    out += renderChromeBar(x, y, dark, theme);
  }
  if (frame.sidebar) {
    out += renderSidebarRail(
      frame.sidebar,
      x,
      y + chromeOffset,
      height - chromeOffset,
      dark,
      theme
    );
  }
  if (frame.topbar) {
    out += renderTopbar(
      frame.topbar,
      x + sidebarWidth,
      y + chromeOffset,
      dimensions.frameWidth - sidebarWidth,
      topbarHeight,
      dark,
      theme
    );
  }
  out += renderFrameBody(
    frame,
    bodyX,
    bodyY,
    bodyWidth,
    dark,
    theme
  );
  if (frame.overlay) {
    out += renderOverlay(frame, x, y, height, dark, theme);
  }
  out += "</g>";
  return out;
}
function renderOverlay(frame, x, y, height, dark, theme) {
  const overlay = frame.overlay;
  if (!overlay) return "";
  const { colors, fonts, dimensions } = theme;
  const metrics = overlayMetrics(frame, dimensions);
  const { panelPad, headerHeight, innerWidth } = metrics;
  const fill = dark ? colors.panelDark : colors.panel;
  const stroke = dark ? colors.borderDark : colors.border;
  let out = "<g>";
  const scrimY = y + metrics.chromeOffset + 1;
  const scrimHeight = height - metrics.chromeOffset - 2;
  out += `<rect x="${x + 1}" y="${scrimY}" width="${dimensions.frameWidth - 2}" height="${scrimHeight}" rx="3" fill="${colors.ink}" opacity="${dark ? 0.42 : 0.18}" />`;
  let panelX;
  let panelY;
  let panelHeight;
  if (overlay.variant === "modal") {
    panelX = x + (dimensions.frameWidth - metrics.panelWidth) / 2;
    panelY = y + metrics.chromeOffset + MODAL_TOP_GAP;
    panelHeight = metrics.panelHeight;
    out += `<rect x="${panelX}" y="${panelY + 3}" width="${metrics.panelWidth}" height="${panelHeight}" rx="8" fill="${colors.ink}" opacity="0.14" />`;
    out += `<rect x="${panelX}" y="${panelY}" width="${metrics.panelWidth}" height="${panelHeight}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1" />`;
  } else {
    const left = overlay.variant === "drawer-left";
    panelX = left ? x + 1 : x + dimensions.frameWidth - metrics.panelWidth - 1;
    panelY = scrimY;
    panelHeight = scrimHeight;
    out += `<rect x="${panelX}" y="${panelY}" width="${metrics.panelWidth}" height="${panelHeight}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="1" />`;
    const edgeX = left ? panelX + metrics.panelWidth : panelX;
    out += `<line x1="${edgeX}" y1="${panelY}" x2="${edgeX}" y2="${panelY + panelHeight}" stroke="${stroke}" stroke-width="1.5" />`;
  }
  if (overlay.label) {
    out += `<text x="${panelX + panelPad}" y="${panelY + panelPad + 5}" font-family="${escapeAttr(fonts.sans)}" font-size="12" font-weight="600" fill="${dark ? colors.bar : colors.ink}">${escapeText(truncateText(overlay.label, metrics.panelWidth - panelPad * 2, 6.5))}</text>`;
    out += `<line x1="${panelX + panelPad}" y1="${panelY + panelPad + headerHeight - 10}" x2="${panelX + metrics.panelWidth - panelPad}" y2="${panelY + panelPad + headerHeight - 10}" stroke="${stroke}" stroke-width="1" />`;
  }
  let cursorY = panelY + panelPad + headerHeight;
  overlay.body.forEach((entry, index) => {
    const entryHeight = measureBodyEntry(entry, dimensions, innerWidth, frame);
    out += renderBodyEntry(entry, panelX + panelPad, cursorY, innerWidth, dark, theme, frame);
    if (entry.marker) {
      out += renderMarkerBadge(entry.marker, panelX + metrics.panelWidth - 8, cursorY + 8, theme);
    }
    cursorY += entryHeight + (index < overlay.body.length - 1 ? dimensions.rowGap : 0);
  });
  out += "</g>";
  return out;
}
function renderChromeBar(x, y, dark, theme) {
  const { colors, dimensions } = theme;
  const dotColor = dark ? colors.barDark : colors.border;
  const barColor = dark ? colors.borderDark : colors.accentFaded;
  return [
    `<circle cx="${x + 18}" cy="${y + 14}" r="3.5" fill="${dotColor}" />`,
    `<circle cx="${x + 30}" cy="${y + 14}" r="3.5" fill="${dotColor}" />`,
    `<circle cx="${x + 42}" cy="${y + 14}" r="3.5" fill="${dotColor}" />`,
    `<rect x="${x + 60}" y="${y + 9}" width="${dimensions.frameWidth - 76}" height="11" rx="2" fill="${barColor}" />`
  ].join("");
}
function renderSidebarRail(items, x, y, height, dark, theme) {
  const { colors, fonts, dimensions } = theme;
  const railWidth = effectiveSidebarWidth(items, dimensions);
  const railHeight = height;
  let out = [
    `<rect x="${x}" y="${y}" width="${railWidth}" height="${railHeight}" fill="${dark ? colors.panelDark : colors.accentFaded}" />`,
    `<line x1="${x + railWidth}" y1="${y}" x2="${x + railWidth}" y2="${y + railHeight}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`
  ].join("");
  const itemHeight = 24;
  const nestedItemHeight = 20;
  let cursorY = y + 20;
  function renderItem(item, depth) {
    const indent = depth * 14;
    const itemY = cursorY;
    if (item.active) {
      out += `<rect x="${x + 6 + indent}" y="${itemY - 12}" width="${railWidth - 12 - indent}" height="20" rx="3" fill="${dark ? colors.barDark : colors.panel}" />`;
    }
    if (depth === 0) {
      out += `<rect x="${x + 12 + indent}" y="${itemY - 6}" width="8" height="8" rx="1.5" fill="${item.active ? colors.accent : dark ? colors.bar : colors.inkMuted}" />`;
    }
    const textX = x + (depth === 0 ? 26 : 16 + indent);
    const badgeWidth = item.badge ? item.badge.length * 5 + 8 : 0;
    const labelMaxWidth = railWidth - (textX - x) - 8 - (badgeWidth > 0 ? badgeWidth + 4 : 0);
    out += `<text x="${textX}" y="${itemY + 2}" font-family="${escapeAttr(fonts.sans)}" font-size="${depth === 0 ? 10 : 10}" font-weight="${item.active ? 600 : 500}" fill="${item.active ? dark ? colors.bar : colors.ink : dark ? colors.barDark : colors.inkMuted}">${escapeText(truncateText(item.label, labelMaxWidth, 5.8))}</text>`;
    if (item.badge) {
      const badgeX = x + railWidth - badgeWidth - 8;
      const badgeY = itemY - 8;
      out += `<rect x="${badgeX}" y="${badgeY}" width="${badgeWidth}" height="13" rx="6.5" fill="${colors.accent}" />`;
      out += `<text x="${badgeX + badgeWidth / 2}" y="${badgeY + 9}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="8" font-weight="700" fill="#FFFFFF">${escapeText(item.badge)}</text>`;
    }
    cursorY += depth === 0 ? itemHeight : nestedItemHeight;
    if (item.items && item.items.length > 0) {
      for (const child of item.items) renderItem(child, depth + 1);
    }
  }
  for (const item of items) renderItem(item, 0);
  return out;
}
function renderTopbar(spec, x, y, width, height, dark, theme) {
  const { colors, fonts } = theme;
  const actions = spec.actions ?? [];
  const actionGap = 8;
  const badgePad = 16;
  const actionMaxWidth = actions.length > 0 ? Math.max(54, Math.min(140, (width - 178 - actionGap * Math.max(0, actions.length - 1)) / actions.length)) : 0;
  const buttonWidths = actions.map((action) => {
    const labelWidth = action.label.length * 6.5 + 18;
    const badgeWidth = action.badge ? action.badge.length * 5.5 + badgePad : 0;
    return Math.max(54, Math.min(actionMaxWidth, labelWidth + badgeWidth));
  });
  const totalButtonWidth = buttonWidths.reduce((sum, buttonWidth) => sum + buttonWidth, 0) + Math.max(0, buttonWidths.length - 1) * actionGap;
  const actionStart = x + width - 12 - totalButtonWidth;
  const titleMaxWidth = actions.length > 0 ? Math.max(40, actionStart - x - 28) : width - 32;
  let out = `<line x1="${x}" y1="${y + height}" x2="${x + width}" y2="${y + height}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`;
  if (spec.title) {
    out += `<text x="${x + 16}" y="${y + height / 2 + 5}" font-family="${escapeAttr(fonts.sans)}" font-size="13" font-weight="600" fill="${dark ? colors.bar : colors.ink}">${escapeText(truncateText(spec.title, titleMaxWidth, 7))}</text>`;
  }
  if (actions.length > 0) {
    let cursorX = actionStart;
    actions.forEach((action, index) => {
      const buttonWidth = buttonWidths[index];
      const cx = cursorX;
      cursorX += buttonWidth + actionGap;
      const isPrimary = index === actions.length - 1;
      const badgeWidth = action.badge ? action.badge.length * 5.5 + 10 : 0;
      const labelMaxWidth = buttonWidth - 14 - (badgeWidth > 0 ? badgeWidth + 6 : 0);
      out += [
        `<rect x="${cx}" y="${y + height / 2 - 11}" width="${buttonWidth}" height="22" rx="3" fill="${isPrimary ? colors.accent : "transparent"}" stroke="${isPrimary ? "none" : dark ? colors.bar : colors.ink}" stroke-width="${isPrimary ? 0 : 1}" />`,
        `<text x="${cx + (badgeWidth > 0 ? 10 : buttonWidth / 2)}" y="${y + height / 2 + 4}" ${badgeWidth > 0 ? "" : 'text-anchor="middle" '}font-family="${escapeAttr(fonts.sans)}" font-size="10" font-weight="600" fill="${isPrimary ? "#FFFFFF" : dark ? colors.bar : colors.ink}">${escapeText(truncateText(action.label, labelMaxWidth, 5.8))}</text>`
      ].join("");
      if (action.badge) {
        const badgeX = cx + buttonWidth - badgeWidth - 6;
        const badgeY = y + height / 2 - 7;
        const badgeFill = isPrimary ? "rgba(255,255,255,0.25)" : colors.accent;
        const badgeTextFill = isPrimary ? "#FFFFFF" : "#FFFFFF";
        out += `<rect x="${badgeX}" y="${badgeY}" width="${badgeWidth}" height="14" rx="7" fill="${badgeFill}" />`;
        out += `<text x="${badgeX + badgeWidth / 2}" y="${badgeY + 10}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="9" font-weight="700" fill="${badgeTextFill}">${escapeText(action.badge)}</text>`;
      }
    });
  }
  return out;
}
function renderFrameBody(frame, x, y, width, dark, theme) {
  const { dimensions } = theme;
  let cursorY = y;
  let out = "<g>";
  for (const entry of frame.body) {
    const height = measureBodyEntry(entry, dimensions, width, frame);
    out += renderBodyEntry(entry, x, cursorY, width, dark, theme, frame);
    if (entry.marker) {
      out += renderMarkerBadge(
        entry.marker,
        x + width + dimensions.framePadX / 2,
        cursorY + Math.min(9, height / 2 + 2),
        theme
      );
    }
    cursorY += height + dimensions.rowGap;
  }
  out += "</g>";
  return out;
}
function renderMarkerBadge(marker, cx, cy, theme) {
  const { colors, fonts } = theme;
  return [
    `<circle cx="${cx}" cy="${cy}" r="7.5" fill="${colors.accent}" />`,
    `<text x="${cx}" y="${cy + 3.5}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="9" font-weight="700" fill="#FFFFFF">${marker}</text>`
  ].join("");
}
function renderBodyEntry(entry, x, y, width, dark, theme, frame) {
  const { colors, fonts } = theme;
  switch (entry.kind) {
    case "heading": {
      return `<text x="${x}" y="${y + 12}" font-family="${escapeAttr(fonts.sans)}" font-size="13" font-weight="600" fill="${dark ? colors.bar : colors.ink}">${escapeText(truncateText(entry.text, width, 7))}</text>`;
    }
    case "accent": {
      if (!entry.text) {
        return `<rect x="${x}" y="${y}" width="${width * 0.6}" height="9" rx="1" fill="${colors.accent}" />`;
      }
      const padX = 7;
      const textWidth = Math.min(width, entry.text.length * 6.8 + padX * 2);
      return [
        `<rect x="${x}" y="${y}" width="${textWidth}" height="16" rx="2" fill="${colors.accentFaded}" />`,
        `<text x="${x + padX}" y="${y + 12}" font-family="${escapeAttr(fonts.sans)}" font-size="11" font-weight="600" fill="${colors.accent}">${escapeText(truncateText(entry.text, textWidth - padX * 2, 6.5))}</text>`
      ].join("");
    }
    case "para": {
      if (entry.text) {
        const lines = wrapText(entry.text, width, 5.6, 3);
        const lineHeight2 = 14;
        return [
          "<g>",
          ...lines.map(
            (line, i) => `<text x="${x}" y="${y + 10 + i * lineHeight2}" font-family="${escapeAttr(fonts.sans)}" font-size="11" fill="${dark ? colors.barDark : colors.inkMuted}">${escapeText(line)}</text>`
          ),
          "</g>"
        ].join("");
      }
      const lineHeight = 4;
      const lineGap = 7;
      let bars = "<g>";
      for (let i = 0; i < entry.lines; i += 1) {
        const lineWidth = lineWidthForIndex(width, i, entry.lines);
        bars += `<rect x="${x}" y="${y + i * (lineHeight + lineGap)}" width="${lineWidth}" height="${lineHeight}" rx="1" fill="${dark ? colors.barDark : colors.bar}" />`;
      }
      bars += "</g>";
      return bars;
    }
    case "button": {
      const outlined = entry.variant === "outlined";
      const textWidth = Math.max(54, Math.min(width, entry.label.length * 7 + 28));
      const fill = outlined ? "transparent" : colors.accent;
      const stroke = outlined ? dark ? colors.bar : colors.ink : "none";
      const textFill = outlined ? dark ? colors.bar : colors.ink : "#FFFFFF";
      return [
        `<rect x="${x}" y="${y}" width="${textWidth}" height="30" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${outlined ? 1 : 0}" />`,
        `<text x="${x + textWidth / 2}" y="${y + 19}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="11" font-weight="600" fill="${textFill}">${escapeText(truncateText(entry.label, textWidth - 18, 6))}</text>`
      ].join("");
    }
    case "buttons": {
      const gap = 8;
      const widths = entry.items.map(
        (item) => Math.max(54, Math.min(width, item.label.length * 7 + 28))
      );
      const totalWidth = widths.reduce((sum, w) => sum + w, 0) + Math.max(0, widths.length - 1) * gap;
      const overflow = totalWidth > width;
      const scale = overflow ? width / totalWidth : 1;
      let cursorX = x;
      let out = "<g>";
      entry.items.forEach((item, index) => {
        const buttonWidth = widths[index] * scale;
        const outlined = item.variant === "outlined";
        const fill = outlined ? "transparent" : colors.accent;
        const stroke = outlined ? dark ? colors.bar : colors.ink : "none";
        const textFill = outlined ? dark ? colors.bar : colors.ink : "#FFFFFF";
        out += [
          `<rect x="${cursorX}" y="${y}" width="${buttonWidth}" height="30" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${outlined ? 1 : 0}" />`,
          `<text x="${cursorX + buttonWidth / 2}" y="${y + 19}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="11" font-weight="600" fill="${textFill}">${escapeText(truncateText(item.label, buttonWidth - 18, 6))}</text>`
        ].join("");
        cursorX += buttonWidth + gap * scale;
      });
      out += "</g>";
      return out;
    }
    case "row": {
      let cellX = x;
      let out = "<g>";
      for (const cell of entry.cells) {
        const node = renderRowCell(cell, cellX, y, x + width, dark, theme);
        cellX = node.nextX;
        out += node.element;
      }
      out += "</g>";
      return out;
    }
    case "chip": {
      let cellX = x;
      let out = "<g>";
      for (const item of entry.items) {
        const remainingWidth = x + width - cellX;
        if (remainingWidth < 34) break;
        const labelWidth = Math.max(34, Math.min(remainingWidth, item.label.length * 6.5 + 16));
        const tone = toneStyle(item.tone, colors);
        out += [
          `<rect x="${cellX}" y="${y}" width="${labelWidth}" height="20" rx="3" fill="${tone.fill}" />`,
          `<text x="${cellX + labelWidth / 2}" y="${y + 14}" text-anchor="middle" font-family="${escapeAttr(fonts.mono)}" font-size="9" letter-spacing="1.4" fill="${tone.text}">${escapeText(truncateText(item.label.toUpperCase(), labelWidth - 12, 5.8))}</text>`
        ].join("");
        cellX += labelWidth + 8;
      }
      out += "</g>";
      return out;
    }
    case "tabs": {
      let cellX = x;
      const baselineY = y + 18;
      const indicatorY = baselineY + 4;
      let out = "<g>";
      entry.labels.forEach((label, index) => {
        const isActive = index === entry.activeIndex;
        const cellWidth = Math.max(64, label.length * 7 + 18);
        const tabColor = isActive ? dark ? colors.bar : colors.ink : dark ? colors.borderDark : colors.inkMuted;
        out += `<text x="${cellX + cellWidth / 2}" y="${baselineY}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="11" font-weight="${isActive ? 600 : 400}" fill="${tabColor}">${escapeText(label)}</text>`;
        if (isActive) {
          out += `<line x1="${cellX + cellWidth * 0.18}" y1="${indicatorY}" x2="${cellX + cellWidth * 0.82}" y2="${indicatorY}" stroke="${colors.accent}" stroke-width="2" stroke-linecap="round" />`;
        }
        cellX += cellWidth;
      });
      out += `<line x1="${x}" y1="${indicatorY + 2}" x2="${x + width}" y2="${indicatorY + 2}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`;
      out += "</g>";
      return out;
    }
    case "list": {
      let cursorY = y;
      let out = "<g>";
      entry.items.forEach((item) => {
        const rowHeight = item.meta ? 34 : 22;
        const showLeading = item.leading && item.leading !== "none";
        const leadingSize = 18;
        const textX = showLeading ? x + leadingSize + 8 : x;
        const titleY = item.meta ? cursorY + 14 : cursorY + Math.round(rowHeight / 2) + 4;
        if (showLeading) {
          if (item.leading === "avatar") {
            out += `<circle cx="${x + leadingSize / 2}" cy="${cursorY + rowHeight / 2}" r="${leadingSize / 2}" fill="${colors.accentFaded}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`;
          } else {
            out += `<rect x="${x}" y="${cursorY + rowHeight / 2 - leadingSize / 2}" width="${leadingSize}" height="${leadingSize}" rx="3" fill="${dark ? colors.barDark : colors.bar}" />`;
          }
        }
        const badgeWidth = item.badge ? item.badge.length * 5.5 + 10 : 0;
        const rightReserve = (item.trailing ? 58 : 0) + (item.badge ? badgeWidth + 8 : 0) + 4;
        out += `<text x="${textX}" y="${titleY}" font-family="${escapeAttr(fonts.sans)}" font-size="11" font-weight="${item.meta ? 600 : 500}" fill="${dark ? colors.bar : colors.ink}">${escapeText(truncateText(item.title, width - (textX - x) - rightReserve, 6))}</text>`;
        if (item.meta) {
          out += `<text x="${textX}" y="${titleY + 14}" font-family="${escapeAttr(fonts.sans)}" font-size="10" fill="${dark ? colors.barDark : colors.inkMuted}">${escapeText(truncateText(item.meta, width - (textX - x) - 8, 5.5))}</text>`;
        }
        if (item.badge) {
          const badgeX = x + width - badgeWidth - (item.trailing ? 60 : 4);
          const badgeY = cursorY + rowHeight / 2 - 7;
          out += `<rect x="${badgeX}" y="${badgeY}" width="${badgeWidth}" height="14" rx="7" fill="${colors.accent}" />`;
          out += `<text x="${badgeX + badgeWidth / 2}" y="${badgeY + 10}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="9" font-weight="700" fill="#FFFFFF">${escapeText(item.badge)}</text>`;
        }
        if (item.trailing) {
          out += `<text x="${x + width - 4}" y="${cursorY + rowHeight / 2 + 4}" text-anchor="end" font-family="${escapeAttr(fonts.sans)}" font-size="10" fill="${dark ? colors.barDark : colors.inkMuted}">${escapeText(truncateText(item.trailing, 54, 5.5))}</text>`;
        }
        cursorY += rowHeight + 6;
      });
      out += "</g>";
      return out;
    }
    case "field": {
      const baseY = entry.label ? y + 14 : y;
      const inputHeight = entry.variant === "textarea" ? 40 : 24;
      const placeholderText = entry.value ?? entry.placeholder ?? "";
      const showCaret = entry.variant === "search";
      let out = "<g>";
      if (entry.label) {
        out += `<text x="${x}" y="${y + 8}" font-family="${escapeAttr(fonts.sans)}" font-size="9" letter-spacing="0.8" fill="${dark ? colors.bar : colors.inkMuted}">${escapeText(entry.label.toUpperCase())}</text>`;
      }
      out += `<rect x="${x}" y="${baseY}" width="${width}" height="${inputHeight}" rx="3" fill="${dark ? colors.panelDark : "transparent"}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`;
      if (showCaret) {
        out += `<circle cx="${x + 12}" cy="${baseY + inputHeight / 2}" r="4" fill="none" stroke="${dark ? colors.bar : colors.inkMuted}" stroke-width="1.4" />`;
        out += `<line x1="${x + 15}" y1="${baseY + inputHeight / 2 + 3}" x2="${x + 18}" y2="${baseY + inputHeight / 2 + 6}" stroke="${dark ? colors.bar : colors.inkMuted}" stroke-width="1.4" stroke-linecap="round" />`;
      }
      out += `<text x="${showCaret ? x + 26 : x + 10}" y="${baseY + inputHeight / 2 + 4}" font-family="${escapeAttr(fonts.sans)}" font-size="10" fill="${entry.value ? dark ? colors.bar : colors.ink : dark ? colors.barDark : colors.inkSubtle}">${escapeText(truncateText(placeholderText, width - (showCaret ? 36 : 20), 5.8))}</text>`;
      if (entry.variant === "select") {
        out += `<line x1="${x + width - 18}" y1="${baseY + inputHeight / 2 - 2}" x2="${x + width - 12}" y2="${baseY + inputHeight / 2 + 3}" stroke="${dark ? colors.bar : colors.inkMuted}" stroke-width="1.4" />`;
        out += `<line x1="${x + width - 12}" y1="${baseY + inputHeight / 2 + 3}" x2="${x + width - 6}" y2="${baseY + inputHeight / 2 - 2}" stroke="${dark ? colors.bar : colors.inkMuted}" stroke-width="1.4" />`;
      }
      out += "</g>";
      return out;
    }
    case "banner": {
      const variantStyle = bannerStyleForExport(entry.variant, colors);
      return [
        `<rect x="${x}" y="${y}" width="${width}" height="32" rx="4" fill="${variantStyle.fill}" stroke="${variantStyle.stroke}" stroke-width="1" />`,
        `<circle cx="${x + 14}" cy="${y + 16}" r="5" fill="${variantStyle.icon}" />`,
        `<text x="${x + 14}" y="${y + 19}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="9" font-weight="700" fill="#FFFFFF">${variantStyle.glyph}</text>`,
        `<text x="${x + 28}" y="${y + 20}" font-family="${escapeAttr(fonts.sans)}" font-size="11" fill="${dark ? colors.bar : colors.ink}">${escapeText(truncateText(entry.text, width - 38, 5.8))}</text>`
      ].join("");
    }
    case "empty": {
      const headingY = y + 16;
      const helperY = entry.helper ? headingY + 18 : headingY;
      const ctaY = entry.cta ? helperY + (entry.helper ? 14 : 18) : 0;
      const centerX = x + width / 2;
      const ctaWidth = entry.cta ? Math.max(80, Math.min(width - 24, entry.cta.length * 6)) : 0;
      let out = `<circle cx="${centerX}" cy="${y - 2}" r="8" fill="none" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1.4" stroke-dasharray="3 3" />`;
      out += `<text x="${centerX}" y="${headingY + 8}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="12" font-weight="600" fill="${dark ? colors.bar : colors.ink}">${escapeText(truncateText(entry.heading, width - 24, 6))}</text>`;
      if (entry.helper) {
        out += `<text x="${centerX}" y="${helperY + 12}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="10" fill="${dark ? colors.barDark : colors.inkMuted}">${escapeText(truncateText(entry.helper, width - 32, 5.4))}</text>`;
      }
      if (entry.cta) {
        out += `<rect x="${centerX - ctaWidth / 2}" y="${ctaY}" width="${ctaWidth}" height="28" rx="4" fill="${colors.accent}" />`;
        out += `<text x="${centerX}" y="${ctaY + 18}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="11" font-weight="600" fill="#FFFFFF">${escapeText(truncateText(entry.cta, Math.max(56, width - 42), 5.8))}</text>`;
      }
      return out;
    }
    case "avatar":
      return [
        `<circle cx="${x + 12}" cy="${y + 14}" r="11" fill="${colors.accentFaded}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`,
        `<text x="${x + 12}" y="${y + 18}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="10" font-weight="600" fill="${dark ? colors.bar : colors.ink}">${escapeText(entry.initials)}</text>`
      ].join("");
    case "avatar-stack": {
      const radius = 11;
      const overlap = 8;
      let cursorX = x + radius;
      let out = "<g>";
      entry.entries.forEach((avatar) => {
        const cx = cursorX;
        cursorX += radius * 2 - overlap;
        if (avatar.overflow) {
          out += `<circle cx="${cx}" cy="${y + 12}" r="${radius}" fill="${dark ? colors.panelDark : colors.panel}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`;
          out += `<text x="${cx}" y="${y + 15}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="9" font-weight="600" fill="${dark ? colors.bar : colors.inkMuted}">${escapeText(avatar.overflow)}</text>`;
          return;
        }
        out += `<circle cx="${cx}" cy="${y + 12}" r="${radius}" fill="${colors.accentFaded}" stroke="${dark ? colors.panelDark : colors.panel}" stroke-width="2" />`;
        if (avatar.initials) {
          out += `<text x="${cx}" y="${y + 15}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="9" font-weight="600" fill="${dark ? colors.bar : colors.ink}">${escapeText(avatar.initials)}</text>`;
        }
      });
      out += "</g>";
      return out;
    }
    case "stat": {
      const valueY = y + 18;
      let out = `<text x="${x}" y="${valueY}" font-family="${escapeAttr(fonts.sans)}" font-size="17" font-weight="700" fill="${dark ? colors.bar : colors.ink}">${escapeText(entry.value)}</text>`;
      if (entry.label) {
        out += `<text x="${x}" y="${valueY + 12}" font-family="${escapeAttr(fonts.sans)}" font-size="9" letter-spacing="0.8" fill="${dark ? colors.barDark : colors.inkMuted}">${escapeText(entry.label.toUpperCase())}</text>`;
      }
      if (entry.trend) {
        const trendFill = entry.trendDirection === "up" ? "#2B8A3E" : entry.trendDirection === "down" ? colors.accent : colors.inkMuted;
        out += `<text x="${x + Math.max(32, entry.value.length * 10) + 8}" y="${valueY}" font-family="${escapeAttr(fonts.sans)}" font-size="10" font-weight="600" fill="${trendFill}">${escapeText(entry.trend)}</text>`;
      }
      return out;
    }
    case "table": {
      const headerHeight = 22;
      const rowHeight = 22;
      const columnCount = Math.max(entry.columns.length, ...entry.rows.map((r) => r.length), 1);
      const columnOffsets = tableColumnOffsets(entry.weights, columnCount, width);
      let out = "<g>";
      entry.columns.forEach((column, colIndex) => {
        const col = columnOffsets[colIndex];
        out += `<text x="${x + col.start + 4}" y="${y + 14}" font-family="${escapeAttr(fonts.sans)}" font-size="9" letter-spacing="0.8" fill="${dark ? colors.barDark : colors.inkMuted}">${escapeText(truncateText(column.toUpperCase(), col.width - 8, 5.5))}</text>`;
      });
      out += `<line x1="${x}" y1="${y + headerHeight - 2}" x2="${x + width}" y2="${y + headerHeight - 2}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`;
      entry.rows.forEach((row, rowIndex) => {
        const rowY = y + headerHeight + rowIndex * rowHeight;
        row.forEach((cell, colIndex) => {
          const col = columnOffsets[colIndex] ?? columnOffsets[columnOffsets.length - 1];
          out += renderTableCell(cell, x + col.start, rowY, col.width, dark, theme);
        });
        if (rowIndex < entry.rows.length - 1) {
          out += `<line x1="${x}" y1="${rowY + rowHeight - 1}" x2="${x + width}" y2="${rowY + rowHeight - 1}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="0.5" />`;
        }
      });
      out += "</g>";
      return out;
    }
    case "media":
      return renderMedia(entry, x, y, width, dark, theme, frame);
    case "card-grid":
      return renderCardGrid(entry, x, y, width, dark, theme);
    case "steps":
      return renderSteps(entry, x, y, width, dark, theme);
    case "columns":
      return renderColumns(entry, x, y, width, dark, theme, frame);
    case "popover":
      return renderPopover(entry, x, y, width, dark, theme, frame);
    case "breadcrumbs": {
      let cursorX = x;
      const baselineY = y + 11;
      let out = "<g>";
      entry.items.forEach((item, index) => {
        const isLast = index === entry.items.length - 1;
        const remaining = x + width - cursorX;
        if (remaining < 30) return;
        const text = truncateText(item, Math.min(remaining, 140), 5.8);
        out += `<text x="${cursorX}" y="${baselineY}" font-family="${escapeAttr(fonts.sans)}" font-size="10" font-weight="${isLast ? 600 : 400}" fill="${isLast ? dark ? colors.bar : colors.ink : dark ? colors.barDark : colors.inkMuted}">${escapeText(text)}</text>`;
        cursorX += text.length * 5.8 + 8;
        if (!isLast) {
          out += `<text x="${cursorX}" y="${baselineY}" font-family="${escapeAttr(fonts.sans)}" font-size="10" fill="${dark ? colors.barDark : colors.inkSubtle}">\u203A</text>`;
          cursorX += 12;
        }
      });
      out += "</g>";
      return out;
    }
    case "accordion": {
      const { dimensions } = theme;
      let cursorY = y;
      let out = "<g>";
      entry.items.forEach((item) => {
        const headerHeight = 24;
        const chevronX = x + 6;
        const chevronY = cursorY + 10;
        if (item.expanded) {
          out += `<path d="M ${chevronX - 4} ${chevronY - 2} L ${chevronX + 4} ${chevronY - 2} L ${chevronX} ${chevronY + 4} Z" fill="${dark ? colors.bar : colors.inkMuted}" />`;
        } else {
          out += `<path d="M ${chevronX - 2} ${chevronY - 4} L ${chevronX + 4} ${chevronY} L ${chevronX - 2} ${chevronY + 4} Z" fill="${dark ? colors.barDark : colors.inkMuted}" />`;
        }
        out += `<text x="${x + 16}" y="${cursorY + 14}" font-family="${escapeAttr(fonts.sans)}" font-size="11" font-weight="600" fill="${dark ? colors.bar : colors.ink}">${escapeText(truncateText(item.title, width - 20, 6))}</text>`;
        out += `<line x1="${x}" y1="${cursorY + headerHeight - 2}" x2="${x + width}" y2="${cursorY + headerHeight - 2}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="0.75" />`;
        cursorY += headerHeight;
        if (item.expanded && item.body.length > 0) {
          const innerX = x + 18;
          const innerWidth = width - 18;
          let innerY = cursorY + 4;
          item.body.forEach((child, childIndex) => {
            const childHeight = measureBodyEntry(child, dimensions, innerWidth, frame);
            out += renderBodyEntry(child, innerX, innerY, innerWidth, dark, theme, frame);
            innerY += childHeight + (childIndex < item.body.length - 1 ? dimensions.rowGap : 0);
          });
          cursorY += measureBodyEntries(item.body, dimensions, innerWidth, frame) + 8;
        }
        cursorY += 4;
      });
      out += "</g>";
      return out;
    }
    case "meter": {
      const hasText = Boolean(entry.label || entry.caption);
      const trackY = hasText ? y + 18 : y + 3;
      const trackHeight = 8;
      const ratio = Math.max(0, Math.min(1, entry.max > 0 ? entry.value / entry.max : 0));
      let out = "<g>";
      if (entry.label) {
        out += `<text x="${x}" y="${y + 9}" font-family="${escapeAttr(fonts.sans)}" font-size="9" letter-spacing="0.8" fill="${dark ? colors.bar : colors.inkMuted}">${escapeText(entry.label.toUpperCase())}</text>`;
      }
      if (entry.caption) {
        out += `<text x="${x + width}" y="${y + 9}" text-anchor="end" font-family="${escapeAttr(fonts.sans)}" font-size="9" fill="${dark ? colors.barDark : colors.inkMuted}">${escapeText(entry.caption)}</text>`;
      }
      out += `<rect x="${x}" y="${trackY}" width="${width}" height="${trackHeight}" rx="4" fill="${dark ? colors.barDark : colors.accentFaded}" />`;
      if (ratio > 0) {
        out += `<rect x="${x}" y="${trackY}" width="${Math.max(trackHeight, width * ratio)}" height="${trackHeight}" rx="4" fill="${colors.accent}" />`;
      }
      out += "</g>";
      return out;
    }
    case "pagination": {
      const cells = paginationSequence(entry.page, entry.pages);
      const cellHeight = 20;
      const cellGap = 4;
      const chevronWidth = 18;
      const cellWidths = cells.map(
        (cell) => cell === "\u2026" ? 14 : Math.max(20, String(cell).length * 6 + 10)
      );
      const totalCells = chevronWidth * 2 + cellGap * (cells.length + 1) + cellWidths.reduce((sum, w) => sum + w, 0);
      let cursorX = x + Math.max(0, (width - totalCells) / 2);
      const cellY = y + 1;
      const textY = cellY + 13.5;
      let out = "<g>";
      const chevron = (glyph) => {
        out += `<text x="${cursorX + chevronWidth / 2}" y="${textY}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="11" fill="${dark ? colors.barDark : colors.inkMuted}">${glyph}</text>`;
        cursorX += chevronWidth + cellGap;
      };
      chevron("\u2039");
      cells.forEach((cell, index) => {
        const cellWidth = cellWidths[index];
        if (cell === "\u2026") {
          out += `<text x="${cursorX + cellWidth / 2}" y="${textY}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="10" fill="${dark ? colors.barDark : colors.inkSubtle}">\u2026</text>`;
        } else {
          const isActive = cell === entry.page;
          if (isActive) {
            out += `<rect x="${cursorX}" y="${cellY}" width="${cellWidth}" height="${cellHeight}" rx="3" fill="${colors.accent}" />`;
          }
          out += `<text x="${cursorX + cellWidth / 2}" y="${textY}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="10" font-weight="${isActive ? 700 : 400}" fill="${isActive ? "#FFFFFF" : dark ? colors.bar : colors.inkMuted}">${cell}</text>`;
        }
        cursorX += cellWidth + cellGap;
      });
      chevron("\u203A");
      out += "</g>";
      return out;
    }
    case "chrome":
      return "";
    case "divider":
      return `<line x1="${x}" y1="${y}" x2="${x + width}" y2="${y}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`;
    case "spacer":
      return "";
  }
}
function paginationSequence(page, pages) {
  if (pages <= 7) {
    return Array.from({ length: pages }, (_, index) => index + 1);
  }
  const out = [1];
  if (page > 3) out.push("\u2026");
  for (let p = Math.max(2, page - 1); p <= Math.min(pages - 1, page + 1); p += 1) {
    out.push(p);
  }
  if (page < pages - 2) out.push("\u2026");
  out.push(pages);
  return out;
}
function renderMedia(entry, x, y, width, dark, theme, frame) {
  const { colors, fonts, dimensions } = theme;
  const height = measureBodyEntry(entry, dimensions, width, frame);
  const label = entry.label ?? (entry.variant === "video" ? "Video" : entry.variant === "illustration" ? "Illustration" : entry.variant === "chart" ? "Chart" : "Image");
  if (entry.variant === "chart") {
    const padX = 14;
    const baselineY = y + height - 18;
    const plotHeight = Math.max(24, height - 44);
    const barFractions = [0.45, 0.72, 0.34, 0.86, 0.58, 0.66, 0.42];
    const barCount = Math.max(4, Math.min(barFractions.length, Math.floor((width - padX * 2) / 26)));
    const slotWidth = (width - padX * 2) / barCount;
    const barWidth = Math.min(18, slotWidth * 0.55);
    let bars = "";
    for (let i = 0; i < barCount; i += 1) {
      const barHeight = plotHeight * barFractions[i % barFractions.length];
      const barX = x + padX + i * slotWidth + (slotWidth - barWidth) / 2;
      bars += `<rect x="${barX}" y="${baselineY - barHeight}" width="${barWidth}" height="${barHeight}" rx="2" fill="${dark ? colors.barDark : colors.bar}" />`;
    }
    return [
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="5" fill="${dark ? colors.panelDark : colors.panel}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`,
      bars,
      `<line x1="${x + padX}" y1="${baselineY}" x2="${x + width - padX}" y2="${baselineY}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1.2" />`,
      `<text x="${x + width / 2}" y="${y + height - 5}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="10" font-weight="600" fill="${dark ? colors.bar : colors.inkMuted}">${escapeText(truncateText(label, Math.max(40, width - 28), 6))}</text>`
    ].join("");
  }
  return [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="5" fill="${dark ? colors.panelDark : colors.accentFaded}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`,
    `<line x1="${x + 12}" y1="${y + 12}" x2="${x + width - 12}" y2="${y + height - 12}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`,
    `<line x1="${x + width - 12}" y1="${y + 12}" x2="${x + 12}" y2="${y + height - 12}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`,
    `<text x="${x + width / 2}" y="${y + height / 2 + 4}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="11" font-weight="600" fill="${dark ? colors.bar : colors.inkMuted}">${escapeText(truncateText(label, Math.max(40, width - 28), 6))}</text>`
  ].join("");
}
function renderCardGrid(entry, x, y, width, dark, theme) {
  const { colors, fonts } = theme;
  const columns = boundedColumnCount(entry.columns ?? 3, entry.cards.length, width);
  const gap = 10;
  const cardWidth = (width - gap * (columns - 1)) / columns;
  const cardHeight = 58;
  let out = "<g>";
  entry.cards.forEach((card, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const cardX = x + col * (cardWidth + gap);
    const cardY = y + row * (cardHeight + gap);
    out += [
      `<rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" rx="5" fill="${dark ? colors.panelDark : colors.panel}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`,
      `<rect x="${cardX + 10}" y="${cardY + 10}" width="${Math.min(cardWidth - 20, 34)}" height="20" rx="3" fill="${dark ? colors.barDark : colors.bar}" />`,
      `<text x="${cardX + 10}" y="${cardY + 42}" font-family="${escapeAttr(fonts.sans)}" font-size="11" font-weight="600" fill="${dark ? colors.bar : colors.ink}">${escapeText(truncateText(card.title, cardWidth - 20, 6))}</text>`,
      card.meta ? `<text x="${cardX + 10}" y="${cardY + 53}" font-family="${escapeAttr(fonts.sans)}" font-size="9" fill="${dark ? colors.barDark : colors.inkMuted}">${escapeText(truncateText(card.meta, cardWidth - 20, 5.5))}</text>` : ""
    ].join("");
  });
  out += "</g>";
  return out;
}
function renderSteps(entry, x, y, width, dark, theme) {
  const { colors, fonts } = theme;
  const horizontal = shouldRenderStepsHorizontally(entry.steps.length, width);
  const activeIndex = entry.activeIndex ?? 0;
  const stepFill = (index) => index === activeIndex ? colors.accent : index < activeIndex ? colors.accentFaded : dark ? colors.panelDark : colors.panel;
  const stepTextFill = (index) => index === activeIndex ? dark ? colors.bar : colors.ink : dark ? colors.barDark : colors.inkMuted;
  let out = "<g>";
  if (!horizontal) {
    entry.steps.forEach((step, index) => {
      const stepY = y + index * 30;
      if (index < entry.steps.length - 1) {
        out += `<line x1="${x + 8}" y1="${stepY + 16}" x2="${x + 8}" y2="${stepY + 30}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1.2" />`;
      }
      out += `<circle cx="${x + 8}" cy="${stepY + 10}" r="7" fill="${stepFill(index)}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`;
      out += `<text x="${x + 24}" y="${stepY + 14}" font-family="${escapeAttr(fonts.sans)}" font-size="11" font-weight="600" fill="${stepTextFill(index)}">${escapeText(truncateText(step.label, width - 28, 6))}</text>`;
    });
    out += "</g>";
    return out;
  }
  const stepWidth = width / entry.steps.length;
  entry.steps.forEach((step, index) => {
    const centerX = x + stepWidth * index + stepWidth / 2;
    if (index < entry.steps.length - 1) {
      out += `<line x1="${centerX + 12}" y1="${y + 11}" x2="${centerX + stepWidth - 12}" y2="${y + 11}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1.2" />`;
    }
    out += `<circle cx="${centerX}" cy="${y + 11}" r="8" fill="${stepFill(index)}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`;
    out += `<text x="${centerX}" y="${y + 34}" text-anchor="middle" font-family="${escapeAttr(fonts.sans)}" font-size="10" font-weight="600" fill="${stepTextFill(index)}">${escapeText(truncateText(step.label, stepWidth - 8, 5.5))}</text>`;
  });
  out += "</g>";
  return out;
}
function renderPopover(entry, x, y, width, dark, theme, frame) {
  const { colors, dimensions } = theme;
  const popoverPad = 12;
  const arrowSize = 8;
  const popoverWidth = Math.min(width, entry.width ?? 220);
  const innerWidth = popoverWidth - popoverPad * 2;
  const contentHeight = measureBodyEntries(entry.body, dimensions, innerWidth, frame);
  const panelHeight = contentHeight + popoverPad * 2;
  const arrowTop = entry.anchor === "top";
  const arrowBottom = entry.anchor === "bottom";
  const arrowLeft = entry.anchor === "left";
  const arrowRight = entry.anchor === "right";
  const panelX = arrowLeft ? x + arrowSize : x;
  const panelY = arrowTop ? y + arrowSize : y;
  const panelWidth = arrowLeft || arrowRight ? popoverWidth - arrowSize : popoverWidth;
  const fill = dark ? colors.panelDark : colors.panel;
  const stroke = dark ? colors.borderDark : colors.border;
  let out = "<g>";
  out += `<rect x="${panelX}" y="${panelY}" width="${panelWidth}" height="${panelHeight}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1" />`;
  if (arrowTop) {
    const ax = panelX + 22;
    const ay = panelY;
    out += `<path d="M ${ax - arrowSize} ${ay} L ${ax} ${ay - arrowSize} L ${ax + arrowSize} ${ay} Z" fill="${fill}" stroke="${stroke}" stroke-width="1" />`;
    out += `<line x1="${ax - arrowSize + 1}" y1="${ay}" x2="${ax + arrowSize - 1}" y2="${ay}" stroke="${fill}" stroke-width="2" />`;
  } else if (arrowBottom) {
    const ax = panelX + 22;
    const ay = panelY + panelHeight;
    out += `<path d="M ${ax - arrowSize} ${ay} L ${ax} ${ay + arrowSize} L ${ax + arrowSize} ${ay} Z" fill="${fill}" stroke="${stroke}" stroke-width="1" />`;
    out += `<line x1="${ax - arrowSize + 1}" y1="${ay}" x2="${ax + arrowSize - 1}" y2="${ay}" stroke="${fill}" stroke-width="2" />`;
  } else if (arrowLeft) {
    const ay = panelY + panelHeight / 2;
    const ax = panelX;
    out += `<path d="M ${ax} ${ay - arrowSize} L ${ax - arrowSize} ${ay} L ${ax} ${ay + arrowSize} Z" fill="${fill}" stroke="${stroke}" stroke-width="1" />`;
    out += `<line x1="${ax}" y1="${ay - arrowSize + 1}" x2="${ax}" y2="${ay + arrowSize - 1}" stroke="${fill}" stroke-width="2" />`;
  } else if (arrowRight) {
    const ay = panelY + panelHeight / 2;
    const ax = panelX + panelWidth;
    out += `<path d="M ${ax} ${ay - arrowSize} L ${ax + arrowSize} ${ay} L ${ax} ${ay + arrowSize} Z" fill="${fill}" stroke="${stroke}" stroke-width="1" />`;
    out += `<line x1="${ax}" y1="${ay - arrowSize + 1}" x2="${ax}" y2="${ay + arrowSize - 1}" stroke="${fill}" stroke-width="2" />`;
  }
  let cursorY = panelY + popoverPad;
  for (let i = 0; i < entry.body.length; i += 1) {
    const child = entry.body[i];
    const childHeight = measureBodyEntry(child, dimensions, innerWidth, frame);
    out += renderBodyEntry(
      child,
      panelX + popoverPad,
      cursorY,
      innerWidth,
      dark,
      theme,
      frame
    );
    cursorY += childHeight + (i < entry.body.length - 1 ? dimensions.rowGap : 0);
  }
  out += "</g>";
  return out;
}
function renderColumns(entry, x, y, width, dark, theme, frame) {
  const { colors, fonts, dimensions } = theme;
  const layout = layoutColumnRegions(entry, width, frame, dimensions);
  let out = "<g>";
  layout.regions.forEach((region) => {
    out += `<rect x="${x + region.x}" y="${y + region.y}" width="${region.width}" height="${region.height}" rx="5" fill="${dark ? colors.panelDark : colors.accentFaded}" opacity="${dark ? 0.75 : 0.5}" stroke="${dark ? colors.borderDark : colors.border}" stroke-width="1" />`;
    if (region.region.label) {
      out += `<text x="${x + region.bodyX}" y="${y + region.y + 13}" font-family="${escapeAttr(fonts.mono)}" font-size="9" letter-spacing="1.1" fill="${dark ? colors.barDark : colors.inkMuted}">${escapeText(truncateText(region.region.label.toUpperCase(), region.bodyWidth, 5.6))}</text>`;
    }
    region.region.body.forEach((child, childIndex) => {
      const childY = region.bodyY + childOffset(region.region.body, childIndex, dimensions, region.bodyWidth, frame);
      out += renderBodyEntry(child, x + region.bodyX, y + childY, region.bodyWidth, dark, theme, frame);
      if (child.marker) {
        out += renderMarkerBadge(child.marker, x + region.x + region.width - 8, y + childY + 8, theme);
      }
    });
  });
  out += "</g>";
  return out;
}
function childOffset(entries, targetIndex, dimensions, width, frame) {
  let offset = 0;
  for (let index = 0; index < targetIndex; index += 1) {
    offset += measureBodyEntry(entries[index], dimensions, width, frame) + dimensions.rowGap;
  }
  return offset;
}
function layoutColumnRegions(entry, width, frame, dimensions) {
  const gap = entry.gap ?? frame.grid?.gap ?? dimensions.rowGap;
  const stack = frame.viewport === "mobile" || width < 360;
  const gridColumns = entry.columns ?? frame.grid?.columns;
  const explicitSpans = entry.regions.some((region) => region.span !== void 0);
  const spans = explicitSpans || !gridColumns ? entry.regions.map((region) => region.span ?? 1) : distributeGridColumns(gridColumns, entry.regions.length);
  const totalSpan = Math.max(1, spans.reduce((sum, span) => sum + span, 0));
  const denominator = gridColumns ? Math.max(gridColumns, totalSpan) : totalSpan;
  const gridColumnWidth = denominator > 0 ? (width - gap * Math.max(0, denominator - 1)) / denominator : width;
  const regionPad = 10;
  let cursorX = 0;
  let cursorY = 0;
  const regions = entry.regions.map((region, index) => {
    const regionWidth = stack ? width : gridColumnWidth * spans[index] + gap * Math.max(0, spans[index] - 1);
    const bodyWidth = Math.max(40, regionWidth - regionPad * 2);
    const labelHeight = region.label ? 18 : 0;
    const bodyY = cursorY + regionPad + labelHeight;
    const bodyHeight = measureBodyEntries(region.body, dimensions, bodyWidth, frame);
    const height2 = Math.max(64, bodyHeight + labelHeight + regionPad * 2);
    const layout = {
      region,
      x: stack ? 0 : cursorX,
      y: stack ? cursorY : 0,
      width: regionWidth,
      bodyX: (stack ? 0 : cursorX) + regionPad,
      bodyY,
      bodyWidth,
      height: height2
    };
    if (stack) {
      cursorY += height2 + gap;
    } else {
      cursorX += regionWidth + gap;
    }
    return layout;
  });
  const height = stack ? Math.max(80, cursorY - gap) : Math.max(80, ...regions.map((region) => region.height));
  return { regions, height };
}
function distributeGridColumns(columns, regionCount) {
  const count = Math.max(1, regionCount);
  const base = Math.max(1, Math.floor(columns / count));
  let remainder = Math.max(0, columns - base * count);
  return Array.from({ length: count }).map(() => {
    const span = base + (remainder > 0 ? 1 : 0);
    remainder -= 1;
    return span;
  });
}
function boundedColumnCount(requested, itemCount, width) {
  const maxByWidth = Math.max(1, Math.floor(width / 120));
  return Math.max(1, Math.min(requested, itemCount || 1, maxByWidth));
}
function shouldRenderStepsHorizontally(stepCount, width) {
  return stepCount > 1 && stepCount <= 5 && width / stepCount >= 92;
}
function ratioToNumber(raw) {
  const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/u.exec(raw.trim());
  if (!match) return 16 / 9;
  const ratioWidth = Number.parseFloat(match[1]);
  const ratioHeight = Number.parseFloat(match[2]);
  if (!Number.isFinite(ratioWidth) || !Number.isFinite(ratioHeight) || ratioHeight <= 0) return 16 / 9;
  return ratioWidth / ratioHeight;
}
function truncateText(text, maxWidth, charWidth) {
  if (text.length * charWidth <= maxWidth) return text;
  const maxChars = Math.max(1, Math.floor(maxWidth / charWidth));
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}
function wrapText(text, maxWidth, charWidth, maxLines) {
  const charsPerLine = Math.max(1, Math.floor(maxWidth / charWidth));
  const trimmed = text.trim();
  if (trimmed.length <= charsPerLine) return [trimmed];
  const lines = [];
  let remaining = trimmed;
  while (lines.length < maxLines && remaining.length > 0) {
    if (remaining.length <= charsPerLine) {
      lines.push(remaining);
      remaining = "";
      break;
    }
    let breakPoint = charsPerLine;
    const lastSpace = remaining.lastIndexOf(" ", charsPerLine);
    if (lastSpace > charsPerLine * 0.5) breakPoint = lastSpace;
    lines.push(remaining.slice(0, breakPoint).trim());
    remaining = remaining.slice(breakPoint).trim();
  }
  if (remaining.length > 0 && lines.length > 0) {
    const lastIdx = lines.length - 1;
    const merged = `${lines[lastIdx]} ${remaining}`;
    lines[lastIdx] = truncateText(merged, maxWidth, charWidth);
  }
  return lines;
}
function bannerStyleForExport(variant, colors) {
  if (variant === "warning") {
    return { fill: "#FFF4D6", stroke: "#E8B53B", icon: "#C58A14", glyph: "!" };
  }
  if (variant === "error") {
    return { fill: "#F7DAD2", stroke: "#D04A2A", icon: colors.accent, glyph: "!" };
  }
  if (variant === "success") {
    return { fill: "#E3EAD3", stroke: "#8FA468", icon: "#5F7A3D", glyph: "\u2713" };
  }
  return { fill: colors.accentFaded, stroke: colors.border, icon: colors.inkMuted, glyph: "i" };
}
function toneStyle(tone, colors) {
  switch (tone) {
    case "ok":
      return { fill: "#DEE7CC", text: "#4F6B33" };
    case "warn":
      return { fill: "#F3E3BB", text: "#8A6414" };
    case "error":
      return { fill: "#F2D3C8", text: "#A63E1F" };
    case "accent":
      return { fill: colors.accentFaded, text: colors.accent };
    case "muted":
    default:
      return { fill: colors.chip, text: colors.chipText };
  }
}
function tableColumnOffsets(weights, columnCount, width) {
  const normalized = weights && weights.length === columnCount && weights.every((w) => w > 0) ? weights : Array.from({ length: columnCount }, () => 1);
  const total = normalized.reduce((sum, w) => sum + w, 0);
  const out = [];
  let cursor = 0;
  for (const weight of normalized) {
    const columnWidth = weight / total * width;
    out.push({ start: cursor, width: columnWidth });
    cursor += columnWidth;
  }
  return out;
}
function renderTableCell(cell, x, rowY, cellWidth, dark, theme) {
  const { colors, fonts } = theme;
  if (typeof cell === "string") {
    return `<text x="${x + 4}" y="${rowY + 14}" font-family="${escapeAttr(fonts.sans)}" font-size="11" fill="${dark ? colors.bar : colors.ink}">${escapeText(truncateText(cell, cellWidth - 8, 6))}</text>`;
  }
  const tone = toneStyle(cell.tone, colors);
  const pillWidth = Math.max(30, Math.min(cellWidth - 8, cell.pill.length * 5.6 + 14));
  return [
    `<rect x="${x + 4}" y="${rowY + 4}" width="${pillWidth}" height="15" rx="7.5" fill="${tone.fill}" />`,
    `<text x="${x + 4 + pillWidth / 2}" y="${rowY + 14.5}" text-anchor="middle" font-family="${escapeAttr(fonts.mono)}" font-size="8.5" letter-spacing="0.8" fill="${tone.text}">${escapeText(truncateText(cell.pill.toUpperCase(), pillWidth - 10, 5.4))}</text>`
  ].join("");
}
function renderRowCell(cell, x, y, maxX, dark, theme) {
  const { colors, fonts } = theme;
  if (cell.type === "toggle") {
    return {
      element: [
        `<rect x="${x}" y="${y + 2}" width="26" height="14" rx="7" fill="${colors.accent}" />`,
        `<circle cx="${x + 19}" cy="${y + 9}" r="5" fill="#FFFFFF" />`
      ].join(""),
      nextX: x + 36
    };
  }
  if (cell.type === "icon") {
    return {
      element: `<rect x="${x}" y="${y + 2}" width="14" height="14" rx="2" fill="${dark ? colors.barDark : colors.bar}" />`,
      nextX: x + 24
    };
  }
  if (cell.type === "checkbox") {
    return {
      element: `<rect x="${x}" y="${y + 2}" width="14" height="14" rx="2" fill="transparent" stroke="${dark ? colors.bar : colors.ink}" stroke-width="1" />`,
      nextX: x + 24
    };
  }
  const text = cell.text ?? "";
  const maxWidth = Math.max(28, maxX - x);
  const width = Math.max(28, Math.min(maxWidth, Math.max(80, text.length * 6.5)));
  return {
    element: `<text x="${x}" y="${y + 14}" font-family="${escapeAttr(fonts.sans)}" font-size="11" fill="${dark ? colors.bar : colors.ink}">${escapeText(truncateText(text, width, 6))}</text>`,
    nextX: x + width + 8
  };
}
function lineWidthForIndex(width, index, total) {
  if (total <= 1) return width;
  const fractions = [1, 0.92, 0.82, 0.95, 0.78, 0.88];
  const fraction = fractions[index % fractions.length];
  if (index === total - 1) return width * 0.72;
  return width * fraction;
}
function renderArrow(x, y, width, top, bottom, theme) {
  const { colors, fonts } = theme;
  const arrowStart = x + 18;
  const arrowEnd = x + width - 18;
  let out = "<g>";
  if (top) {
    out += `<text x="${x + width / 2}" y="${y - 18}" text-anchor="middle" font-family="${escapeAttr(fonts.mono)}" font-size="11" letter-spacing="2.4" fill="${colors.inkMuted}">${escapeText(top.toUpperCase())}</text>`;
  }
  out += `<line x1="${arrowStart}" y1="${y}" x2="${arrowEnd - 6}" y2="${y}" stroke="${colors.accent}" stroke-width="1.5" stroke-dasharray="5 4" />`;
  out += `<polygon points="${arrowEnd - 6},${y - 5} ${arrowEnd + 4},${y} ${arrowEnd - 6},${y + 5}" fill="${colors.accent}" />`;
  if (bottom) {
    out += `<text x="${x + width / 2}" y="${y + 24}" text-anchor="middle" font-family="${escapeAttr(fonts.serif)}" font-style="italic" font-size="11" fill="${colors.inkSubtle}">${escapeText(bottom)}</text>`;
  }
  out += "</g>";
  return out;
}
function renderTransitionLabel(x, y, text, theme) {
  const { colors, fonts } = theme;
  return `<text x="${x}" y="${y}" text-anchor="middle" font-family="${escapeAttr(fonts.serif)}" font-style="italic" font-size="11" fill="${colors.inkSubtle}">${escapeText(`\u201C${text}\u201D`)}</text>`;
}
function escapeAttr(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function escapeText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// src/options-html.ts
var LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function optionLetter(index) {
  return index < LETTERS.length ? LETTERS[index] : String(index + 1);
}
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function parseOptionMeta(blockContent) {
  const meta = {};
  for (const raw of blockContent.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.startsWith("#")) break;
    const body = line.replace(/^#+\s*/, "");
    const colon = body.indexOf(":");
    const key = (colon === -1 ? body : body.slice(0, colon)).trim().toLowerCase();
    const value = colon === -1 ? "" : body.slice(colon + 1).trim();
    if ((key === "option" || key === "title") && value) meta.title = value;
    else if ((key === "best-when" || key === "best when") && value) meta.bestWhen = value;
    else if (key === "risk" && value) meta.risk = value;
    else if (key === "suggested") meta.suggested = value === "" || /^(true|yes)$/i.test(value);
  }
  return meta;
}
function styles(theme) {
  const c = theme.colors;
  const f = theme.fonts;
  return `:root{
  --wf-bg:${c.bg}; --wf-panel:${c.panel}; --wf-border:${c.border};
  --wf-ink:${c.ink}; --wf-ink-muted:${c.inkMuted}; --wf-ink-subtle:${c.inkSubtle};
  --wf-accent:${c.accent}; --wf-accent-soft:${c.accentFaded};
  --wf-chip:${c.chip}; --wf-chip-text:${c.chipText};
  --wf-sans:${f.sans}; --wf-mono:${f.mono};
}
*{box-sizing:border-box}
body{margin:0;background:var(--wf-bg);color:var(--wf-ink);font-family:var(--wf-sans);line-height:1.5;-webkit-font-smoothing:antialiased}
.wf-options{max-width:1040px;margin:0 auto;padding:40px 28px 64px}
.wf-head{margin-bottom:24px}
.wf-head h1{margin:0;font-size:26px;font-weight:650;letter-spacing:-0.01em}
.wf-head .wf-intro{margin:8px 0 0;max-width:62ch;color:var(--wf-ink-muted);font-size:15px}
.wf-tabs{display:flex;flex-wrap:wrap;gap:6px;border-bottom:1px solid var(--wf-border);padding-bottom:10px;margin-bottom:20px}
.wf-tab{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--wf-ink-muted);font:inherit;font-size:14px;cursor:pointer}
.wf-tab:hover{color:var(--wf-ink);background:var(--wf-panel)}
.wf-tab.is-active{color:var(--wf-ink);background:var(--wf-panel);border-color:var(--wf-border)}
.wf-tab.is-active.is-suggested{border-color:var(--wf-accent);background:var(--wf-accent-soft)}
.wf-tab-letter{font-family:var(--wf-mono);font-size:12px;font-weight:600;color:var(--wf-accent)}
.wf-tab-title{font-weight:500}
.wf-flag{font-family:var(--wf-mono);font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--wf-accent)}
.wf-panel[hidden]{display:none}
.wf-panel{border:1px solid var(--wf-border);border-radius:12px;background:var(--wf-panel);padding:24px;display:flex;flex-direction:column;gap:14px}
.wf-panel.is-suggested{border-color:var(--wf-accent)}
.wf-panel-head{display:flex;align-items:baseline;gap:10px}
.wf-panel-letter{font-family:var(--wf-mono);font-size:18px;font-weight:600;color:var(--wf-accent)}
.wf-panel-title{margin:0;font-size:18px;font-weight:600;flex:1}
.wf-meta{margin:0;font-size:14px;color:var(--wf-ink-muted);max-width:64ch}
.wf-label{font-family:var(--wf-mono);font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--wf-ink-subtle);margin-right:8px}
.wf-diagram{margin:2px 0 0;border-radius:6px;overflow:hidden}
.wf-diagram svg{display:block;width:100%;height:auto}
.wf-lint{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.wf-lint-item{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--wf-ink-muted)}
.wf-lint-sev{flex:0 0 auto;font-family:var(--wf-mono);font-size:11px;text-transform:uppercase;color:var(--wf-accent)}
.wf-lint-item.is-info .wf-lint-sev{color:var(--wf-ink-subtle)}
.wf-foot{margin-top:28px;font-size:12px;color:var(--wf-ink-subtle)}
@media print{.wf-tabs{display:none}.wf-panel[hidden]{display:flex!important}.wf-panel{break-inside:avoid;margin-bottom:20px}}`;
}
var TABS_SCRIPT = `(function(){
  var tablist=document.querySelector('[role="tablist"]');
  if(!tablist)return;
  var tabs=Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
  function select(tab){
    tabs.forEach(function(t){
      var on=t===tab;
      t.setAttribute('aria-selected',on?'true':'false');
      t.tabIndex=on?0:-1;
      t.classList.toggle('is-active',on);
      var panel=document.getElementById(t.getAttribute('aria-controls'));
      if(panel)panel.hidden=!on;
    });
  }
  tabs.forEach(function(tab,i){
    tab.addEventListener('click',function(){select(tab);tab.focus();});
    tab.addEventListener('keydown',function(e){
      var n;
      if(e.key==='ArrowRight'||e.key==='ArrowDown')n=tabs[(i+1)%tabs.length];
      else if(e.key==='ArrowLeft'||e.key==='ArrowUp')n=tabs[(i-1+tabs.length)%tabs.length];
      else if(e.key==='Home')n=tabs[0];
      else if(e.key==='End')n=tabs[tabs.length-1];
      else return;
      e.preventDefault();select(n);n.focus();
    });
  });
})();`;
function panelHtml(opt, index, active) {
  const title = escapeHtml(opt.title || `Option ${opt.letter}`);
  const flag = opt.suggested ? `<span class="wf-flag">suggested</span>` : "";
  const bestWhen = opt.bestWhen ? `<p class="wf-meta"><span class="wf-label">Best when</span>${escapeHtml(opt.bestWhen)}</p>` : "";
  const risk = opt.risk ? `<p class="wf-meta"><span class="wf-label">Risk</span>${escapeHtml(opt.risk)}</p>` : "";
  const warnings = opt.warnings && opt.warnings.length ? `<ul class="wf-lint" aria-label="Wireframe warnings">${opt.warnings.map(
    (w) => `<li class="wf-lint-item is-${escapeHtml(w.severity)}"><span class="wf-lint-sev">${escapeHtml(
      w.severity
    )}</span><span>${escapeHtml(w.message)}</span></li>`
  ).join("")}</ul>` : "";
  return `<section role="tabpanel" id="wf-panel-${index}" aria-labelledby="wf-tab-${index}" class="wf-panel${active ? " is-active" : ""}${opt.suggested ? " is-suggested" : ""}"${active ? "" : " hidden"}>
  <header class="wf-panel-head"><span class="wf-panel-letter">${opt.letter}</span><h2 class="wf-panel-title">${title}</h2>${flag}</header>
  ${bestWhen}${risk}
  <div class="wf-diagram" role="img" aria-label="${title} wireframe">${opt.svg}</div>
  ${warnings}
</section>`;
}
function renderOptionsHtml(options, theme, input = {}) {
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.suggested)
  );
  const title = input.title || "Wireframe options";
  const tabs = options.map((opt, i) => {
    const active = i === activeIndex;
    const label = escapeHtml(opt.title || `Option ${opt.letter}`);
    const flag = opt.suggested ? `<span class="wf-flag">suggested</span>` : "";
    return `<button type="button" role="tab" id="wf-tab-${i}" aria-controls="wf-panel-${i}" aria-selected="${active ? "true" : "false"}" tabindex="${active ? "0" : "-1"}" class="wf-tab${active ? " is-active" : ""}${opt.suggested ? " is-suggested" : ""}"><span class="wf-tab-letter">${opt.letter}</span><span class="wf-tab-title">${label}</span>${flag}</button>`;
  }).join("");
  const panels = options.map((opt, i) => panelHtml(opt, i, i === activeIndex)).join("\n");
  const intro = input.intro ? `<p class="wf-intro">${escapeHtml(input.intro)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${styles(theme)}</style>
</head>
<body>
<main class="wf-options">
<header class="wf-head"><h1>${escapeHtml(title)}</h1>${intro}</header>
<div class="wf-tabs" role="tablist" aria-label="Wireframe options">${tabs}</div>
<div class="wf-panels">
${panels}
</div>
<p class="wf-foot">${options.length} option${options.length === 1 ? "" : "s"} \xB7 self-contained \u2014 no network, no scripts beyond tab switching.</p>
</main>
<script>${TABS_SCRIPT}</script>
</body>
</html>
`;
}

// src/cli.ts
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h" || token === "--help") args.help = true;
    else if (token === "--check") args.check = true;
    else if (token === "--strict") args.strict = true;
    else if (token === "--stdout") args.stdout = true;
    else if (token === "--html") args.html = true;
    else if (token === "--in") args.in = argv[++i];
    else if (token === "--out") args.out = argv[++i];
    else if (token === "--theme") args.theme = argv[++i];
    else if (token === "--title") args.title = argv[++i];
    else if (token === "--intro") args.intro = argv[++i];
    else if (token.startsWith("--in=")) args.in = token.slice(5);
    else if (token.startsWith("--out=")) args.out = token.slice(6);
    else if (token.startsWith("--theme=")) args.theme = token.slice(8);
    else if (token.startsWith("--title=")) args.title = token.slice(8);
    else if (token.startsWith("--intro=")) args.intro = token.slice(8);
    else if (!token.startsWith("-") && !args.in) args.in = token;
  }
  return args;
}
var USAGE = [
  "Render or check a wireframe DSL block \u2014 offline, self-contained.",
  "",
  "Usage:",
  "  wireframe-render <input> --out <file.svg>  [--theme <theme.json>]",
  "  wireframe-render <input> --html --out <file.html> [--title <t>] [--intro <t>]",
  "  wireframe-render <input> --check           [--theme <theme.json>]",
  "",
  "  <input>    a file with one or more ```wireframe fenced blocks, or a raw",
  "             DSL body (the whole file is treated as one block if unfenced)",
  "  --out      where to write the SVG. With multiple blocks, block 1 \u2192 <out>,",
  "             block 2 \u2192 <out>.2.svg, etc. Omit and pass --stdout to print.",
  "  --html     aggregate every block into ONE self-contained HTML page that",
  "             shows them as lettered, tabbed options with each SVG embedded.",
  "             Per-option title/best-when/risk/suggested ride in leading `#`",
  "             comments of each block (e.g. `# option: \u2026`, `# suggested`).",
  '  --title    page title for --html (default: "Wireframe options")',
  "  --intro    optional lede paragraph under the --html title",
  "  --check    parse + lint every block, write nothing. Exit 1 on a parse error.",
  "  --strict   with --out: treat lint/dropped-key warnings as fatal \u2014 the block",
  "             is not written and the exit code is 1. One call = check + render.",
  "  --stdout   write the rendered SVG to stdout instead of a file (one block)",
  "  --theme    optional wireframe-theme.json (partial overrides merge into the",
  "             built-in theme; invalid files fall back to the default)"
].join("\n");
function blocksFrom(source) {
  const fenced = extractWireframeBlocks(source);
  return fenced.length > 0 ? fenced : [{ line: 1, content: source }];
}
function loadTheme(themePath) {
  if (!themePath) return DEFAULT_WIREFRAME_THEME;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(themePath, "utf8"));
  } catch {
    process.stderr.write(`warning: could not read --theme ${themePath}; using the default theme
`);
    return DEFAULT_WIREFRAME_THEME;
  }
  const validated = validateWireframeOverride(parsed);
  if (!validated.ok) {
    process.stderr.write(`warning: invalid theme (${validated.error}); using the default theme
`);
    return DEFAULT_WIREFRAME_THEME;
  }
  return mergeWireframeTheme(DEFAULT_WIREFRAME_THEME, validated.value);
}
function outPathFor(out, index) {
  if (index === 0) return out;
  const ext = path.extname(out);
  const stem = ext ? out.slice(0, -ext.length) : out;
  return `${stem}.${index + 1}${ext || ".svg"}`;
}
function runCheck(source) {
  const blocks = blocksFrom(source);
  let failed = 0;
  blocks.forEach(({ line, content }, index) => {
    const label = blocks.length > 1 ? `block ${index + 1} (line ${line})` : "wireframe";
    const parsed = parseWireframe(content);
    if (!parsed.ok) {
      failed += 1;
      process.stderr.write(`error: ${label} did not parse: ${parsed.error}
`);
      return;
    }
    for (const message of parsed.dropped ?? []) {
      process.stderr.write(`warning: ${label}: dropped \u2014 ${message}
`);
    }
    for (const lint of lintWireframe(parsed.wireframe)) {
      process.stderr.write(`${lint.severity}: ${label}: ${lint.message}
`);
    }
    process.stdout.write(`ok: ${label} parsed
`);
  });
  return failed > 0 ? 1 : 0;
}
function runRender(source, args) {
  const theme = loadTheme(args.theme);
  const blocks = blocksFrom(source);
  if (args.stdout) {
    const parsed = parseWireframe(blocks[0].content);
    if (!parsed.ok) {
      process.stderr.write(`error: wireframe did not parse: ${parsed.error}
`);
      return 1;
    }
    process.stdout.write(renderWireframeSvg(parsed.wireframe, theme));
    return 0;
  }
  if (!args.out) {
    process.stderr.write("error: pass --out <file.svg> (or --stdout, or --check)\n");
    return 2;
  }
  let failed = 0;
  blocks.forEach(({ line, content }, index) => {
    const label = blocks.length > 1 ? `block ${index + 1} (line ${line})` : "wireframe";
    const parsed = parseWireframe(content);
    if (!parsed.ok) {
      failed += 1;
      process.stderr.write(`error: ${label} did not parse: ${parsed.error}
`);
      return;
    }
    let warningCount = 0;
    for (const message of parsed.dropped ?? []) {
      warningCount += 1;
      process.stderr.write(`warning: ${label}: dropped \u2014 ${message}
`);
    }
    for (const lint of lintWireframe(parsed.wireframe)) {
      warningCount += 1;
      process.stderr.write(`${lint.severity}: ${label}: ${lint.message}
`);
    }
    if (args.strict && warningCount > 0) {
      failed += 1;
      process.stderr.write(
        `error: ${label}: ${warningCount} warning(s) above \u2014 not written (--strict)
`
      );
      return;
    }
    const target = outPathFor(args.out, index);
    try {
      writeFileSync(target, renderWireframeSvg(parsed.wireframe, theme), "utf8");
    } catch (error) {
      failed += 1;
      process.stderr.write(`error: cannot write ${target}: ${String(error)}
`);
      return;
    }
    process.stdout.write(`wrote ${target}
`);
  });
  return failed > 0 ? 1 : 0;
}
function runHtml(source, args) {
  if (!args.out) {
    process.stderr.write("error: --html needs --out <file.html>\n");
    return 2;
  }
  const theme = loadTheme(args.theme);
  const blocks = blocksFrom(source);
  const options = [];
  let failed = 0;
  blocks.forEach(({ line, content }, index) => {
    const label = blocks.length > 1 ? `block ${index + 1} (line ${line})` : "wireframe";
    const parsed = parseWireframe(content);
    if (!parsed.ok) {
      failed += 1;
      process.stderr.write(`error: ${label} did not parse: ${parsed.error}
`);
      return;
    }
    const meta = parseOptionMeta(content);
    const warnings = lintWireframe(parsed.wireframe).map((lint) => {
      process.stderr.write(`${lint.severity}: ${label}: ${lint.message}
`);
      return { severity: lint.severity, message: lint.message };
    });
    options.push({
      letter: optionLetter(options.length),
      title: meta.title,
      bestWhen: meta.bestWhen,
      risk: meta.risk,
      suggested: meta.suggested,
      svg: renderWireframeSvg(parsed.wireframe, theme),
      warnings
    });
  });
  if (options.length === 0) {
    process.stderr.write("error: no wireframe blocks rendered; nothing to write\n");
    return 1;
  }
  const html = renderOptionsHtml(options, theme, { title: args.title, intro: args.intro });
  try {
    writeFileSync(args.out, html, "utf8");
  } catch (error) {
    process.stderr.write(`error: cannot write ${args.out}: ${String(error)}
`);
    return 1;
  }
  process.stdout.write(`wrote ${args.out} (${options.length} option${options.length === 1 ? "" : "s"})
`);
  return failed > 0 ? 1 : 0;
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.in) {
    process.stdout.write(`${USAGE}
`);
    return args.help ? 0 : 2;
  }
  let source;
  try {
    source = readFileSync(args.in, "utf8");
  } catch (error) {
    process.stderr.write(`error: cannot read ${args.in}: ${String(error)}
`);
    return 1;
  }
  if (args.check) return runCheck(source);
  if (args.html) return runHtml(source, args);
  return runRender(source, args);
}
process.exit(main());
