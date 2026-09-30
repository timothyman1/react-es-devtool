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
type CloseInfo = { status?: number; error?: string }

export type SseEvents = {
  open: StreamRef
  message: StreamRef & Message
  close: StreamRef & CloseInfo & { reason: CloseReason }
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

const redact = (url: string) =>
  url.replace(/([?&](?:session|token|key|auth)[^=]*=)[^&]*/gi, '$1***')

function track(transport: Transport, url: string) {
  const ref = {
    streamId: `${TAB_ID}-${(seq += 1)}`,
    url: redact(url),
    transport
  }
  let closed = false
  return {
    open: () => eventClient.emit('open', { ...ref, t: Date.now() }),
    message: ({ data, ...rest }: Message) => {
      // A chunk pre-read before the app cancelled must not land after close.
      if (closed) return
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
      eventClient.emit('close', { ...ref, t: Date.now(), reason, ...info })
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

  return (chunk: Uint8Array) => {
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
      this.addEventListener('message', (e) =>
        tap.message({ data: e.data, id: e.lastEventId || undefined })
      )
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
      tap.close('error', { status })
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
          parse(value)
          controller.enqueue(value)
        } catch (err) {
          tap.close(signal?.aborted ? 'client' : 'error', {
            status,
            error: String(err)
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
