// Strategy & Targets: planning assumptions, versioned in strategy_configs.
// None of these values come from the attendee workbook.

export interface ThresholdRule {
  metric: string;
  unit: string;
  scaleAt: number;
  changeFrom: number;
  stopBelow: number;
  extra?: string;
}

export interface StrategyConfig {
  planningBaseline: number;
  baseTarget: number;
  stretchTarget: number;
  eventDays: number;
  northStar: string;
  capacity: { dailyLimit: number | null; totalLimit: number | null; confirmedBy: string | null; confirmedAt: string | null };
  market: { tamStudents: number; samStudents: number; note: string };
  budget: {
    base: { standardMarketing: number; contingency: number; ceiling: number };
    stretch: { standardMarketing: number; contingency: number; ceiling: number };
  };
  planningShowRate: number;
  thresholds: Record<string, ThresholdRule>;
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  planningBaseline: 5000,
  baseTarget: 9000,
  stretchTarget: 11000,
  eventDays: 2,
  northStar: "Unique verified physical attendees: one distinct person counted once across both days.",
  capacity: { dailyLimit: null, totalLimit: null, confirmedBy: null, confirmedAt: null },
  market: { tamStudents: 1_950_000, samStudents: 700_000, note: "Presentation planning assumptions. The attendee workbook does not validate TAM or SAM." },
  budget: {
    base: { standardMarketing: 400_000, contingency: 40_000, ceiling: 1_600_000 },
    stretch: { standardMarketing: 400_000, contingency: 50_000, ceiling: 2_400_000 },
  },
  planningShowRate: 0.65,
  thresholds: {
    campus_cup: { metric: "Incremental verified attendees per active college", unit: "attendees/college", scaleAt: 60, changeFrom: 35, stopBelow: 35, extra: "Judge only after a sufficiently sized pilot." },
    crewpass: { metric: "Crew member check-in rate (with ≥10 pt uplift vs control to scale)", unit: "%", scaleAt: 70, changeFrom: 55, stopBelow: 55, extra: "Scaling also needs ≥10 percentage-point uplift versus control." },
    campus_network: { metric: "Incremental verified attendees per active captain", unit: "attendees/captain", scaleAt: 20, changeFrom: 10, stopBelow: 10 },
    challenge_circuit: { metric: "Confirmed finalist teams (with sponsor funding secured)", unit: "teams", scaleAt: 40, changeFrom: 25, stopBelow: 25, extra: "Scaling also needs sponsor funding secured." },
    student_passport: { metric: "Incremental verified attendees per active partner", unit: "attendees/partner", scaleAt: 25, changeFrom: 10, stopBelow: 10 },
  },
};

export function thresholdVerdict(rule: ThresholdRule, value: number | null): "scale" | "change" | "stop" | "insufficient" {
  if (value === null || Number.isNaN(value)) return "insufficient";
  if (value >= rule.scaleAt) return "scale";
  if (value >= rule.changeFrom) return "change";
  return "stop";
}
