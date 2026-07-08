# Hero icon animation — vote tally effect

## Goal
Animate the blue app icon in the homepage hero (`public/index.html`) so its three bars fill in left to right, like votes being tallied. Plays once on page load, then holds. No JS, no loop, no effect on the nav bar logo (same rect markup, different element).

Why this approach: views in this app toggle via `display:none/block` (see `.view` / `.view.active` in `index.html`, and the show-view logic around line 695) rather than re-rendering the DOM. That means a CSS `animation ... 1 both` fires once on initial load and stays in its end state even when the user bounces between views client-side — exactly the "tally once, then rest" behavior we want, with zero JavaScript.

## File
`public/index.html`

## Tasks

- [x] Find the hero icon markup (currently around line 163, inside the `#view-home` hero block — the `<div style="background:#2563eb">` wrapping an `<svg>` with 3 `<rect>` bars).
- [x] Add a `hero-icon` class to that `<svg>` tag only. Do **not** add it to the nav bar logo svg near the top of the file (same rect pattern, must stay static).

  ```html
  <svg viewBox="0 0 24 24" class="w-10 h-10 hero-icon" fill="#ffffff" aria-hidden="true">
    <rect x="3" y="5" width="18" height="4" rx="2"/>
    <rect x="3" y="10" width="13" height="4" rx="2" fill-opacity="0.6"/>
    <rect x="3" y="15" width="9" height="4" rx="2" fill-opacity="0.6"/>
  </svg>
  ```

- [x] Add the animation CSS to the `<style>` block near the top of the file (drop it near the other component-specific styles, e.g. after the RSVP button rules around line 90-95):

  ```css
  /* ── Hero icon vote-tally animation ──────────── */
  .hero-icon rect { transform-box: fill-box; transform-origin: left; }

  @keyframes tallyBar1 {
    0%   { transform: scaleX(0); }
    14%  { transform: scaleX(0.38); }
    30%  { transform: scaleX(0.38); }
    31%  { transform: scaleX(0.66); }
    50%  { transform: scaleX(0.66); }
    51%  { transform: scaleX(0.88); }
    70%  { transform: scaleX(0.88); }
    71%  { transform: scaleX(1.06); }
    85%, 100% { transform: scaleX(1); }
  }
  @keyframes tallyBar2 {
    0%, 18% { transform: scaleX(0); }
    32%  { transform: scaleX(0.4); }
    46%  { transform: scaleX(0.4); }
    47%  { transform: scaleX(0.7); }
    64%  { transform: scaleX(0.7); }
    65%  { transform: scaleX(0.92); }
    82%  { transform: scaleX(0.92); }
    83%  { transform: scaleX(1.06); }
    95%, 100% { transform: scaleX(1); }
  }
  @keyframes tallyBar3 {
    0%, 34% { transform: scaleX(0); }
    48%  { transform: scaleX(0.45); }
    60%  { transform: scaleX(0.45); }
    61%  { transform: scaleX(0.78); }
    76%  { transform: scaleX(0.78); }
    77%  { transform: scaleX(1.06); }
    92%, 100% { transform: scaleX(1); }
  }
  .hero-icon rect:nth-child(1) { animation: tallyBar1 1.8s cubic-bezier(.3,.9,.4,1) 1 both; }
  .hero-icon rect:nth-child(2) { animation: tallyBar2 1.8s cubic-bezier(.3,.9,.4,1) 1 both; }
  .hero-icon rect:nth-child(3) { animation: tallyBar3 1.8s cubic-bezier(.3,.9,.4,1) 1 both; }

  @media (prefers-reduced-motion: reduce) {
    .hero-icon rect { animation: none !important; }
  }
  ```

- [x] Verify: open `public/index.html` in a browser (or run `python3 -m http.server` from inside `public/` and hit `localhost:8000`). Reload the page — bars should tick in left to right, top to bottom, then sit still. Confirm the nav bar logo (top-left "Huddle" wordmark icon) does not animate.
- [x] Verify: switch to another view (e.g. click "Home" nav button, or navigate into a poll flow and back) and confirm the hero icon does not replay — it should already be sitting in its final, fully-filled state.
- [x] Verify: enable "reduce motion" in OS accessibility settings, reload, confirm bars appear static/full immediately with no animation.

## Ship it
Once verified, use the deploy-reference skill for the GitHub push + Fly.io deploy steps (repo pushes under the `catdad-ship-it` GitHub account).
