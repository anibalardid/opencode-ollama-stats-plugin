/** @jsxImportSource @opentui/solid */
/** @jsxRuntime automatic */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createRoot, createSignal } from "solid-js"

// ── Config sources ──────────────────────────────────────────────────────────
const CONFIG_PATHS = [
  { path: process.env.HOME + "/.config/opencode/opencode-quota/ollama-cloud.json", type: "json" },
  { path: process.env.HOME + "/.config/ollama-usage/config.yaml", type: "yaml" },
  { path: process.env.HOME + "/.ollama-usage/config.yaml", type: "yaml" },
] as const

const SETTINGS_URL = "https://ollama.com/settings"
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0"
const SCRAPE_TIMEOUT_MS = 10_000
const REFRESH_INTERVAL_MS = 180_000

// ── Cookie resolution ───────────────────────────────────────────────────────
interface CookieResult {
  cookie: string
  source: string
}

function readYamlCookie(content: string): string | null {
  const stripped = content.replace(/#[^\n]*/g, "")
  const m = stripped.match(/(?:^|\n)\s*cookie\s*:\s*["']?\s*(.+?)\s*["']?\s*(?:\n|$)/)
  return m ? m[1].trim() : null
}

async function resolveCookie(): Promise<{ result?: CookieResult; error?: string }> {
  // 1. Env var
  const env = process.env.OLLAMA_USAGE_COOKIE?.trim()
  if (env) return { result: { cookie: env, source: "OLLAMA_USAGE_COOKIE" } }

  // 2. Config files
  for (const { path, type } of CONFIG_PATHS) {
    try {
      const fs = await import("fs/promises")
      const content = await fs.readFile(path, "utf-8")

      let cookie: string | null = null
      if (type === "json") {
        const parsed = JSON.parse(content)
        cookie = typeof parsed.cookie === "string" ? parsed.cookie.trim() : null
      } else {
        cookie = readYamlCookie(content)
      }

      if (cookie) return { result: { cookie, source: path } }
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        return { error: `Error reading ${path}: ${err.message}` }
      }
    }
  }

  return { error: "no cookie found" }
}

// ── Scraper ──────────────────────────────────────────────────────────────────
interface UsageData {
  sessionPercent: number
  weeklyPercent: number
  sessionReset?: string
  weeklyReset?: string
  planTier?: string
}

const RETRY_DELAYS = [60_000, 60_000, 60_000] as const

function parseUsageFromHtml(html: string): { data?: UsageData; error?: string } {
  const usageRe = /(\d+(?:\.\d+)?)%\s*used/gi
  const usageMatches = [...html.matchAll(usageRe)]

  if (usageMatches.length === 0) {
    return { error: "No usage data found on settings page" }
  }

  let sessionPct: number | undefined
  let weeklyPct: number | undefined

  for (const match of usageMatches) {
    const pct = parseFloat(match[1])
    if (isNaN(pct)) continue

    const pos = match.index!
    const context = html.slice(Math.max(0, pos - 500), pos).toLowerCase()

    if (context.includes("session")) {
      sessionPct = pct
    } else if (context.includes("weekly")) {
      weeklyPct = pct
    }
  }

  // Fallback to positional if context matching failed
  if (sessionPct === undefined || weeklyPct === undefined) {
    const uniquePcts = [...new Set(usageMatches.map((m) => parseFloat(m[1])).filter((n) => !isNaN(n)))]
    if (sessionPct === undefined) sessionPct = uniquePcts[0] ?? 0
    if (weeklyPct === undefined) weeklyPct = uniquePcts[1] ?? uniquePcts[0] ?? 0
  }

  const timeRe = /class="[^"]*local-time[^"]*"[^>]*data-time="([^"]*)"/g
  const resetTimes = [...html.matchAll(timeRe)].map((m) => m[1])

  const planRe = /class="[^"]*capitalize[^"]*"[^>]*>([^<]*)</
  const planMatch = html.match(planRe)
  const planTier = planMatch ? planMatch[1].trim() : undefined

  return {
    data: {
      sessionPercent: sessionPct,
      weeklyPercent: weeklyPct,
      sessionReset: resetTimes[0],
      weeklyReset: resetTimes[1],
      planTier,
    },
  }
}

async function scrapeUsage(cookie: string): Promise<{ data?: UsageData; error?: string }> {
  try {
    const resp = await fetch(SETTINGS_URL, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
        Cookie: `__Secure-session=${cookie}`,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    })

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location") || ""
      return { error: `Auth error: redirected to ${loc.slice(0, 60)} — cookie may be expired` }
    }

    if (!resp.ok) {
      return { error: `HTTP ${resp.status}` }
    }

    const html = await resp.text()
    return parseUsageFromHtml(html)
  } catch (err: any) {
    return { error: err?.message ?? String(err) }
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function barStr(ratio: number, w: number): string {
  const filled = Math.round(Math.min(ratio, 1) * w)
  return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, w - filled))
}

function fmtPct(used: number): string {
  return `${used.toFixed(1)}%`
}

