---
name: WTS Tickets
description: Ticket check-in system — a light "office" theme for organizer-facing pages and a dark "kiosk" theme for door/scanning-facing pages, sharing one accent color and one set of status colors.
colors:
  light-navy: "#1a1f3c"
  light-navy-dark: "#10132a"
  light-navy-mid: "#252b52"
  light-red: "#c4294a"
  light-red-dark: "#a02039"
  light-bg: "#f4f5f8"
  light-card: "#ffffff"
  light-text: "#1e293b"
  light-text-muted: "#64748b"
  light-border: "#dde3ed"
  dark-bg: "#000000"
  dark-bg-alt: "#080810"
  dark-surface: "#1c1c1e"
  dark-surface-hover: "#3a3a3c"
  dark-overlay-low: "rgba(255,255,255,0.06)"
  dark-overlay-mid: "rgba(255,255,255,0.1)"
  dark-text: "#ffffff"
  dark-text-muted: "rgba(255,255,255,0.4)"
  dark-border: "rgba(255,255,255,0.1)"
  success: "#10b981"
  danger: "#dc2626"
  danger-soft-bg: "#fef2f2"
  danger-soft-border: "#fca5a5"
  danger-soft-text: "#991b1b"
  warning-bg: "#fef3c7"
  warning-text: "#92400e"
typography:
  body:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: 14px
    fontWeight: "400"
    lineHeight: 1.5
  heading-lg:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: 26px
    fontWeight: "800"
    letterSpacing: -0.5px
  heading-md:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: 18px
    fontWeight: "700"
  label-sm:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: 11px
    fontWeight: "600"
    letterSpacing: 0.6px
  kiosk-display:
    fontFamily: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: clamp(40px, 8vw, 88px)
    fontWeight: "800"
rounded:
  sm: 6px
  DEFAULT: 10px
  md: 13px
  lg: 16px
  pill: 20px
  full: 9999px
spacing:
  unit: 8px
  card-padding: 16px
  section-gap: 24px
components:
  btn-primary-light:
    backgroundColor: "{colors.light-navy}"
    textColor: "#ffffff"
    rounded: "{rounded.DEFAULT}"
    height: 48px
  btn-danger-light:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
    rounded: "{rounded.DEFAULT}"
  btn-pill-dark:
    backgroundColor: "{colors.dark-overlay-mid}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.pill}"
  card-light:
    backgroundColor: "{colors.light-card}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.md}"
    padding: "{spacing.card-padding}"
  card-dark:
    backgroundColor: "{colors.dark-overlay-low}"
    textColor: "{colors.dark-text}"
    rounded: "{rounded.md}"
    padding: "{spacing.card-padding}"
  status-badge-success:
    backgroundColor: "#d1fae5"
    textColor: "#065f46"
    rounded: "{rounded.full}"
  status-badge-warning:
    backgroundColor: "{colors.warning-bg}"
    textColor: "{colors.warning-text}"
    rounded: "{rounded.full}"
  status-badge-danger:
    backgroundColor: "{colors.danger-soft-bg}"
    textColor: "{colors.danger-soft-text}"
    rounded: "{rounded.full}"
---

## Overview

WTS Tickets is a ticket check-in system with two distinct, deliberate visual contexts rather than one uniform theme:

- **Light / office theme** — used wherever an organizer is managing an event at a desk: `dashboard.html`, `register.html` (the public registration form), the auth pages, and the white card on `at-door.html`. Personality: clean, trustworthy, navy-and-white with a warm red/pink accent for primary actions.
- **Dark / kiosk theme** — used wherever the UI is held at a door, scanned quickly, or projected on a screen: `scanner.html`, `checkin.html`, `settings.html` (mobile PWA), and `display.html`. Personality: near-black "frosted glass" — translucent white overlays and backdrop-blur over true black, for glanceability, battery-friendly OLED contrast, and legibility in dim venues.

Both themes share the same font stack and the same *meaning* for status colors (green = success/checked-in, red = danger/error, amber = pending/warning) — only the surface and text colors around them differ. When building a new page or component, decide which context it lives in first, then pull tokens from the matching theme below. Don't blend the two on one screen.

## Colors

**Light theme** (`light-*` tokens, canonical source: `public/style.css` `:root` block):
- `light-navy` (`#1a1f3c`) is the primary surface color for headers, primary buttons, and dark text accents. `light-navy-dark`/`light-navy-mid` are used for gradients and hover states.
- `light-red` (`#c4294a`) is the single brand accent — used for links, active states, and anything that should draw the eye as "the app's color." Do not introduce a second accent hue (a past drift introduced indigo `#4f46e5` on one page — that was corrected, not a second valid accent).
- `light-bg`/`light-card`/`light-text`/`light-text-muted`/`light-border` are the neutral scale for backgrounds, cards, and text hierarchy.

