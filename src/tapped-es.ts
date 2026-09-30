import { EventClient } from '@tanstack/devtools-event-client'

export type Transport = 'eventsource' | 'fetch'
export type CloseReason = 'client' | 'server' | 'error' | 'page-unload'

type StreamRef = {
  streamId: string
  url: string
  transport: Transport
  t: number
}
type Message = { event?: string; data: string; id?: string }
type CloseInfo = {
  status?: number
  error?: string
  /** Start of a non-2xx response body, usually the server's own error message. */
  body?: string
  midEvent?: boolean
}
/** Circumstances of an error close. Browsers hide the real cause (the net:: code) from JS. */
export type Diagnosis = {
  after?: number // ms from open to the drop; unset if it never opened
  idle?: number // ms since the last data
  bytes: number
  messages: number
  offline: boolean
  hidden: boolean
  hint?: string
}

export type SseEvents = {
  open: StreamRef
  message: StreamRef & Message
  close: StreamRef & CloseInfo & Partial<Diagnosis> & { reason: CloseReason }
}

// ponytail: the devtools bus mounts lazily and EventClient drops everything after
// 5 failed connect retries; 1s apart gives a cold `next dev` compile ~5s.
export const eventClient: EventClient<SseEvents> = /* @__PURE__ */ new EventClient({
  pluginId: 'event-source',
  reconnectEveryMs: 1000
})

// The devtools bus rebroadcasts events to other tabs; stream ids carry this
// prefix so the panel can keep only its own tab's streams. It lives on a global
// because a hot reload re-runs this module while the tap installed by the first
// run keeps emitting with the first id.
const TAB = Symbol.for('sse-tap-tab')
const g = globalThis as typeof globalThis & { [TAB]?: string }
export const TAB_ID: string = /* @__PURE__ */ tabId()
function tabId() {
  return (g[TAB] ??= Math.random().toString(36).slice(2, 8))
}

const MAX_DATA = 4096 // ponytail: per-message cap so history fits sessionStorage
let seq = 0

const MAX_BODY = 500
const IDLE_TIMEOUT = 30_000 // ponytail: proxies cut idle streams at 30-120s; shorter gaps read as plain drops

