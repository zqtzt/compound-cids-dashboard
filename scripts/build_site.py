#!/usr/bin/env python3
"""Copy the self-contained public dashboard into _site for GitHub Pages."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
output = root / "_site"
output.mkdir(exist_ok=True)
for pattern in ("*.html", "*.css", "*.js"):
    for path in root.glob(pattern):
        shutil.copy2(path, output / path.name)
for name in ("assets", "data"):
    shutil.copytree(root / name, output / name, dirs_exist_ok=True)
(output / ".nojekyll").touch()
print("Static site:", output)
print("Bytes:", sum(path.stat().st_size for path in output.rglob("*") if path.is_file()))
