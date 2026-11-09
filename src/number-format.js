export function toLatinDigits(value = "") {
  return String(value)
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

export function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { useGrouping: false }).format(value);
}

export function formatPersianDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tehran",
  }).format(new Date(value));
}
