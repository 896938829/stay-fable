"use strict";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value) {
  return String(value).padStart(2, "0");
}

function assertDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Invalid local date");
  }
  return value;
}

function parseDate(value) {
  const match = typeof value === "string" ? DATE_PATTERN.exec(value) : null;
  if (!match) {
    throw new Error("Invalid local date");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = new Date(year, month - 1, day);
  if (
    result.getFullYear() !== year ||
    result.getMonth() !== month - 1 ||
    result.getDate() !== day
  ) {
    throw new Error("Invalid local date");
  }
  return result;
}

function formatDate(value) {
  const date = assertDate(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toDate(value) {
  return typeof value === "string" ? parseDate(value) : assertDate(value);
}

function addDays(value, amount) {
  if (!Number.isInteger(amount)) {
    throw new Error("Day amount must be an integer");
  }
  const source = toDate(value);
  const result = new Date(source.getFullYear(), source.getMonth(), source.getDate());
  result.setDate(result.getDate() + amount);
  return result;
}

function compareDates(left, right) {
  const leftDate = toDate(left);
  const rightDate = toDate(right);
  const leftValue = new Date(
    leftDate.getFullYear(),
    leftDate.getMonth(),
    leftDate.getDate(),
  ).getTime();
  const rightValue = new Date(
    rightDate.getFullYear(),
    rightDate.getMonth(),
    rightDate.getDate(),
  ).getTime();
  return Math.sign(leftValue - rightValue);
}

function getDefaultDates(clock) {
  const now = (clock || (() => new Date()))();
  return {
    checkin: formatDate(addDays(now, 1)),
    checkout: formatDate(addDays(now, 2)),
  };
}

module.exports = {
  addDays,
  compareDates,
  formatDate,
  getDefaultDates,
  parseDate,
};
