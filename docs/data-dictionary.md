# Data dictionary and mapping

How the supplied `Attendee Dataset.xlsx` maps onto the canonical model. Any uploaded file is mapped the same way through the import wizard; the synonyms that drive suggestions are in `src/lib/import/schema.ts`. Column-level statistics for the supplied file are in [data-profile.md](data-profile.md).

The Sponsor Dataset is not used.

| Workbook sheet | Canonical entity → table | Field mapping (source → canonical) | Notes |
|---|---|---|---|
| Read me, Field guide | ignored (kept in `raw_source_rows`) | – | Rules from these sheets are implemented in the analytics. |
| Event | event → `event_info` | event_name → name, event_starts_at → starts_at, event_ends_at → ends_at, timezone, currency, history_start, history_end | Default as-of date = history_end. Timezone sets how naive times are read. |
| Targets | targets → `target_versions` | effective_at, identified_external_people_goal → identified_goal, registration_goal, unique_external_visitors_goal → visitor_goal, marketing_budget_inr → budget_inr, target_version → label | The version in effect on the as-of date is used. |
| Campaigns | campaigns → `campaigns` | campaign_id → source_id, campaign_name → name, channel, target_audience, objective, owner_id + owner_name → team member, planned_start_at, planned_end_at | App-editable fields added: status, initiative, approved/committed budget, UTM, KPI targets, notes. |
| Daily Marketing | campaign_daily → `campaign_daily` | activity_id → source_id, campaign_id → campaign, activity_date, impressions, clicks, reported_reach, landing_page_sessions → sessions, registration_starts, marketing_spend_inr → spend_inr, platform | Anonymous event counts. Negative spend = vendor credit. 2 duplicate IDs removed. |
| People | people → `people` | person_id → source_id, person_name → display_name, person_type, first_seen_at, first_touch_source, first_campaign_id → first campaign, owner | Names are stored but never shown in lists or sent to the AI. |
| Interest and Engagement | interactions → `interactions` | interaction_id → source_id, person_id, campaign_id, occurred_at, event_type | `detail` text is kept in raw rows only. |
| Registrations | registrations → `registrations` | registration_id → source_id, person_id, campaign_id, registered_at | Registration source for attribution. |
| Registration History | registration_history → `registration_status_history` | history_id → source_id, registration_id, status, effective_at | 4 duplicate IDs removed. Corrections made in the app are added as new versions with `edited_by`. |
| Check-ins | check_ins → `check_ins` | event_id → source_id, person_id, registration_id, campaign_id, occurred_at, result, verification, source → method | 20 duplicate IDs removed. Empty campaign = unattributed. |

Name and owner columns repeated on fact sheets (person_name, campaign_name, owner_name) are kept in the raw copy; the canonical tables join through IDs.

## What the workbook does not contain

| Missing | Effect in the app |
|---|---|
| Venue capacity | Strategy & Targets shows "not configured"; the AI and dashboards refuse to call a target capacity-safe. |
| Person-level reach, impressions or page visits | Reach→registration per person is not computed. Anonymous totals are shown separately. |
| Tasks, budget commitments, experiments | Seeded demo records, labelled "Demo seed". |
| Control groups | Incremental lift cannot be computed until an experiment records results. |
| Sponsor revenue | Out of scope; the AI says so. |

## Canonical entities for other uploads

| Entity | Required fields | Unlocks |
|---|---|---|
| Event details | none | Event dates for as-of and forecasts |
| Targets | effective date | Targets vs actuals |
| Campaigns | campaign ID, name | Names, channels, owners |
| Daily campaign metrics | campaign (ID or name), date | Spend and anonymous activity |
| People | person ID | Distinct people, person type, first touch |
| Interactions | ID, person, occurred at, event type | Engagement and opt-outs |
| Registrations | ID, person, registered at | Registrations and show-up |
| Registration status history | ID, registration, status, effective at | Confirmed/cancelled/waitlisted as of a date |
| Check-ins | ID, person, occurred at | Verified attendance |

At least a registrations or a check-ins sheet is required. Missing references are handled explicitly: an unknown campaign becomes a placeholder campaign with a warning; an unknown person becomes a placeholder person with no type; a status row for an unknown registration is rejected.
