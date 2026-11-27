"use client";
import { Bar, BarChart, CartesianGrid, Legend, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const C = { brand: "#1d4ed8", soft: "#93b4f5", ink: "#334766", grid: "#e3e8f0", warn: "#b45309" };

export function WeeklyTrendChart({ data }: { data: { weekStarting: string; registrations: number; spend: number | null }[] }) {
  return (
    <div className="h-64 w-full" role="img" aria-label="Weekly registrations and spend">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={C.grid} vertical={false} />
          <XAxis dataKey="weekStarting" tick={{ fontSize: 11, fill: C.ink }} tickFormatter={(d: string) => d.slice(5)} />
          <YAxis yAxisId="l" tick={{ fontSize: 11, fill: C.ink }} width={40} />
          <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11, fill: C.ink }} width={56} tickFormatter={(v: number) => `₹${Math.round(v / 1000)}k`} />
          <Tooltip formatter={(v, n) => (n === "Spend (₹)" ? `₹${Number(v).toLocaleString("en-IN")}` : Number(v).toLocaleString("en-IN"))} labelFormatter={(l) => `Week of ${l}`} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar yAxisId="l" dataKey="registrations" name="Registrations" fill={C.brand} radius={[3, 3, 0, 0]} />
          <Line yAxisId="r" dataKey="spend" name="Spend (₹)" stroke={C.warn} strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HBarChart({ data, valueLabel, format }: { data: { name: string; value: number }[]; valueLabel: string; format?: "inr" | "pct" | "int" }) {
  const f = (v: number) => (format === "inr" ? `₹${Math.round(v).toLocaleString("en-IN")}` : format === "pct" ? `${(v * 100).toFixed(1)}%` : Math.round(v).toLocaleString("en-IN"));
  return (
    <div className="w-full" style={{ height: Math.max(160, data.length * 34 + 30) }} role="img" aria-label={valueLabel}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={C.grid} horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11, fill: C.ink }} tickFormatter={f} />
          <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 12, fill: C.ink }} />
          <Tooltip formatter={(v) => f(Number(v))} />
          <Bar dataKey="value" name={valueLabel} fill={C.brand} radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
