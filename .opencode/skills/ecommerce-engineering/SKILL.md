---
name: E-commerce Engineering
description: Use when changing ZASHM's catalog, cart, checkout, coupon/pricing, inventory, order lifecycle, shipping, tracking, or conversion flow.
---

# ZASHM E-commerce Engineering

## Mission

Protect revenue and customer trust: every price, discount, stock movement, and
order transition must be correct under concurrency and honest to the customer.

## Domain model

```
Product ──< Cart line ──> Order ──> status lifecycle
   │                        │
   └── variantStock          └── coupon (optional, one code per order)
```

- **Product:** `price`, optional `salePrice` (effective price = `salePrice` when
  present and lower), `stock`, `variantStock` keyed `"<size>-<color>"`, `active`.
- **Cart line:** product + size + color + qty. Availability is computed from the
  matching variant when the product has variants, otherwise from global stock.
- **Order id:** `ZSH-<RANDOM>-<SUFFIX>`; generated server-side.
- **Statuses (in order):** `Pending`, `Confirmed`, `Processing`, `Shipped`,
  `Delivered`, `Cancelled`. Only transitions supported by the admin UI/SQL may be
  used; cancellation restores stock and coupon usage exactly once.
- **Coupon:** `percentage` or `fixed`, with `minOrderAmount`, `maxDiscount`,
  `usageLimit`, `usageCount`, `startDate`, `endDate`, `active`.
- **Shipping:** Egypt governorates via `EGYPT_GOVERNORATES`/`getShippingCost`;
  free-shipping threshold and Cairo-local dates are server-side facts.
- **Tracking:** order id + HMAC token (`?track=<id>&tk=<token>`), optionally
  expiring; limited-access views mask PII.

## Money rules (non-negotiable)

1. The browser may display a preview, but `api/orders.js` is the authority.
2. Server recomputes: line price from the DB product, subtotal, coupon discount
   from the locked coupon row, shipping, and total. Never accept client totals.
3. Round to integer EGP consistently (`Math.round`) and clamp discount to
   `0 <= discount <= subtotal`.
4. `percentage` is the only percentage type; anything else is `fixed`.
5. `maxDiscount` caps a percentage discount; `minOrderAmount` invalidates it
   below the threshold. Mirror these rules in `src/store.js` so the cart preview
   matches the server, but never let the preview decide.
6. Coupon usage increments only after a successful order INSERT, in the same
   transaction. A failed/duplicate order never consumes a use.
7. Cancellation releases one use; deletion restores stock/coupon only when the
   order was not already cancelled. Missing coupons are tolerated
   (`coupon_not_found`) so legacy orders can still be cancelled.

## Inventory rules

- Deduct only after validation, inside `atomic_place_order`; lock products in
  ascending id. `stock = sum(variantStock)` must stay true for variant products.
- For products **without** variants, aggregate demand across all cart lines of
  that product and compare once with global stock.
- Deduction is strict: `missing_product`/`missing_variant`/`unavailable` reject
  the order (409) and change nothing.
- Restore is tolerant: `atomic_adjust_stock(+1)` restores every existing line and
  reports missing products/variants as warnings; `stockRestored` reflects whether
  anything was restored and `partial` flags a partial restore.
- `reservedStock` is **not** part of availability. Do not subtract it. Do not
  write it.
- Never allow negative stock. Treat it as a data incident: stop and report.
- Product deletion is a permanent inventory decision; the admin UI must confirm
  it and explain that historical orders will warn about missing products.

## Cart and checkout UX contract

- Cart persists in `localStorage` under `zashm_cart`; applied discount in
  `sessionStorage` (`zashm_applied_discount`) with only
  `{code,type,value,maxDiscount,minOrderAmount}`.
- Re-validate the coupon when the cart total changes; if it becomes invalid,
  remove it with a clear message rather than silently charging more.
- If stock changed while shopping, show the affected lines and offer
  `reduceCartForStockIssues`/removal; never submit a cart the server will reject
  without explaining why.
- Checkout is guest-based (no Supabase Auth customer account). Required fields:
  name, Egyptian mobile, governorate/city, address; optional email/notes.
- Use an idempotency key per checkout attempt; a retry with the same key+cart is
  a duplicate (safe), same key+different cart is a conflict (409).
- Disable the submit button while pending, show the server error verbatim, and
  never double-submit.
- On success: clear the cart, show the order id, and offer tracking.

## Order lifecycle

- All status changes and deletions go through one SQL function each
  (`atomic_set_order_status`, `atomic_delete_order`) with optimistic concurrency:
  the caller sends the status it read; a mismatch returns `status_changed`.
- Cancel/delete must be idempotent: a second cancel/delete must not restore stock
  or coupon twice.
- Restoring stock/coupon and writing the order happen in one transaction.
- The admin response may include `warnings` (e.g. `legacy_items_skipped`,
  `missing_product`, `coupon_not_found`) — surface them to the operator; do not
  swallow them.
- Coupons referenced by a non-cancelled order cannot be deleted (`coupon_in_use`,
  409). Cancelled orders do not block deletion.

## Analytics and conversion

- Track only real events (page view, product view, add-to-cart, checkout,
  purchase) through `src/lib/analytics.js`/`ga.js`; no fake or duplicate events.
- Never send PII (email, phone, address) to analytics.
- Preserve the current GA opt-out/empty-ID behaviour: no `VITE_GA_ID` means no
  analytics.
- Product JSON-LD (`src/lib/seo.js`) must reflect the effective price and stock
  availability.

## Testing checklist (run on local PostgreSQL, never destructive in production)

- [ ] Place order with/without coupon; totals match the server.
- [ ] Coupon: inactive, expired, future, usage-limit, min-order, max-discount,
      percentage vs fixed, deleted coupon.
- [ ] Concurrent placement of the last unit: exactly one succeeds.
- [ ] Idempotency: same key+cart → duplicate; same key+different cart → conflict.
- [ ] Cancel then cancel again: stock/coupon move once.
- [ ] Delete open order vs already-cancelled order: restore correctly.
- [ ] Missing product/variant: deduction rejects, restore warns and continues.
- [ ] Variant product keeps `stock = sum(variantStock)`.
- [ ] Shipping cost for Cairo, Alexandria, and a frontier governorate.
- [ ] Tracking token valid/expired/tampered; PII masked on limited access.
- [ ] `npm test` and `npm run build` pass; no production data touched.

## Stop conditions

Nonzero/negative `reservedStock`, unexpected stock, duplicate coupon usage,
orders that transition without stock movement, or any operation that could
delete real orders — stop and report before proceeding.
