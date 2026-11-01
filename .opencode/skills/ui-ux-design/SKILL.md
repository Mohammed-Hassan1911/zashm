---
name: UI/UX Design
description: Use when designing or reviewing ZASHM screens, components, spacing, typography, colour, motion, RTL/Arabic layout, accessibility, and the always-visible WhatsApp/scroll-to-top actions.
---

# ZASHM UI/UX Design

## Brand identity (do not replace it)

ZASHM is a **quiet-luxury Egyptian fashion label**. The UI is dark, editorial,
and restrained: black canvas, warm gold accents, serif display type, generous
whitespace, and minimal chrome. Never introduce bright gradients, playful
illustrations, rounded "SaaS" cards, or a second accent colour.

| Token | Value / source | Use |
|---|---|---|
| Background | `#0a0a0a` (`--bg`) | page canvas |
| Elevated surfaces | `--bg2`, `--bg3` | cards, drawers, inputs |
| Gold | `#c9a84c` (`--gold`) | CTAs, active states, links, focus ring |
| Text | `--text`, `--text2`, `--text3` | primary / secondary / muted |
| Border | `--border` | 1px hairlines |
| Display font | Cormorant Garamond | headings, prices, editorial copy |
| UI font | Montserrat | body, labels, buttons |
| Radius | small (2–8px) | sharp luxury feel; pills only for badges |
| Motion | 200–400ms ease-out | subtle, never bouncy |

Tokens are defined in `src/index.css`; reuse them. Inline styles are common in
this codebase — match the surrounding pattern rather than introducing CSS
modules or Tailwind.

## Layout system

- Max content width is roughly `1280px` with `24px` desktop / `16px` mobile
  gutters. Keep consistent vertical rhythm (multiples of 4/8px).
- Product grids: 4 columns desktop, 2 tablet, 1 small mobile; never let cards
  overflow their container (`min-width: 0` on grid children).
- Section headings pair a small gold eyebrow label with a large serif heading.
  Use sentence case in English and natural Arabic, not ALL CAPS for long text.
- The site is bilingual (English + Arabic). Keep both languages in copy where the
  existing pattern does; do not machine-translate brand names.

## Accessibility baseline (WCAG 2.1 AA)

- Contrast: body text ≥ 4.5:1, large text ≥ 3:1. Gold on black passes for large
  text and UI, not for small body copy; use `--text` for paragraphs.
- Every interactive element is a real `<button>`/`<a>` with an accessible name.
  Icon-only buttons need `aria-label` and a visible focus ring.
- Never remove focus outlines without a replacement. Use
  `:focus-visible` styling in gold.
- Images need meaningful `alt`; decorative images use `alt=""`.
- Announce async results with the existing toast system; toasts should use
  `role="status"`/`aria-live="polite"` (assertive only for errors).
- Modals: `role="dialog"`, `aria-modal="true"`, labelled by the heading, Escape
  closes, focus is trapped and restored.
- Forms: visible labels (not placeholder-only), `aria-invalid`, and error text
  linked with `aria-describedby`.
- Respect `prefers-reduced-motion`; disable parallax/large transitions.

## The floating actions (hard requirement)

The WhatsApp button and scroll-to-top button must **always** be visible and
fixed to the viewport:

- Both use `position: fixed` and `z-index: 30000` via `--floating-action-z`
  (above header 1000, mobile nav 900, drawers/modals 2000–9999, toasts 20000).
- WhatsApp is bottom-left, scroll-to-top bottom-right; on mobile both sit
  `calc(84px + env(safe-area-inset-bottom))` above the mobile nav. Desktop uses
  `24px` + safe-area offsets.
- Never add logic that hides them on scroll, on obstruction, when the keyboard
  opens, or inside modals. They may be visually subdued when inactive (the
  scroll-to-top button is disabled at the top) but must remain rendered.
- Keep at least `12px` between the two buttons and from screen edges.
- Ensure footer/bottom content has enough padding so the buttons do not cover
  links or the last row of content.
- Both need `aria-label`, keyboard focus, and a minimum 44×44px touch target.

## Component patterns

- **Buttons:** primary = gold fill + dark text; secondary = transparent + gold
  border; ghost = text only. One primary action per view. Disabled = reduced
  opacity + `cursor: not-allowed` + `aria-disabled`.
- **Cards:** image first, name, price; hover reveals a secondary action without
  shifting layout. Use `aspect-ratio` to prevent layout shift.
- **Forms:** single column, 16px inputs on mobile (prevents iOS zoom), inline
  validation after blur/submit, never validate on every keystroke.
- **Empty states:** one short sentence + one action, never a dead end.
- **Destructive actions:** explicit confirmation with the object name, red-tinted
  danger styling (existing admin pattern), and a cancel path.
- **Loading:** skeletons match final dimensions; avoid full-page spinners for
  partial updates.

## Copy and tone

- English is concise and editorial; Arabic is warm and formal. Keep the
  `English / العربية` pairing used by `BilingualMessage` and API errors.
- Prices in EGP with the existing formatting; never mix currencies.
- Error copy states what happened and what to do next; never expose stack
  traces, SQL, or internal identifiers.

## Review checklist

- [ ] Brand palette/typography preserved; no new visual language.
- [ ] Spacing consistent; no clipped text, overflow, or layout shift.
- [ ] Mobile 320/375px and desktop 1440px both intentional.
- [ ] Keyboard, screen-reader labels, focus, contrast pass.
- [ ] Floating actions visible and above every layer at every breakpoint.
- [ ] Reduced motion honoured; animation does not block input.
- [ ] Both languages render without truncation or RTL overlap.
