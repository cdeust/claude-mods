#!/usr/bin/env python3
"""Run a copied Codex package without references to the source checkout.

Source: codex/.codex-plugin/plugin.json and codex/hooks/hooks.json at e899dc0b.
This is package/CLI acceptance, not proof of a native Codex host lifecycle.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    with tempfile.TemporaryDirectory(prefix="mods-package-") as directory:
        package = Path(directory) / "package"
        shutil.copytree("codex", package)
        manifest = json.loads((package / ".codex-plugin/plugin.json").read_text())
        assert (package / manifest["hooks"]).is_file()
        assert list((package / manifest["skills"]).glob("*/SKILL.md"))
        command = package / "skills/autopilot/scripts/run.mjs"
        result = subprocess.run(
            ["node", str(command), "critical"],
            cwd=directory,
            check=True,
            capture_output=True,
            text=True,
        )
        result = json.loads(result.stdout)
        assert result["effort"] == "high" and result["enforced"] is False
        hook = package / "runtime/hook.mjs"
        result = subprocess.run(
            ["node", str(hook), "PreToolUse"],
            cwd=directory,
            env={**os.environ, "PLUGIN_DATA": str(Path(directory) / "data")},
            input=json.dumps(
                {
                    "hook_event_name": "PreToolUse",
                    "session_id": "ci-package",
                    "cwd": directory,
                    "tool_name": "Write",
                    "tool_input": {"file_path": "README.md"},
                }
            ),
            check=True,
            capture_output=True,
            text=True,
        )
        assert json.loads(result.stdout) == {}, result.stdout
        assert list((Path(directory) / "data/sessions").glob("*.jsonl"))
    print("Copied Codex package command and hook completed")


if __name__ == "__main__":
    main()
