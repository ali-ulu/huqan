# HUQAN Dashboard — Manual UX & Accessibility Audit

This document collects high-priority UX, visual, and accessibility (WCAG 2.1 AA) findings observed during manual testing and code inspection across desktop, tablet, and mobile viewports.

---

## 1. Global UI, Typography & Visual Hierarchy

### 1.1 Small Base Font Sizes & Weak Contrast

- **Where found:** Global UI — body text, sidebar labels, card descriptions, `.homehero p` (`public/css/app.css`).
- **Problem:** Text sizes are critically small (down to 9–11px on narrow screens), and light-gray fonts are used on pale backgrounds.
- **Impact:** High cognitive load, severe readability issues for low-vision users. Fails WCAG AA contrast expectations (>= 4.5:1).
- **How to fix:**
  - Establish a baseline font size: `:root { font-size: 16px; }` and use `rem` or fluid typography `clamp(0.875rem, 1vw, 1rem)` for scaling.
  - Remove micro-sizes like `font-size: 9px / 10px` in CSS media queries.
  - Ensure line-height is at least 1.4–1.6 for body and label text.
  - Darken body text to high-contrast palette tokens (e.g., `#0f1720`).

### 1.2 Microcopy & Card Metrics Clarity

- **Where found:** Cards and microcopy (e.g., "Observability & Queue" metrics cards).
- **Problem:** Key metric numbers and labels are small and low-contrast, with visual emphasis placed on background card gradients rather than data.
- **Impact:** Reduces scanability for monitoring workflows where quick data comprehension is vital.
- **How to fix:**
  - Increase font size and weight for numerical values; ensure a clear visual hierarchy between data and supporting labels.
  - Solidify background overlays behind text to guarantee contrast over gradients.

### 1.3 System Status Indicators (Color Dependence)

- **Where found:** System status indicator (`#sysdot`, `#sys`, "SYSTEM STATUS PARTIAL") and badge dots.
- **Problem:** Relies primarily on color (yellow/green/red) to convey system state without redundant visual shapes or text context.
- **Impact:** Color-blind users or users on monochrome screens cannot reliably assess system health.
- **How to fix:**
  - Pair status dots with explicit text labels, icons, or geometric patterns.
  - Ensure status text updates are announced via `aria-live="polite"`.
  - Hide decorative status dots from screen readers using `aria-hidden="true"`.

---

## 2. Navigation & Mobile Responsiveness

### 2.1 Mobile Touch Targets & Keyboard Focus

- **Where found:** Navigation controls, header language picker (`#locale-selector`), and floating action buttons.
- **Problem:** Interactive elements shrink on smaller screens, falling below the standard touch target size (44x44 CSS px). Visible focus indicators for keyboard navigation are faint or absent.
- **Impact:** Impairs users with motor disabilities and mobile/touch users. Keyboard-only users lose track of their focus state.
- **How to fix:**
  - Enforce minimum hit area: `min-height: 44px; min-width: 44px;` across all interactive buttons and dropdowns.
  - Add explicit focus rings using `box-shadow` or high-contrast `outline` (e.g., `:focus-visible { outline: 2px solid #0173ea; }`).

### 2.2 Layout Overlaps on Narrow Viewports

- **Where found:** Mobile/Tablet views (375px–768px viewports).
- **Problem:** Content feels cramped vertically, and floating rounded action buttons overlap main card containers.
- **Impact:** Obstructs critical data and prevents clicks on underlying elements.
- **How to fix:**
  - Reflow floating controls on mobile breakpoints into a fixed bottom toolbar or sticky footer.
  - Avoid fixed-height containers and nested scrollbars where possible.

---

## 3. Iconography & HTML Semantics

### 3.1 Text-Based Unicode Glyphs Used as Icons

- **Where found:** Navigation sidebar, search bar (`<span>⌕</span>`), and action buttons (`<i>⌂</i>`, `<i>✓</i>`, `<i>⚙</i>`).
- **Problem:** Icons are rendered as raw Unicode characters inside `<span>` and `<i>` tags instead of semantic vector graphics.
- **Impact:**
  - **Screen Reader Noise:** AT attempts to read out raw Unicode characters (e.g., "contains symbol 2315") instead of ignoring decorative icons.
  - **Rendering Issues:** Unicode glyphs render inconsistently across OS environments (macOS vs Windows vs Android) and cannot be reliably aligned or animated with CSS.
- **How to fix:**
  - Replace Unicode spans with inline SVGs or a standard icon set (e.g., Lucide/Heroicons).
  - Mark all decorative icons with `aria-hidden="true"`.

---

## 4. Module-Specific Manual Findings

### 4.1 Home & Header Search

- **Where found:** `public/index.html`, `public/css/app.css`
- **Problem:** The search input placeholder text has low contrast and relies on placeholders as labels.
- **Impact:** Screen readers miss input purpose if labels are unmapped; placeholder disappears on input.
- **How to fix:**
  - Maintain explicit `aria-label` or visible `<label>` for search inputs.
  - Darken placeholder tint (e.g., `color: #6b7b8a`).

### 4.2 Graph — Trust Network Panel

- **Where found:** `public/index.html`, `public/js/home-navigation.js`
- **Problem:** Graph SVG (`#lines`) lacks accessible naming, internal node labels, and keyboard focus routing.
- **Impact:** Screen reader users cannot explore the visualization; keyboard users cannot interact with graph nodes.
- **How to fix:**
  - Add `<title id="graph-title">Trust Network</title>` inside `<svg role="img" aria-labelledby="graph-title">`.
  - Add `tabindex="0"` and `aria-label` to dynamic node elements.

### 4.3 Viewer — Receipt Terminal

- **Where found:** `public/viewer/index.html`, `public/viewer/app.mjs`
- **Problem:** Status region (`#status`) updates dynamically without an explicit live region container.
- **Impact:** Screen reader users are unaware when session states change or new search results arrive.
- **How to fix:**
  - Add `role="status"` or `aria-live="polite"` to `#status`.

### 4.4 Ingest — Run Details

- **Where found:** `#v-ingest-run`, `public/js/ingest-run-detail.js`
- **Problem:** Large raw JSON dumps (`#ingestrunraw`) are presented without collapse/expand toggles or quick-copy affordances.
- **Impact:** Causes fatigue for screen reader users navigating large code blocks.
- **How to fix:**
  - Provide a structured key-value summary first.
  - Wrap raw JSON in an expandable region with `aria-expanded` controls.

### 4.5 Observability — Real-time Events & Charts

- **Where found:** `#obsevents`, Tool usage donut chart.
- **Problem:** Streaming event text containers update without live semantics, and donut charts use color-only legends.
- **Impact:** Real-time log lines are missed by AT users.
- **How to fix:**
  - Set `role="log" aria-live="polite"` on `#obsevents`.
  - Provide accessible text descriptions for donut charts and ensure high contrast for chart labels.

---

## Summary of Automated Artifacts

Automated scans (`npm audit`, `pa11y`, `lighthouse`) have been executed and saved under `review/automated/`. Human-readable WCAG findings are extracted in `review/pa11y_issues.md`.
