// Per-request target instance for Gateway→addon routing (3.1 multi-instance).
//
// The Gateway can serve several Blender instances at once, and the addon client
// then refuses any call that omits `instanceId` (ambiguity error). A request from
// the DSH host already names its caller, and the caller's GUI session names the
// Blender instance it owns — so that instance becomes the default route target
// for every addon call made while handling the request. An explicit
// `instance_id` in the payload still wins (see the /plan route).
//
// Async-local because one Gateway serves concurrent callers: a process-wide
// "current instance" would let one session's plan op drive another's Blender.
import { AsyncLocalStorage } from 'node:async_hooks'

const TARGET = new AsyncLocalStorage<string>()

export function runWithInstance<T>(instanceId: string | null | undefined, fn: () => T): T {
  const id = String(instanceId || '').trim()
  return id ? TARGET.run(id, fn) : fn()
}

export function currentInstanceId(): string | null {
  const id = TARGET.getStore()
  return id ? id : null
}
