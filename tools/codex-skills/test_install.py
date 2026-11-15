"""Exercise install integrity and refusal paths with isolated temporary folders."""

import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("toolkit_install", ROOT / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="codex-skill-toolkit-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.destination = self.base / "installed"

    def run_installer(self, *args, root=ROOT):
        return subprocess.run(
            [sys.executable, str(root / "install.py"), "--dest", str(self.destination), *args],
            text=True, capture_output=True, check=False,
        )

    def test_install_and_repeat_preserve_identical_content(self):
        first = self.run_installer("--install")
        self.assertEqual(first.returncode, 0, first.stderr)
        before = {p: p.read_bytes() for p in self.destination.rglob("*") if p.is_file()}
        again = self.run_installer("--install", "--installed")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(before, {p: p.read_bytes() for p in before})
        for skill in installer.verify_sources()["skills"]:
            self.assertEqual(installer.inventory(self.destination / skill["name"]), skill["files"])

    def test_all_conflicts_checked_before_any_copy(self):
        conflict = self.destination / "ui-state-review"
        conflict.mkdir(parents=True)
        (conflict / "SKILL.md").write_text("existing local work", encoding="utf-8")
        result = self.run_installer("--install")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Existing skill conflict", result.stderr)
        self.assertEqual({p.name for p in self.destination.iterdir()}, {"ui-state-review"})
        self.assertEqual((conflict / "SKILL.md").read_text(), "existing local work")

    def test_source_tampering_refused_without_creating_destination(self):
        copied = self.base / "bundle"
        shutil.copytree(ROOT, copied, ignore=shutil.ignore_patterns("__pycache__"))
        skill = copied / "skills" / "frontend-conventions" / "SKILL.md"
        skill.write_text(skill.read_text() + "\nChanged after review.\n", encoding="utf-8")
        result = self.run_installer("--install", root=copied)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("differs from reviewed manifest", result.stderr)
        self.assertFalse(self.destination.exists())

    def test_extra_executable_refused_without_creating_destination(self):
        copied = self.base / "bundle"
        shutil.copytree(ROOT, copied, ignore=shutil.ignore_patterns("__pycache__"))
        (copied / "skills" / "frontend-conventions" / "extra.py").write_text("print('never run')")
        result = self.run_installer("--install", root=copied)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unexpected non-document", result.stderr)
        self.assertFalse(self.destination.exists())

    def test_missing_installation_reported(self):
        result = self.run_installer("--installed")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing installed skills", result.stderr)
        self.assertFalse(self.destination.exists())

    def test_older_python_refused_before_source_inspection(self):
        with patch.object(installer.sys, "version_info", (3, 11, 9)), patch.object(
            installer.sys, "argv", ["install.py", "--dest", str(self.destination), "--install"]
        ), patch.object(installer, "verify_sources", wraps=installer.verify_sources) as inspect:
            with self.assertRaisesRegex(ValueError, "Python 3.12 or newer"):
                installer.main()
            inspect.assert_not_called()
        self.assertFalse(self.destination.exists())

    def test_unavailable_junction_detection_refused_before_source_inspection(self):
        with patch.object(installer.Path, "is_junction"), patch.object(
            installer.sys, "argv", ["install.py", "--dest", str(self.destination), "--install"]
        ), patch.object(installer, "verify_sources", wraps=installer.verify_sources) as inspect:
            delattr(installer.Path, "is_junction")
            with self.assertRaisesRegex(ValueError, "junction detection"):
                installer.main()
            inspect.assert_not_called()
        self.assertFalse(self.destination.exists())

    @unittest.skipUnless(sys.platform == "win32", "Requires a native Windows junction")
    def test_windows_junction_and_ancestor_refused_without_writing_target(self):
        target = self.base / "junction-target"
        target.mkdir()
        # Paths are passed as environment data, not interpolated into shell code.
        creation = subprocess.run(
            [
                "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction "
                "-Path $env:CODEX_TOOLKIT_TEST_LINK -Target $env:CODEX_TOOLKIT_TEST_TARGET | Out-Null",
            ],
            env={**os.environ, "CODEX_TOOLKIT_TEST_LINK": str(self.destination),
                 "CODEX_TOOLKIT_TEST_TARGET": str(target)},
            text=True, capture_output=True, check=False,
        )
        self.assertEqual(creation.returncode, 0, creation.stderr)
        self.assertTrue(self.destination.is_junction())
        for destination in (self.destination, self.destination / "nested-skills"):
            with self.subTest(destination=destination):
                result = subprocess.run(
                    [sys.executable, str(ROOT / "install.py"), "--dest", str(destination), "--install"],
                    text=True, capture_output=True, check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Link/junction is not allowed", result.stderr)
                self.assertEqual(list(target.iterdir()), [])

    def test_source_destination_overlap_refused(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "install.py"), "--dest", str(ROOT / "skills"), "--install"],
            text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("separate from source", result.stderr)


if __name__ == "__main__":
    unittest.main()
