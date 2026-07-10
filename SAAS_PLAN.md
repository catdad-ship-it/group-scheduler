# group-scheduler → SaaS: Build Plan

This is the working plan for turning the single-user scheduling tool into a multi-tenant SaaS. It's written to be handed to Claude Code in the terminal — work it phase by phase. Each phase is shippable on its own and has acceptance criteria so we know when it's actually done.

## How to use this doc with Claude in the terminal

Open the repo and start Claude:

```bash
cd /Users/brady/Dev/group-scheduler
claude
```

Then point it at a phase, e.g.:

> Read SAAS_PLAN.md and implement Phase 1. Work through the tasks in order, check them off in the file as you go, and stop at the acceptance criteria so I can test before we move on.

Do one phase per session. Don't let it jump ahead — each phase depends on the last.

---

## Current state (as of Phase 0–2 + follow-ups being done)

- **Stack:** Node + Express, deployed on Fly.io at `huddlr.co` (custom domain; the old `group-scheduler.fly.dev` URL still works too).
- **Auth:** magic-link email login (Resend, sending from `login@huddlr.co`). Sessions are signed JWT cookies, 90 days, survive restarts/redeploys.
- **Storage:** Postgres (`users`, `polls`, `slots`, `votes` as real rows). The old `polls.json` file/volume is kept around untouched as a cold fallback, not read by the app anymore.
- **Multi-tenancy:** every poll has an owner; admin actions (confirm, edit, delete) check "do you own this poll," not a shared password. Voting stays anonymous — no login required to respond to a poll.
- **Poll types:** schedule, question, rsvp, availability.

<details>
<summary>Original starting state (pre-Phase 0, for history)</summary>

- One shared admin password (`ADMIN_PASSWORD`, defaulted to `brady`). "Admin" = Brady, full stop.
- All polls in a flat `polls.json` file. Sessions in an in-memory `Map`, wiped on every restart/redeploy.
- Every gap between that and a SaaS came from one assumption baked in everywhere: **one owner, one machine.** Phases 0–2 unwound that.
</details>

## Guiding principles

- **Don't rewrite.** Node/Express on Fly is fine. We're adding, not replacing.
- **Each phase ships.** No six-week branch. Every phase ends deployable.
- **Migrate data, don't lose it.** `polls.json` has real polls in it. Keep them.
- **Editable over clever.** Prefer boring, obvious code Brady can read and change.

## Tech decisions (defaults — change here if you disagree)

- **Database:** Fly Postgres (already on Fly, keeps everything in one place, one bill). Alternative if we want managed/serverless: Neon.
- **Auth:** magic-link email login. No passwords to store, no reset flow to build, fits a tool where people already expect email links.
- **Sessions:** signed cookies (JWT) so a redeploy doesn't log everyone out, and it works if Fly runs more than one machine.
- **Email:** Resend (simple API, generous free tier) for magic links + notifications.
- **Billing:** Stripe Checkout + one webhook. Not built until people are actually using it (Phase 3).

---

## Phase 0 — Prep & safety net

Small stuff first so the real work is safe.

