import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type SpanOptions,
  type Tracer,
} from "@opentelemetry/api";

const TRACER_NAME = "@zettapay/api";
const TRACER_VERSION = "0.1.0";

/**
 * Returns the shared ZettaPay tracer. The OpenTelemetry global tracer provider
 * is wired up by `initTracing` at process boot — calling `getTracer` before
 * boot, or with tracing disabled, returns a NoopTracer that creates spans
 * which are never exported. Either way callers can use the same API.
 */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

/**
 * Wraps an async operation in a span. Records exceptions and sets the span
 * status to ERROR on throw, then re-throws so business logic semantics are
 * preserved. Returns the operation's result on success.
 *
 * Usage:
 *   const result = await withSpan("payments.create", { merchantId }, async (span) => {
 *     span.setAttribute("payment.amount", amount);
 *     return doWork();
 *   });
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes | undefined,
  fn: (span: Span) => Promise<T>,
  options: SpanOptions = {},
): Promise<T> {
  const tracer = getTracer();
  const spanOptions: SpanOptions = attributes
    ? { ...options, attributes: { ...(options.attributes ?? {}), ...attributes } }
    : options;
  return tracer.startActiveSpan(name, spanOptions, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      recordSpanError(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Synchronous variant of {@link withSpan} for non-async hot paths. */
export function withSpanSync<T>(
  name: string,
  attributes: Attributes | undefined,
  fn: (span: Span) => T,
  options: SpanOptions = {},
): T {
  const tracer = getTracer();
  const spanOptions: SpanOptions = attributes
    ? { ...options, attributes: { ...(options.attributes ?? {}), ...attributes } }
    : options;
  return tracer.startActiveSpan(name, spanOptions, (span) => {
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      recordSpanError(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Records an error on the span without ending it. Caller controls lifecycle. */
export function recordSpanError(span: Span, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}
