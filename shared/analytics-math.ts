import { moneyScale, type DailySales, type ScenarioInput } from "./analytics.js";

const sum = (days: DailySales[], field: "gross" | "discounts" | "reversals" | "orders" | "units") => days.reduce((total, day) => total + day[field], 0);
export const netSales = (day: DailySales) => day.gross - day.discounts - day.reversals;
export function salesMetrics(days: DailySales[]) {
  const gross = sum(days, "gross"), discounts = sum(days, "discounts"), reversals = sum(days, "reversals");
  const orders = sum(days, "orders"), net = gross - discounts - reversals;
  const costsKnown = days.length > 0 && days.every((day) => day.cogs !== null);
  const expensesKnown = days.length > 0 && days.every((day) => day.operatingExpenses !== null);
  const trafficKnown = days.length > 0 && days.every((day) => day.sessions !== null && day.purchasingSessions !== null);
  const cogs = costsKnown ? days.reduce((total, day) => total + day.cogs!, 0) : null;
  const grossProfit = cogs === null ? null : net - cogs;
  const sessions = trafficKnown ? days.reduce((total, day) => total + day.sessions!, 0) : null;
  return {
    gross, discounts, reversals, net, orders, units: sum(days, "units"),
    aov: orders ? (gross - discounts) / orders : null,
    grossProfit, grossMargin: grossProfit !== null && net > 0 ? grossProfit / net * 100 : null,
    operatingProfit: grossProfit !== null && expensesKnown ? grossProfit - days.reduce((total, day) => total + day.operatingExpenses!, 0) : null,
    conversion: sessions ? days.reduce((total, day) => total + day.purchasingSessions!, 0) / sessions * 100 : null,
  };
}
export function percentageChange(current: number, previous: number) {
  return previous > 0 ? (current - previous) / previous * 100 : null;
}
export function scenarioDays(days: DailySales[], input: ScenarioInput): DailySales[] {
  const orderFactor = 1 + input.ordersPct / 100;
  return days.map((day) => {
    if (day.date < input.start || day.date > input.end) return { ...day };
    const orders = Math.round(day.orders * orderFactor);
    const effectiveOrderFactor = day.orders ? orders / day.orders : orderFactor;
    const salesFactor = effectiveOrderFactor * (1 + input.aovPct / 100);
    return {
    ...day,
    gross: Math.round(day.gross * salesFactor), discounts: Math.round(day.discounts * salesFactor),
    reversals: Math.round(day.reversals * salesFactor), orders,
    units: Math.round(day.units * effectiveOrderFactor),
    cogs: day.cogs === null ? null : Math.round(day.cogs * effectiveOrderFactor * (1 + input.costPct / 100)),
    // Order-count assumptions do not establish which sessions would convert.
    purchasingSessions: null,
    };
  });
}

type Model = "Last observation" | "Trailing 7 observations" | "Weekday average";
const models: Model[] = ["Last observation", "Trailing 7 observations", "Weekday average"];
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
export function nextDate(date: string, offset = 1) {
  const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}
function prediction(history: DailySales[], date: string, model: Model, metric: "sales" | "orders") {
  const values = model === "Last observation" ? history.slice(-1)
    : model === "Trailing 7 observations" ? history.slice(-7)
      : history.filter((day) => weekday(day.date) === weekday(date)).slice(-4);
  const selected = values.length ? values : history.slice(-7);
  return selected.reduce((total, day) => total + (metric === "sales" ? netSales(day) : day.orders), 0) / selected.length;
}
export function forecastSales(input: DailySales[], horizon = 30) {
  const days = [...input].sort((a, b) => a.date.localeCompare(b.date));
  if (days.length < 28) return null;
  const count = Math.min(28, Math.floor(days.length / 4));
  const holdout = days.slice(-count);
  const scores = models.map((model) => {
    const errors = holdout.map((day, index) => {
      const history = days.slice(0, days.length - count + index);
      return netSales(day) - prediction(history, day.date, model, "sales");
    });
    return { model, mae: errors.reduce((total, error) => total + Math.abs(error), 0) / count, errors };
  }).sort((a, b) => a.mae - b.mae);
  const best = scores[0];
  const variance = best.errors.reduce((total, error) => total + error ** 2, 0) / count;
  const points = Array.from({ length: horizon }, (_, index) => {
    const date = nextDate(days.at(-1)!.date, index + 1);
    const sales = prediction(days, date, best.model, "sales");
    // An indicative residual band, not a calibrated probability guarantee.
    const width = Math.sqrt(variance) * 1.96 * Math.sqrt(1 + index / 7);
    return { date, sales, orders: Math.max(0, prediction(days, date, best.model, "orders")), lower: sales - width, upper: sales + width };
  });
  return {
    model: best.model, mae: best.mae, testedDays: count, scores: scores.map(({ model, mae }) => ({ model, mae })),
    points, total: points.reduce((total, point) => total + point.sales, 0),
    currencyScale: moneyScale,
  };
}
