"""The release workflow publishes a GitHub Release for a delegate tag, from the tag only.

The `tag` job of pipeline-post-merge.yml pushes `delegate/v<version>` with a deploy
key; release.yml turns that tag (or one named by hand) into a Release. This test pins
its contract: triggers, the tag regex, least privilege, the version check against the
manifest at the tagged commit, and that no `run:` script interpolates an expression.
"""

import json
import os
from pathlib import Path
import re
import subprocess
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/release.yml"
TAG_REGEX = r"^delegate/v[0-9]+\.[0-9]+\.[0-9]+$"
# source: .github/workflows/pipeline.yml and pipeline-post-merge.yml (checkout);
# Cortex .github/workflows/release.yml (action-gh-release), the fleet's CI source of truth.
PINS = {
    "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
    "softprops/action-gh-release": "efb35369e0ad2afab669f228072c1b0d510eae64",
}


def workflow():
    document = yaml.safe_load(WORKFLOW.read_text())
    # YAML 1.1 reads the bare key `on` as the boolean True.
    document["on"] = document.pop(True, document.get("on"))
    return document


def job():
    return workflow()["jobs"]["release"]


def step(name):
    return next(s for s in job()["steps"] if s.get("name") == name)


class ReleaseWorkflowContract(unittest.TestCase):
    def test_triggers_are_delegate_tags_and_a_dispatch_with_a_required_tag(self):
        on = workflow()["on"]
        self.assertEqual(set(on), {"push", "workflow_dispatch"})
        self.assertEqual(on["push"], {"tags": ["delegate/v*.*.*"]})
        tag = on["workflow_dispatch"]["inputs"]["tag"]
        self.assertIs(tag["required"], True)
        self.assertEqual(tag["type"], "string")

    def test_least_privilege(self):
        self.assertEqual(workflow()["permissions"], {"contents": "read"})
        self.assertEqual(job()["permissions"], {"contents": "write"})

    def test_the_tag_is_validated_before_the_checkout(self):
        names = [s.get("name") for s in job()["steps"]]
        self.assertLess(
            names.index("Validate the tag name"), names.index("Check out the tag")
        )
        self.assertIn(TAG_REGEX, step("Validate the tag name")["run"])

    def test_the_tag_regex_accepts_only_release_versions(self):
        pattern = re.compile(TAG_REGEX)
        for good in ("delegate/v0.3.2", "delegate/v10.0.1"):
            self.assertTrue(pattern.fullmatch(good), good)
        for bad in (
            "delegate/v0.3",
            "delegate/v1.2.3-rc1",
            "v0.3.2",
            "main",
            "delegate/v1.2.3;x",
        ):
            self.assertIsNone(pattern.fullmatch(bad), bad)

    def test_the_validation_script_rejects_a_bad_tag(self):
        script = step("Validate the tag name")["run"]
        for tag, code in (
            ("delegate/v0.3.2", 0),
            ("delegate/v0.3", 1),
            ("x\ndelegate/v0.3.2", 1),
        ):
            with self.subTest(tag=tag):
                result = subprocess.run(
                    ["bash", "-e", "-c", script],
                    env={"PATH": os.environ["PATH"], "RELEASE_TAG": tag},
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode, code)

    def test_the_version_check_compares_the_manifest_at_the_tag(self):
        run = step("Verify the tag names this commit and the manifest's version")["run"]
        self.assertIn('git show "${commit}:${VERSION_FILE}"', run)
        self.assertIn('"delegate/v${version}" != "$RELEASE_TAG"', run)
        self.assertIn("exit 1", run)

    def test_the_version_file_and_prefix_are_those_of_ci_json(self):
        packages = json.loads((ROOT / "ci.json").read_text())["release_packages"]
        env = job()["env"]
        self.assertIn(
            {"version_file": env["VERSION_FILE"], "tag_prefix": "delegate/v"}, packages
        )
        self.assertTrue(env["VERSION_FILE"].startswith(env["MOD_DIR"] + "/"))

    def test_no_run_script_interpolates_an_expression(self):
        for s in job()["steps"]:
            if "run" in s:
                with self.subTest(step=s.get("name")):
                    self.assertNotIn("${{", s["run"])

    def test_actions_are_pinned_to_the_fleet_shas(self):
        for s in job()["steps"]:
            if "uses" in s:
                action, sha = s["uses"].split("@")
                self.assertEqual(sha, PINS[action], action)

    def test_the_release_carries_the_tarball_and_its_checksum(self):
        release = step("Create the GitHub Release")["with"]
        self.assertEqual(release["tag_name"], "${{ env.RELEASE_TAG }}")
        self.assertIs(release["fail_on_unmatched_files"], True)
        files = release["files"].splitlines()
        self.assertEqual(len(files), 2)
        self.assertTrue(files[1].endswith(".sha256"))
        self.assertEqual(files[1], files[0] + ".sha256")

    def test_the_notes_come_from_tags_not_from_main(self):
        run = step("Write the release notes from the delegate tags")["run"]
        self.assertIn("git tag --list 'delegate/v*' --sort=-version:refname", run)
        self.assertNotIn("main", run)


if __name__ == "__main__":
    unittest.main()
