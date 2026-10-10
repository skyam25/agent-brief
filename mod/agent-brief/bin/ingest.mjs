// Built by `pnpm build:mod` from extension/tools/ingest. Do not edit.

// tools/ingest/ingest.ts
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/esm/index.mjs
import { createRequire } from "module";
var require2 = createRequire("/");
var _a;
var Worker;
var isMarkedAsUntransferable;
try {
  _a = require2("worker_threads"), Worker = _a.Worker, isMarkedAsUntransferable = _a.isMarkedAsUntransferable;
} catch (e) {
}
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i2 = 0; i2 < 31; ++i2) {
    b[i2] = start += 1 << eb[i2 - 1];
  }
  var r = new i32(b[30]);
  for (var i2 = 1; i2 < 30; ++i2) {
    for (var j = b[i2]; j < b[i2 + 1]; ++j) {
      r[j] = j - b[i2] << 5 | i2;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i2 = 0;
  var l = new u16(mb);
  for (; i2 < s; ++i2) {
    if (cd[i2])
      ++l[cd[i2] - 1];
  }
  var le = new u16(mb);
  for (i2 = 1; i2 < mb; ++i2) {
    le[i2] = le[i2 - 1] + l[i2 - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        var sv = i2 << 4 | cd[i2];
        var r_1 = mb - cd[i2];
        var v = le[cd[i2] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        co[i2] = rev[le[cd[i2] - 1]++] >> 15 - cd[i2];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i2 = 1; i2 < a.length; ++i2) {
    if (a[i2] > m)
      m = a[i2];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i2 = 0; i2 < hcLen; ++i2) {
          clt[clim[i2]] = bits(dat, pos + i2 * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i2 = 0; i2 < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i2++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i2 - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i2++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i2 = sym - 257, b = fleb[i2];
          add = bits(dat, pos, (1 << b) - 1) + fl[i2];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var b2 = function(d, b) {
  return d[b] | d[b + 1] << 8;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var b8 = function(d, b) {
  return b4(d, b) + b4(d, b + 4) * 4294967296;
};
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
var dutf8 = function(d) {
  for (var r = "", i2 = 0; ; ) {
    var c = d[i2++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i2 + eb > d.length)
      return { s: r, r: slc(d, i2 - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i2++] & 63) << 12 | (d[i2++] & 63) << 6 | d[i2++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i2++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i2++] & 63) << 6 | d[i2++] & 63);
  }
};
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i2 = 0; i2 < dat.length; i2 += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i2, i2 + 16384));
    return r;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
    if (r.length)
      err(8);
    return s;
  }
}
var slzh = function(d, b) {
  return b + 30 + b2(d, b + 26) + b2(d, b + 28);
};
var zh = function(d, b, z) {
  var fnl = b2(d, b + 28), efl = b2(d, b + 30), fn = strFromU8(d.subarray(b + 46, b + 46 + fnl), !(b2(d, b + 8) & 2048)), es = b + 46 + fnl;
  var _a2 = z64hs(d, es, efl, z, b4(d, b + 20), b4(d, b + 24), b4(d, b + 42)), sc = _a2[0], su = _a2[1], off = _a2[2];
  return [b2(d, b + 10), sc, su, fn, es + efl + b2(d, b + 32), off];
};
var z64hs = function(d, b, l, z, sc, su, off) {
  var nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e = b + l;
  var nf = nsc + nsu + noff;
  if (z && nf) {
    for (; b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) == 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * nsu) : sc,
          nsu ? b8(d, b + 4) : su,
          noff ? b8(d, b + 4 + 8 * (nsu + nsc)) : off,
          1
        ];
      }
    }
    if (z < 2)
      err(13);
  }
  return [sc, su, off, 0];
};
function unzipSync(data, opts) {
  var files = {};
  var e = data.length - 22;
  for (; b4(data, e) != 101010256; --e) {
    if (!e || data.length - e > 65558)
      err(13);
  }
  ;
  var c = b2(data, e + 8);
  if (!c)
    return {};
  var o = b4(data, e + 16);
  var z = b4(data, e - 20) == 117853008;
  if (z) {
    var ze = b4(data, e - 12);
    z = b4(data, ze) == 101075792;
    if (z) {
      c = b4(data, ze + 32);
      o = b4(data, ze + 48);
    }
  }
  var fltr = opts && opts.filter;
  for (var i2 = 0; i2 < c; ++i2) {
    var _a2 = zh(data, o, z), c_2 = _a2[0], sc = _a2[1], su = _a2[2], fn = _a2[3], no = _a2[4], off = _a2[5], b = slzh(data, off);
    o = no;
    if (!fltr || fltr({
      name: fn,
      size: sc,
      originalSize: su,
      compression: c_2
    })) {
      if (!c_2)
        files[fn] = slc(data, b, b + sc);
      else if (c_2 == 8)
        files[fn] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
      else
        err(14, "unknown compression type " + c_2);
    }
  }
  return files;
}

