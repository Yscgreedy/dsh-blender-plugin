"""Every icon the add-on hands to Blender must exist in the target icon set.

Blender resolves `icon='NAME'` through an RNA enum. An unknown name raises
`TypeError: UILayout.label(): error with keyword argument "icon" - enum "<NAME>"
not found in (...)` from inside the panel's `draw()`, and the UI layer catches
that exception and paints "Error (see console)" in place of the panel body. The
add-on therefore loses the whole preferences / N-panel section with no
add-on-side traceback the user can act on.

Blender 5.3 dropped the long-standing `DISPLAY` icon, which blanked
`ui/preferences.py` right after the Gateway port field on Windows + Blender 5.3.

`tests/fixtures/blender_icons.json` is a snapshot of the icon enum; regenerate
it on a new Blender major from a real install:

    blender --background --python-expr "import bpy, json; print(json.dumps([i.identifier for i in bpy.types.UILayout.bl_rna.functions['label'].parameters['icon'].enum_items]))"

Keep the snapshot on the newest supported Blender: an icon that only exists
there is fine for the shipped manifest, whereas one removed there is a crash.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ADDON_ROOT = Path(__file__).resolve().parents[3] / "extension" / "dsh_blender_bridge"
FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "blender_icons.json"

# Keyword form only: `icon=name` from a variable cannot be resolved statically.
ICON_LITERAL = re.compile(r"""icon\s*=\s*['"]([A-Za-z0-9_]+)['"]""")


def icon_enum() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def icon_literals():
    for path in sorted(ADDON_ROOT.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        text = path.read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(), 1):
            for match in ICON_LITERAL.finditer(line):
                yield path.relative_to(ADDON_ROOT).as_posix(), lineno, match.group(1)


def test_fixture_is_a_usable_snapshot():
    data = icon_enum()
    assert data["blender_version"] == "5.3.0"
    assert len(data["icons"]) > 900
    assert "DESKTOP" in data["icons"]


def test_all_icon_literals_resolve_against_the_snapshot():
    known = set(icon_enum()["icons"])
    unknown = [
        f"{name}:{lineno}: icon={icon}"
        for name, lineno, icon in icon_literals()
        if icon not in known
    ]
    assert not unknown, "unknown Blender icons:\n" + "\n".join(unknown)


def test_the_addon_does_not_use_the_removed_display_icon():
    # Regression anchor: `DISPLAY` is what killed the preferences draw on 5.3.
    assert "DISPLAY" not in set(icon_enum()["icons"])
    used = {icon for _, _, icon in icon_literals()}
    assert "DISPLAY" not in used
