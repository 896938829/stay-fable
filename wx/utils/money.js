"use strict";

function formatMoney(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error("Money must be a nonnegative safe integer");
  }
  const yuan = Math.floor(cents / 100);
  const remainder = String(cents % 100).padStart(2, "0");
  return `¥${yuan}.${remainder}`;
}

module.exports = {
  formatMoney,
};
