// Pure seasonal logic: a starter checklist and weather cues from a 7-day forecast (Open-Meteo, free, no key).

export interface SeasonalTemplate {
  title: string;
  rrule: string;
  month: number; // first month it applies
  weather: "any" | "cold" | "frost" | "warm" | "heat";
}

/** A starter checklist the user can add in one tap. Months are northern-hemisphere defaults; each is editable. */
export const SEASONAL_TEMPLATES: SeasonalTemplate[] = [
  { title: "Put winter tires on", rrule: "FREQ=YEARLY;BYMONTH=10", month: 10, weather: "cold" },
  { title: "Put summer tires on", rrule: "FREQ=YEARLY;BYMONTH=4", month: 4, weather: "warm" },
  { title: "Clean the gutters", rrule: "FREQ=YEARLY;BYMONTH=4,11", month: 4, weather: "any" },
  { title: "Replace the furnace / AC filter", rrule: "FREQ=MONTHLY;INTERVAL=3", month: 1, weather: "any" },
  { title: "Test smoke and CO detectors", rrule: "FREQ=MONTHLY;INTERVAL=6", month: 3, weather: "any" },
  { title: "Drain and cover outdoor taps", rrule: "FREQ=YEARLY;BYMONTH=11", month: 11, weather: "frost" },
  { title: "Service the AC before summer", rrule: "FREQ=YEARLY;BYMONTH=5", month: 5, weather: "heat" },
  { title: "Check the car battery and wipers", rrule: "FREQ=YEARLY;BYMONTH=11", month: 11, weather: "cold" },
];

export interface DayForecast {
  date: string; // YYYY-MM-DD
  tmin: number; // °C
  tmax: number;
}

export interface WeatherSignals {
  /** Mean daily low over the next 7 days below 7 °C: the usual winter-tire rule of thumb. */
  cold: boolean;
  /** A night at or below 0 °C in the next 7 days. */
  frost: boolean;
  /** Mean daily low at or above 7 °C: summer tires are fine again. */
  warm: boolean;
  /** A day at or above 30 °C. */
  heat: boolean;
  meanMin: number;
  minMin: number;
  maxMax: number;
  days: number;
}

/** Defensive parse of Open-Meteo's daily response. Returns [] on anything unexpected. */
export function parseOpenMeteo(j: unknown): DayForecast[] {
  const d = (j as { daily?: { time?: unknown; temperature_2m_min?: unknown; temperature_2m_max?: unknown } })?.daily;
  if (!d || !Array.isArray(d.time) || !Array.isArray(d.temperature_2m_min) || !Array.isArray(d.temperature_2m_max)) return [];
  const out: DayForecast[] = [];
  for (let i = 0; i < Math.min(d.time.length, 16); i++) {
    const date = d.time[i];
    const tmin = d.temperature_2m_min[i];
    const tmax = d.temperature_2m_max[i];
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (typeof tmin !== "number" || typeof tmax !== "number" || !Number.isFinite(tmin) || !Number.isFinite(tmax)) continue;
    out.push({ date, tmin, tmax });
  }
  return out;
}

export function weatherSignals(days: DayForecast[]): WeatherSignals | null {
  const w = days.slice(0, 7);
  if (w.length < 3) return null;
  const mins = w.map((d) => d.tmin);
  const maxs = w.map((d) => d.tmax);
  const meanMin = mins.reduce((a, b) => a + b, 0) / w.length;
  const minMin = Math.min(...mins);
  const maxMax = Math.max(...maxs);
  return {
    cold: meanMin < 7,
    frost: minMin <= 0,
    warm: meanMin >= 7,
    heat: maxMax >= 30,
    meanMin: Math.round(meanMin * 10) / 10,
    minMin,
    maxMax,
    days: w.length,
  };
}

export function weatherMatches(cue: string | null | undefined, s: WeatherSignals | null): boolean {
  if (!s || !cue || cue === "any") return false;
  return !!(s as unknown as Record<string, boolean>)[cue];
}

export function describeWeather(cue: string, s: WeatherSignals): string {
  switch (cue) {
    case "cold":
      return `lows average ${s.meanMin}°C this week`;
    case "frost":
      return `a low of ${s.minMin}°C is forecast`;
    case "warm":
      return `lows average ${s.meanMin}°C this week`;
    case "heat":
      return `a high of ${s.maxMax}°C is forecast`;
    default:
      return "";
  }
}