**Dark/kiosk theme** (`dark-*` tokens, canonical source: `public/kiosk.css` `:root` block):
- `dark-bg` (`#000000`) is the base for full-screen camera/scan views; `dark-bg-alt` (`#080810`) is used for settings/detail panels that sit slightly "above" the base.
- `dark-surface` (`#1c1c1e`) is used for opaque sheets/modals; `dark-overlay-low`/`dark-overlay-mid` are the translucent-white card/row backgrounds that give the "frosted glass" look — always over a dark backdrop, never used as a standalone opaque color.

**Status colors** (shared meaning, both themes): `success` (`#10b981`), `danger` (`#dc2626`), and the `warning-bg`/`warning-text` pairing (`#fef3c7`/`#92400e`) are canonical everywhere. Light-theme surfaces mostly use the soft pastel variants (`status-badge-*` components below); dark-theme surfaces use the same hues at full saturation against translucent-white or black backgrounds for contrast. One exception: `display.html`'s full-screen door-display fills the *entire viewport* with the status color, so it uses deliberately darker/muted variants (`--status-success-bg: rgb(16,127,60)`, `--status-warning-bg: rgb(185,85,15)`, `--status-danger-bg: rgb(185,30,30)`) so white text stays legible and it isn't blinding from across a room — same three meanings, adapted for full-bleed use.

## Typography

One font stack everywhere: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`. No custom webfonts.

- `heading-lg` (26px/800) — page/section titles (event name on register.html, "Settings" header on dashboard.html).
- `heading-md` (18px/700) — card/modal titles.
- `label-sm` (11px/600, uppercase, letter-spaced) — section eyebrows ("CUSTOM FIELDS", "ACCESS & SHARING").
- `body` (14px/400) — default running text and form inputs.
- `kiosk-display` — fluid `clamp()` sizing used only on `display.html` for the door-display result name, since that screen is read from a distance.

## Layout

- Base spacing unit is 8px; card interior padding is 16px; the gap between major sections is 24px.
- Light theme: content lives in white cards over a `light-bg` page background, generally with a max content width and generous padding (dashboard settings panel: `max-width: 640px`).
- Dark theme: content is closer to full-bleed (camera viewfinder, full-screen result states), with translucent cards floating directly on the dark background rather than being contained by an outer page margin.

## Elevation & Depth

- Light theme uses flat cards with a 1px `light-border` and an optional soft shadow (`0 2px 12px rgba(0,0,0,0.07)`, `--shadow` in `style.css`) — depth comes from shadow, not blur.
- Dark theme uses `backdrop-filter: blur(20px)` translucent-white layers over the black backdrop — depth comes from blur and alpha layering, not shadow. A sheet/modal in the dark theme is `rgba(10,10,10,0.88)` with `blur(20px)` and a `1px solid rgba(255,255,255,0.1)` top border, not a drop shadow.

## Shapes

- Radius scale: `sm` 6px (small chips), `DEFAULT` 10px (inputs, standard buttons), `md` 13px (cards), `lg` 16px (larger cards/modals), `pill` 20px (kiosk-theme primary action buttons — check-in button, tab-bar icons), `full` for circular avatars/dots.
- The pill-radius convention (20-22px) is specific to the dark/kiosk theme's primary tap targets; the light theme's buttons stay at the smaller `DEFAULT`/`md` radii.

## Components

- **Buttons**: light theme primary actions are navy-filled rectangles (`rounded.DEFAULT`); dark theme primary actions are translucent-white pills (`rounded.pill`). Both themes use the shared `danger` color for destructive actions, just with different surface treatments (solid light-theme danger button vs. a soft red text/pill on dark backgrounds).
- **Cards**: `card-light` (white, bordered) vs. `card-dark` (translucent white over black, blurred). Same padding/radius scale, different surface.
- **Status badges**: `status-badge-success`/`-warning`/`-danger` are pill-shaped, pastel-background/dark-text pairings used for check-in/order/discount-code status everywhere in the light theme; the dark theme expresses the same three states through icon/text color directly (no pill background) since translucent cards already provide the "chip" visual.
- **Tab bar** (dark theme only): `scanner.html`/`checkin.html`/`settings.html` share one `.tab-bar`/`.tab-bar-inner`/`.tab-bar-safe`/`.tab-btn` implementation, now factored into `public/kiosk.css` instead of being copy-pasted per page.

## Do's and Don'ts

- **Do** keep the light/dark split — it's intentional, not inconsistency. Don't try to make `scanner.html` look like `dashboard.html` or vice versa.
- **Do** use the shared `success`/`danger`/`warning-*` tokens for status everywhere, even across the theme boundary — a "checked in" state should always mean the same green, whether you're looking at the dashboard's attendee table or the kiosk scanner's result screen.
- **Don't** introduce a second accent hue in the light theme. `light-red` is it.
- **Don't** hand-roll `.tab-bar` styles again on a new dark-theme page — link `public/kiosk.css`.
- **Don't** add a drop shadow to a dark-theme translucent card, or a backdrop-blur to a light-theme flat card — the depth technique is theme-specific.
