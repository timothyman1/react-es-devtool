'use client';

import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';

import css from './index.css?inline';

import {
  duration,
  eventClient,
  installTap,
  type SseEvents,
  TAB_ID,
  type Transport
} from './tapped-es';

type Kind = keyof SseEvents;
type RefKeys = 'streamId' | 'url' | 'transport';
type Row = { [K in Kind]: { kind: K } & Omit<SseEvents[K], RefKeys> }[Kind] & {
  key: number;
};
type Stream = {
  id: string;
  url: string;
  transport: Transport;
  count: number;
  rows: Row[];
};

const STORAGE_KEY = 'sse-tap';
// ponytail: fixed caps keep a long logs session inside sessionStorage's ~5 MB
const MAX_STREAMS = 200;
const MAX_ROWS = 500;

// Kept on a global so a hot reload (Vite HMR, a Next rebuild of the linked
// package) re-runs this module without losing the recorded streams.
const STATE = Symbol.for('event-source-devtool');
// The notify side lives here too: a panel from an earlier run must still hear
// records made by the run that now owns the bus subscriptions.
type State = {
  streams: Map<string, Stream>;
  rowKey: number;
  listeners: Set<() => void>;
  version: number;
  frame: number;
  off?: () => void;
};
const g = globalThis as typeof globalThis & { [STATE]?: State };
// `@__PURE__` lets a production build drop the store along with the panel.
const state = /* @__PURE__ */ initState();
function initState(): State {
  return (g[STATE] ??= {
    streams: new Map(load()),
    rowKey: 0,
    listeners: new Set(),
    version: 0,
    frame: 0
  });
}

function load(): [string, Stream][] {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

const isClosed = (s: Stream) => s.rows.at(-1)?.kind === 'close';

// Batched to one render per frame; a busy logs stream can emit hundreds/sec.
function notify() {
  state.version += 1;
  state.frame ||= requestAnimationFrame(() => {
    state.frame = 0;
    state.listeners.forEach((l) => l());
  });
}

function record<K extends Kind>(kind: K, payload: SseEvents[K]) {
  const { streamId, url, transport, ...rest } = payload;
  if (!streamId.startsWith(TAB_ID)) return; // rebroadcast from another tab

  let stream = state.streams.get(streamId);
  if (!stream) {
    stream = { id: streamId, url, transport, count: 0, rows: [] };
    state.streams.set(streamId, stream);
    if (state.streams.size > MAX_STREAMS) state.streams.delete(state.streams.keys().next().value!);
  }
  state.rowKey += 1;
  stream.rows.push({ kind, ...rest, key: state.rowKey } as Row);
  if (stream.rows.length > MAX_ROWS) stream.rows.shift();
  if (kind === 'message') stream.count += 1;
  notify();
}

function persist() {
  const t = Date.now();
  const saved = Array.from(state.streams).map(([id, s]) => [
    id,
    isClosed(s)
      ? s
      : {
          ...s,
          rows: [...s.rows, { kind: 'close', t, reason: 'page-unload', key: 0 }]
        }
  ]);
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // quota exceeded: skip this save rather than break unload
  }
}

// Browser + dev only: this module is statically imported, so it also runs on
// the server and in prod builds, where it must stay inert.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  // Subscribed at module load, not in the panel: the bus doesn't replay, and
  // the panel only mounts while its devtools tab is open.
  // A re-run replaces the previous run's subscriptions instead of stacking.
  state.off?.();
  const offs = [
    eventClient.on('open', (e) => record('open', e.payload)),
    eventClient.on('message', (e) => record('message', e.payload)),
    eventClient.on('close', (e) => record('close', e.payload))
  ];
  window.addEventListener('pagehide', persist);
  state.off = () => {
    offs.forEach((off) => off());
    window.removeEventListener('pagehide', persist);
  };
  // After the subscriptions above, so the first stream is never missed.
  installTap();
}

// React never updates a hoisted <style> in place, so the href follows the
// content; a fixed href would keep the old CSS until a full reload.
const STYLE_HREF = /* @__PURE__ */ styleHref();
function styleHref() {
  let h = 0;
  for (let i = 0; i < css.length; i += 1) h = (h * 31 + css.charCodeAt(i)) | 0;
  return `event-source-devtool-${(h >>> 0).toString(36)}`;
}

function clear() {
  state.streams.clear();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage blocked: in-memory clear is enough
  }
  notify();
}

const subscribe = (l: () => void) => {
  state.listeners.add(l);
  return () => state.listeners.delete(l);
};

const time = (t: number) =>
  `${new Date(t).toTimeString().slice(0, 8)}.${String(t % 1000).padStart(3, '0')}`;