export const duration = (ms: number) =>
  ms < 60_000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${Math.floor(ms / 60_000)}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`

/** Best guess at why a stream errored, from the circumstances the browser does expose. */
export function explain(
  transport: Transport,
  info: CloseInfo,
  d: Omit<Diagnosis, 'hint'>
): string | undefined {
  if (transport === 'fetch' && !info.error) return // HTTP error: status and body say it
  if (d.offline) return 'browser went offline'
  if (transport === 'eventsource')
    return "server answered with a non-200 status or a non-event-stream Content-Type (EventSource doesn't say which); see the Network tab"
  if (d.after === undefined)
    return 'request failed before any response: DNS, refused connection, CORS or an extension; the DevTools console has the net:: code'
  if (d.idle !== undefined && d.idle >= IDLE_TIMEOUT)
    return `no data for ${duration(d.idle)}, likely a proxy or load-balancer idle timeout; send heartbeats`
  return 'connection dropped mid-stream; the DevTools console has the net:: code'
}

const redact = (url: string) =>
  url.replace(/([?&](?:session|token|key|auth)[^=]*=)[^&]*/gi, '$1***')

function track(transport: Transport, url: string) {
  const ref = {
    streamId: `${TAB_ID}-${(seq += 1)}`,
    url: redact(url),
    transport
  }
  let closed = false
  let openedAt: number | undefined
  let lastDataAt: number | undefined
  let bytes = 0
  let messages = 0
  return {
    open: () => {
      openedAt = lastDataAt = Date.now()
      eventClient.emit('open', { ...ref, t: openedAt })
    },
    received: (n: number) => {
      lastDataAt = Date.now()
      bytes += n
    },
    message: ({ data, ...rest }: Message) => {
      // A chunk pre-read before the app cancelled must not land after close.
      if (closed) return
      messages += 1
      eventClient.emit('message', {
        ...ref,
        t: Date.now(),
        ...rest,
        data: data.slice(0, MAX_DATA)
      })
    },
    close: (reason: CloseReason, info?: CloseInfo) => {
      if (closed) return
      closed = true
      const t = Date.now()
      if (reason !== 'error')
        return eventClient.emit('close', { ...ref, t, reason, ...info })
      const d = {
        after: openedAt && t - openedAt,
        idle: lastDataAt && t - lastDataAt,
        bytes,
        messages,
        offline: !navigator.onLine,
        hidden: document.hidden
      }
      const hint = explain(transport, info ?? {}, d)
      eventClient.emit('close', { ...ref, t, reason, ...info, ...d, hint })
    }
  }
}

/** Incremental text/event-stream parser; feed it raw chunks as they arrive. */
export function parseSse(onMessage: (message: Message) => void) {
  const decoder = new TextDecoder()
  let buffer = ''
  let pendingCR = false
  let data: string[] = []
  let event: string | undefined
  let id: string | undefined

  const feed = (chunk: Uint8Array) => {
    let text = decoder.decode(chunk, { stream: true })
    // A CRLF split across chunks must not read as an extra blank line.
    if (pendingCR && text.startsWith('\n')) text = text.slice(1)
    if (text) pendingCR = text.endsWith('\r')

    const lines = (buffer + text).split(/\r\n|\r|\n/)
    buffer = lines.pop()!
    lines.forEach((line) => {
      if (line === '') {
        if (data.length) onMessage({ event, data: data.join('\n'), id })
        data = []
        event = undefined
        id = undefined
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'data') data.push(value)
        else if (field === 'event') event = value
        else if (field === 'id') id = value
      }
    })
  }
  // True when the stream stopped partway through an event.
  return Object.assign(feed, { midEvent: () => buffer !== '' || data.length > 0 })
}

/** Reads the start of a response body from a clone, leaving the original to the app. */
async function head(res: Response) {
  const reader = res.clone().body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < MAX_BODY) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    // body failed mid-read: keep what arrived
  }
  reader.cancel().catch(() => {})
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY)
}

const INSTALLED = Symbol.for('sse-tap')

/** Patches window.EventSource and window.fetch to emit open/message/close for every SSE stream. */
export function installTap() {
  const w = window as typeof window & { [INSTALLED]?: true }
  if (w[INSTALLED]) return // HMR re-runs this module; never wrap twice
  w[INSTALLED] = true

  const NativeEventSource = window.EventSource
  window.EventSource = class extends NativeEventSource {
    private tap = track('eventsource', this.url)

    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init)
      const { tap } = this
      // Registered before the app's onmessage/onerror, so readyState is read
      // before app code gets a chance to close().
      this.addEventListener('open', () => tap.open())
      this.addEventListener('message', (e) => {
        tap.received(e.data.length)
        tap.message({ data: e.data, id: e.lastEventId || undefined })
      })
      this.addEventListener('error', () => {
        if (this.readyState === NativeEventSource.CLOSED) tap.close('error')
      })
    }

    close() {
      this.tap.close('client')
      super.close()
    }
  }

  const nativeFetch = window.fetch
  window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const signal = init?.signal ?? request?.signal
    const url = request?.url ?? String(input)
    // fetchEventSource always sends this, so failed agent-chat requests
    // (HTML/JSON error bodies) are still recorded.
    const wantsSse = new Headers(init?.headers ?? request?.headers)
      .get('accept')
      ?.includes('text/event-stream')

    let res: Response
    try {
      res = await nativeFetch(input, init)
    } catch (err) {
      if (wantsSse)
        track('fetch', url).close(signal?.aborted ? 'client' : 'error', {
          error: String(err)
        })
      throw err
    }

    const isSse = res.headers.get('content-type')?.startsWith('text/event-stream')
    if (!wantsSse && !isSse) return res

    const { status } = res
    const tap = track('fetch', res.url || url)
    if (!res.ok) {
      // Read off a clone so the app gets the response right away.
      void head(res).then((body) => tap.close('error', { status, body: body || undefined }))
      return res
    }
    tap.open()
    if (!res.body) {
      tap.close('server', { status })
      return res
    }

    // Pull-through rather than tee(): cancelling the app's side must still
    // cancel the network read.
    const reader = res.body.getReader()
    const parse = parseSse(tap.message)
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            tap.close('server', { status })
            controller.close()
            return
          }
          tap.received(value.byteLength)
          parse(value)
          controller.enqueue(value)
        } catch (err) {
          tap.close(signal?.aborted ? 'client' : 'error', {
            status,
            error: String(err),
            midEvent: parse.midEvent() || undefined
          })
          controller.error(err)
        }
      },
      cancel(reason) {
        tap.close('client', { status })
        return reader.cancel(reason)
      }
    })

    const tapped = new Response(body, {
      status,
      statusText: res.statusText,
      headers: res.headers
    })
    Object.defineProperty(tapped, 'url', { value: res.url })
    return tapped
  }
}
