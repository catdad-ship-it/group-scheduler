# Backlog: UX + feature ideas

Pulled from a product review on 2026-07-09. Unprioritized — pull items into SAAS_PLAN.md phases (or a new phase) once we're ready to sequence them.

## UX / satisfaction

- [ ] Real-time results — poll for new votes every few seconds on the results view instead of requiring a manual refresh.
- [ ] One-click "nudge" button next to each name in "who hasn't voted" — fires an email immediately, ahead of any automated reminder system.
- [ ] Voter self-edit — let a voter reopen their own submission via their link and change their response, instead of the organizer deleting-and-redoing via admin.
- [ ] "Preview as voter" button in the create flow — see exactly what the recipient will see before sharing the link.
- [ ] Post-confirmation screen — a clean "you're locked in" screen with full details after a slot is confirmed (pairs with the .ics export in SAAS_PLAN Phase 4).
- [ ] Duplicate/reuse poll — "duplicate this poll" (same slots/voters, no responses) for repeat kickoff-style polls.
- [ ] Timezone confirmation on vote submit — "your response was recorded in Eastern Time" so cross-org confusion doesn't surface later as a no-show.
- [ ] Mobile pass on the availability-grid paint interaction — confirm the drag-to-paint UI actually works on a phone, since clients likely vote from email on mobile.
- [ ] Empty/loading states — skeletons instead of blank flashes on dashboard/poll load.
- [ ] Smart-suggested slot — surface "most people can make this one" from the existing heatmap data instead of making the organizer read the grid.

## New features

- [ ] Per-client hub page — a persistent link aggregating all past/upcoming polls with one client.
- [ ] Two-way calendar connect (Google/Outlook) for the internal team side — teammates connect their calendar instead of manually picking availability.
- [ ] Slack notification/webhook on vote or confirm.
- [ ] SMS reminders as an option for stakeholders who don't check email fast.

## Infrastructure

- [ ] Settings nav — a place to toggle the above features on/off (per user or per poll), rather than shipping everything as always-on.
