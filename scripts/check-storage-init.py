#!/usr/bin/env python3
"""Exercise each Compose storage-init command against a partly root-owned volume.

Usage: CONTAINER_CLI=podman python3 scripts/check-storage-init.py IMAGE
Reads the JSON-form entrypoint directly from each compose file (no YAML dependency).
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

cli = os.environ.get("CONTAINER_CLI", "podman")
image = sys.argv[1]
root = Path(__file__).resolve().parent.parent


def run(*args):
    return subprocess.check_output([cli, *args], text=True).strip()


for compose in ("docker-compose.yml", "docker-compose.prod.yml", "docker/docker-compose.yml"):
    volume = "hycanvas-init-check-" + uuid.uuid4().hex
    try:
        entrypoint = next(line.split("entrypoint:", 1)[1].strip()
                          for line in (root / compose).read_text().splitlines()
                          if "entrypoint:" in line)
        command = json.loads(entrypoint)
        assert command[:2] == ["sh", "-c"]
        run("run", "--rm", "-u", "0", "-v", volume + ":/app/.data/storage",
            "--entrypoint", "sh", image, "-c",
            "mkdir -p /app/.data/storage/copied; "
            "echo preserved > /app/.data/storage/copied/file; "
            "chown -R 0:0 /app/.data/storage/copied; "
            "chown 10001:0 /app/.data/storage; "
            "ln -s /usr/local/bin/hycanvas /app/.data/storage/link")
        for _ in range(2):
            run("run", "--rm", "-u", "0", "-v", volume + ":/app/.data/storage",
                "--entrypoint", "sh", image, "-c", command[2].replace("$$", "$"))
            result = run("run", "--rm", "-v", volume + ":/app/.data/storage",
                         "--entrypoint", "sh", image, "-c",
                         "test $(stat -c %u:%g /app/.data/storage/copied/file) = 10001:0 && "
                         "test $(stat -c %u /usr/local/bin/hycanvas) = 0 && "
                         "echo writable >> /app/.data/storage/copied/file && "
                         "head -1 /app/.data/storage/copied/file")
            assert result == "preserved", result
        print("PASS", compose, "repairs nested ownership, preserves bytes and symlink target, repeatable")
    finally:
        run("volume", "rm", "-f", volume)