- [x] Back up current data: copy `polls.json` to `polls-backup-<date>.json` (there's already one — make a fresh one).
- [x] Confirm `ADMIN_PASSWORD` is set as a real Fly secret, not the default, before any other changes ship.
- [x] Add a `.env.example` documenting every env var the app will need (DB URL, JWT secret, Resend key, Stripe keys).
- [x] Create a `dev` branch so `main` stays deployable.

**Acceptance:** fresh backup exists, `dev` branch created, no behavior change in prod.

## Phase 1 — Accounts & multi-tenancy (the real SaaS unlock)

Right now "admin" means Brady. It needs to mean "whoever created this poll." This is the biggest phase and the one that makes it a product. Do it together with Phase 2 — accounts need somewhere to live.

- [x] Add a `users` concept: id, email, createdAt, plan (default `free`).
- [x] Add `ownerId` to every poll.
- [x] Build magic-link login: enter email → emailed a one-time link → clicking it sets a signed session cookie.
- [x] Replace the single-password check. Every admin route (`list polls`, `confirm`, `unconfirm`, `patch title`, `delete poll`, `delete vote`) changes from "is this THE admin?" to "does the logged-in user own THIS poll?"
- [x] **Creating a poll requires an account.** Anonymous visitors cannot create polls — the create flow is gated behind login, and poll creation attaches the logged-in user as owner. (**Voting stays anonymous** — no login to respond to a poll.)
- [x] Admin poll list shows only the current user's polls.
- [x] Keep public voting exactly as-is — voters never log in.

**Acceptance:** two different accounts can each create polls and only see/manage their own; a voter with a poll link can still vote without any login; Brady's old shared password no longer grants access to everything.

## Phase 2 — Move off the JSON file to Postgres

`polls.json` can't handle two people writing at once and won't survive Fly relocating the machine. This and Phase 1 are best shipped together.

- [x] Provision Fly Postgres and attach it to the app (commands below).
- [x] Schema: `users`, `polls`, `slots`, `votes` (votes and slots as real rows, not JSON blobs, so we can query them).
- [x] Write a one-time migration script that reads `polls.json` and inserts every existing poll/slot/vote. Assign existing polls to Brady's account.
- [x] Swap `loadDB()`/`saveDB()` for real queries. Delete the file-based path once migration is verified.
- [x] Move sessions to signed JWT cookies (drop the in-memory `Map`).

**Acceptance:** all existing polls show up under Brady's account after migration; app survives a redeploy with sessions and data intact; two simultaneous votes don't clobber each other.

## Post-Phase 2 follow-ups (done)

Small things that came up right after Phase 1+2 shipped, done before moving on to Phase 3:

- [x] Registered `huddlr.co` and moved the app to it (Fly custom domain + cert). The old `group-scheduler.fly.dev` link still works too — nothing broke for existing shared poll links.
- [x] Verified `huddlr.co` in Resend and switched magic-link emails to send from `login@huddlr.co`, replacing the sandbox sender that could only email Brady's own address. Real signup emails now actually deliver to anyone.
- [x] Extended the login session from 30 to 90 days, so magic-link email is needed less often. (Considered adding password login as an alternative — decided against it for now: it would bring back password-hashing and brute-force-protection responsibilities that magic-link was chosen specifically to avoid.)

## Phase 3 — Billing (Stripe)

- [x] Define tiers (revised from the original draft after discussion). **Free** = 3 active polls (no `confirmed_slot` and not past `deadline`), schedule/question/rsvp types only. **Pro = $5/mo** (launch-price, well below the original $15–20 positioning target — intentional, revisit once there are real payers) = unlimited active polls + the `availability` poll type. Deadline reminders and custom branding stay Phase 4 — they don't exist as features yet, so Pro isn't gated on them at launch.
- [x] Stripe Checkout for upgrade (`POST /api/billing/checkout`, subscription mode).
- [x] Webhook that flips `user.plan` on `checkout.session.completed`, `customer.subscription.deleted`, and `invoice.payment_failed` (`POST /api/webhooks/stripe`).
- [x] Enforce limits at poll-creation time — 402 with an upsell message, checked both client- and server-side.
- [x] Billing settings page: current plan, upgrade button (free) or manage-billing button via Stripe portal (pro).
- [x] Grandfathering: `scripts/grandfather-existing-users.js` sets every pre-existing user to `plan='pro'` — written but **not yet run**; run it once at prod cutover, right before this ships.
- [x] Downgrade behavior: cancelling/failed payment flips to `free` but never touches existing polls — only blocks *creating new* polls (or using `availability`) while over the cap.

**Verified locally (2026-07-09):** Stripe CLI installed and logged in to a test-mode sandbox account, created the `Huddlr Pro` product + $5/mo price, ran `stripe listen --forward-to localhost:3010/api/webhooks/stripe` for a local `whsec_...`. Full round trip exercised with a real test-mode Checkout session and card `4242 4242 4242 4242`: `checkout.session.completed` flipped the dev user (`niemanbrady@gmail.com`) to `plan='pro'` with `stripe_customer_id`/`stripe_subscription_id` set, billing page correctly showed the Pro state; cancelling the subscription (exercising the same `customer.subscription.deleted` path the billing portal uses) flipped the user back to `plan='free'` and the UI reverted to the upgrade prompt. One hiccup along the way: the dev server happened to be down for the first checkout completion, so that webhook 200'd only after `stripe events resend <id>` was used to redeliver it once the server was back up — worth noting Stripe's own retry schedule would have eventually redelivered it anyway.

**Acceptance:** a free user hits the cap and gets an upgrade prompt (✅ verified locally); paying flips them to Pro and unlocks features (✅ verified locally, 2026-07-09); cancelling downgrades them (✅ verified locally, 2026-07-09 — tested by cancelling the subscription immediately via the Stripe API, which fires `customer.subscription.deleted` and correctly flips the user back to `free`. Note: the actual billing-portal "cancel" button defaults to scheduling cancellation for period end rather than cancelling immediately, so `customer.subscription.deleted` — and the downgrade — wouldn't fire until the period elapses in that flow; the webhook handler itself was verified, but that specific portal-driven timing wasn't).

**Deploy timing (deliberately deferred):** the build above is done and verified locally, but merging to `main` and deploying is intentionally pushed to the end of the roadmap — see **Phase 9**. Decision (2026-07-09): don't turn on billing for real until the product is more robust (Phases 4–8), not right after it's built.

## Phase 4+ — Backlog, prioritized (2026-07-09)

Below supersedes the old one-shot "Phase 4" draft. Source: a product-review backlog dumped into `TODO.md` on 2026-07-09 (14 items, unprioritized), now sequenced against the positioning decision and what's actually shipped. Custom domain is done (huddlr.co is live) so it's dropped from the list below.

### Before/alongside Phase 4 — not a phase, just don't skip these

- [x] **Mobile QA pass on the availability-grid drag-to-paint.** Verified 2026-07-09: the core interaction already used unified Pointer Events (not raw mouse events) and `.avail-cell` already had `touch-action: none` scoped correctly in the stylesheet — both right. Found and fixed one real bug: the grid container (`#avail-grid`) had a *redundant* inline `touch-action:none` that over-applied to the header row and time-label column too, which would've blocked native horizontal swipe-scroll on any poll wide enough to overflow a phone screen (a 7-day poll needs ~389px, wider than an iPhone SE's 375px). Removed the inline override; `.avail-cell`'s own `touch-action: none` still correctly locks out scroll during an actual paint-drag. Re-verified the paint interaction itself with simulated touch-type Pointer Events after the fix — still paints correctly across a drag. Caveat: a headless browser can't fully simulate the OS-level native scroll gesture itself, so the scroll-restoration specifically wasn't observed end-to-end, only the CSS precondition for it (`touch-action: auto` on non-cell elements) — worth a real-device check next time Brady has a phone in hand.
- [x] **Automated DB backups + basic uptime monitoring.** Done 2026-07-10. **Backups:** `group-scheduler-db`'s daily volume snapshots were already running (5-day retention) — confirmed via `fly volumes snapshots list`, not just assumed. Added WAL-based continuous backups on top (`fly postgres backup enable`, 7-day recovery window, base backup every 24h) for point-in-time recovery instead of once-daily granularity; required scaling the Postgres VM from 256MB→512MB (~$1.30/mo) since backups need ≥512MB. Also bumped volume snapshot retention 5→14 days. **Monitoring:** self-hosted Uptime Kuma as its own Fly app (`huddlr-uptime`, separate app/volume from production — avoids UptimeRobot's free-tier ToS ban on commercial use), watching `https://huddlr.co` every 60s. Alerts via email over Resend SMTP (dedicated `uptime-kuma-smtp` API key, not the production one) to `niemanbrady@gmail.com`. Verified with a real forced-down test (bad URL, 0 retries) — both the down alert and the recovery alert landed correctly. **Mistake made and fixed along the way:** an early attempt to script around a Tigris ToS prompt (`fly storage create` without realizing it auto-attaches to the app in the current directory) accidentally added stray AWS/Tigris secrets to the *production* `group-scheduler` app and triggered two unplanned rolling restarts. Caught immediately, secrets removed, bucket destroyed, prod health double-checked (both huddlr.co and the fly.dev URL returned 200 throughout) — no lasting impact, but worth remembering: never run `fly storage create` (or similar app-context-sensitive commands) without an explicit `-a` or from a directory with no `fly.toml` at all.

