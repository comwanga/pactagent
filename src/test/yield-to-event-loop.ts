import { afterEach } from "vitest";

/*
 * Lets each Vitest test process turn its event loop once after every test.
 *
 * Several long suites are CPU-bound and only await promises, so a whole file
 * can run without the event loop turning. Vitest's worker RPC (for example
 * "onTaskUpdate") gives up after 60 s, and its reply is only processed when the
 * loop turns. Whether the reply or the expired timeout runs first then depends
 * on the loop phase the stall started in. Tests that wait on a worker thread,
 * as PDF extraction does since Issue #61, shift that phase, and the run fails
 * with "Timeout calling onTaskUpdate". Turning the loop between tests keeps
 * every stall far below the RPC timeout.
 *
 * The real setImmediate is captured here, before any test can install fake
 * timers.
 */
const realSetImmediate = globalThis.setImmediate;

afterEach(() => new Promise<void>((resolve) => realSetImmediate(() => resolve())));
