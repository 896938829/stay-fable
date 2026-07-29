import type { Clock } from "../common/clock/clock.js";
import { BusinessException } from "../common/http/business.exception.js";

export interface CatalogDateRange {
  checkin: string;
  checkout: string;
  nights: number;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

const invalidDateRange = (): BusinessException =>
  new BusinessException(400, "CATALOG_DATE_RANGE_INVALID", "入住或离店日期无效");
const checkinInPast = (): BusinessException =>
  new BusinessException(400, "CATALOG_CHECKIN_IN_PAST", "入住日期不能早于当天");
const stayTooLong = (): BusinessException =>
  new BusinessException(400, "CATALOG_STAY_TOO_LONG", "入住时长不能超过30晚");
const clockUnavailable = (): BusinessException =>
  new BusinessException(503, "CATALOG_CLOCK_UNAVAILABLE", "服务暂时不可用，请稍后重试");

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
};

const parseCalendarDate = (value: string): CalendarDate | undefined => {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return undefined;
  }

  return { year, month, day };
};

// Days since 1970-01-01 in the proleptic Gregorian calendar, without local-time parsing.
const toDayOrdinal = ({ year, month, day }: CalendarDate): number => {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;

  return era * 146_097 + dayOfEra - 719_468;
};

const currentShanghaiDate = (clock: Clock): CalendarDate => {
  try {
    const now = clock.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("Invalid clock date");
    }

    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: SHANGHAI_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts
        .filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
        .map((part) => [part.type, part.value]),
    );

    const value = `${values.year ?? ""}-${values.month ?? ""}-${values.day ?? ""}`;
    const date = parseCalendarDate(value);
    if (!date) {
      throw new Error("Invalid business date parts");
    }

    return date;
  } catch {
    throw clockUnavailable();
  }
};

export const parseCatalogDateRange = (
  checkin: string,
  checkout: string,
  clock: Clock,
): CatalogDateRange => {
  const checkinDate = parseCalendarDate(checkin);
  const checkoutDate = parseCalendarDate(checkout);
  if (!checkinDate || !checkoutDate) {
    throw invalidDateRange();
  }

  const checkinOrdinal = toDayOrdinal(checkinDate);
  const checkoutOrdinal = toDayOrdinal(checkoutDate);
  const nights = checkoutOrdinal - checkinOrdinal;
  if (nights <= 0) {
    throw invalidDateRange();
  }

  if (checkinOrdinal < toDayOrdinal(currentShanghaiDate(clock))) {
    throw checkinInPast();
  }
  if (nights > 30) {
    throw stayTooLong();
  }

  return { checkin, checkout, nights };
};
