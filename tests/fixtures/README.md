# Test fixtures

Immutable inputs shared by more than one test. Do not read state from a live
Blender/backend here; tests that need those belong in `tests/e2e/`.

- `capability.lock.json`: frozen 35 family / 261 op / 6 tool surface (copied from
  `tests/capability.lock.json` during the T1 skeleton; the legacy file is removed in T11).
- `plan_readonly.baseline.json`: frozen read-only op whitelist (same migration path).
- `blender_icons.json`: Blender 5.3 icon enum snapshot; the add-on's `icon='NAME'`
  literals are resolved against it (`tests/unit/python/test_addon_ui_icons.py`),
  because an unknown name raises inside `draw()` and the UI paints
  "Error (see console)" instead of the panel. Regenerate on a new Blender major.
