# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules


provider_root = Path(SPECPATH).resolve()

analysis = Analysis(
    [str(provider_root / "frozen_main.py")],
    pathex=[str(provider_root)],
    binaries=[],
    datas=[],
    hiddenimports=collect_submodules("qqmusic_api"),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "PyInstaller",
        "_pytest",
        "hatchling",
        "jsonschema",
        "mypy",
        "pydantic.mypy",
        "pydantic.v1.mypy",
        "pytest",
        "ruff",
        "setuptools",
    ],
    noarchive=False,
    optimize=0,
)

python_archive = PYZ(analysis.pure)

executable = EXE(
    python_archive,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="qqmusic-provider",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)

bundle = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="qqmusic-provider",
)