function path(url: string) {
  try {
    const u = new URL(url, window.location.href);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function status(s: Stream) {
  const last = s.rows.at(-1);
  if (last?.kind !== 'close') return { dot: '●', color: 'es:text-ok' };
  return last.reason === 'error'
    ? { dot: '⚠', color: 'es:text-error' }
    : { dot: '✕', color: 'es:text-muted' };
}

const size = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);

// Under an error close: the error body, the circumstances of the drop and a guess at why.
function closeContext(row: Row) {
  if (row.kind !== 'close' || row.reason !== 'error') return null;
  const facts = [
    row.after !== undefined && `after ${duration(row.after)}`,
    row.idle !== undefined && `idle ${duration(row.idle)}`,
    row.after !== undefined && `${row.messages ?? 0} msgs / ${size(row.bytes ?? 0)}`,
    row.midEvent && 'cut mid-event',
    row.offline && 'offline',
    row.hidden && 'tab hidden'
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      {row.body && <div className="es:break-all es:pl-4 es:text-muted">{row.body}</div>}
      {facts && <div className="es:pl-4 es:text-muted">{facts}</div>}
      {row.hint && <div className="es:pl-4">→ {row.hint}</div>}
    </>
  );
}

function RowView({ row }: { row: Row }) {
  const [pretty, setPretty] = useState(false);

  if (row.kind !== 'message') {
    const detail =
      row.kind === 'close' ? [row.reason, row.status, row.error].filter(Boolean).join(' · ') : '';
    return (
      <div
        className={`es:border-y es:border-border es:px-2 es:py-1 ${row.kind === 'close' && row.reason === 'error' ? 'es:text-error' : 'es:text-muted'}`}
      >
        {time(row.t)} ── {row.kind} {detail}
        {closeContext(row)}
      </div>
    );
  }

  let { data } = row;
  if (pretty) {
    try {
      data = JSON.stringify(JSON.parse(row.data), null, 2);
    } catch {
      // not JSON: show as-is
    }
  }
  return (
    <button
      type="button"
      className="es:flex es:w-full es:gap-3 es:px-2 es:py-0.5 es:text-left es:hover:bg-hover"
      onClick={() => setPretty((p) => !p)}
    >
      <span className="es:shrink-0 es:text-muted">{time(row.t)}</span>
      <span className="es:w-20 es:shrink-0 es:truncate es:text-muted">
        {row.event ?? 'message'}
      </span>
      <span className={pretty ? 'es:whitespace-pre-wrap es:break-all' : 'es:truncate'}>{data}</span>
    </button>
  );
}

type MessageRow = Extract<Row, { kind: 'message' }>;
type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => !!v && typeof v === 'object' && !Array.isArray(v);

// Nested objects become dot-path columns ({payload: {id}} → "payload.id");
// arrays and empty objects stay whole in one cell.
function flatten(obj: Fields, prefix = '', out: Fields = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (isObject(v) && Object.keys(v).length) flatten(v, `${prefix}${k}.`, out);
    else out[prefix + k] = v;
  }
  return out;
}

// Rows are append-only and immutable, so each one's data is parsed once.
const parsedRows = new WeakMap<Row, Fields>();

function fields(row: MessageRow) {
  let parsed = parsedRows.get(row);
  if (!parsed) {
    try {
      const json = JSON.parse(row.data);
      parsed = isObject(json) ? flatten(json) : { data: json };
    } catch {
      parsed = { data: row.data };
    }
    parsedRows.set(row, parsed!);
  }
  return parsed!;
}

const cellText = (v: unknown) =>
  typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);

const TH =
  'es:sticky es:top-0 es:z-10 es:border-b es:border-border es:bg-bg es:px-2 es:py-1 es:font-normal';
const TIME = 'es:sticky es:left-0 es:z-10 es:border-r es:border-border es:bg-bg';

