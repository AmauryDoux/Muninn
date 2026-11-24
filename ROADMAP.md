# Muninn roadmap

v1 is the core loop: capture, confirm, remind, recall, correct. Everything below is planned, not built.
The v1 schema already has the hooks these need, so none of them should require a table rebuild:

| Hook in v1 schema | What it is for |
|---|---|
| `items.kind` has no CHECK, plus `items.subtype` | New item types (`gift_idea`, `warranty`, `service_record`, `medication`, ...) without a migration |
| `items.attrs_enc` | Encrypted JSON of typed attributes per type (price, store, serial, expires_on, dose, ...) |
| `things`, `places` tables | Objects you own or look after, and saved locations |
| `links` table | An item linked to any number of people, places, things or other items, with a role (`gift_for`, `about`, `owed_by`, `at`, `follow_up_of`) |
| `items.recurrence` | RRULE subset (`FREQ=YEARLY`, `FREQ=MONTHLY;INTERVAL=6`) |
| `triggers` table | Date-relative reminders anchored to a dated fact or an item date, with an offset ("14 days before Emma's birthday", "30 days before the warranty ends") |
| `facts.value_type = 'date'` | Birthdays, anniversaries, last-done dates that triggers can anchor to |
| `facts.subject_type` includes `thing` and `place` | "The boiler's model is X", "the spare key is in the blue drawer" |

## From the spec's phases

**v1.1**
- ~~Observed patterns~~ (built).
- Weekly review on Sunday evening (Sonnet 5.5).
- ~~Recurring maintenance from a template list~~ (built as the seasonal starter) (filters, oil change, renewals): `recurrence` + `triggers`.
- "You're planning a Target run on Saturday, add the sheets?" when two open items share a place hint.
- ~~Evaluate `triggers` in the cron~~ (built).

**v2**
- Places: saved locations, errand grouping by store and route (Google Maps, quotas at $0).
- Arrival nudges through an iOS Shortcuts automation that calls the Worker.
- Planner for "plan my Saturday" (Sonnet 5.5).

**Later (each opt-in, each revocable)**
- Gmail read-only for return and bill deadlines; calendar read.
- Read-only bridge to Smart Household AI (shopping list, stores).
- Shared capture from your wife's phone (a second user: changes the threat model, needs its own review).
- French captures (switch embeddings to bge-m3 and re-embed from the stored raw text).

## Feature ideas (requested 2026-11-23, built 2026-11-24)

All twelve are built; see docs/PROGRESS.md for the decisions. Receipt photos (R2) are still to do.

Each is mostly a new `subtype`, a few `attrs`, links and triggers, plus parser examples and a screen.

| Feature | How it maps |
|---|---|
| **Gift memory** ("Emma wants the blue Lego set") | item `kind=note, subtype=gift_idea`, link `gift_for` person, attrs `{price, store, url}`; surfaced by a trigger 14 days before the person's birthday fact |
| **Important dates** (birthdays, anniversaries, renewals) | `facts` with `value_type=date`, plus a yearly `trigger` with a negative offset |
| **Kids' details** (sizes, allergies, teachers) | `facts` on the person (`shoe_size`, `allergies`, `teacher`), with `review_after` so sizes get re-asked as kids grow |
| **Home inventory** ("where's the spare key") | `things` rows with a `location` attr, or `facts` on a thing; recall answers from them |
| **Service history** (car, boiler) | items `subtype=service_record` linked `about` a thing, attrs `{mileage, cost, garage}`; trigger "6 months after the last one" |
| **Seasonal checklists** (winter tyres, gutters, AC filter) | template items with `recurrence=FREQ=YEARLY;BYMONTH=10` |
| **Who owes whom** | item `subtype=debt`, links `owed_by` / `owed_to` person, attrs `{amount, currency}`; nudge after N days |
| **Warranties and receipts** | item `subtype=warranty` linked to a thing, attrs `{bought_on, store, expires_on, receipt_ref}`; trigger 30 days before `expires_on`. Receipt photos need R2 (free tier) and a decision on encryption of files |
| **Meeting follow-ups** | item `subtype=follow_up`, link `with` people, `follow_up_of` the meeting item; due-date reminder |
| **Ideas inbox** | item `kind=note, subtype=idea`, no reminders, its own list and semantic recall |
| **Learning and cert tracker** | item `subtype=cert` with attrs `{issuer, earned_on, expires_on, cpe_required}`; trigger before expiry, CPE tally from `events` |
| **Light health** (meds, last tetanus shot) | `facts` on a person with `value_type=date` (`last_tetanus`), trigger at +10 years; meds as recurring items. Before adding health data: confirm Anthropic data retention settings (see ARCHITECTURE.md, Security) |

## Advice (requested 2026-11-23)

**In v1 (built):** on-demand advice through the same box. When you ask for a suggestion or a how-to ("what should I get Emma for her birthday", "how often should the boiler be serviced"), the parser routes it to an advice call that gets your profile (people, active facts) and the 8 notes closest to the question, so answers are personal. Health, finance and legal answers get a fixed "general information, not professional advice" line, added by code rather than left to the model.

**Built 2026-11-24: proactive and pattern-based tips.** Suggestions Muninn offers on its own, from profile facts and observed patterns, for example "Emma's shoe size was recorded 8 months ago, check it before buying shoes", "the boiler service is due next month and you usually book in September", "you snoozed the dentist 4 times, want me to pick a slot?". Design notes:
- Generated by code rules first (stale facts, upcoming triggers, repeated snoozes); the model only words them.
- Shown in the morning brief or the weekly review, never as extra pushes, and under the daily push cap.
- Each tip has act / snooze / dismiss, logged in `events`, so tips that get dismissed stop.
- A "Tips" switch in settings (on by default; rules only, so no AI cost unless "AI wording" is turned on).
