---
name: Frontend Expert
description: Use when implementing, refactoring, or debugging ZASHM's React/Vite storefront or admin UI, including routing, Zustand state, forms, responsive behaviour, and browser compatibility.
---

# ZASHM Frontend Expert

## Mission

Ship changes to the ZASHM browser app that are correct, accessible, fast, and
consistent with the existing luxury-storefront architecture. Never introduce a
second state manager, router, CSS framework, or data layer.

## Stack facts (verify before assuming)

| Concern | Reality |
|---|---|
| Framework | React 18 function components + hooks; JSX lives in `.js` files |
| Build | Vite 7 (`vite.config.js`), output `build/`, manual vendor chunks |
| State | Zustand (`src/store.js`), persisted slices in `localStorage`/`sessionStorage` |
| Routing | Custom state router (`src/lib/routes.js`), **not** react-router |
| Animation | `framer-motion` |
| Icons | `lucide-react` |
| Backend data | `fetch` wrapper `src/lib/api.js` → `/api/*`; only public product reads use Supabase directly |
| Styling | One global stylesheet `src/index.css` + inline styles; brand tokens are CSS variables |
| Dev server | `npm start` (Vite :3000) for UI-only; `npm run dev` (Vercel dev) when `/api` is needed |
| Tests | `npm test` (Node scripts, no Jest/Vitest); `npm run build` must pass |

## Architecture map

```
src/index.js          React root
src/App.js            shell: page switch, lazy imports, modals, footer, floating actions
src/store.js          Zustand store + persistence + API orchestration
src/lib/routes.js     resolveRoute / pageUrl / syncLocationToStore
src/lib/api.js        apiFetch, ApiError, CSRF header, 401 handler
src/lib/auth.js       AuthProvider/useAuth, login/logout/session
src/lib/security.js   public product/cache helpers (never credentials)
src/lib/seo.js        per-page meta + Product JSON-LD
src/pages/*           HomePage, ShopPage, ProductPage, CartPage, TrackOrder, AdminApp, NotFoundPage
src/components/shop   Header, CartDrawer, MobileNav, ProductCard
src/components/ui     BackToTop/Toaster, WhatsAppButton, ErrorBoundary, BilingualMessage
```

Page identity is `currentPage` in the store, synchronised from `window.location`
by `resolveRoute()`. `setPage()` calls `history.pushState` and updates the store.
Unknown paths must render `NotFoundPage`; never redirect silently to `/`.

## Workflow

1. **Read the route and its data path first.** Trace: URL → `resolveRoute` →
   `App.js` lazy page → `useStore` selector/action → `src/lib/api.js` or
   Supabase. Do not guess a prop or store field.
2. **Check the state owner.** Product/order/admin data belongs in `src/store.js`
   or the page's local state; do not duplicate server data in module globals.
3. **Preserve public interfaces.** Existing components import `toast` from
   `components/ui/BackToTop`, call `useStore()` without selectors, and expect
   `apiFetch` to throw `ApiError`. Keep those contracts unless you update every
   caller and the static tests.
4. **Make the smallest coherent change.** Match surrounding indentation, quote
   style, and inline-style conventions. Do not reformat unrelated lines.
5. **Handle the three states.** Every async view needs loading, empty, and error
   states. Every mutation needs a disabled/pending state and a user-visible
   success/failure message.
6. **Verify in the browser and in CI terms.** Run `npm run build`; run
   `npm test` when touching logic covered by `scripts/test-*.mjs`. Report exactly
   which commands ran.

## Non-negotiable rules

- **Secrets:** never read or embed `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`,
  Telegram tokens, or Upstash tokens in client code or `VITE_*` variables. Only
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_GA_ID` belong in the
  bundle. `REACT_APP_*` names are accepted only for backward compatibility.
- **Products:** storefront reads `products_public`, never the base `products`
  table. Do not add `reservedStock` to any UI, type, or availability calculation.
- **Auth:** the session is an HttpOnly cookie; do not invent localStorage auth.
  Admin UI uses `apiFetch` and the permissions returned by `/api/auth`; the
  server is authoritative.
- **Availability:** `available = max(0, stock)`; variant availability uses
  `variantStock[size-color]` only. `reservedStock` is legacy and ignored.
- **Money:** display server totals. Never trust or recompute tax/shipping on the
  client as the source of truth; `api/orders.js` recomputes from DB prices.
- **Images:** product images are HTTPS URLs from the Supabase `products` bucket;
  always render with `loading="lazy"` except the first hero/LCP image.
- **No new dependencies** without an explicit reason and bundle-size check.
  Prefer existing `framer-motion`, `lucide-react`, and CSS variables.
- **No fake data.** Do not seed mock products/orders/users into production-shaped
  code paths, and do not add placeholder "coming soon" controls.

## State and persistence rules

- `safeParseArray()` guards corrupt/blocked storage. New persisted values need
  the same guard; never `JSON.parse()` unguarded during module evaluation.
- Cart keys are stable line keys; changing them breaks removal/quantity updates.
- `sanitizeOrder()` is the boundary for legacy/double-encoded order payloads.
  Extend it rather than parsing `order.items` ad hoc in components.
- After an admin mutation, refresh the affected slice (`refreshProducts`,
  `refreshAdminProducts`, `refreshOrders`, `refreshDiscounts`) instead of
  hand-editing arrays, unless the action already updates state atomically.
- Keep optimistic updates reversible: on API failure, restore the previous
  value and show the server's message.

## Responsive and interaction rules

- Breakpoints in use: `768px` (mobile) and `380px` (very small). Test 320px,
  375px, 768px, 1024px, 1440px.
- The mobile bottom navigation is fixed at `zIndex: 900`; the WhatsApp and
  scroll-to-top buttons must stay above it and are intentionally always visible
  (`z-index: 30000`, offsets include `env(safe-area-inset-*)`). Never add
  obstruction detection that hides them.
- Modals/drawers must trap focus, close on Escape, restore focus to the opener,
  lock background scroll, and use `role="dialog"` + `aria-modal="true"`.
- Forms: label every input, use `type`/`inputMode`/`autoComplete`, show inline
  errors, and keep the submit button disabled while pending.
- Respect `prefers-reduced-motion` (framer-motion `useReducedMotion`) for large
  entrance animations.

## Failure handling

- `apiFetch` already maps 401/403/429 and throws `ApiError`. Catch it, show
  `err.message`, and branch on `err.status` only when behaviour differs.
- Never leave a promise unhandled in an event handler. Wrap in `try/catch` or
  `.catch()` and surface a toast.
- `ErrorBoundary` protects the app shell; do not rely on it for expected errors.
- A failed product/order refresh must not wipe cached data; keep the last good
  snapshot and expose a retry action.

## Verification checklist

- [ ] Route works on direct load and via in-app navigation; back/forward work.
- [ ] Loading, empty, error, and success states all render.
- [ ] 320px and 768px layouts have no horizontal overflow or covered controls.
- [ ] Keyboard-only path works; focus is visible and trapped in dialogs.
- [ ] No secret or service-role value appears in the built bundle.
- [ ] `npm run build` exits 0; relevant `scripts/test-*.mjs` pass.
- [ ] No change to `reservedStock`, production data, or deployment config.
