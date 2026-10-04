import { describe, expect, it } from "vitest";
import { daysAgo, laPazToday, plusDays } from "./dates";

describe("fechas relativas", () => {
  it("hoy es el día de La Paz (UTC−4), no el de UTC", () => {
    expect(laPazToday(new Date("2026-10-02T03:30:00Z"))).toBe("2026-10-01");
    expect(laPazToday(new Date("2026-10-02T04:00:00Z"))).toBe("2026-10-02");
  });

  it("suma y resta días de calendario cruzando meses y años", () => {
    expect(plusDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(plusDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(plusDays("2026-03-31", 180)).toBe("2026-09-27");
  });

  it("hace n días, contado desde el día de La Paz", () => {
    const now = new Date("2026-10-02T14:00:00Z");
    expect(daysAgo(0, now)).toBe("2026-10-02");
    expect(daysAgo(205, now)).toBe("2026-03-11");
  });
});
