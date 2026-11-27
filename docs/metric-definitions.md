# Metric definitions

All metrics are computed in SQL in `src/lib/analytics/` at request time, scoped to the active dataset version and an as-of date (end of that day in the dataset timezone). Nothing is cached or copied to the frontend.

| Metric | Definition | Tag |
|---|---|---|
| Unique verified attendees (north star) | Distinct `person_id` with ≥1 check-in where result = admitted and verification = verified, person type = external, occurred at ≤ as-of. If the dataset lacks result, verification or person type, that condition is dropped and a warning is shown. | Observed |
| Daily visits | Distinct people per local date meeting the same conditions. A two-day visitor appears on both days. | Observed |
| Attended multiple days | Attendees with verified admissions on 2+ distinct local dates. | Observed |
| Walk-ins | Verified attendees with no registration. | Observed |
| Excluded check-ins | Rows not admitted or not verified; verified rows for non-external people. | Observed |
| Identified external people | People of type external first seen on or before as-of. | Observed |
| Engaged | Distinct external people with any interaction. | Observed |
| Registered people | Distinct external people with a registration on or before as-of. | Observed |
| Latest status | Status of the newest history version per registration with effective_at ≤ as-of (ties broken by source ID). | Observed |
| Show-up rate | Registered external people with a verified admission ÷ registered external people. | Calculated |
| Funnel conversion | Each stage ÷ the previous available stage. Shown with its denominator. | Calculated |
| Net spend | Sum of `spend_inr` for activity dates ≤ as-of (debits less vendor credits). | Observed |
| Cost per registration | Campaign net spend ÷ campaign registered people. | Calculated |
| Cost per verified attendee | Campaign net spend ÷ verified attendees attributed by registration source. | Calculated |
| Portfolio show-up | All attributed verified attendees ÷ all attributed registered people. | Calculated |
| Campaign health | Critical: show-up >15 pts below portfolio, or cost per verified attendee >2× the median. Attention: >5 pts below, >1.3× median, or spend above the campaign's approved budget. Insufficient: <20 registered people. | Calculated |
| Attribution: first touch | Attendees grouped by their first recorded campaign. | Calculated |
| Attribution: registration source | Attendees grouped by the campaign on their earliest registration; walk-ins are unattributed. | Calculated |
| Attribution: last interaction | Campaign of the latest non-opt-out interaction before the first verified admission. | Calculated |
| Targets vs actuals | Latest target version effective ≤ as-of vs the matching observed metric. | Observed + Calculated |
| Weekly trend | Registrations, newly identified people, spend, cancellations and opt-outs by ISO week (local time). | Observed |
| Period comparison | The same counts for two inclusive date ranges, with absolute and % change. | Calculated |
| Forecast | If as-of is after the event: observed. Otherwise, with ≥14 days of registrations: registered so far + (last 14 days ÷ 14) × days to event, × planning show-up rate. Otherwise insufficient. | Estimated |
| Budget remaining | Approved − committed − spent, per line; festival-funded totals exclude sponsor-funded lines. | Calculated |
| Headroom to ceiling | Scenario ceiling − approved festival-funded total. | Calculated |
| Overdue task | Open (not done or cancelled) with due date before today (IST). | Observed |
| Blocked task | Status blocked, or any unfinished dependency. | Observed |
| Open effort | Estimated hours × (1 − progress). | Calculated |
| Experiment uplift | Treatment rate − control rate in percentage points, with a normal-approximation 95% interval. Only when both cohorts have results. | Calculated |
| Incremental CAC | Not computed from attribution. Needs an experiment with a control group. | – |