### Phase 4 — Close the confirm loop

Small, no new infra, directly improves the core flow every poll already goes through (vote → confirm). Fastest path to shipping something.

- [~] Voter self-edit — deferred at Brady's request during the 2026-07-10 build round. Research is done and preserved (see the plan history): the server already does a blind upsert on `(poll_id, name_lower)` with no ownership check, so this is a UX problem (helping a voter find/reopen their own response), not a security one. Two viable approaches scoped — a same-session name-lookup (no new infra) or a personal magic-link edit token (schema change, sets up Phase 5's email nudges to reuse the same token) — pick back up whenever ready.
- [x] Post-confirmation screen — a clean "you're locked in" screen (`renderConfirmedScreen`) shown to non-owner voters once a schedule poll's slot is confirmed, with a "View full details" escape hatch back to the full vote/results view. Scoped to `type === 'schedule'` only — the only poll type with a single "winning slot" concept.
- [x] Calendar export: hardened the existing `downloadICS()` (added `DTSTAMP`, escaped ICS special characters — a comma in the poll title previously produced a malformed file) and added a Google Calendar link (`googleCalendarUrl()`) next to it, both in the confirmed banner and the new locked-in screen.
- [x] Timezone confirmation on vote submit — scoped to `schedule` and `availability` (the only types where timezone carries real time-of-day meaning; `rsvp`/`question` hardcode `'UTC'` with no time-of-day concept, correctly left untouched). Shows a toast naming the recorded timezone (`friendlyTzName()`) on submit, and persistently surfaces it in the "already voted" card too, since a toast alone is easy to miss.
- [x] Real-time results — polls `GET /api/polls/:id` every 5s while a poll view is open (`startPollRefresh`/`refreshPollTick`), pausing while the tab is hidden and catching up instantly on `visibilitychange`. Guards against stomping an in-progress vote form (`isVoteFormActive()`) by doing a partial DOM update (`refreshResultsOnly()`) instead of a full re-render in that case.

