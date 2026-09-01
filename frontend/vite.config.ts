// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // Production build target. The lovable config defaults nitro to Cloudflare;
  // we deploy the frontend to Vercel (serverless SSR), so override the preset.
  // The `/api/*` same-origin proxy in production is a Vercel rewrite — see
  // vercel.json — mirroring the dev-only vite proxy below.
  nitro: { preset: "vercel" },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    server: {
      // Dev-only: forwards /api/* to the Express backend so the browser sees
      // everything as same-origin — the session cookie (express-session)
      // round-trips without any CORS configuration on the backend. Not a
      // production deployment concern yet (unspecified). Port 3001, not the
      // Express default 3000 — an unrelated container on this machine
      // already occupies 3000.
      proxy: {
        "/api": {
          target: "http://localhost:3011",
          changeOrigin: true,
        },
      },
    },
  },
});
