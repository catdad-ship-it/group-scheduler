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
