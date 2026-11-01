#!/usr/bin/env python3
"""Independently compare every exported grid value and coverage with source NC."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import struct
import numpy as np
from scipy.io import netcdf_file

ROOT = Path(__file__).resolve().parents[1]
LAYERS = ("surface", "epipelagic", "mesopelagic")
FIELDS = ("ToE_compound", "ToE_compound_direction",
          "ToE_compound_significant_flag", "Exposure_level", "Exposure_type")


def validate(source, data, report):
    manifest = json.loads((data / "manifest.json").read_text())
    statistics = json.loads((data / "statistics.json").read_text())
    mask = np.fromfile(data / "domain.bin", dtype="u1").reshape(180, 360).astype(bool)
    with netcdf_file(source / "ToE_compound_1980.nc", "r", mmap=False) as nc:
        np.testing.assert_array_equal(mask, np.isfinite(nc.variables["Exposure_level_surface"].data))
        lat = nc.variables["lat"].data.astype("f8")
    # 独立使用cos(lat)形式验证权重，与导出器的边界正弦积分交叉核对。
    row_area = np.cos(np.deg2rad(lat)) * (
        2 * np.sin(np.pi / 360) * np.pi / 180 * 6371.0088**2
    )
    area = np.repeat(row_area[:, None], 360, axis=1)
    denominator = area[mask].sum()
    np.testing.assert_allclose(denominator, manifest["domain"]["area_km2"], rtol=1e-14)
    maximum_error, value_count, statistic_count = 0.0, 0, 0
    for record in statistics["records"]:
        year = record["year"]
        source_file = source / ("ToE_compound_" + str(year) + ".nc")
        grid_file = data / "grid" / (str(year) + ".bin")
        item = next(item for item in manifest["annual_files"] if item["year"] == year)
        assert hashlib.sha256(source_file.read_bytes()).hexdigest() == item["source_sha256"]
        payload = grid_file.read_bytes()
        assert hashlib.sha256(payload).hexdigest() == item["grid_sha256"]
        assert struct.unpack_from("<4s6H", payload) == (b"CCID", 1, 180, 360, 3, year, 0)
        offset = 16
        with netcdf_file(source_file, "r", mmap=False) as nc:
            for layer in LAYERS:
                for index, name in enumerate(FIELDS):
                    original = nc.variables[name + "_" + layer].data
                    dtype, missing = ("<u2", 65535) if index == 0 else ("u1", 255)
                    encoded = np.frombuffer(payload, dtype=dtype, count=64800, offset=offset).reshape(180, 360)
                    np.testing.assert_array_equal(encoded == missing, ~np.isfinite(original))
                    np.testing.assert_array_equal(encoded[np.isfinite(original)], original[np.isfinite(original)])
                    offset += encoded.nbytes
                    value_count += original.size
                toe = nc.variables["ToE_compound_" + layer].data
                direction_var = nc.variables["ToE_compound_direction_" + layer]
                category = direction_var.data
                significant = nc.variables["ToE_compound_significant_flag_" + layer].data
                meanings = direction_var.flag_meanings.decode().split()
                flag_values = direction_var.flag_values.astype(int)
                # 直接根据NC的物理含义构造集合，独立于导出器的硬编码类别表。
                sets = {
                    "T": {int(code) for code, meaning in zip(flag_values, meanings) if "warming" in meaning},
                    "S": {int(code) for code, meaning in zip(flag_values, meanings)
                          if "salinization" in meaning or "freshening" in meaning},
                    "DO": {int(code) for code, meaning in zip(flag_values, meanings) if "deoxygenation" in meaning},
                }
                sets["TDO"] = sets["T"] & sets["DO"]
                sets["TS"] = sets["T"] & sets["S"]
                sets["TSDO"] = sets["T"] & sets["S"] & sets["DO"]
                eligible = mask & np.isfinite(toe) & (significant == 1)
                for key, codes in sets.items():
                    subset = eligible & np.isin(category, list(codes))
                    independent_area = float(area[subset].sum())
                    result = record["layers"][layer][key]
                    percent = independent_area / denominator * 100
                    maximum_error = max(maximum_error, abs(percent - result["percent"]))
                    np.testing.assert_allclose(independent_area, result["area_km2"], rtol=1e-13, atol=1e-8)
                    np.testing.assert_allclose(percent, result["percent"], rtol=1e-13, atol=1e-11)
                    assert 0 <= result["percent"] <= 100
                    statistic_count += 1
        assert offset == len(payload)
    result = {
        "passed": True, "years": 36, "range": [1990, 2025], "layers": 3,
        "scientific_grid_values_checked": value_count,
        "coverage_values_checked": statistic_count,
        "maximum_absolute_percentage_error": maximum_error,
        "domain_cells": int(mask.sum()), "domain_area_km2": float(denominator),
        "method": "Full NC-to-binary comparison; independently decoded NC flag meanings and cosine-area integration",
    }
    if report:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--data", default=ROOT / "data", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    validate(args.source, args.data, args.report)
