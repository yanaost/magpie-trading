import { describe, it, expect } from "vitest";
import { TradingCalendar, weekKey, isoDate } from "./trading-week.js";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// US market holidays / half-days used across the edge cases (2024).
const HOLIDAYS = [
  "2024-01-15", // MLK (Mon)
  "2024-03-29", // Good Friday (Fri)
  "2024-07-04", // Independence Day (Thu)
  "2024-11-28", // Thanksgiving (Thu)
];
const HALF_DAYS = [
  "2024-07-03", // day before Independence Day (Wed)
  "2024-11-29", // day after Thanksgiving (Fri)
];

const cal = new TradingCalendar(HOLIDAYS, HALF_DAYS);

describe("weekKey", () => {
  it("maps every weekday of a week to the same Monday", () => {
    // 2024-03-04 is a Monday.
    for (const iso of [
      "2024-03-04",
      "2024-03-06",
      "2024-03-08",
      "2024-03-10", // Sunday still belongs to that Mon–Sun week
    ]) {
      expect(weekKey(d(iso))).toBe("2024-03-04");
    }
    expect(weekKey(d("2024-03-11"))).toBe("2024-03-11"); // next week
  });
});

describe("TradingCalendar.isTradingDay", () => {
  it("excludes weekends and holidays, includes half-days", () => {
    expect(cal.isTradingDay(d("2024-03-08"))).toBe(true); // Fri
    expect(cal.isTradingDay(d("2024-03-09"))).toBe(false); // Sat
    expect(cal.isTradingDay(d("2024-03-10"))).toBe(false); // Sun
    expect(cal.isTradingDay(d("2024-01-15"))).toBe(false); // MLK holiday
    expect(cal.isTradingDay(d("2024-11-29"))).toBe(true); // half-day trades
    expect(cal.isHalfDay(d("2024-11-29"))).toBe(true);
  });
});

describe("TradingCalendar — week boundaries (normal week)", () => {
  it("Friday is the week-close, Monday is the week-open", () => {
    expect(cal.isWeekCloseSession(d("2024-03-08"))).toBe(true); // Fri
    expect(cal.isWeekCloseSession(d("2024-03-07"))).toBe(false); // Thu
    expect(cal.isWeekOpenSession(d("2024-03-11"))).toBe(true); // Mon
    expect(cal.isWeekOpenSession(d("2024-03-12"))).toBe(false); // Tue
  });
});

describe("TradingCalendar — holiday edges", () => {
  it("Good Friday shifts the week-close to Thursday", () => {
    expect(cal.isTradingDay(d("2024-03-29"))).toBe(false); // Good Friday
    expect(cal.isWeekCloseSession(d("2024-03-29"))).toBe(false);
    expect(cal.isWeekCloseSession(d("2024-03-28"))).toBe(true); // Thu is the close
  });

  it("a Monday holiday shifts the week-open to Tuesday", () => {
    expect(cal.isWeekOpenSession(d("2024-01-15"))).toBe(false); // MLK, not trading
    expect(cal.isWeekOpenSession(d("2024-01-16"))).toBe(true); // Tue is the open
    // The prior week still closes on its Friday.
    expect(cal.isWeekCloseSession(d("2024-01-12"))).toBe(true);
  });
});

describe("TradingCalendar — half-day edges", () => {
  it("the half-day after Thanksgiving is still the week-close", () => {
    expect(cal.isWeekCloseSession(d("2024-11-29"))).toBe(true); // half-day Fri
    expect(cal.isWeekCloseSession(d("2024-11-27"))).toBe(false); // Wed, not the close
    expect(isoDate(cal.prevTradingDay(d("2024-11-29")))).toBe("2024-11-27"); // skips the holiday Thu
  });

  it("a mid-week holiday does not create a false week-close", () => {
    // Jul 3 (half-day Wed) precedes the Jul 4 holiday, but Jul 5 (Fri) trades,
    // so the week still closes Friday — not on the half-day.
    expect(cal.isWeekCloseSession(d("2024-07-03"))).toBe(false);
    expect(cal.isWeekCloseSession(d("2024-07-05"))).toBe(true);
    expect(isoDate(cal.nextTradingDay(d("2024-07-03")))).toBe("2024-07-05");
  });
});
