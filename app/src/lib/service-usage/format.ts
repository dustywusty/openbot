/** Missing or invalid quota is unknown; zero is a measured value. */
export function reportedUsedPercent(
  used: number | null | undefined,
): number | null {
  return typeof used === "number" &&
    Number.isFinite(used) &&
    used >= 0 &&
    used <= 100
    ? used
    : null;
}
export function durationLabel(seconds: number): string {
  if (seconds < 60) return "less than a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return `${hours}h${rest ? ` ${rest}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}
export function resetLabel(resetAt: number | null, nowSeconds: number): string {
  if (resetAt === null || !Number.isFinite(resetAt))
    return "Reset time not reported";
  return resetAt <= nowSeconds
    ? "Reset time passed; refresh usage"
    : `Resets in ${durationLabel(resetAt - nowSeconds)}`;
}
export function observedLabel(observedAt: number, nowSeconds: number): string {
  if (!Number.isFinite(observedAt) || observedAt <= 0)
    return "Update time not reported";
  const age = Math.max(0, nowSeconds - observedAt);
  return age < 60
    ? "Updated just now"
    : `Updated ${durationLabel(age)} ago${age >= 120 ? " · May be out of date" : ""}`;
}
