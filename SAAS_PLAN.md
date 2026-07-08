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

## Current state (what we're starting from)

- **Stack:** Node + Express, deployed on Fly.io. Frontend is static files in `public/`.
- **Auth:** one shared admin password (`ADMIN_PASSWORD`, defaults to `brady`). "Admin" = Brady, full stop.
- **Storage:** all polls in a flat `polls.json` file. Sessions in an in-memory `Map` — wiped on every restart/redeploy.
- **Poll types:** schedule, question, rsvp, availability.

Every gap between this and a SaaS comes from one assumption baked in everywhere: **one owner, one machine.** The plan below unwinds that.

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

- [ ] Add a `users` concept: id, email, createdAt, plan (default `free`).
- [ ] Add `ownerId` to every poll.
- [ ] Build magic-link login: enter email → emailed a one-time link → clicking it sets a signed session cookie.
- [ ] Replace the single-password check. Every admin route (`list polls`, `confirm`, `unconfirm`, `patch title`, `delete poll`, `delete vote`) changes from "is this THE admin?" to "does the logged-in user own THIS poll?"
- [ ] **Creating a poll requires an account.** Anonymous visitors cannot create polls — the create flow is gated behind login, and poll creation attaches the logged-in user as owner. (**Voting stays anonymous** — no login to respond to a poll.)
- [ ] Admin poll list shows only the current user's polls.
- [ ] Keep public voting exactly as-is — voters never log in.

**Acceptance:** two different accounts can each create polls and only see/manage their own; a voter with a poll link can still vote without any login; Brady's old shared password no longer grants access to everything.

## Phase 2 — Move off the JSON file to Postgres

`polls.json` can't handle two people writing at once and won't survive Fly relocating the machine. This and Phase 1 are best shipped together.

- [ ] Provision Fly Postgres and attach it to the app (commands below).
- [ ] Schema: `users`, `polls`, `slots`, `votes` (votes and slots as real rows, not JSON blobs, so we can query them).
- [ ] Write a one-time migration script that reads `polls.json` and inserts every existing poll/slot/vote. Assign existing polls to Brady's account.
- [ ] Swap `loadDB()`/`saveDB()` for real queries. Delete the file-based path once migration is verified.
- [ ] Move sessions to signed JWT cookies (drop the in-memory `Map`).

**Acceptance:** all existing polls show up under Brady's account after migration; app survives a redeploy with sessions and data intact; two simultaneous votes don't clobber each other.

## Phase 3 — Billing (Stripe)

Don't build this until Phases 1–2 are live and someone's using it.

- [ ] Define tiers. Draft: **Free** = 3 active polls, schedule/question/rsvp types. **Pro (~$8–12/mo)** = unlimited polls, availability grids, deadline reminders, custom branding.
- [ ] Stripe Checkout for upgrade.
- [ ] Webhook that flips `user.plan` on successful payment / cancellation.
- [ ] Enforce limits at poll-creation time (block/upsell when a free user hits the cap).
- [ ] Billing settings page: current plan, manage/cancel via Stripe portal.

**Acceptance:** a free user hits the cap and gets an upgrade prompt; paying flips them to Pro and unlocks features; cancelling downgrades them at period end.

## Phase 4 — The stuff that makes people pay

- [ ] Email notifications: "your poll got a new response," deadline reminders (Resend).
- [ ] Calendar export: `.ics` download + Google Calendar link on the confirmed slot.
- [ ] Custom domain.
- [ ] Automated DB backups + basic uptime monitoring.
- [ ] Light branding controls for Pro (logo/color on the voting page).

**Acceptance:** confirming a slot sends attendees an .ics; deadline reminders fire; DB backs up on a schedule.

---

## Open product question (decide before Phase 3)

The build is ~2–3 focused weeks. The harder question is positioning — this space is crowded (Doodle, When2meet, Rallly, Cal.com). The win isn't "another scheduler," it's a **wedge**: a specific audience or workflow, probably one Brady knows from the agency side, where the generic tools are annoying. Worth deciding before writing billing code. Park it here, don't let it block Phases 1–2.

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
