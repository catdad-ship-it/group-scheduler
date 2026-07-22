# SEO Improvement Plan — huddlr.co

Goal: move from "technically well-tagged single page with almost no rankable
content" to "a small site Google can actually rank for the phrases people
search." The technical metadata baseline (OG, Twitter, JSON-LD, robots,
sitemap, canonical, GSC verification tag) is already in place — see the
`<head>` of `public/index.html`. This plan covers items 1–6: the content and
indexing work that lifts placement.

Ordered by impact. Items 1, 2, 4, 6 are pure edits to `public/index.html`.
Item 3 adds new static pages. Item 5 is external (Search Console).

---

## 1. Rewrite the `<h1>` as a keyword phrase (not the wordmark)

**Problem.** The only `<h1>` on the indexable page is literally `Huddlr`
(`public/index.html:289`). The single strongest on-page ranking signal is
spent on a brand word nobody searches for.

**Change.**
- Make the H1 a descriptive phrase, e.g.
  `Group scheduling & availability polls`.
- Keep the "Huddlr" wordmark visible, but as styled text / the logo mark, not
  as the H1. Options: wrap the wordmark in a `<span>`/`<div>` with the same
  classes, or give the logo SVG an `aria-label="Huddlr"`.
- Keep exactly one `<h1>` in the home view. The other `<h1>`s in the file are
  in app views (Create, My Polls, Branding, poll view) that are `noindex` via
  robots.txt + canonical, so they don't compete — leave them.

**Acceptance.** Home view renders one `<h1>` containing the target phrase;
"Huddlr" still reads as the brand visually; no layout regression at the
`sm:` breakpoint.

**Effort.** ~15 min.

---

## 2. Add real body copy to the homepage

**Problem.** Visible text is ~3 short lines + four card labels. Thin content
is the actual ranking ceiling — Google has nothing to match queries against.

**Change.** Add below-the-fold marketing sections to `#view-home`, using a
proper heading hierarchy (`<h2>`/`<h3>`), natural keyword phrasing, and
crawlable text (not icon-only):
- **How it works** — 3 steps: create a poll → share the link → the group
  decides. (Some copy already exists under the "How it works" comment; expand
  it into indexable prose.)
- **Four poll types, one paragraph each** — expand the existing card labels
  (Find a Time, Availability Grid, Ask a Question, Quick RSVP) into a short
  explanatory paragraph each, worked around real phrases: "find a meeting
  time," "collect everyone's availability," "ranked-choice vote," "quick
  headcount / RSVP."
- **Why Huddlr** — short value props: free, no account needed to vote, share
  by link/QR, works on mobile.
- **FAQ** — 5–8 Q&As (feeds item 4). Examples: "Is Huddlr free?", "Do voters
  need an account?", "How is this different from a group text?", "How many
  people can vote?", "Can I use it for scheduling a meeting?"

**Guardrails.**
- Write for humans first; no keyword stuffing.
- Content must be in the initial HTML (server-sent), not injected by JS after
  load, so crawlers see it without executing scripts.
- Keep it inside `#view-home` so it stays hidden on app routes.

**Acceptance.** Homepage has a logical H1→H2→H3 outline; several hundred words
of unique, readable copy; renders with JS disabled.

**Effort.** ~2–3 hrs (mostly copywriting).

---

## 3. Build dedicated landing pages for top queries

**Problem.** One page can't rank for everything, and the canonical
deliberately collapses all SPA routes to `/`. Need separate indexable URLs
for distinct intents.

**Approach (fits current architecture).** `express.static` serves `/public`
*before* the SPA catch-all (`server.js:180` then `server.js:1138`), so a real
file at `public/meeting-scheduler/index.html` is served directly at
`/meeting-scheduler` — a genuine crawlable document, no client routing, no
server changes.

**Pages (start with 2–3, expand later):**
- `/meeting-scheduler` — "Find a Time" intent
- `/availability-poll` — "Availability Grid" intent (When2meet-style)
- `/ranked-choice-vote` — "Ask a Question" intent
- `/rsvp` — "Quick RSVP" intent
- (later) a comparison page, e.g. "free When2meet alternative"