All verified locally 2026-07-10 against the dev server, across all four poll types (schedule/rsvp/question/availability) where applicable — including a real two-source polling test (a background `curl` vote landing automatically within one interval) and confirming an in-progress name field survives a background refresh untouched.

**Acceptance:** confirming a slot shows a clear locked-in screen with an .ics/Google Calendar link attendees can add (✅); votes carry an explicit timezone, confirmed to the voter (✅); results update without a manual refresh (✅); a voter can revise their own response without organizer help (deferred — not yet built).

### Phase 5 — Chase-the-voter workflows

This is the named daily pain in the positioning doc: chasing the one unresponsive client stakeholder. Highest leverage for the agency wedge specifically.

- [x] **Schema change (prerequisite):** `expected_voters` went from bare `TEXT[]` names to structured `JSONB` `[{name, email?}]` — there was previously nowhere to send a nudge or reminder. Migration in `db/schema.sql` is guarded (checks `information_schema` before converting) so it's safe to re-run, and converts existing data via a temp-column swap (`ALTER ... TYPE ... USING` with a correlated subquery isn't allowed by Postgres directly). Verified locally: one pre-existing poll's plain names converted to `[{"name":"Alice"}, ...]` correctly, migration re-ran cleanly a second time with no errors.
- [x] Email notifications: "your poll got a new response" fires to the organizer on a genuinely new vote (checked via a pre-upsert existence lookup, not the upsert result itself, so a revote doesn't re-notify). Sent fire-and-forget after the vote response is already returned, so an email failure can never fail the vote itself.
- [x] Deadline reminders — an in-process sweep (checks every 30 min, plus once at boot) emails the organizer once a poll's deadline is within 24h, naming who still hasn't voted and the best slot so far. Deliberately organizer-only, not auto-sent to non-responders (see positioning decision below). Deduped via a `deadline_reminder_sent_at` column claimed atomically with `UPDATE ... RETURNING`, so it's safe even if this ever runs on more than one machine. Editing a poll's deadline resets that column so the edit gets its own fresh reminder window.
- [x] One-click "nudge" button next to each name in "who hasn't voted" — only shown when that expected voter has an email on file (added via `Name <email>` in the expected-voters field); falls back to no button (nothing to send to) otherwise. Rate-limited to one send per 15 minutes per voter to survive an accidental double-click. Owner-only endpoint (`POST /api/polls/:id/nudge`).
- [x] Smart-suggested slot — a server-side port of the existing client-side "best match" scoring (`computeBestSlot` in server.js), scoped to `schedule`/`availability` only (same type-scoping Phase 4 used for the confirmed screen), embedded directly into the new-response, nudge, and deadline-reminder email bodies so the organizer doesn't have to open the poll to see it.

**Positioning decision (2026-07-10):** nudge/reminder emails require an email address per expected voter, which didn't exist before this phase. Chose to let the organizer optionally attach one (`Name <email>`) and have Huddle send real emails — rather than a lighter mailto/copy-link approach — since that's what the acceptance criteria actually needs. Automated deadline reminders were scoped to organizer-only (not auto-emailing non-responders) to avoid Huddle silently emailing external people who never clicked anything themselves; the organizer decides whether to nudge from there.

**Verified locally 2026-07-10** against the dev server (Resend's console-log fallback, no real send needed to inspect bodies): new-response notification fired with the correct best-slot line on a fresh vote; nudge button appeared only for the voter with an email on file and disappeared/blocked correctly on cooldown (429); deadline-reminder sweep fired once when a poll's deadline was set within the 24h window (tested via a server restart, since the sweep also runs at boot) and correctly did *not* re-fire on a second restart; editing the deadline via PATCH correctly reset the reminder-sent flag; the voter self-select dropdown (from Phase 1) kept working against the new structured voter shape.

**Not gated by plan** — available on both Free and Pro, consistent with Phase 4. No per-poll/user "mute notifications" toggle yet (always-on); easy to add later if it gets noisy.

**Merged to `main` and deployed to production, 2026-07-10.** The production `expected_voters` migration was run *before* the code deploy (at explicit request) — confirmed zero live polls had any expected voters set at the time, so no real data was at risk, but it did briefly leave the still-deployed old code writing to a column shape it didn't expect (any create/edit that set expected voters would have 500'd). Closed within the same session by reconstructing the Phase 5 diff onto `main` (isolated via `git diff <dev-commit>^ <dev-commit>`, confirmed billing-free, applied clean) and deploying. Both `https://huddlr.co` and `https://group-scheduler.fly.dev` verified reachable (200) post-deploy with no error-level logs. Full UI smoke test against the live *authenticated* flow (create/nudge/vote) wasn't done against production itself — that would require a real login-email round trip, which isn't available in this environment; local verification above plus the clean diff/deploy is what backs this.

**Acceptance:** an organizer gets notified of new responses without checking back (✅); an unresponsive voter can be nudged with one click (✅, when an email is on file for them); the best slot is surfaced automatically instead of requiring manual grid-reading (✅, now also in email bodies, not just the results page).

### Phase 6 — Branding & the price raise

The positioning decision (`fb46184`) named custom branding as *the* thing that justifies Pro pricing north of $5/mo — Pro launched cheap specifically because this doesn't exist yet. Building it is the unlock for revisiting the $15–20/mo target, not just a nice-to-have.

- [x] Light branding controls (logo/color on the voting page a client sees). Account-level (one brand per user, applied to all their polls — matches the agency→client wedge), stored in Postgres: `users.brand_logo` (base64 `data:` URI, ~150KB cap) + `users.brand_color` (hex). No object storage — backed up with the DB, dodges the `fly storage`/Tigris footgun. On the voting page: a banner (logo on a white chip over a strip in the accent color) via the shared `renderPollHeader` so all 4 poll types get it, plus the accent color on the primary "Submit Vote" CTA. Color applied via a `--brand` CSS var that defaults to the app's blue, so an unbranded poll is pixel-identical (verified: branded CTA `#db2777`, unbranded falls back to `#2563eb`, no banner).
- [x] Minimal settings surface — a dedicated **Branding** view (nav button, login-gated) with logo upload (file→data URL, client- and server-side type + size validation), a native color picker synced to a hex field, a live preview, and save via `GET`/`PATCH /api/branding`. Deliberately just branding, not the full "toggle every feature" nav (that's Phase 7).

**Gating decision (2026-07-10):** branding is *defined* as a Pro feature, but billing/plan-enforcement is parked on the `billing` branch (off the mainline until Phase 9), and no production user can become Pro yet. So branding ships **ungated** on the mainline now — the `plan==='pro'` gate gets added at Phase 9 alongside the poll-cap and availability gates, keeping *all* plan-policy with billing and the mainline billing-free. Interim cost of free users getting branding is ~zero pre-launch. **Added to the Phase 9 checklist: gate branding behind Pro when billing merges.**

**Price raise:** deferred, not code here — the actual $5→$15–20 change lives with the Stripe price on the `billing` branch and takes effect at Phase 9. Revisit the number now that branding (the anchor feature) exists.

**One bug found and fixed during verification:** the global `express.json({ limit: '16kb' })` body cap would have rejected any realistic logo (a ~40KB image base64-encodes well past 16KB) with an ugly 413 HTML page *before* the branding route's own validator ran. Fixed by routing `PATCH /api/branding` through a dedicated 512kb JSON parser while every other endpoint stays at the tight 16kb. Verified a ~40KB logo now saves (200) while oversize (>200KB) still rejects gracefully with a JSON error.

**Verified locally 2026-07-10** against the dev server: set logo + color, confirmed the banner + accent render on a real voting page and that the green confirmed/results elements are untouched (color scoped to banner + CTA only); confirmed an unbranded poll is pixel-identical to before (blue CTA, no banner); server-side validation rejects bad color, non-image logos, and oversize logos with friendly JSON errors; no console errors.

**Acceptance:** a user can set a logo/color that shows on their voting pages (✅); revisit Pro pricing once this is live (pending — it's a number/decision tied to the Phase 9 billing go-live). Pro-gating the feature is deferred to Phase 9 by the decision above.

### Phase 7 — Agency relationship features

Bigger effort (new data model for grouping polls by client), deepens the wedge rather than polishing what exists. Do after Phase 6 so branding — the thing that makes an agency look competent to a client — already exists when this ships.

- [ ] Per-client hub page — a persistent link aggregating all past/upcoming polls with one client.
- [ ] "Preview as voter" button in the create flow — see exactly what the recipient will see before sharing the link.
- [ ] Duplicate/reuse poll — "duplicate this poll" (same slots/voters, no responses) for repeat kickoff-style polls.
- [ ] Empty/loading states — skeletons instead of blank flashes on dashboard/poll load.
- [ ] Revisit the full settings nav here (toggle features per user/per poll) — by now nudge, reminders, branding, and timezone display are all real candidates, so the case for it is no longer hypothetical.

**Acceptance:** a client's whole poll history is visible from one link; an organizer can preview the voter view before sharing; a poll can be duplicated without recreating slots/voters from scratch.

### Phase 8 — Integrations

Biggest lift (external OAuth/services), least proven demand. Do only once repeat usage from real agency customers justifies the investment — not speculatively.

- [ ] Two-way calendar connect (Google/Outlook) for the internal team side — teammates connect their calendar instead of manually picking availability.
- [ ] Slack notification/webhook on vote or confirm.
- [ ] SMS reminders as an option for stakeholders who don't check email fast.

**Acceptance:** a teammate's real calendar availability populates a poll without manual entry; a Slack channel gets notified on vote/confirm; SMS reminders can be opted into per poll.

### Phase 9 — Ship billing to production

The actual build is already done (Phase 3, verified locally on 2026-07-09) — this phase is only the go-live step, and it's deliberately last. Decision (2026-07-09): hold off turning on real payments until Phases 4–8 have made the product more robust, rather than monetizing it right after the billing code was written.

**Where the code lives (as of 2026-07-10):** the billing implementation is parked on the dedicated **`billing` branch** (branched off `main` after Phase 5) — deliberately *not* on `dev` or `main`, so it cannot reach production through a normal deploy. `dev` and `main` are now identical and billing-free; new work (Phases 6–8) flows `dev → main` as an ordinary fast-forward. An immutable snapshot of the pre-split history is tagged `archive/dev-pre-billing-split`. To go live, bring billing back in as its own step:

- [ ] `git checkout main && git merge billing` — reconcile billing against everything built in Phases 6–8 (resolve conflicts once, with all real code present). Push `main`, then fast-forward `dev`.
- [ ] Re-verify the Checkout → webhook → plan-flip round trip still works after the merge (nothing in Phases 6–8 should touch billing code, but confirm before going live).
- [ ] **Gate Phase 6 branding behind Pro.** Branding shipped ungated on the mainline (Phase 6) because no one could be Pro pre-billing; when billing merges, add the `plan==='pro'` check to the branding UI/routes alongside the poll-cap and availability gates so it becomes a real Pro-tier feature.
- [ ] Set real Fly secrets: `STRIPE_SECRET_KEY` (live), `STRIPE_WEBHOOK_SECRET` (from a production webhook endpoint, not `stripe listen`), `STRIPE_PRICE_ID` (a live-mode price, not the test-mode one created 2026-07-09).
- [ ] Run `scripts/grandfather-existing-users.js` once, right before/at cutover, so existing users (including Brady's own real polls) land on `plan='pro'` instead of getting capped.
- [ ] `fly deploy`, then verify prod: confirm the billing page renders, and — carefully, since this now touches real money — run one real low-stakes Checkout + cancellation to confirm the live webhook path before telling any actual customer about Pro.

**Acceptance:** a real credit card can upgrade a real account to Pro in production and the webhook correctly flips their plan; existing pre-cutover users were grandfathered and weren't accidentally capped.

---

## Positioning (decided)

**The wedge: agencies and client-services teams scheduling multi-stakeholder meetings across two organizations** — kickoffs, review calls, working sessions where you're wrangling availability across your own team *and* a handful of client-side people who are slow to respond and not on your calendar tool.

Why this one, not a generic "another scheduler" play or the wedding/event-party angle (which is what real usage has actually looked like so far):

- Calendly/Cal.com are built for 1:1 booking, not group consensus. Doodle/When2meet/Rallly are built for casual friend-group scheduling and read as unprofessional in front of a client. Neither serves "align 8 people across 2 companies on a time."
- The features already built line up with this: expected-voters + "who hasn't voted" tracking (chasing the one unresponsive client stakeholder is the actual daily pain), deadlines, and the description field for meeting context/agenda. These read as "get busy external people to commit" features, not casual-scheduling features.
- Wedding/event-party use (the real usage seen so far) is B2C, one-and-done per customer, and a weak fit for recurring SaaS revenue. Agency work is repeat business with an actual budget line for tools like this already.

**What this changes for Phase 3+:**
- Custom branding (agency logo/colors on the voting page a client sees) is a Pro-tier anchor feature, not a nice-to-have — it's what makes an agency look competent in front of their client.
- Price a notch higher than a casual-consumer tool: float **$15–20/mo** for Pro rather than $8–12, since agencies already have budget for Calendly Teams/Doodle-equivalent tools.
- Homepage/marketing copy should eventually speak to this audience directly (not urgent before Phase 3, but worth revisiting before spending on acquisition).

## Terminal setup (run when you start Phase 2)

Add Postgres to the Fly app and set secrets:

```bash
cd /Users/brady/Dev/group-scheduler

# Provision Postgres and attach it (sets DATABASE_URL automatically)
fly postgres create --name group-scheduler-db
fly postgres attach group-scheduler-db

# Secrets the app will need
fly secrets set JWT_SECRET="$(openssl rand -hex 32)"
fly secrets set RESEND_API_KEY="re_xxx"        # from resend.com
# Stripe (Phase 3)
fly secrets set STRIPE_SECRET_KEY="sk_live_xxx"
fly secrets set STRIPE_WEBHOOK_SECRET="whsec_xxx"

# Node deps you'll likely add along the way
npm install pg jsonwebtoken
```

Deploy / push follow the usual flow (GitHub user `catdad-ship-it`, then `fly deploy`).

## Definition of done for the whole thing

A stranger can land on the site, sign up with their email, create scheduling polls, share links, collect anonymous votes, confirm a time, and — if they want more than the free tier — pay for it. Brady's existing polls survive the whole migration.
