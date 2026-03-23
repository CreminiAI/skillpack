#!/usr/bin/env python3
"""
Create a SkillPack directory from a manifest JSON file.

The manifest must already match the skillpack.json schema used by this repo:
  - name: string
  - description: string
  - version: string
  - prompts: string[]
  - skills: [{ name, source, description }]

This script writes the pack config, creates a skills/ directory, copies the
repository's launcher templates, and can optionally run `skillpack zip`.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, help="Path to JSON manifest")
    parser.add_argument("--output", required=True, help="Target pack directory")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Allow writing into a non-empty target directory",
    )
    parser.add_argument(
        "--zip",
        action="store_true",
        help="Run `npx -y @cremini/skillpack zip` after scaffolding",
    )
    return parser.parse_args()


def load_manifest(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"Manifest not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in manifest {path}: {exc}") from exc

    validate_manifest(data, str(path))
    return data


def validate_manifest(data: object, source_label: str) -> None:
    if not isinstance(data, dict):
        raise SystemExit(f"Invalid manifest from {source_label}: expected a JSON object")

    name = data.get("name")
    description = data.get("description")
    version = data.get("version")
    prompts = data.get("prompts")
    skills = data.get("skills")

    if not isinstance(name, str) or not name.strip():
        raise SystemExit(f'Invalid manifest from {source_label}: "name" is required')
    if not isinstance(description, str):
        raise SystemExit(
            f'Invalid manifest from {source_label}: "description" must be a string'
        )
    if not isinstance(version, str):
        raise SystemExit(f'Invalid manifest from {source_label}: "version" must be a string')
    if not isinstance(prompts, list) or any(not isinstance(item, str) for item in prompts):
        raise SystemExit(
            f'Invalid manifest from {source_label}: "prompts" must be a string array'
        )
    if not isinstance(skills, list):
        raise SystemExit(f'Invalid manifest from {source_label}: "skills" must be an array')

    names: set[str] = set()
    for index, skill in enumerate(skills):
        if not isinstance(skill, dict):
            raise SystemExit(
                f'Invalid manifest from {source_label}: "skills[{index}]" must be an object'
            )

        skill_name = skill.get("name")
        skill_source = skill.get("source")
        skill_description = skill.get("description")

        if not isinstance(skill_name, str) or not skill_name.strip():
            raise SystemExit(
                f'Invalid manifest from {source_label}: "skills[{index}].name" is required'
            )
        if not isinstance(skill_source, str) or not skill_source.strip():
            raise SystemExit(
                f'Invalid manifest from {source_label}: "skills[{index}].source" is required'
            )
        if not isinstance(skill_description, str):
            raise SystemExit(
                f'Invalid manifest from {source_label}: "skills[{index}].description" must be a string'
            )

        normalized = skill_name.strip().lower()
        if normalized in names:
            raise SystemExit(
                f'Invalid manifest from {source_label}: duplicate skill name "{skill_name}" is not allowed'
            )
        names.add(normalized)


def ensure_target_dir(path: Path, overwrite: bool) -> None:
    if path.exists():
        if not path.is_dir():
            raise SystemExit(f"Output path exists and is not a directory: {path}")
        has_files = any(path.iterdir())
        if has_files and not overwrite:
            raise SystemExit(
                f"Output directory is not empty: {path}. Re-run with --overwrite to continue."
            )
    path.mkdir(parents=True, exist_ok=True)


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[3]


def copy_launchers(pack_dir: Path) -> None:
    repo_root = repo_root_from_script()
    templates_dir = repo_root / "templates"

    for name in ("start.sh", "start.bat"):
        source = templates_dir / name
        if not source.exists():
            raise SystemExit(f"Missing template file: {source}")
        destination = pack_dir / name
        shutil.copyfile(source, destination)
        if name == "start.sh":
            destination.chmod(0o755)


def write_pack_files(pack_dir: Path, manifest: dict) -> None:
    (pack_dir / "skillpack.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (pack_dir / "skills").mkdir(exist_ok=True)


def run_zip(pack_dir: Path) -> None:
    result = subprocess.run(
        ["npx", "-y", "@cremini/skillpack", "zip"],
        cwd=pack_dir,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"Failed to zip pack at {pack_dir} (exit {result.returncode})")


def main() -> int:
    args = parse_args()
    manifest_path = Path(args.manifest).resolve()
    output_dir = Path(args.output).resolve()

    manifest = load_manifest(manifest_path)
    ensure_target_dir(output_dir, overwrite=args.overwrite)
    write_pack_files(output_dir, manifest)
    copy_launchers(output_dir)

    print(f"[OK] Wrote SkillPack to {output_dir}")

    if args.zip:
        run_zip(output_dir)
        print(f"[OK] Zipped SkillPack in {output_dir}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
