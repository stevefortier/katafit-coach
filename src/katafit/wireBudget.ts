export function backendWireBudget(remainingMs: number): number {
  // Heroku's router requires an initial response within 30 seconds.
  // Leave room for transport overhead and never extend a claimed lease.
  return Math.min(25000, remainingMs);
}