**Each page needs:**
- Its own `<title>`, meta description, and **self-referencing** canonical
  (`https://huddlr.co/meeting-scheduler` — NOT pointing back to `/`).
- A unique keyword-targeted `<h1>` and unique body copy (don't clone).
- The shared header/footer and a clear CTA into the app (`startCreate(...)`).
- An OG/Twitter block (can reuse the shared og-image initially).

**Also update:**
- `public/sitemap.xml` — add a `<url>` entry per new page.
- `public/robots.txt` — these are marketing pages, so they should be
  crawlable. Current `Allow: /$` only allows the exact homepage; confirm the
  new paths aren't caught by a `Disallow`. Simplest: keep `Disallow` rules
  targeting only the app areas (`/api/`, `/dashboard`, `/clients/`,
  `/branding`, `/*?poll=`) and drop the restrictive `Allow: /$` so the new
  static pages are crawlable by default.

**Watch out.** Avoid thin/duplicate pages — each must justify its existence
with unique content, or it hurts more than it helps. Ship 2 good ones before
adding more.

**Effort.** ~1–1.5 hrs per page after the first (first one sets the template).

---

## 4. Add FAQ structured data (`FAQPage` JSON-LD)

**Problem.** Missing an easy shot at rich results / extra SERP real estate.

**Change.**
- Add a second `<script type="application/ld+json">` block in `<head>` with
  `@type: FAQPage`, mirroring the visible FAQ from item 2.
- **Every** Q&A in the JSON-LD must appear verbatim in the visible page copy —
  Google requires parity, and mismatches are a manual-action risk.
- Validate with Google's Rich Results Test before shipping.

**Dependency.** Do item 2's FAQ first (or together).

**Effort.** ~30 min.

---

## 5. Complete Search Console verification & submit sitemap

**Problem.** The `google-site-verification` meta tag is present
(`public/index.html`) but verification/submission isn't confirmed done. Until
this is finished we're flying blind on which queries we impress for.

**Steps (external, in Google Search Console UI):**
1. Verify the `https://huddlr.co` property (the meta tag is already deployed,
   so the HTML-tag method should pass immediately).
2. Submit `https://huddlr.co/sitemap.xml`.
3. Use URL Inspection → Request Indexing for `/` and each new landing page
   from item 3.
4. After a few days, check the Performance report for actual query/impression
   data and feed it back into copy and future landing pages.

**Note.** This is a manual step for Brady in the GSC dashboard — not a code
change. No credentials handled here.

**Effort.** ~20 min + waiting for Google to crawl.

---

## 6. Tighten the meta description

**Problem.** Current description is ~250 chars; Google truncates around
~155–160, so the tail is wasted and the key phrase isn't front-loaded.

**Change.** Rewrite to ~150 chars, key phrase first. Draft:
> Free group scheduling & availability polls. Find a meeting time, run a
> ranked-choice vote, or take a quick RSVP — share a link, no account needed
> to vote.

- Update the plain `<meta name="description">`.
- Consider aligning `og:description` / `twitter:description` (these can be
  slightly longer/punchier since they're for social cards, not SERP snippets —
  keep them as-is if they read well).

**Effort.** ~10 min.

---

## Suggested sequencing

1. **Batch A (one edit pass to `index.html`, deploy together):** items 1, 2,
   4, 6 — H1, body copy + FAQ, FAQ schema, meta description.
2. **Batch B:** item 5 — verify GSC, submit sitemap, request indexing for `/`.
3. **Batch C:** item 3 — landing pages, one at a time; add each to sitemap and
   request indexing as it ships.

Batch A is the biggest single lift (content thinness is the real ceiling) and
should go first. Items 7–9 from the earlier discussion (backlinks, blog
content, Core Web Vitals / build step) are out of scope here but are the
longer-term authority plays once this foundation is live.

---

## Out of scope for this plan (tracked elsewhere / needs input)
- **Backlinks & directory listings** (Product Hunt, AlternativeTo, "best
  When2meet alternatives" roundups) — the real authority lever for a new
  domain; needs positioning input.
- **Blog / long-tail articles** — future.
- **Core Web Vitals / real build step** (Tailwind Play CDN → self-hosted) —
  already tracked in `CODE_REVIEW_PLAN.md` 4.7.
