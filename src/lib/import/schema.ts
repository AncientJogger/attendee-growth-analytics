// Canonical model that any uploaded workbook or CSV is mapped onto.
// Synonyms drive the suggested mapping; users confirm or change it in the import wizard.

export type FieldType = "text" | "int" | "datetime" | "date" | "bool";

export interface FieldSpec {
  type: FieldType;
  label: string;
  required?: boolean;
  syn: string[];
}

export interface EntitySpec {
  label: string;
  description: string;
  sheetSyn: string[];
  fields: Record<string, FieldSpec>;
  unlocks: string;
}

export const ENTITIES = {
  event: {
    label: "Event details",
    description: "One row describing the event: name, dates, timezone, currency.",
    sheetSyn: ["event", "event_info", "festival"],
    unlocks: "Event dates for the as-of selector and forecasts.",
    fields: {
      name: { type: "text", label: "Event name", syn: ["event_name", "name", "festival_name", "event"] },
      starts_at: { type: "datetime", label: "Starts at", syn: ["event_starts_at", "starts_at", "start", "event_start", "start_date"] },
      ends_at: { type: "datetime", label: "Ends at", syn: ["event_ends_at", "ends_at", "end", "event_end", "end_date"] },
      timezone: { type: "text", label: "Timezone", syn: ["timezone", "tz", "time_zone"] },
      currency: { type: "text", label: "Currency", syn: ["currency"] },
      history_start: { type: "date", label: "History start", syn: ["history_start", "data_start", "period_start"] },
      history_end: { type: "date", label: "History end", syn: ["history_end", "data_end", "period_end"] },
    },
  },
  targets: {
    label: "Targets",
    description: "Dated target versions (goals and approved marketing budget).",
    sheetSyn: ["targets", "goals", "target", "plan"],
    unlocks: "Targets vs actuals.",
    fields: {
      effective_at: { type: "datetime", label: "Effective at", required: true, syn: ["effective_at", "effective_date", "date", "valid_from"] },
      identified_goal: { type: "int", label: "Identified people goal", syn: ["identified_external_people_goal", "identified_goal", "leads_goal", "lead_goal"] },
      registration_goal: { type: "int", label: "Registration goal", syn: ["registration_goal", "registrations_goal", "reg_goal"] },
      visitor_goal: { type: "int", label: "Unique visitor goal", syn: ["unique_external_visitors_goal", "visitor_goal", "attendance_goal", "attendee_goal", "visitors_goal"] },
      budget_inr: { type: "int", label: "Marketing budget", syn: ["marketing_budget_inr", "budget", "marketing_budget", "budget_inr"] },
      label: { type: "text", label: "Version label", syn: ["target_version", "version", "label", "plan_name"] },
    },
  },
  campaigns: {
    label: "Campaigns",
    description: "One row per campaign.",
    sheetSyn: ["campaigns", "campaign", "campaign_list"],
    unlocks: "Campaign names, channels and owners.",
    fields: {
      source_id: { type: "text", label: "Campaign ID", required: true, syn: ["campaign_id", "id", "campaign_code", "campaign_key"] },
      name: { type: "text", label: "Campaign name", required: true, syn: ["campaign_name", "name", "campaign", "title"] },
      channel: { type: "text", label: "Channel", syn: ["channel", "medium", "source"] },
      target_audience: { type: "text", label: "Target audience", syn: ["target_audience", "audience", "segment"] },
      objective: { type: "text", label: "Objective", syn: ["objective", "goal", "purpose"] },
      owner_id: { type: "text", label: "Owner ID", syn: ["owner_id", "owner_code"] },
      owner_name: { type: "text", label: "Owner name", syn: ["owner_name", "owner", "manager"] },
      planned_start: { type: "datetime", label: "Planned start", syn: ["planned_start_at", "start_date", "planned_start", "start"] },
      planned_end: { type: "datetime", label: "Planned end", syn: ["planned_end_at", "end_date", "planned_end", "end"] },
    },
  },
  campaign_daily: {
    label: "Daily campaign metrics",
    description: "Anonymous daily counts per campaign (impressions, reach, clicks, sessions, spend).",
    sheetSyn: ["daily_marketing", "campaign_daily", "marketing", "daily", "ads", "spend"],
    unlocks: "Spend, cost per result and anonymous activity (reach, clicks, sessions).",
    fields: {
      source_id: { type: "text", label: "Activity ID", syn: ["activity_id", "row_id", "id", "record_id"] },
      campaign_ref: { type: "text", label: "Campaign (ID or name)", required: true, syn: ["campaign_id", "campaign_name", "campaign"] },
      activity_date: { type: "date", label: "Date", required: true, syn: ["activity_date", "date", "day", "report_date"] },
      impressions: { type: "int", label: "Impressions", syn: ["impressions", "views", "impr"] },
      clicks: { type: "int", label: "Clicks", syn: ["clicks", "link_clicks"] },
      reported_reach: { type: "int", label: "Reported reach", syn: ["reported_reach", "reach"] },
      sessions: { type: "int", label: "Landing page sessions", syn: ["landing_page_sessions", "sessions", "page_visits", "visits"] },
      registration_starts: { type: "int", label: "Registration starts", syn: ["registration_starts", "form_starts", "reg_starts"] },
      spend_inr: { type: "int", label: "Spend", syn: ["marketing_spend_inr", "spend", "cost", "spend_inr", "amount"] },
      platform: { type: "text", label: "Platform", syn: ["platform", "reporting_source"] },
    },
  },
  people: {
    label: "People",
    description: "One row per identified person.",
    sheetSyn: ["people", "persons", "contacts", "leads", "attendees", "audience"],
    unlocks: "Distinct people, person type (external vs internal) and first-touch attribution.",
    fields: {
      source_id: { type: "text", label: "Person ID", required: true, syn: ["person_id", "id", "contact_id", "lead_id", "user_id"] },
      display_name: { type: "text", label: "Name", syn: ["person_name", "name", "full_name"] },
      person_type: { type: "text", label: "Person type", syn: ["person_type", "type", "category", "attendee_type"] },
      first_seen_at: { type: "datetime", label: "First seen at", syn: ["first_seen_at", "created_at", "first_seen"] },
      first_touch_source: { type: "text", label: "First touch source", syn: ["first_touch_source", "source", "acquisition_source"] },
      first_campaign_ref: { type: "text", label: "First campaign (ID or name)", syn: ["first_campaign_id", "first_campaign_name", "first_campaign", "campaign_id"] },
      owner_id: { type: "text", label: "Owner ID", syn: ["owner_id"] },
      owner_name: { type: "text", label: "Owner name", syn: ["owner_name", "owner"] },
    },
  },
  interactions: {
    label: "Interactions",
    description: "Identified engagement actions (page visits, downloads, opt-outs).",
    sheetSyn: ["interest_and_engagement", "interactions", "engagement", "lead_interactions", "activity", "events"],
    unlocks: "Engagement and opt-out analysis.",
    fields: {
      source_id: { type: "text", label: "Interaction ID", required: true, syn: ["interaction_id", "id", "event_id"] },
      person_ref: { type: "text", label: "Person ID", required: true, syn: ["person_id", "contact_id", "lead_id"] },
      campaign_ref: { type: "text", label: "Campaign (ID or name)", syn: ["campaign_id", "campaign_name", "campaign"] },
      occurred_at: { type: "datetime", label: "Occurred at", required: true, syn: ["occurred_at", "timestamp", "date", "created_at"] },
      event_type: { type: "text", label: "Event type", required: true, syn: ["event_type", "type", "action"] },
    },
  },
  registrations: {
    label: "Registrations",
    description: "One row per registration.",
    sheetSyn: ["registrations", "registration", "signups", "sign_ups", "tickets"],
    unlocks: "Registrations by campaign and registration-to-attendance.",
    fields: {
      source_id: { type: "text", label: "Registration ID", required: true, syn: ["registration_id", "id", "ticket_id", "signup_id"] },
      person_ref: { type: "text", label: "Person ID", required: true, syn: ["person_id", "contact_id", "attendee_id"] },
      campaign_ref: { type: "text", label: "Campaign (ID or name)", syn: ["campaign_id", "campaign_name", "campaign", "source_campaign"] },
      registered_at: { type: "datetime", label: "Registered at", required: true, syn: ["registered_at", "created_at", "registration_date", "date", "signup_date"] },
    },
  },
  registration_history: {
    label: "Registration status history",
    description: "Dated status versions for each registration.",
    sheetSyn: ["registration_history", "status_history", "registration_status", "history"],
    unlocks: "Confirmed, cancelled and waitlisted status as of any date.",
    fields: {
      source_id: { type: "text", label: "History ID", required: true, syn: ["history_id", "id", "version_id"] },
      registration_ref: { type: "text", label: "Registration ID", required: true, syn: ["registration_id", "ticket_id"] },
      status: { type: "text", label: "Status", required: true, syn: ["status", "state"] },
      effective_at: { type: "datetime", label: "Effective at", required: true, syn: ["effective_at", "updated_at", "date", "changed_at"] },
    },
  },
  check_ins: {
    label: "Check-ins",
    description: "Gate admission records.",
    sheetSyn: ["check_ins", "checkins", "check_in", "attendance", "admissions", "entries", "scans"],
    unlocks: "Verified physical attendance (the north-star metric).",
    fields: {
      source_id: { type: "text", label: "Check-in ID", required: true, syn: ["event_id", "checkin_id", "check_in_id", "id", "scan_id"] },
      person_ref: { type: "text", label: "Person ID", required: true, syn: ["person_id", "attendee_id", "contact_id"] },
      registration_ref: { type: "text", label: "Registration ID", syn: ["registration_id", "ticket_id"] },
      campaign_ref: { type: "text", label: "Campaign (ID or name)", syn: ["campaign_id", "campaign_name"] },
      occurred_at: { type: "datetime", label: "Occurred at", required: true, syn: ["occurred_at", "checked_in_at", "timestamp", "time", "date"] },
      result: { type: "text", label: "Result (admitted/denied)", syn: ["result", "outcome", "admission_result"] },
      verification: { type: "text", label: "Verification", syn: ["verification", "verified", "verification_status"] },
      method: { type: "text", label: "Method (scanner/manual)", syn: ["source", "method", "channel"] },
    },
  },
} satisfies Record<string, EntitySpec>;

export type EntityKey = keyof typeof ENTITIES;
export const ENTITY_KEYS = Object.keys(ENTITIES) as EntityKey[];

export interface SheetMapping {
  entity: EntityKey | "ignore";
  columns: Record<string, string>; // canonical field -> source header
}
export interface DatasetMapping {
  timezoneOffsetMinutes?: number;
  sheets: Record<string, SheetMapping>;
}

export function norm(h: string): string {
  return String(h ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
