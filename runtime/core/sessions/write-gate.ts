import type { CallerIdentity, GrantRecord, SessionRecord, SessionResult } from './types.js'
import { callerKey, callerMatchesHolder, fail } from './types.js'
import { parseScopes, scopesCover } from './scopes.js'
import { conflictingHumanEdits } from './human-edits.js'
import type { ScopeSpec } from './scopes.js'

/** State checks shared by every agent write: ownership, pause, python lock, scope syntax. */
export function evaluateWriteGate(
  session: SessionRecord,
  c: CallerIdentity,
  scopes: unknown,
  opts: { py?: boolean; scopeDeclared?: boolean },
): SessionResult<{ effective: ScopeSpec[] }> {
  if (session.paused) {
    return fail(
      'human_paused',
      'session',
      'the human paused agent writes in Blender',
      'wait for the human to resume writes in the DSH Blender Bridge panel',
      { sessionId: session.id, pausedAt: session.pausedAt },
    )
  }
  const humanEdits = conflictingHumanEdits(session, parseScopes(scopes))
  if (humanEdits.length) {
    return fail(
      'human_modified',
      'session',
      'the human changed objects covered by this write scope',
      're-read the changed objects, then call blender_session mark_read with the same scope before writing',
      {
        sessionId: session.id,
        humanModifiedAt: session.humanModifiedAt,
        changed: humanEdits.map((edit) => ({
          kind: edit.kind,
          name: edit.name,
          revision: edit.revision,
        })),
      },
    )
  }
  if (opts.py && session.activePy && callerKey(session.activePy.caller) !== callerKey(c)) {
    return fail(
      'py_busy',
      'session',
      'another agent is running Python',
      'retry after the active Python call finishes',
      {
        holder: session.activePy.caller,
        startedAt: session.activePy.startedAt,
        retryAfterMs: 250,
      },
    )
  }
  const writes = parseScopes(scopes)
  // 反馈 1: a subagent with collection:_probe_x must be able to run Python there.
  // Python has no static scope, so the declared scope is the contract; the act
  // receipt reports the objects it actually changed and the Gateway flags any
  // write outside the declaration (scope_violation).
  return { ok: true, effective: writes.length ? writes : [{ kind: 'exclusive' }] }
}

/**
 * The owner/granter is never blocked by its own grants.
 *
 * Field retest: issuing `collection:_probe_grant` to a subagent then writing that
 * same collection as the owner returned scope_conflict — the granter locked itself
 * out. A grant authorizes its holder; it does not fence the owner. Scope conflicts
 * remain meaningful between two non-owner agents (grant issuance still refuses
 * overlapping holders), but the main agent always writes.
 */
export function authorizeMainWrite(
  _session: SessionRecord,
  _c: CallerIdentity,
  _effective: ScopeSpec[],
): SessionResult<{ mode: 'main' }> {
  return { ok: true, mode: 'main' }
}

export function coveringGrant(
  session: SessionRecord,
  c: CallerIdentity,
  effective: ScopeSpec[],
): GrantRecord | null {
  for (const g of session.grants.values()) {
    if (!callerMatchesHolder(g.holder, c)) continue
    if (scopesCover(g.scopes, effective)) return g
  }
  return null
}
