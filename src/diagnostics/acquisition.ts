/** Host-only acquisition provenance; never a property of model-facing data.
 * 0=unknown, 1=success, 2=HTTP401/403, 3=HTTP404, 4=HTTP5xx,
 * 5=transport timeout, 6=connectivity, 7=cancellation, 8=other failure.
 * cacheCode: 0=unknown, 1=gateway occurrence, 2=invocation reuse,
 * 3=new transport dispatch, 4=no transport dispatch.
 * This is observation only, not authorization or a retry decision.
 */
export interface AcquisitionDiagnostic {
  readonly outcomeCode: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly cacheCode: 0 | 1 | 2 | 3 | 4;
  readonly statusCode?: number;
}
const acquired = new WeakMap<object, Readonly<AcquisitionDiagnostic>>();
export function attestAcquisition<T>(
  value: T,
  diagnostic: AcquisitionDiagnostic,
): T {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function")
  )
    acquired.set(
      value,
      Object.freeze({
        outcomeCode: diagnostic.outcomeCode,
        cacheCode: diagnostic.cacheCode,
        ...(diagnostic.statusCode !== undefined
          ? { statusCode: diagnostic.statusCode }
          : {}),
      }),
    );
  return value;
}
export function acquisitionDiagnostic(value: unknown) {
  return value !== null &&
    (typeof value === "object" || typeof value === "function")
    ? acquired.get(value)
    : undefined;
}
