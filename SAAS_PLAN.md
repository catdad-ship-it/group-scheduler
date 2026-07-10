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

- [ ] Voter self-edit — let a voter reopen their own submission via their link and change their response, instead of the organizer deleting-and-redoing via admin.
- [ ] Post-confirmation screen — a clean "you're locked in" screen with full details after a slot is confirmed.
- [ ] Calendar export: `.ics` download + Google Calendar link on the confirmed slot (pairs directly with the above).
- [ ] Timezone confirmation on vote submit — "your response was recorded in Eastern Time," so cross-org confusion doesn't surface later as a no-show.
- [ ] Real-time results — poll for new votes every few seconds on the results view instead of requiring a manual refresh.

**Acceptance:** a voter can revise their own response without organizer help; confirming a slot shows a clear locked-in screen with an .ics attendees can add; votes carry an explicit timezone; results update without a manual refresh.

### Phase 5 — Chase-the-voter workflows

This is the named daily pain in the positioning doc: chasing the one unresponsive client stakeholder. Highest leverage for the agency wedge specifically.

- [ ] Email notifications: "your poll got a new response," deadline reminders (Resend).
- [ ] One-click "nudge" button next to each name in "who hasn't voted" — fires an email immediately, ahead of any automated reminder.
- [ ] Smart-suggested slot — surface "most people can make this one" from the existing heatmap data instead of making the organizer read the grid.

**Acceptance:** an organizer gets notified of new responses without checking back; an unresponsive voter can be nudged with one click; the best slot is surfaced automatically instead of requiring manual grid-reading.

### Phase 6 — Branding & the price raise

The positioning decision (`fb46184`) named custom branding as *the* thing that justifies Pro pricing north of $5/mo — Pro launched cheap specifically because this doesn't exist yet. Building it is the unlock for revisiting the $15–20/mo target, not just a nice-to-have.

- [ ] Light branding controls for Pro (logo/color on the voting page a client sees).
- [ ] Minimal settings surface to support the above (logo upload, color picker) — not the full "toggle every feature" nav from the backlog; that's premature until there are enough toggleable features to justify it (see Phase 7).

**Acceptance:** a Pro user can set a logo/color that shows on their voting pages; revisit Pro pricing once this is live.

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

- [ ] Re-verify the Checkout → webhook → plan-flip round trip still works after everything built in Phases 4–8 (nothing above should touch billing code, but confirm before going live).
- [ ] Merge `dev` → `main`, push both.
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
