// Which write requests skip the write gate — one table plus one interpreter.
//
// Each route used to spell the decision itself: `isReadOnly('/x', op) ? null : leaseGate(payload)`
// plus a private exception in /worker (isolated) and /act (py with a caller). Changing one skip
// rule meant editing eight files, and no single place could answer "which requests never reach
// the gate?". Now the exceptions are data and the predicate has exactly one definition; the
// routes only ask whether the gate applies.
//
// Default is "gate it": an unknown path, an unknown op, or a missing rule all fall through to the
// lease/session gate. Skipping is the exception and must be stated here.

import { currentCaller } from './caller.js'
import { isReadOnly } from './lease.js'

type Payload = Record<string, unknown> | null | undefined

/**
 * path → "this request does not touch the live scene" predicate.
 *
 * Only two routes need a rule beyond the read-only op table:
 * - /act: a py call with a caller is authorized and queued once in beginPy (it holds the py lock
 *   and honours wait_ms). Going through leaseGate first returns py_busy/scope_required before the
 *   wait, which is why the old route skipped it. Legacy clients without a caller keep the lease.
 * - /worker: isolated work runs in its own subprocess/temp kernel, so it never touches the live
 *   scene the lease protects.
 */
const SKIP_RULES: Record<string, (payload: Record<string, unknown>) => boolean> = {
  '/act': (payload) => payload.py === true && currentCaller() !== null,
  '/worker': (payload) => payload.isolated === true,
}

/** True when this request must pass the write gate. False = the route may proceed directly. */
export function shouldGateWrite(path: string, payload?: Payload): boolean {
  const body = (payload || {}) as Record<string, unknown>
  const skip = Object.prototype.hasOwnProperty.call(SKIP_RULES, path) ? SKIP_RULES[path] : null
  if (skip && skip(body)) return false
  return !isReadOnly(path, body.op)
}

/** The paths that skip the gate for reasons other than a read-only op (tests assert this set). */
export const SKIP_RULE_PATHS: string[] = Object.keys(SKIP_RULES)
