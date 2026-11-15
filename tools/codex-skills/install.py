"""Verify/copy reviewed text-only skills with Python 3.12+; no downloads or overwrites."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys


ROOT = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def plain_path(path):
    """Reject links/junctions in a path, including existing ancestors."""
    for part in (path, *path.parents):
        if part.is_symlink() or part.is_junction():
            raise ValueError(f"Link/junction is not allowed: {part}")


def inventory(folder):
    plain_path(folder)
    if not folder.is_dir():
        raise ValueError(f"Missing skill directory: {folder}")
    result = {}
    for path in folder.rglob("*"):
        plain_path(path)
        if path.is_file():
            relative = path.relative_to(folder).as_posix()
            if path.suffix not in (".md", ".yaml") and relative != "LICENSE":
                raise ValueError(f"Unexpected non-document file: {path}")
            result[relative] = digest(path)
        elif not path.is_dir():
            raise ValueError(f"Unsupported file: {path}")
    return result


def verify_sources():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if manifest["schema_version"] != 1:
        raise ValueError("Unsupported manifest schema")
    names = set()
    for skill in manifest["skills"]:
        name = skill["name"]
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(name) > 64 or name in names:
            raise ValueError(f"Invalid or duplicate skill name: {name}")
        names.add(name)
        folder = ROOT / "skills" / name
        if inventory(folder) != skill["files"]:
            raise ValueError(f"Content differs from reviewed manifest: {name}")
        text = (folder / "SKILL.md").read_text(encoding="utf-8")
        # The maintained files use simple, single-line frontmatter fields.
        # Codex's own skills/list performs the authoritative YAML parse.
        if not text.startswith("---\n") or "\n---\n" not in text[4:]:
            raise ValueError(f"Invalid frontmatter delimiters: {name}")
        header = text.split("\n---\n", 1)[0]
        if f"\nname: {name}\n" not in header or not re.search(r"\ndescription: .+", header):
            raise ValueError(f"Missing/mismatched metadata: {name}")
    if {p.name for p in (ROOT / "skills").iterdir()} != names:
        raise ValueError("Unexpected source skill folder")
    return manifest


def main():
    if sys.version_info < (3, 12) or not callable(getattr(Path, "is_junction", None)):
        raise ValueError("Python 3.12 or newer with pathlib junction detection is required.")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", type=Path, default=Path.home() / ".agents" / "skills")
    parser.add_argument("--install", action="store_true", help="Copy absent skills after full preflight")
    parser.add_argument("--installed", action="store_true", help="Require all destination copies to match")
    args = parser.parse_args()
    manifest = verify_sources()
    destination = args.dest.expanduser().absolute()
    plain_path(destination)
    source = (ROOT / "skills").resolve()
    resolved_destination = destination.resolve()
    if (resolved_destination == source or source in resolved_destination.parents
            or resolved_destination in source.parents):
        raise ValueError("Destination must be separate from source snapshots")
    missing = []
    # Check every existing target before writing anything. Never merge or replace.
    for skill in manifest["skills"]:
        target = destination / skill["name"]
        plain_path(target)
        if target.exists():
            if inventory(target) != skill["files"]:
                raise ValueError(f"Existing skill conflict; left untouched: {target}")
        else:
            missing.append(skill)
    if args.installed and missing and not args.install:
        raise ValueError("Missing installed skills: " + ", ".join(s["name"] for s in missing))
    if args.install:
        destination.mkdir(parents=True, exist_ok=True)
        for skill in missing:
            target = destination / skill["name"]
            plain_path(target)
            # copytree refuses an existing target, including a concurrent install.
            # An interrupted copy remains visible as a conflict on the next run.
            shutil.copytree(source / skill["name"], target)
            if inventory(target) != skill["files"]:
                raise ValueError(f"Post-copy verification failed: {target}")
            print(f"Installed {target}")
    print(f"Verified {len(manifest['skills'])} source skills; destination: {destination}")
    if not args.install and missing:
        print("Not installed: " + ", ".join(s["name"] for s in missing))
    elif not missing or args.install:
        print("All installed copies match the reviewed hashes.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
