import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { moneyScale, type DailySales } from "../shared/analytics";
import { forecastSales, netSales } from "../shared/analytics-math";
import type { TrafficDay } from "../shared/traffic";

type Forecast = ReturnType<typeof forecastSales>;
const shortDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const compact = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value / moneyScale);
export function SalesChart({ days, scenario, forecast, currency }: { days: DailySales[]; scenario?: DailySales[]; forecast?: Forecast; currency: string }) {
  const actual = days.map((day) => ({
    date: day.date, actual: netSales(day),
    scenario: scenario ? netSales(scenario.find((item) => item.date === day.date) ?? day) : undefined,
  }));
  const data = [
    ...actual.map((point, index) => ({ ...point, forecast: forecast && index === actual.length - 1 ? point.actual : undefined, band: undefined as [number, number] | undefined })),
    ...(forecast?.points.map((point) => ({ date: point.date, actual: undefined, scenario: undefined, forecast: point.sales, band: [point.lower, point.upper] as [number, number] })) ?? []),
  ];
  return <div className="analytics-chart" role="img" aria-label={`${scenario ? "Actual versus scenario" : forecast ? "Historical net sales and forecast with indicative uncertainty" : "Historical net sales"} in ${currency}`}>
    <ResponsiveContainer width="100%" height={290}>
      <AreaChart data={data} margin={{ left: 0, right: 12, top: 16, bottom: 4 }}>
        <defs><linearGradient id="sales-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0d9b78" stopOpacity={.2} /><stop offset="100%" stopColor="#0d9b78" stopOpacity={0} /></linearGradient></defs>
        <CartesianGrid vertical={false} stroke="#edf0f2" />
        <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={55} tick={{ fontSize: 10, fill: "#82908c" }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={compact} width={55} tick={{ fontSize: 10, fill: "#82908c" }} axisLine={false} tickLine={false} />
        <Tooltip labelFormatter={(value) => shortDate(String(value))} formatter={(value, name) => [Array.isArray(value) ? value.map((item) => `${currency} ${(Number(item) / moneyScale).toFixed(2)}`).join(" to ") : `${currency} ${(Number(value) / moneyScale).toLocaleString("en", { maximumFractionDigits: 2 })}`, name]} contentStyle={{ borderRadius: 12, border: "1px solid #e4e9e7", fontSize: 12 }} />
        <Area dataKey="band" name="Indicative range" stroke="none" fill="#aaa0f3" fillOpacity={.16} isAnimationActive={false} />
        <Area type="linear" dataKey="actual" name="Actual net sales" stroke="#0d9b78" strokeWidth={2} fill="url(#sales-fill)" isAnimationActive={false} />
        {scenario && <Area type="linear" dataKey="scenario" name="What-if net sales" stroke="#8672d8" strokeWidth={2} fill="transparent" strokeDasharray="5 4" isAnimationActive={false} />}
        {forecast && <Area type="linear" dataKey="forecast" name="Forecast net sales" stroke="#8672d8" strokeWidth={2} fill="transparent" strokeDasharray="5 4" isAnimationActive={false} />}
      </AreaChart>
    </ResponsiveContainer>
  </div>;
}
export function OrdersChart({ days }: { days: DailySales[] }) {
  const buckets = new Map<string, number>();
  for (const day of days) { const month = day.date.slice(0, 7); buckets.set(month, (buckets.get(month) ?? 0) + day.orders); }
  return <div className="analytics-chart" role="img" aria-label="Orders by calendar month; partial months include only recorded dates">
    <ResponsiveContainer width="100%" height={200}><BarChart data={[...buckets].map(([month, orders]) => ({ month, orders }))}>
      <CartesianGrid vertical={false} stroke="#edf0f2" /><XAxis dataKey="month" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tick={{ fontSize: 10 }} width={45} axisLine={false} tickLine={false} />
      <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} /><Bar dataKey="orders" name="Orders" fill="#96cbbb" radius={[4, 4, 0, 0]} maxBarSize={38} isAnimationActive={false} />
    </BarChart></ResponsiveContainer>
  </div>;
}
export function ForecastComparison({ original, changed }: { original: NonNullable<Forecast>; changed: NonNullable<Forecast> }) {
  return <div className="analytics-chart" role="img" aria-label="Baseline and alternative-history forecasts; not causal impact estimates">
    <ResponsiveContainer width="100%" height={220}><LineChart data={original.points.map((point, index) => ({ date: point.date, baseline: point.sales, alternative: changed.points[index]?.sales }))}>
      <CartesianGrid vertical={false} stroke="#edf0f2" /><XAxis dataKey="date" tickFormatter={shortDate} minTickGap={45} tick={{ fontSize: 10 }} /><YAxis tickFormatter={compact} width={55} tick={{ fontSize: 10 }} />
      <Tooltip formatter={(value) => (Number(value) / moneyScale).toFixed(2)} /><Legend wrapperStyle={{ fontSize: 11 }} />
      <Line dataKey="baseline" name="Original-history forecast" stroke="#0d9b78" dot={false} isAnimationActive={false} />
      <Line dataKey="alternative" name="Alternative-history forecast" stroke="#8672d8" strokeDasharray="5 4" dot={false} isAnimationActive={false} />
    </LineChart></ResponsiveContainer>
  </div>;
}
export function TrafficChart({ days }: { days: TrafficDay[] }) {
  return <div className="analytics-chart" role="img" aria-label="Recorded website sessions and purchasing sessions by day">
    <ResponsiveContainer width="100%" height={220}><LineChart data={days}>
      <CartesianGrid vertical={false} stroke="#edf0f2" />
      <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={45} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
      <YAxis yAxisId="sessions" tick={{ fontSize: 10 }} width={45} axisLine={false} tickLine={false} />
      <YAxis yAxisId="purchases" orientation="right" tick={{ fontSize: 10 }} width={35} axisLine={false} tickLine={false} />
      <Tooltip labelFormatter={(value) => shortDate(String(value))} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
      <Legend wrapperStyle={{ fontSize: 10 }} />
      <Line yAxisId="sessions" dataKey="sessions" name="Sessions · left axis" stroke="#0d9b78" dot={false} isAnimationActive={false} />
      <Line yAxisId="purchases" dataKey="purchasingSessions" name="Purchasing sessions · right axis" stroke="#8672d8" dot={false} isAnimationActive={false} />
    </LineChart></ResponsiveContainer>
  </div>;
}