// lib/export/anchor.ts
var BLOB_TEXT_LEN = 80;
function textOrLabel(d) {
  if (d.text && d.text.length >= BLOB_TEXT_LEN && d.label) return d.label;
  return d.text;
}
function pointedName(d) {
  return d.label || d.ariaLabel || d.name || textOrLabel(d) || d.selector;
}
function pointedPhrase(d, q) {
  const board = d.artboard ? d.artboard.title || d.artboard.file : void 0;
  if (board && d.tag === "artboard") {
    return `artboard ${q(board)}${d.local ? ` at (${d.local.x},${d.local.y})` : ""}`;
  }
  const noun = d.role || d.tag;
  const label = pointedName(d);
  const base = label ? `${noun} ${q(label)}` : noun;
  return board ? `${base} in artboard ${q(board)}` : base;
}
function briefEventLabel(e) {
  switch (e.type) {
    case "click": {
      const d = e.payload.descriptor;
      const label = textOrLabel(d) || d.ariaLabel || d.name || d.selector || d.tag;
      return label ? `clicking ${quote(label)}` : "clicking";
    }
    case "input": {
      const d = e.payload.descriptor;
      const name = d.ariaLabel || d.name || textOrLabel(d) || d.selector;
      return name ? `typing in ${quote(name)}` : "typing";
    }
    case "pointer": {
      const d = e.payload.descriptor;
      if (!d) return `pointing at (${e.payload.x},${e.payload.y}) on the canvas`;
      return `pointing at ${pointedPhrase(d, quote)}`;
    }
    case "pick": {
      const d = e.payload.descriptor;
      if (!d) return `pointing at (${e.payload.x},${e.payload.y})`;
      return `pointing at ${pointedPhrase(d, quote)}`;
    }
    case "text-select": {
      if (e.payload.cleared || !e.payload.text) return void 0;
      return `with ${quote(e.payload.text)} selected`;
    }
    case "selection": {
      const { kind, name, nodeId } = e.payload;
      const subject = [kind, name ? quote(name) : void 0].filter(Boolean).join(" ");
      if (subject) return `with ${subject} selected`;
      return nodeId ? `with node ${nodeId} selected` : void 0;
    }
    case "nav":
    case "spa-route":
      return `on ${pathOf(e.payload.url)}`;
    case "error":
      return `as an error fired (${clip(e.payload.message, 48)})`;
    case "net-request": {
      const p = e.payload;
      if (p.failed || typeof p.status === "number" && p.status >= 400) {
        return `as ${p.status ?? "a failed"} ${p.method} ${pathOf(p.url)} returned`;
      }
      return void 0;
    }
    case "annotation": {
      const target = e.payload.shapes.find((s) => s.targetDescriptor)?.targetDescriptor;
      return target ? `annotating ${pointedPhrase(target, quote)}` : "annotating";
    }
    case "file-captured":
    case "file-attached":
      return `around the file ${quote(e.payload.fileName)}`;
    default:
      return void 0;
  }
}
var PRIORITY = {
  error: 6,
  annotation: 5,
  pick: 5,
  click: 4,
  selection: 4,
  "text-select": 3,
  "net-request": 3,
  nav: 3,
  "spa-route": 3,
  "file-captured": 2,
  "file-attached": 2,
  pointer: 2,
  input: 1
};
var WINDOW_MS = 1500;
var WIDE_WINDOW_MS = 3e3;
var WIDE_WINDOW_TYPES = /* @__PURE__ */ new Set([
  "pointer",
  "pick",
  "selection"
]);
function anchorPhrase(label) {
  return /^[a-z]{2,}ing\b/i.test(label) ? `while ${label}` : label;
}
function annotationSpans(events) {
  const spans = [];
  let open;
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.type === "annotation-start") open = e.t;
    else if (e.type === "annotation" && open !== void 0) {
      spans.push({ start: open, end: e.t, event: e });
      open = void 0;
    }
  }
  return spans;
}
function spanAnchor(v, spans) {
  let best;
  for (const span of spans) {
    const overlap = Math.min(v.payload.tEnd, span.end) - Math.max(v.payload.tStart, span.start);
    if (overlap < 0) continue;
    if (!best || overlap > best.overlap) best = { overlap, span };
  }
  const label = best ? briefEventLabel(best.span.event) : void 0;
  return best && label ? { event: best.span.event, label } : void 0;
}
function buildAnchors(events) {
  const out = /* @__PURE__ */ new Map();
  const spans = annotationSpans(events);
  for (const v of events) {
    if (v.type !== "voice-segment") continue;
    const drawn = spanAnchor(v, spans);
    if (drawn) {
      out.set(v.id, drawn);
      continue;
    }
    let best;
    for (const e of events) {
      if (e.type === "voice-segment") continue;
      const win = WIDE_WINDOW_TYPES.has(e.type) ? WIDE_WINDOW_MS : WINDOW_MS;
      if (e.t < v.payload.tStart - win || e.t > v.payload.tEnd + win) continue;
      const pr = PRIORITY[e.type] ?? 0;
      if (pr === 0) continue;
      const label = briefEventLabel(e);
      if (!label) continue;
      const dist = Math.abs(e.t - v.payload.tStart);
      if (!best || pr > best.pr || pr === best.pr && dist < best.dist) {
        best = { pr, dist, anchor: { event: e, label } };
      }
    }
    if (best) out.set(v.id, best.anchor);
  }
  return out;
}
function buildAnchorMap(events) {
  const out = /* @__PURE__ */ new Map();
  for (const [id, a] of buildAnchors(events)) out.set(id, a.label);
  return out;
}
function buildAnchorSources(events) {
  const out = /* @__PURE__ */ new Map();
  for (const [id, a] of buildAnchors(events)) out.set(id, a.event.id);
  return out;
}
function pathOf(url) {
  try {
    return new URL(url).pathname || "/";
  } catch {
    const q = url.indexOf("?");
    return q >= 0 ? url.slice(0, q) : url;
  }
}
function quote(s) {
  const t = clip(s, 40);
  return `"${t}"`;
}
function clip(s, n) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}\u2026` : t;
}

// lib/export/markdown.ts
function formatClock(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1e3));
  const seconds = totalSec % 60;
  const minutes = Math.floor(totalSec / 60);
  const ss = String(seconds).padStart(2, "0");
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mm = String(minutes % 60).padStart(2, "0");
    return `${hours}:${mm}:${ss}`;
  }
  return `${String(minutes).padStart(2, "0")}:${ss}`;
}
function renderReport(input) {
  const events = sortedEvents(input.events);
  const lines = [];
  const anchors = buildAnchorMap(events);
  renderHeader(input, events, lines);
  lines.push("");
  lines.push("## Timeline");
  lines.push("");
  let i2 = 0;
  while (i2 < events.length) {
    const e = events[i2];
    if (e.type === "voice-segment") {
      let j = i2;
      const run2 = [];
      const anchor = anchors.get(e.id);
      while (j < events.length && events[j].type === "voice-segment" && !isClip(events[j]) && anchors.get(events[j].id) === anchor) {
        run2.push(events[j]);
        j += 1;
      }
      if (run2.length >= 2) renderVoiceGroup(run2, lines, anchor);
      else if (isClip(e)) renderClip(e, events, input, lines, anchor);
      else renderEvent(e, input, lines, anchors);
      i2 = Math.max(j, i2 + 1);
    } else {
      renderEvent(e, input, lines, anchors);
      i2 += 1;
    }
  }
  renderAppendices(events, input, lines);
  return normalize(lines);
}
var CLOCK_NOTE = "Every time is from session start. The offset into an audio clip is the report time minus the clip's start, so `+3.1s` under a clip is 3.1 s into its file.";
function renderHeader(input, events, lines) {
  const { session } = input;
  lines.push(`# Session Report: ${escapeInline(session.name)}`);
  lines.push("");
  const appUrls = collectAppUrls(session);
  const lastT = events.length > 0 ? events[events.length - 1].t : 0;
  const durationMs = session.endedAt != null ? session.endedAt - session.startedAt : lastT;
  lines.push(`- **App:** ${appUrls.length > 0 ? appUrls.join(", ") : "(none)"}`);
  lines.push(`- **Date:** ${new Date(session.startedAt).toISOString()}`);
  lines.push(`- **Duration:** ${formatClock(durationMs)}`);
  lines.push(
    `- **Clock:** ${CLOCK_NOTE}`
  );
  lines.push(`- **Verbosity level:** ${input.level}`);
  lines.push(`- **Events:** ${events.length}`);
  if (input.openapi) {
    lines.push(
      `- **API spec:** \`${input.openapi.path}\` (${input.openapi.endpointCount} endpoint(s) compiled from captured requests)`
    );
  }
  lines.push("");
  lines.push("### Tabs");
  lines.push("");
  if (session.tabs.length === 0) {
    lines.push("_No tabs recorded._");
  } else {
    lines.push("| Tab | Role | URL | Title |");
    lines.push("| --- | --- | --- | --- |");
    for (const tab of session.tabs) {
      lines.push(
        `| ${tab.tabId} | ${tab.role} | ${escapeCell(tab.url)} | ${escapeCell(
          tab.title
        )} |`
      );
    }
  }
}
function isClip(e) {
  const t = e.payload.transcript;
  return t == null || t.trim().length === 0 && e.payload.assetId !== void 0;
}
var CLIP_SIGNAL_TYPES = /* @__PURE__ */ new Set([
  "pick",
  "annotation",
  "selection",
  "click",
  "note",
  "marker"
]);
function signalText(e) {
  switch (e.type) {
    case "pick":
      return pickText(e, "");
    case "click":
      return clickText(e, "");
    case "selection":
      return selectionText(e, "");
    case "annotation":
      return `\u270F\uFE0F ANNOTATION ${e.payload.shapes.map(describeShape).join("; ") || "(no shapes)"}`;
    case "note":
      return `\u{1F4DD} NOTE ${quoteLabel(clipText(e.payload.text, 120))}`;
    case "marker":
      return `\u{1F4CC} MARKER ${quoteLabel(e.payload.name)}`;
    default:
      return void 0;
  }
}
function renderClip(e, events, input, lines, anchor) {
  const p = e.payload;
  const span = `[${formatClock(p.tStart)}\u2013${formatClock(p.tEnd)}]`;
  const path = p.assetId ? input.assetPath(p.assetId) : void 0;
  const file = path ?? "(audio not included)";
  const status = p.transcriptionError ? `transcription failed: ${oneLine(p.transcriptionError)}` : p.transcript == null ? "untranscribed" : "no speech";
  const where = anchor ? ` _(${escapeInline(anchorPhrase(anchor))})_` : "";
  lines.push(`> \u{1F399}\uFE0F ${span}${where} ${escapeInline(file)} (${escapeInline(status)})`);
  for (const s of events) {
    if (!CLIP_SIGNAL_TYPES.has(s.type) || s.t < p.tStart || s.t > p.tEnd) continue;
    const text = signalText(s);
    if (!text) continue;
    const offset = ((s.t - p.tStart) / 1e3).toFixed(1);
    lines.push(`> - +${offset}s ${escapeInline(text)}`);
  }
}
function clickText(e, tab) {
  const d = e.payload.descriptor;
  const mods = e.payload.modifiers.length > 0 ? ` +${e.payload.modifiers.join("+")}` : "";
  return `CLICK ${quoteLabel(labelOf(d))} (${selectorOf(d)}${tab})${mods}`;
}
function pickText(e, tab) {
  const d = e.payload.descriptor;
  if (!d) return `\u{1F449} POINTED AT (${e.payload.x},${e.payload.y})${tab ? ` (${tab.slice(2)})` : ""}`;
  return `\u{1F449} POINTED AT ${pointedPhrase(d, quoteLabel)} (${selectorOf(d)}${tab})`;
}
function selectionText(e, tab) {
  const { kind, name, nodeId, path } = e.payload;
  const parts = [
    kind,
    name ? quoteLabel(name) : void 0,
    // A Claude Design address prints as is; other apps' ids read as nodes.
    nodeId ? nodeId.includes("#") ? `(${nodeId})` : `(node ${nodeId})` : void 0,
    path ? `[${path}]` : void 0
  ].filter(Boolean);
  return `SELECTED ${parts.length ? parts.join(" ") : "object"}${tab ? ` (${tab.slice(2)})` : ""}`;
}
function clipText(s, n) {
  const t = oneLine(s);
  return t.length > n ? `${t.slice(0, n - 1)}\u2026` : t;
}
function renderVoiceGroup(run2, lines, anchor) {
  const first = run2[0];
  const last = run2[run2.length - 1];
  const text = run2.map((e) => e.payload.transcript).filter((t) => t != null && t.trim().length > 0).join(" ").replace(/\s+/g, " ").trim();
  const start = first.payload.tStart ?? first.t;
  const end = last.payload.tEnd ?? last.t;
  const span = `${formatClock(start)}\u2013${formatClock(end)} \xB7 ${formatDuration(
    Math.max(0, end - start)
  )}`;
  const body = text.length > 0 ? escapeInline(text) : "(no transcript)";
  const where = anchor ? ` _(${escapeInline(anchorPhrase(anchor))})_` : "";
  lines.push(`> \u{1F399}\uFE0F [${formatClock(start)}]${where} ${body} _(${span})_`);
}
function formatDuration(ms) {
  const s = Math.round(ms / 1e3);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}