function fmtTime(iso?: string): string {
  if (!iso) return ""
  try {
    const d = new Date(iso)
    const now = new Date()
    const diff = d.getTime() - now.getTime()
    if (diff <= 0) return "resets now"
    const hours = Math.round(diff / 3600_000)
    if (hours < 24) return `in ${hours}h`
    const days = Math.round(hours / 24)
    return `in ${days}d`
  } catch {
    return ""
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────
const KV_EXP = "ollama-cloud:exp"

let init = false

const tui: TuiPlugin = async (api) => {
  if (init) return
  init = true

  let sd: (() => void) | undefined
  let timerId: ReturnType<typeof setInterval> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const cl = () => {
    try { sd?.() } catch {}
    if (timerId) clearInterval(timerId)
    if (retryTimer) clearTimeout(retryTimer)
    init = false
  }

  try {
    if (api.lifecycle?.onDispose) api.lifecycle.onDispose(cl)
    if (!api.lifecycle?.onDispose && api.lifecycle?.signal)
      api.lifecycle.signal.addEventListener("abort", cl, { once: true })

    createRoot((dis) => {
      sd = dis

      // State: loading | error(msg) | help(no cookie) | data
      type State =
        | { kind: "loading" }
        | { kind: "error"; msg: string }
        | { kind: "help" }
        | { kind: "data"; d: UsageData }

      const [state, setState] = createSignal<State>({ kind: "loading" })
      const [expanded, setExpanded] = createSignal(
        api.kv?.get?.<boolean>(KV_EXP, true) !== false,
      )

      let retryAttempt = 0

      async function refresh() {
        const resolved = await resolveCookie()
        if (!resolved.result) {
          setState({ kind: "help" })
          return
        }

        const scraped = await scrapeUsage(resolved.result.cookie)
        if (scraped.error) {
          setState({ kind: "error", msg: scraped.error })
          // Stop normal interval, start retry chain
          if (timerId) { clearInterval(timerId); timerId = undefined }
          scheduleRetry(retryAttempt)
          retryAttempt++
          return
        }

        retryAttempt = 0
        setState({ kind: "data", d: scraped.data! })
        // Start normal interval if not already running
        if (!timerId) timerId = setInterval(refresh, REFRESH_INTERVAL_MS)
      }

      function scheduleRetry(attempt: number) {
        if (retryTimer) clearTimeout(retryTimer)
        if (attempt >= RETRY_DELAYS.length) return
        retryTimer = setTimeout(() => {
          refresh().then(() => {
            // On success after retry, resume normal interval
            if (timerId) clearInterval(timerId)
            timerId = setInterval(refresh, REFRESH_INTERVAL_MS)
          })
        }, RETRY_DELAYS[attempt])
      }

      // Initial fetch — don't start interval until first success
      refresh()

      api.slots?.register?.({
        order: 220,
        slots: {
          sidebar_content(ctx, _props) {
            const s = state()
            const e = expanded()
            const fg = ctx.theme.current.text
            const mu = ctx.theme.current.textMuted
            const warn = ctx.theme.current.warning ?? "#e6a817"

            if (s.kind === "loading") {
              return (
                <box flexDirection="column">
                  <text fg={mu}>Ollama Cloud</text>
                  <text fg={mu}>Loading…</text>
                </box>
              )
            }

            if (s.kind === "help") {
              return (
                <box flexDirection="column">
                  <text fg={warn}>⚠ Ollama Cloud</text>
                  <text fg={mu}>No cookie configured</text>
                  <text fg={mu}>Set OLLAMA_USAGE_COOKIE</text>
                  <text fg={mu}>or create:</text>
                  <text fg={mu}>~/.config/opencode/</text>
                  <text fg={mu}>  opencode-quota/</text>
                  <text fg={mu}>    ollama-cloud.json</text>
                  <text fg={mu}>  → {"{"}"cookie":"...{"}"}</text>
                </box>
              )
            }

            if (s.kind === "error") {
              return (
                <box flexDirection="column">
                  <text fg={warn}>⚠ Ollama Cloud</text>
                  <text fg={mu}>{s.msg}</text>
                </box>
              )
            }

            // Data
            const d = s.d
            const sessionPct = d.sessionPercent
            const weeklyPct = d.weeklyPercent

            const sessionCircle = sessionPct >= 80 ? "🔴 " : sessionPct >= 50 ? "🟡 " : ""
            const weeklyCircle = weeklyPct >= 80 ? "🔴 " : weeklyPct >= 50 ? "🟡 " : ""

            return (
              <box flexDirection="column">
                <box
                  flexDirection="row"
                  justifyContent="space-between"
                  onMouseDown={() => {
                    const next = !e
                    setExpanded(next)
                    api.kv?.set?.(KV_EXP, next)
                  }}
                >
                  <text fg={fg}>{e ? "▼" : "▶"} Ollama Cloud{d.planTier ? ` (${d.planTier})` : ""}</text>
                  <text fg={fg}>{sessionCircle}{fmtPct(sessionPct)}</text>
                </box>
                {e && (
                  <box flexDirection="column">
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={fg}>{sessionCircle}Session</text>
                      <text fg={fg}>{fmtPct(sessionPct)} used</text>
                    </box>
                    <text fg={fg}>
                      {barStr(sessionPct / 100, 8)} {fmtPct(sessionPct)}
                    </text>
                    {d.sessionReset && <text fg={mu}>Reset {fmtTime(d.sessionReset)}</text>}

                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={fg}>{weeklyCircle}Weekly</text>
                      <text fg={fg}>{fmtPct(weeklyPct)} used</text>
                    </box>
                    <text fg={fg}>
                      {barStr(weeklyPct / 100, 8)} {fmtPct(weeklyPct)}
                    </text>
                    {d.weeklyReset && <text fg={mu}>Reset {fmtTime(d.weeklyReset)}</text>}
                  </box>
                )}
              </box>
            )
          },
        },
      })
    })
  } catch (err) {
    cl()
    api.ui?.toast?.({ message: "ollama-cloud-usage failed", variant: "error" })
    throw err
  }
}

export default { id: "ollama-cloud-usage", tui }
