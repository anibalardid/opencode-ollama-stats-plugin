// index.tsx
import { createRoot, createSignal } from "solid-js";
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
var CONFIG_PATHS = [
  { path: process.env.HOME + "/.config/opencode/opencode-quota/ollama-cloud.json", type: "json" },
  { path: process.env.HOME + "/.config/ollama-usage/config.yaml", type: "yaml" },
  { path: process.env.HOME + "/.ollama-usage/config.yaml", type: "yaml" }
];
var SETTINGS_URL = "https://ollama.com/settings";
var USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";
var SCRAPE_TIMEOUT_MS = 1e4;
var REFRESH_INTERVAL_MS = 18e4;
function readYamlCookie(content) {
  const stripped = content.replace(/#[^\n]*/g, "");
  const m = stripped.match(/(?:^|\n)\s*cookie\s*:\s*["']?\s*(.+?)\s*["']?\s*(?:\n|$)/);
  return m ? m[1].trim() : null;
}
async function resolveCookie() {
  const env = process.env.OLLAMA_USAGE_COOKIE?.trim();
  if (env) return { result: { cookie: env, source: "OLLAMA_USAGE_COOKIE" } };
  for (const { path, type } of CONFIG_PATHS) {
    try {
      const fs = await import("fs/promises");
      const content = await fs.readFile(path, "utf-8");
      let cookie = null;
      if (type === "json") {
        const parsed = JSON.parse(content);
        cookie = typeof parsed.cookie === "string" ? parsed.cookie.trim() : null;
      } else {
        cookie = readYamlCookie(content);
      }
      if (cookie) return { result: { cookie, source: path } };
    } catch (err) {
      if (err?.code !== "ENOENT") {
        return { error: `Error reading ${path}: ${err.message}` };
      }
    }
  }
  return { error: "no cookie found" };
}
var RETRY_DELAYS = [6e4, 6e4, 6e4];
function parseUsageFromHtml(html) {
  const usageRe = /(\d+(?:\.\d+)?)%\s*used/gi;
  const usageMatches = [...html.matchAll(usageRe)];
  if (usageMatches.length === 0) {
    return { error: "No usage data found on settings page" };
  }
  let sessionPct;
  let weeklyPct;
  for (const match of usageMatches) {
    const pct = parseFloat(match[1]);
    if (isNaN(pct)) continue;
    const pos = match.index;
    const context = html.slice(Math.max(0, pos - 500), pos).toLowerCase();
    if (context.includes("session")) {
      sessionPct = pct;
    } else if (context.includes("weekly")) {
      weeklyPct = pct;
    }
  }
  if (sessionPct === void 0 || weeklyPct === void 0) {
    const uniquePcts = [...new Set(usageMatches.map((m) => parseFloat(m[1])).filter((n) => !isNaN(n)))];
    if (sessionPct === void 0) sessionPct = uniquePcts[0] ?? 0;
    if (weeklyPct === void 0) weeklyPct = uniquePcts[1] ?? uniquePcts[0] ?? 0;
  }
  const timeRe = /class="[^"]*local-time[^"]*"[^>]*data-time="([^"]*)"/g;
  const resetTimes = [...html.matchAll(timeRe)].map((m) => m[1]);
  const planRe = /class="[^"]*capitalize[^"]*"[^>]*>([^<]*)</;
  const planMatch = html.match(planRe);
  const planTier = planMatch ? planMatch[1].trim() : void 0;
  return {
    data: {
      sessionPercent: sessionPct,
      weeklyPercent: weeklyPct,
      sessionReset: resetTimes[0],
      weeklyReset: resetTimes[1],
      planTier
    }
  };
}
async function resolveIPv4(host) {
  const g = globalThis;
  try {
    if (g.Bun?.dns?.lookup) {
      const res = await g.Bun.dns.lookup(host);
      const a = res?.find?.((r) => r.family === 4);
      if (a?.address) return a.address;
    }
  } catch {
  }
  try {
    const dns = await import("dns/promises");
    const res = await dns.lookup(host, { family: 4 });
    if (res?.address) return res.address;
  } catch {
  }
  return void 0;
}
async function fetchWithIPv4Fallback(url, init2) {
  try {
    return await fetch(url, init2);
  } catch (err) {
    const host = new URL(url).hostname;
    const ip = await resolveIPv4(host);
    if (!ip) throw err;
    const u = new URL(url);
    const headers = new Headers(init2.headers);
    headers.set("Host", host);
    return await fetch(`https://${ip}${u.pathname}${u.search}`, {
      ...init2,
      headers,
      // @ts-ignore Bun-specific: keep TLS SNI/hostname verification on the real host
      tls: { serverName: host }
    });
  }
}
async function scrapeUsage(cookie) {
  try {
    const resp = await fetchWithIPv4Fallback(SETTINGS_URL, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
        Cookie: `__Secure-session=${cookie}`
      },
      redirect: "manual",
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS)
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location") || "";
      return { error: `Auth error: redirected to ${loc.slice(0, 60)} \u2014 cookie may be expired` };
    }
    if (!resp.ok) {
      return { error: `HTTP ${resp.status}` };
    }
    const html = await resp.text();
    return parseUsageFromHtml(html);
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}
function barStr(ratio, w) {
  const filled = Math.round(Math.min(ratio, 1) * w);
  return "\u2588".repeat(Math.max(0, filled)) + "\u2591".repeat(Math.max(0, w - filled));
}
function fmtPct(used) {
  return `${used.toFixed(1)}%`;
}
function fmtTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = /* @__PURE__ */ new Date();
    const diff = d.getTime() - now.getTime();
    if (diff <= 0) return "resets now";
    const hours = Math.round(diff / 36e5);
    if (hours < 24) return `in ${hours}h`;
    const days = Math.round(hours / 24);
    return `in ${days}d`;
  } catch {
    return "";
  }
}
var KV_EXP = "ollama-cloud:exp";
var init = false;
var tui = async (api) => {
  if (init) return;
  init = true;
  let sd;
  let timerId;
  let retryTimer;
  const cl = () => {
    try {
      sd?.();
    } catch {
    }
    if (timerId) clearInterval(timerId);
    if (retryTimer) clearTimeout(retryTimer);
    init = false;
  };
  try {
    if (api.lifecycle?.onDispose) api.lifecycle.onDispose(cl);
    if (!api.lifecycle?.onDispose && api.lifecycle?.signal)
      api.lifecycle.signal.addEventListener("abort", cl, { once: true });
    createRoot((dis) => {
      sd = dis;
      const [state, setState] = createSignal({ kind: "loading" });
      const [expanded, setExpanded] = createSignal(
        api.kv?.get?.(KV_EXP, true) !== false
      );
      let retryAttempt = 0;
      async function refresh() {
        const resolved = await resolveCookie();
        if (!resolved.result) {
          setState({ kind: "help" });
          return;
        }
        const scraped = await scrapeUsage(resolved.result.cookie);
        if (scraped.error) {
          setState({ kind: "error", msg: scraped.error });
          if (timerId) {
            clearInterval(timerId);
            timerId = void 0;
          }
          scheduleRetry(retryAttempt);
          retryAttempt++;
          return;
        }
        retryAttempt = 0;
        setState({ kind: "data", d: scraped.data });
        if (!timerId) timerId = setInterval(refresh, REFRESH_INTERVAL_MS);
      }
      function scheduleRetry(attempt) {
        if (retryTimer) clearTimeout(retryTimer);
        const delay = attempt < RETRY_DELAYS.length ? RETRY_DELAYS[attempt] : REFRESH_INTERVAL_MS;
        retryTimer = setTimeout(() => {
          refresh();
        }, delay);
      }
      refresh();
      api.slots?.register?.({
        order: 220,
        slots: {
          sidebar_content(ctx, _props) {
            const s = state();
            const e = expanded();
            const fg = ctx.theme.current.text;
            const mu = ctx.theme.current.textMuted;
            const warn = ctx.theme.current.warning ?? "#e6a817";
            if (s.kind === "loading") {
              return /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
                /* @__PURE__ */ jsx("text", { fg: mu, children: "Ollama Cloud" }),
                /* @__PURE__ */ jsx("text", { fg: mu, children: "Loading\u2026" })
              ] });
            }
            if (s.kind === "help") {
              return /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
                /* @__PURE__ */ jsx("text", { fg: warn, children: "\u26A0 Ollama Cloud" }),
                /* @__PURE__ */ jsx("text", { fg: mu, children: "No cookie configured" }),
                /* @__PURE__ */ jsx("text", { fg: mu, children: "Set OLLAMA_USAGE_COOKIE" }),
                /* @__PURE__ */ jsx("text", { fg: mu, children: "or create:" }),
                /* @__PURE__ */ jsx("text", { fg: mu, children: "~/.config/opencode/" }),
                /* @__PURE__ */ jsx("text", { fg: mu, children: "  opencode-quota/" }),
                /* @__PURE__ */ jsx("text", { fg: mu, children: "    ollama-cloud.json" }),
                /* @__PURE__ */ jsxs("text", { fg: mu, children: [
                  "  \u2192 ",
                  "{",
                  '"cookie":"...',
                  "}"
                ] })
              ] });
            }
            if (s.kind === "error") {
              return /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
                /* @__PURE__ */ jsx("text", { fg: warn, children: "\u26A0 Ollama Cloud" }),
                /* @__PURE__ */ jsx("text", { fg: mu, children: s.msg })
              ] });
            }
            const d = s.d;
            const sessionPct = d.sessionPercent;
            const weeklyPct = d.weeklyPercent;
            const sessionCircle = sessionPct >= 80 ? "\u{1F534} " : sessionPct >= 50 ? "\u{1F7E1} " : "";
            const weeklyCircle = weeklyPct >= 80 ? "\u{1F534} " : weeklyPct >= 50 ? "\u{1F7E1} " : "";
            return /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
              /* @__PURE__ */ jsxs(
                "box",
                {
                  flexDirection: "row",
                  justifyContent: "space-between",
                  onMouseDown: () => {
                    const next = !e;
                    setExpanded(next);
                    api.kv?.set?.(KV_EXP, next);
                  },
                  children: [
                    /* @__PURE__ */ jsxs("text", { fg, children: [
                      e ? "\u25BC" : "\u25B6",
                      " Ollama Cloud",
                      d.planTier ? ` (${d.planTier})` : ""
                    ] }),
                    /* @__PURE__ */ jsxs("text", { fg, children: [
                      sessionCircle,
                      fmtPct(sessionPct)
                    ] })
                  ]
                }
              ),
              e && /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
                /* @__PURE__ */ jsxs("box", { flexDirection: "row", justifyContent: "space-between", children: [
                  /* @__PURE__ */ jsxs("text", { fg, children: [
                    sessionCircle,
                    "Session"
                  ] }),
                  /* @__PURE__ */ jsxs("text", { fg, children: [
                    fmtPct(sessionPct),
                    " used"
                  ] })
                ] }),
                /* @__PURE__ */ jsxs("text", { fg, children: [
                  barStr(sessionPct / 100, 8),
                  " ",
                  fmtPct(sessionPct)
                ] }),
                d.sessionReset && /* @__PURE__ */ jsxs("text", { fg: mu, children: [
                  "Reset ",
                  fmtTime(d.sessionReset)
                ] }),
                /* @__PURE__ */ jsxs("box", { flexDirection: "row", justifyContent: "space-between", children: [
                  /* @__PURE__ */ jsxs("text", { fg, children: [
                    weeklyCircle,
                    "Weekly"
                  ] }),
                  /* @__PURE__ */ jsxs("text", { fg, children: [
                    fmtPct(weeklyPct),
                    " used"
                  ] })
                ] }),
                /* @__PURE__ */ jsxs("text", { fg, children: [
                  barStr(weeklyPct / 100, 8),
                  " ",
                  fmtPct(weeklyPct)
                ] }),
                d.weeklyReset && /* @__PURE__ */ jsxs("text", { fg: mu, children: [
                  "Reset ",
                  fmtTime(d.weeklyReset)
                ] })
              ] })
            ] });
          }
        }
      });
    });
  } catch (err) {
    cl();
    api.ui?.toast?.({ message: "ollama-cloud-usage failed", variant: "error" });
    throw err;
  }
};
var index_default = { id: "ollama-cloud-usage", tui };
export {
  index_default as default
};
