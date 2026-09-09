import type { StateStore } from "../state/store.ts";
import type { RuntimeEventInput } from "../observability/events.ts";
import { Tracer } from "../observability/tracer.ts";

type PayloadSensitivity = "public" | "internal" | "personal" | "secret";

const bridgedTracers = new WeakSet<Tracer>();

/**
 * Keep a caller's tracer sink while also making its events durable. This is
 * intentionally local to project-owned runtime composition: the shared
 * observability and direct-execution interfaces remain unchanged.
 */
export function ensureTracerEventsPersisted(tracer: Tracer, state: StateStore | undefined): void {
  if (state === undefined || tracer.sink === state || bridgedTracers.has(tracer)) return;
  const emit = tracer.emit.bind(tracer);
  tracer.emit = (input: RuntimeEventInput, payloadSensitivity: PayloadSensitivity = "internal") => {
    const event = emit(input, payloadSensitivity);
    if (state.getEvent(event.eventId) === undefined) state.append(event);
    return event;
  };
  bridgedTracers.add(tracer);
}