function renderEvent(e, input, lines, anchors) {
  const clock = `[${formatClock(e.t)}]`;
  const tab = tabSuffix(e.tabId);
  switch (e.type) {
    // --- interactions: one-liners ------------------------------------------
    case "click": {
      lines.push(`${clock} ${clickText(e, tab)}`);
      break;
    }
    case "input": {
      const d = e.payload.descriptor;
      const value = e.payload.redacted ? "\xABredacted\xBB" : oneLine(e.payload.value);
      lines.push(
        `${clock} INPUT ${quoteLabel(value)} into (${selectorOf(d)}${tab})`
      );
      break;
    }
    case "key": {
      const where = e.payload.descriptor ? ` (${selectorOf(e.payload.descriptor)}${tab})` : tab ? ` (${tab.slice(2)})` : "";
      const mods = e.payload.modifiers.length > 0 ? `${e.payload.modifiers.join("+")}+` : "";
      lines.push(`${clock} KEY ${mods}${e.payload.key}${where}`);
      break;
    }
    case "hover": {
      const d = e.payload.descriptor;
      const noun = d.role || d.tag || "element";
      const lbl = labelOf(d);
      const dwell = e.payload.dwellMs ? ` for ${(e.payload.dwellMs / 1e3).toFixed(1)}s` : "";
      lines.push(
        `${clock} HOVER ${noun}${lbl ? ` ${quoteLabel(lbl)}` : ""} (${selectorOf(d)}${tab})${dwell}`
      );
      break;
    }
    case "pointer": {
      const d = e.payload.descriptor;
      if (!d) {
        lines.push(`${clock} POINT (${e.payload.x},${e.payload.y})`);
        break;
      }
      lines.push(`${clock} POINT ${pointedPhrase(d, quoteLabel)} (${selectorOf(d)}${tab})`);
      break;
    }
    case "pick": {
      lines.push(`${clock} ${pickText(e, tab)}`);
      break;
    }
    case "text-select": {
      if (e.payload.cleared) {
        lines.push(`${clock} SELECT cleared${tab ? ` (${tab.slice(2)})` : ""}`);
        break;
      }
      const d = e.payload.descriptor;
      const text = (e.payload.text ?? "") + (e.payload.truncated ? "\u2026" : "");
      lines.push(
        `${clock} SELECT ${quoteLabel(text)}${d ? ` (${selectorOf(d)}${tab})` : ""}`
      );
      break;
    }
    case "selection": {
      lines.push(`${clock} ${selectionText(e, tab)}`);
      break;
    }
    case "scroll": {
      lines.push(`${clock} ${scrollLine(e.payload, e.tabId)}`);
      break;
    }
    // --- navigation / tabs: section breaks ---------------------------------
    case "nav": {
      lines.push("");
      lines.push(
        `## ${clock} NAV ${escapeInline(e.payload.url)}${titlePart(e.payload.title)}`
      );
      lines.push("");
      break;
    }
    case "spa-route": {
      lines.push("");
      lines.push(
        `## ${clock} ROUTE (${e.payload.method}) ${escapeInline(
          e.payload.url
        )}${titlePart(e.payload.title)}`
      );
      lines.push("");
      break;
    }
    case "tab-switch": {
      lines.push("");
      lines.push(
        `## ${clock} TAB SWITCH \u2192 tab ${e.payload.toTabId}${e.payload.toUrl ? ` ${escapeInline(e.payload.toUrl)}` : ""}${titlePart(e.payload.toTitle)}`
      );
      lines.push("");
      break;
    }
    case "tab-opened": {
      lines.push("");
      lines.push(
        `## ${clock} TAB OPENED${e.payload.url ? ` ${escapeInline(e.payload.url)}` : ""}${titlePart(e.payload.title)}`
      );
      lines.push("");
      break;
    }
    case "tab-closed": {
      lines.push("");
      lines.push(
        `## ${clock} TAB CLOSED${e.payload.url ? ` ${escapeInline(e.payload.url)}` : ""}${titlePart(e.payload.title)}`
      );
      lines.push("");
      break;
    }
    // --- network -----------------------------------------------------------
    case "net-request": {
      renderNetRequest(e, input, lines);
      break;
    }
    // --- console / error ---------------------------------------------------
    case "console": {
      const p = e.payload;
      const repeat = p.repeat && p.repeat > 1 ? ` (\xD7${p.repeat})` : "";
      const src = p.source ? ` @ ${p.source}` : "";
      lines.push(`${clock} console.${p.level}${repeat}${src}`);
      lines.push("```");
      lines.push(p.text);
      lines.push("```");
      break;
    }
    case "error": {
      const p = e.payload;
      const repeat = p.repeat && p.repeat > 1 ? ` (\xD7${p.repeat})` : "";
      lines.push("");
      lines.push(`\u26A0 **ERROR ${clock}**${repeat} (${p.origin}) ${oneLine(p.message)}`);
      if (p.stack) {
        lines.push("```");
        lines.push(p.stack);
        lines.push("```");
      }
      lines.push("");
      break;
    }
    // --- visual ------------------------------------------------------------
    case "screenshot": {
      const path = input.assetPath(e.payload.assetId);
      if (!path) break;
      const ctx = e.payload.contextText ? oneLine(e.payload.contextText) : `screenshot (${e.payload.trigger})`;
      lines.push(`${clock} \u{1F4F7} ${escapeInline(ctx)}`);
      lines.push(`![${escapeInline(ctx)}](${path})`);
      break;
    }
    case "annotation-start": {
      break;
    }
    case "annotation": {
      renderAnnotation(e, input, lines);
      break;
    }
    // --- voice -------------------------------------------------------------
    case "voice-segment": {
      const p = e.payload;
      const text = p.transcript != null && p.transcript.trim().length > 0 ? oneLine(p.transcript) : p.transcriptionError ? `(transcription failed: ${oneLine(p.transcriptionError)})` : "(no transcript)";
      const anchor = anchors?.get(e.id);
      const where = anchor ? ` _(${escapeInline(anchorPhrase(anchor))})_` : "";
      lines.push(`> \u{1F399}\uFE0F ${clock}${where} ${escapeInline(text)}`);
      break;
    }
    // --- video -------------------------------------------------------------
    case "video-segment": {
      const p = e.payload;
      const span = `${formatClock(p.tStart)}\u2013${formatClock(p.tEnd)}`;
      const path = p.assetId ? input.assetPath(p.assetId) : void 0;
      const link = path ? ` \u2192 \`${path}\`` : "";
      const note = p.note ? ` \u2014 ${escapeInline(oneLine(p.note))}` : "";
      lines.push(`${clock} \u{1F3AC} VIDEO segment ${span}${link}${note}`);
      break;
    }
    // --- files -------------------------------------------------------------
    case "file-captured":
    case "file-attached": {
      const p = e.payload;
      const verb = e.type === "file-attached" ? "ATTACHED" : "CAPTURED";
      const ctx = p.contextText ? ` \u2014 ${oneLine(p.contextText)}` : "";
      const meta = p.metadataOnly ? ", metadata-only" : "";
      const path = p.assetId ? input.assetPath(p.assetId) : void 0;
      const link = path ? ` \u2192 \`${path}\`` : "";
      lines.push(
        `${clock} \u{1F4CE} FILE ${verb} "${escapeInline(p.fileName)}" (${p.mime}, ${humanBytes(
          p.size
        )}${meta})${ctx}${link}`
      );
      break;
    }
    // --- user signals ------------------------------------------------------
    case "marker": {
      lines.push("");
      lines.push(`> ## \u{1F4CC} MARKER ${clock}: ${escapeInline(e.payload.name)}`);
      lines.push("");
      break;
    }
    case "note": {
      lines.push("");
      lines.push(`> ## \u{1F4DD} NOTE ${clock}`);
      for (const ln of e.payload.text.split("\n")) lines.push(`> ${ln}`);
      lines.push("");
      break;
    }
    case "session-note": {
      lines.push(`> \u2139\uFE0F ${clock} (${e.payload.kind}) ${escapeInline(e.payload.text)}`);
      break;
    }
    default:
      assertNever(e);
  }
}
function scrollLine(p, tabId) {
  const where = p.container ?? "window";
  const tab = tabSuffix(tabId);
  if (!p.landmark && !p.inView?.length && p.percent === void 0) {
    return `SCROLL (${p.from.x},${p.from.y}) \u2192 (${p.to.x},${p.to.y}) [${where}${tab}]`;
  }
  const dir = p.direction ? `${p.direction} ` : "";
  const axis = p.direction === "left" || p.direction === "right" ? "across" : "down";
  const scroller = where === "window" ? "" : `${where}${p.containerLabel ? ` ${quoteLabel(p.containerLabel)}` : ""}`;
  const parts = [];
  let head;
  if (p.landmark) {
    head = `SCROLL ${dir}to ${quoteLabel(p.landmark)}`;
    if (p.landmarkSelector) parts.push(p.landmarkSelector);
    if (p.section) parts.push(`in ${quoteLabel(p.section)}`);
    if (p.percent !== void 0) parts.push(`${p.percent}% ${axis}${scroller ? ` ${scroller}` : ""}`);
    else if (scroller) parts.push(scroller);
  } else {
    head = p.percent !== void 0 ? `SCROLL ${dir}to ${p.percent}%` : `SCROLL ${dir}`.trimEnd();
    if (scroller) parts.push(scroller);
  }
  if (tab) parts.push(tab.slice(2));
  const paren = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const seen = p.inView?.length ? ` \xB7 in view: ${p.inView.map(quoteLabel).join(", ")}` : "";
  return `${head}${paren}${seen}`;
}
function renderNetRequest(e, input, lines) {
  const clock = `[${formatClock(e.t)}]`;
  const p = e.payload;
  const status = p.failed ? `FAILED${p.failureReason ? ` (${p.failureReason})` : ""}` : p.status != null ? String(p.status) : "\u2014";
  const path = urlPath(p.url);
  const ws = p.websocket ? " [ws]" : "";
  lines.push("");
  lines.push(`${clock} \u{1F310} ${status} ${p.method} ${escapeInline(path)}${ws}`);
  if (p.collapsed) {
    const statuses = p.collapsed.statuses.join(", ");
    const note = p.collapsed.note ? ` \u2014 ${p.collapsed.note}` : "";
    lines.push(
      `> (\xD7${p.collapsed.count} similar\u2026) statuses: ${statuses}${note}`
    );
    lines.push("");
    return;
  }
  if (p.bodyShape) {
    if (p.bodyShape.request) {
      lines.push(`- request shape: \`${oneLine(p.bodyShape.request)}\``);
    }
    if (p.bodyShape.response) {
      lines.push(`- response shape: \`${oneLine(p.bodyShape.response)}\``);
    }
    lines.push("");
    return;
  }
  if (p.websocket && p.wsFrames && p.wsFrames.length > 0) {
    lines.push("```");
    for (const f of p.wsFrames) {
      const arrow = f.dir === "sent" ? "\u2192" : "\u2190";
      const trunc = f.truncated ? " \u2026" : "";
      lines.push(`${arrow} [${formatClock(f.ts)}] ${oneLine(f.text ?? "")}${trunc}`);
    }
    lines.push("```");
    lines.push("");
    return;
  }
  renderBody("Request", p.requestBody, input, lines);
  renderBody("Response", p.responseBody, input, lines);
  lines.push("");
}
function renderBody(label, body, input, lines) {
  if (!body) return;
  if (!body.present) {
    lines.push(`- ${label}: _(body not captured)_`);
    return;
  }
  const notes = [];
  if (body.mime) notes.push(body.mime);
  if (body.base64) notes.push("base64");
  if (body.truncated) {
    notes.push(
      body.originalSize != null ? `truncated from ${humanBytes(body.originalSize)}` : "truncated"
    );
  }
  const assetLink = body.assetId ? input.assetPath(body.assetId) : void 0;
  if (assetLink) notes.push(`full body: \`${assetLink}\``);
  const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
  if (body.text == null || body.text.length === 0) {
    lines.push(`- ${label}${suffix}: _(empty)_`);
    return;
  }
  lines.push(`- ${label}${suffix}:`);
  lines.push("```" + fenceLang(body.mime));
  lines.push(body.text);
  lines.push("```");
}
function renderAnnotation(e, input, lines) {
  const clock = `[${formatClock(e.t)}]`;
  const p = e.payload;
  lines.push("");
  lines.push(`### ${clock} Annotation`);
  if (p.shapes.length === 0) {
    lines.push("- _(no shapes)_");
  } else {
    for (const shape of p.shapes) lines.push(`- ${describeShape(shape)}`);
  }
  const path = p.screenshotAssetId ? input.assetPath(p.screenshotAssetId) : void 0;
  if (path) lines.push(`![](${path})`);
  lines.push("");
}
function describeShape(shape) {
  const parts = [`**${shape.tool}**`];
  if (shape.text) parts.push(`"${oneLine(shape.text)}"`);
  const target = shape.targetDescriptor;
  if (target?.artboard && target.tag === "artboard") {
    const local = target.local ? `, local (${target.local.x},${target.local.y})` : "";
    parts.push(
      `on ${selectorOf(target)} (artboard ${quoteLabel(target.artboard.title || target.artboard.file)}${local})`
    );
  } else if (target) {
    const label = target.artboard ? target.label ?? labelOf(target) : labelOf(target);
    const board = target.artboard ? ` in artboard ${quoteLabel(target.artboard.title || target.artboard.file)}` : "";
    parts.push(
      `on ${selectorOf(target)}${label ? ` (${quoteLabel(label)})` : ""}${board}`
    );
  }
  const where = shapePosition(shape);
  if (where) parts.push(where);
  if (shape.color) parts.push(`\xB7 ${shape.color}`);
  return parts.join(" ");
}
function shapePosition(shape) {
  const at = (p) => `(${Math.round(p.x)},${Math.round(p.y)})`;
  switch (shape.tool) {
    case "arrow":
      return shape.to ? `at ${at(shape.to)}` : "";
    case "rect":
    case "ellipse":
    case "redact":
      return shape.rect ? `at ${at(shape.rect)} size ${Math.round(shape.rect.w)}\xD7${Math.round(shape.rect.h)}` : "";
    case "pen":
    case "highlighter":
      return shape.points?.[0] ? `from ${at(shape.points[0])}` : "";
    case "text":
      return shape.rect ? `at ${at(shape.rect)}` : "";
  }
}
function renderAppendices(events, input, lines) {
  const nets = events.filter(
    (e) => e.type === "net-request"
  );
  const consoles = events.filter(
    (e) => e.type === "console" || e.type === "error"
  );
  if (nets.length > 0) {
    lines.push("");
    lines.push("## Appendix: Network Index");
    lines.push("");
    for (const e of nets) {
      const p = e.payload;
      const status = p.failed ? "FAIL" : p.status != null ? String(p.status) : "\u2014";
      lines.push(
        `- [${formatClock(e.t)}] ${status} ${p.method} ${escapeInline(p.url)}`
      );
    }
  }
  if (consoles.length > 0) {
    lines.push("");
    lines.push("## Appendix: Console Dump");
    lines.push("");
    lines.push("```");
    for (const e of consoles) {
      const stamp = `[${formatClock(e.t)}]`;
      if (e.type === "error") {
        lines.push(`${stamp} ERROR (${e.payload.origin}) ${oneLine(e.payload.message)}`);
      } else {
        const repeat = e.payload.repeat && e.payload.repeat > 1 ? ` (\xD7${e.payload.repeat})` : "";
        lines.push(`${stamp} ${e.payload.level}${repeat}: ${oneLine(e.payload.text)}`);
      }
    }
    lines.push("```");
  }
}
function sortedEvents(events) {
  return [...events].sort((a, b) => a.t - b.t);
}
function collectAppUrls(session) {
  const origins = /* @__PURE__ */ new Set();
  const add = (url) => {
    if (!url) return;
    origins.add(originOf(url));
  };
  add(session.initialUrl);
  for (const tab of session.tabs) add(tab.url);
  return [...origins];
}
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
function urlPath(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
function selectorOf(d) {
  if (!d) return "?";
  if (d.selector) return d.selector;
  let s = d.tag || "?";
  if (d.id) s += `#${d.id}`;
  return s;
}
function labelOf(d) {
  if (!d) return "";
  return textOrLabel(d) ?? d.ariaLabel ?? d.name ?? "";
}
function quoteLabel(label) {
  return `"${escapeInline(oneLine(label))}"`;
}
function tabSuffix(tabId) {
  return tabId != null ? `, tab ${tabId}` : "";
}
function titlePart(title) {
  return title ? ` \u2014 ${escapeInline(oneLine(title))}` : "";
}
function fenceLang(mime) {
  if (!mime) return "";
  if (mime.includes("json")) return "json";
  if (mime.includes("html")) return "html";
  if (mime.includes("xml")) return "xml";
  if (mime.includes("javascript")) return "js";
  return "";
}
function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return `${n}`;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function oneLine(s) {
  return s.replace(/\s+/g, " ").trim();
}
function escapeInline(s) {
  return s.replace(/`/g, "\u02CB");
}
function escapeCell(s) {
  return oneLine(s).replace(/\|/g, "\\|").replace(/`/g, "\u02CB");
}
function normalize(lines) {
  const out = [];
  for (const line of lines) {
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}
function assertNever(x2) {
  throw new Error(`Unhandled event variant: ${JSON.stringify(x2)}`);
}

// tools/ingest/bundle-files.ts
var LEVELS = ["L0", "L1", "L2", "L3"];
function rootFolder(entryNames) {
  let root;
  for (const name of entryNames) {
    if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
      throw new Error(`unsafe zip entry: ${name}`);
    }
    const [head, ...rest] = name.split("/");
    if (!head || rest.length === 0) throw new Error(`zip entry outside a root folder: ${name}`);
    if (root === void 0) root = head;
    else if (root !== head) throw new Error(`zip has more than one root folder: ${root}, ${head}`);
  }
  if (root === void 0) throw new Error("zip is empty");
  return root;
}
function parseFeedbackFile(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("session.json is not valid JSON");
  }
  if (typeof json !== "object" || json === null) throw new Error("session.json is not an object");
  const o = json;
  if (typeof o.feedbackVersion !== "number") {
    throw new Error("session.json has no feedbackVersion; re-export with a current extension build");
  }
  if (typeof o.session !== "object" || o.session === null) throw new Error("session.json has no session");
  if (!Array.isArray(o.events)) throw new Error("session.json has no events array");
  const level = LEVELS.includes(o.level) ? o.level : "L1";
  return {
    feedbackVersion: o.feedbackVersion,
    level,
    session: o.session,
    events: o.events
  };
}
var IGNORE_LINE = ".feedback/";
function withFeedbackIgnored(current) {
  if (current === null) return `${IGNORE_LINE}
`;
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l === ".feedback" || l === ".feedback/" || l === "/.feedback" || l === "/.feedback/")) {
    return null;
  }
  const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  return `${current}${sep}${IGNORE_LINE}
`;
}

