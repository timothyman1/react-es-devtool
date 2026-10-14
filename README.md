# react-es-devtool

A [TanStack Devtools](https://tanstack.com/devtools) plugin that records Server-Sent Events streams, from both `EventSource` and `fetch` responses with `text/event-stream`.

```sh
pnpm add -D react-es-devtool
```

```tsx
import { TanStackDevtools } from '@tanstack/react-devtools'
import { EventSourcePanel } from 'react-es-devtool'

<TanStackDevtools plugins={[{ name: 'EventSource', render: <EventSourcePanel /> }]} />
```

It only runs when `NODE_ENV` is `development`. In production builds it's a no-op and gets tree-shaken. Requires React 18 or later.