function TableView({ rows }: { rows: Row[] }) {
  const messages = rows.filter((r): r is MessageRow => r.kind === 'message');
  const hasEvent = messages.some((r) => r.event);
  const columns = Array.from(new Set(messages.flatMap((r) => Object.keys(fields(r)))));
  const numeric = new Set(
    columns.filter((c) =>
      messages.every((r) => {
        const v = fields(r)[c];
        return v === undefined || typeof v === 'number';
      })
    )
  );

  return (
    <div className="es:flex-1 es:overflow-auto es:bg-bg">
      <table className="es:border-separate es:border-spacing-0 es:whitespace-nowrap">
        <thead>
          <tr>
            <th className={`${TH} es:left-0 es:z-20 es:border-r es:text-left`}>
              <span className="es:text-muted">time</span>
            </th>
            {hasEvent && (
              <th className={`${TH} es:text-left`}>
                <span className="es:text-muted">event</span>
              </th>
            )}
            {columns.map((c) => (
              <th key={c} className={`${TH} ${numeric.has(c) ? 'es:text-right' : 'es:text-left'}`}>
                <span className="es:text-muted">{c}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="es:hover:bg-hover">
              <td className={`${TIME} es:px-2 es:py-0.5`}>
                <span className="es:text-muted">{time(row.t)}</span>
              </td>
              {row.kind === 'message' ? (
                <>
                  {hasEvent && (
                    <td className="es:px-2 es:py-0.5 es:text-muted">{row.event ?? 'message'}</td>
                  )}
                  {columns.map((c) => {
                    const text = cellText(fields(row)[c]);
                    return (
                      <td
                        key={c}
                        title={text}
                        className={`es:text-muted  es:max-w-96 es:truncate es:px-2 es:py-0.5 ${numeric.has(c) ? 'es:text-right es:tabular-nums' : ''}`}
                      >
                        {text}
                      </td>
                    );
                  })}
                </>
              ) : (
                <td
                  colSpan={columns.length + (hasEvent ? 1 : 0)}
                  className={`es:px-2 es:py-0.5 ${row.kind === 'close' && row.reason === 'error' ? 'es:text-error' : 'es:text-muted'}`}
                >
                  ── {row.kind}{' '}
                  {row.kind === 'close' &&
                    [row.reason, row.status, row.error].filter(Boolean).join(' · ')}
                  {closeContext(row)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Props = { theme?: 'light' | 'dark' };

function Panel({ theme = 'dark' }: Props) {
  useSyncExternalStore(
    subscribe,
    () => state.version,
    () => state.version
  );
  const [selectedId, setSelectedId] = useState<string>();
  const [variant, setVariant] = useState<'normal' | 'table'>('table');

  // A hot reload inserts the new <style> but React never removes the old one,
  // whose deleted rules would keep applying.
  useEffect(() => {
    for (const el of document.querySelectorAll('style[data-href^="event-source-devtool-"]'))
      if (el.getAttribute('data-href') !== STYLE_HREF) el.remove();
  }, []);

  const list = Array.from(state.streams.values()).reverse();
  const selected = (selectedId && state.streams.get(selectedId)) || list[0];

  return (
    <div
      data-es-theme={theme}
      className="es-root es:flex es:h-full es:bg-bg es:font-mono es:text-xs es:text-fg"
    >
      {/* React 19 hoists and dedupes this by href; styles ship with the panel. */}
      <style href={STYLE_HREF} precedence="default">
        {css}
      </style>
      <div className="es:flex es:w-2/5 es:flex-col es:border-r es:border-border">
        <div className="es:flex es:items-center es:justify-between es:border-b es:border-border es:px-2 es:py-1">
          <span className="es:text-muted">{list.length} streams</span>
          <button type="button" className="es:underline" onClick={clear}>
            Clear
          </button>
        </div>
        <div className="es:flex-1 es:overflow-auto">
          {list.map((s) => {
            const { dot, color } = status(s);
            const last = s.rows.at(-1);
            return (
              <button
                type="button"
                key={s.id}
                title={s.url}
                onClick={() => setSelectedId(s.id)}
                className={`es:flex es:w-full es:gap-2 es:px-2 es:py-1 es:text-left es:hover:bg-active ${s === selected ? 'es:bg-selected' : ''}`}
              >
                <span className={color}>{dot}</span>
                <span className="es:w-10 es:shrink-0 es:text-muted">
                  {s.transport === 'eventsource' ? 'es' : 'fetch'}
                </span>
                <span className="es:flex-1 es:truncate">{path(s.url)}</span>
                {last?.kind === 'close' && (
                  <span className={color}>
                    {last.reason}
                    {last.status && last.status !== 200 ? ` ${last.status}` : ''}
                  </span>
                )}
                <span className="es:text-muted">{s.count}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="es:flex es:min-w-0 es:flex-1 es:flex-col">
        <section className="es:flex es:gap-2 es:flex-row es:items-start es:px-2 es:py-1">
          <button type="button" className="es:underline" onClick={() => setVariant('normal')}>
            Normal
          </button>
          <button type="button" className="es:underline" onClick={() => setVariant('table')}>
            Table
          </button>
        </section>
        {variant === 'normal' ? (
          <div className="es:flex-1 es:overflow-auto">
            {selected?.rows.map((row) => (
              <RowView key={row.key} row={row} />
            ))}
          </div>
        ) : (
          <TableView rows={selected?.rows ?? []} />
        )}
      </div>
    </div>
  );
}

// Like TanStack's own EventClient: the consumer's bundler replaces NODE_ENV,
// folds this to the no-op in production and tree-shakes the panel, its CSS
// and the store. The library build can't do it; one dist serves both modes.
export const EventSourcePanel: (props: Props) => ReactNode =
  process.env.NODE_ENV === 'development' ? Panel : () => null;