// lib/export/transcript-index.ts
function clipIdOf(id) {
  const m = /^(.*)\.\d+$/.exec(id);
  return m?.[1] ?? id;
}
function transcriptIndex(events, assetPath) {
  const voices = events.filter((e) => e.type === "voice-segment");
  const clipAsset = /* @__PURE__ */ new Map();
  for (const v of voices) if (v.payload.assetId) clipAsset.set(v.id, v.payload.assetId);
  return voices.map((v) => {
    const p = v.payload;
    const assetId = p.assetId ?? clipAsset.get(clipIdOf(v.id));
    const audio = assetId ? assetPath(assetId) : void 0;
    return {
      t: p.tStart,
      tEnd: p.tEnd,
      text: p.transcript,
      ...audio ? { audio, audioStart: p.clipStart ?? p.tStart } : {},
      ...p.words ? { words: p.words } : {},
      ...p.transcriptionError ? { error: p.transcriptionError } : {}
    };
  });
}

// tools/ingest/transcript.ts
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
var atMs = (chunkStartMs, seconds) => Math.round(chunkStartMs + seconds * 1e3);
function yapToUtterances(json, chunkStartMs) {
  if (!isRecord(json) || !Array.isArray(json.segments)) {
    throw new Error("yap output has no segments array");
  }
  const out = [];
  for (const seg of json.segments) {
    if (!isRecord(seg)) continue;
    const text = typeof seg.text === "string" ? seg.text.trim() : "";
    const start = num(seg.start);
    const end = num(seg.end);
    if (!text || start === void 0) continue;
    const words = [];
    if (Array.isArray(seg.words)) {
      for (const w of seg.words) {
        if (!isRecord(w)) continue;
        const word = typeof w.text === "string" ? w.text.trim() : "";
        const ws = num(w.start);
        if (word && ws !== void 0) words.push({ word, t: atMs(chunkStartMs, ws) });
      }
    }
    out.push({
      tStart: atMs(chunkStartMs, start),
      tEnd: atMs(chunkStartMs, end ?? start),
      text,
      words
    });
  }
  return out;
}
function whisperToUtterances(json, chunkStartMs) {
  if (!isRecord(json) || !Array.isArray(json.transcription)) {
    throw new Error("whisper output has no transcription array");
  }
  const out = [];
  for (const seg of json.transcription) {
    if (!isRecord(seg) || !isRecord(seg.offsets)) continue;
    const text = typeof seg.text === "string" ? seg.text.trim() : "";
    const from = num(seg.offsets.from);
    const to = num(seg.offsets.to);
    if (!text || from === void 0 || /^\[.*\]$/.test(text)) continue;
    out.push({
      tStart: Math.round(chunkStartMs + from),
      tEnd: Math.round(chunkStartMs + (to ?? from)),
      text,
      words: []
    });
  }
  return out;
}
function mergeTranscripts(events, byEventId) {
  const out = [];
  for (const e of events) {
    const result = e.type === "voice-segment" ? byEventId.get(e.id) : void 0;
    if (e.type !== "voice-segment" || !result) {
      out.push(e);
      continue;
    }
    if ("error" in result) {
      out.push(withPayload(e, e.id, {
        ...e.payload,
        transcript: null,
        transcriptionError: result.error,
        provider: result.provider
      }));
      continue;
    }
    if (result.utterances.length === 0) {
      out.push(withPayload(e, e.id, {
        ...e.payload,
        transcript: "",
        words: [],
        provider: result.provider
      }));
      continue;
    }
    result.utterances.forEach((u, i2) => {
      const { assetId: _assetId, transcriptionError: _err, ...rest } = e.payload;
      const payload = {
        ...rest,
        ...i2 === 0 && e.payload.assetId !== void 0 ? { assetId: e.payload.assetId } : {},
        tStart: u.tStart,
        tEnd: u.tEnd,
        transcript: u.text,
        words: u.words,
        provider: result.provider,
        clipStart: e.payload.tStart
      };
      out.push(withPayload(e, i2 === 0 ? e.id : `${e.id}.${i2 + 1}`, payload));
    });
  }
  return out.map((e, i2) => ({ e, i: i2 })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map(({ e }) => e);
}
function withPayload(e, id, payload) {
  return { ...e, id, t: payload.tStart, payload };
}
function prunePointers(events) {
  const anchors = new Set(buildAnchorSources(events).values());
  return events.filter((e) => e.type !== "pointer" || anchors.has(e.id));
}
function transcriptRows(events, assetPath = () => void 0) {
  return transcriptIndex(events, assetPath);
}
function countFeedback(events) {
  const counts = { annotations: 0, notes: 0, utterances: 0, markers: 0 };
  for (const e of events) {
    if (e.type === "annotation") counts.annotations += 1;
    else if (e.type === "note") counts.notes += 1;
    else if (e.type === "marker") counts.markers += 1;
    else if (e.type === "voice-segment" && e.payload.transcript?.trim()) counts.utterances += 1;
  }
  return counts;
}

// tools/ingest/ingest.ts
async function ingestZip(opts) {
  const projectDir = resolve(opts.projectDir);
  const entries = unzipSync(new Uint8Array(await readFile(opts.zipPath)));
  const names = Object.keys(entries).filter((n) => !n.endsWith("/"));
  const name = rootFolder(names);
  const sessionText = entries[`${name}/session.json`];
  if (!sessionText) throw new Error("zip has no session.json");
  const sessionJson = new TextDecoder().decode(sessionText);
  const file = parseFeedbackFile(sessionJson);
  const raw = JSON.parse(sessionJson);
  const tmp = await mkdtemp(join(tmpdir(), "feedback-ingest-"));
  try {
    const work = join(tmp, name);
    for (const entry of names) {
      const path = join(tmp, entry);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entries[entry]);
    }
    const byEventId = /* @__PURE__ */ new Map();
    for (const e of file.events) {
      if (e.type !== "voice-segment" || !e.payload.assetId) continue;
      const audio = join(work, e.payload.assetId);
      if (!existsSync(audio)) continue;
      byEventId.set(e.id, await opts.transcribe(audio, e.payload.tStart));
    }
    const events = prunePointers(mergeTranscripts(file.events, byEventId));
    const present = new Set(names.map((n) => n.slice(name.length + 1)));
    const assetPath = (id) => present.has(id) ? id : void 0;
    const report = renderReport({
      session: file.session,
      events,
      assets: [],
      level: file.level,
      assetPath
    });
    await writeFile(join(work, "report.md"), report);
    await writeFile(
      join(work, "transcript.json"),
      JSON.stringify(transcriptRows(events, assetPath), null, 2)
    );
    await writeFile(
      join(work, "session.json"),
      JSON.stringify({ ...raw, events }, null, 2)
    );
    const dest = join(projectDir, ".feedback", name);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dirname(dest), { recursive: true });
    await cp(work, dest, { recursive: true });
    await ensureFeedbackIgnored(projectDir);
    const shotsDir = join(dest, "screenshots");
    const screenshots = existsSync(shotsDir) ? (await readdir(shotsDir)).sort().map((f) => join(shotsDir, f)) : [];
    return {
      ok: true,
      name,
      dir: dest,
      reportPath: join(dest, "report.md"),
      screenshots,
      counts: countFeedback(events)
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
async function ensureFeedbackIgnored(projectDir) {
  const path = join(projectDir, ".gitignore");
  const current = existsSync(path) ? await readFile(path, "utf8") : null;
  const next = withFeedbackIgnored(current);
  if (next !== null) await writeFile(path, next);
}

// tools/ingest/transcribe.ts
import { execFile } from "node:child_process";
import { readFile as readFile2, rm as rm2 } from "node:fs/promises";
import { promisify } from "node:util";
var run = promisify(execFile);
var TIMEOUT_MS = 5 * 6e4;
function messageOf(err2) {
  if (err2 && typeof err2 === "object") {
    const e = err2;
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    if (stderr) return stderr.split("\n").slice(-3).join(" ").slice(0, 400);
    if (typeof e.message === "string") return e.message.slice(0, 400);
  }
  return String(err2);
}
function makeTranscriber(opts) {
  return async (webmPath, chunkStartMs) => {
    const provider = opts.transcriber;
    const wav = webmPath.replace(/\.[^./]+$/, "") + ".wav";
    const out = wav.replace(/\.wav$/, `.${provider}`);
    try {
      await run(opts.ffmpegBin, ["-y", "-loglevel", "error", "-i", webmPath, "-ar", "16000", "-ac", "1", wav], {
        timeout: TIMEOUT_MS
      });
      if (provider === "whisper") {
        if (!opts.whisperModel) throw new Error("whisper needs --whisper-model <ggml model path>");
        await run(opts.whisperBin, ["-m", opts.whisperModel, "-oj", "-of", out, "-np", "-f", wav], {
          timeout: TIMEOUT_MS
        });
        const json2 = JSON.parse(await readFile2(`${out}.json`, "utf8"));
        return { provider, utterances: whisperToUtterances(json2, chunkStartMs) };
      }
      await run(opts.yapBin, ["transcribe", "--json", "--word-timestamps", "--max-length", "400", "-o", `${out}.json`, wav], {
        timeout: TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024
      });
      const json = JSON.parse(await readFile2(`${out}.json`, "utf8"));
      return { provider, utterances: yapToUtterances(json, chunkStartMs) };
    } catch (err2) {
      return { provider, error: messageOf(err2) };
    } finally {
      await rm2(wav, { force: true });
      await rm2(`${out}.json`, { force: true });
    }
  };
}

// tools/ingest/cli.ts
var FLAGS = /* @__PURE__ */ new Set(["--project", "--transcriber", "--whisper-model", "--yap", "--ffmpeg", "--whisper"]);
function parseArgs(argv) {
  const flags = /* @__PURE__ */ new Map();
  const positional = [];
  for (let i2 = 0; i2 < argv.length; i2 += 1) {
    const arg = argv[i2];
    if (FLAGS.has(arg)) {
      const value = argv[i2 + 1];
      if (value === void 0) throw new Error(`${arg} needs a value`);
      flags.set(arg, value);
      i2 += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const [zipPath] = positional;
  const projectDir = flags.get("--project");
  if (!zipPath || positional.length > 1) throw new Error("usage: ingest <zip> --project <dir>");
  if (!projectDir) throw new Error("--project <dir> is required");
  const transcriber = flags.get("--transcriber") ?? "yap";
  if (transcriber !== "yap" && transcriber !== "whisper") {
    throw new Error(`--transcriber must be yap or whisper, not ${transcriber}`);
  }
  const whisperModel = flags.get("--whisper-model");
  return {
    zipPath,
    projectDir,
    transcriber,
    yapBin: flags.get("--yap") ?? "/opt/homebrew/bin/yap",
    ffmpegBin: flags.get("--ffmpeg") ?? "/opt/homebrew/bin/ffmpeg",
    whisperBin: flags.get("--whisper") ?? "/opt/homebrew/bin/whisper-cli",
    ...whisperModel ? { whisperModel } : {}
  };
}
async function main(argv) {
  try {
    const args = parseArgs(argv);
    const result = await ingestZip({
      zipPath: args.zipPath,
      projectDir: args.projectDir,
      transcribe: makeTranscriber(args)
    });
    process.stdout.write(`${JSON.stringify(result)}
`);
    return 0;
  } catch (err2) {
    const error = err2 instanceof Error ? err2.message : String(err2);
    process.stdout.write(`${JSON.stringify({ ok: false, error })}
`);
    return 1;
  }
}

// tools/ingest/main.ts
process.exitCode = await main(process.argv.slice(2));
