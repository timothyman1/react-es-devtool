import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    // Keep tsc's .d.ts files across `vite build --watch` rebuilds.
    emptyOutDir: false,
    lib: { entry: 'src/event-source.tsx', formats: ['es'], fileName: 'index' },
    rolldownOptions: {
      external: [/^react(\/|$)/, '@tanstack/devtools-event-client']
    }
  }
})
