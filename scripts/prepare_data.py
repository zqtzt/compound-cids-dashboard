#!/usr/bin/env python3
"""Export the published annual NC files without changing their scientific values."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
import struct

import numpy as np
from scipy.io import loadmat, netcdf_file

ROOT = Path(__file__).resolve().parents[1]
LAYERS = ("surface", "epipelagic", "mesopelagic")
FIELDS = ("ToE_compound", "ToE_compound_direction",
          "ToE_compound_significant_flag", "Exposure_level", "Exposure_type")
SERIES = {
    "T": [1, 5, 6, 7, 8, 9],
    "S": [2, 3, 5, 6, 8, 9],
    "DO": [4, 7, 8, 9],
    "TDO": [7, 8, 9],
    "TS": [5, 6, 8, 9],
    "TSDO": [8, 9],
}
EARTH_RADIUS_KM = 6371.0088


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_nc(path):
    with netcdf_file(path, "r", mmap=False) as nc:
        arrays = {key: var.data.copy() for key, var in nc.variables.items()}
        attrs = {
            key: value.decode("utf-8") if isinstance(value, bytes)
            else value.item() if isinstance(value, np.generic) else value
            for key, value in nc._attributes.items()
        }
    return arrays, attrs


def export(source, coastline, destination):
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "grid").mkdir(exist_ok=True)
    # 1980年原始暴露等级均缺测；其有限发布值恰好提供固定水面分析域。
    anchor, anchor_meta = load_nc(source / "ToE_compound_1980.nc")
    assert np.all(np.asarray(anchor_meta["Original_low_count"]) == 0)
    mask = np.isfinite(anchor["Exposure_level_surface"])
    for layer in LAYERS:
        assert np.array_equal(mask, np.isfinite(anchor["Exposure_level_" + layer]))
    lon, lat = anchor["lon"].astype(float), anchor["lat"].astype(float)
    np.testing.assert_array_equal(lon, np.arange(0.5, 360))
    np.testing.assert_array_equal(lat, np.arange(-89.5, 90))
    assert mask.shape == (180, 360)
    assert mask.sum() == 35706
    assert not np.any(mask[(lat < -69.5) | (lat > 67.5)])
    # 面积由格点南北边界精确积分；不使用未加权格点数作为面积比例。
    row_area = EARTH_RADIUS_KM**2 * np.deg2rad(1) * (
        np.sin(np.deg2rad(lat + 0.5)) - np.sin(np.deg2rad(lat - 0.5))
    )
    area = np.broadcast_to(row_area[:, None], mask.shape)
    denominator = float(area[mask].sum())
    np.testing.assert_allclose(area.sum(), 4 * np.pi * EARTH_RADIUS_KM**2)
    (destination / "domain.bin").write_bytes(mask.astype("u1").tobytes())

    records, inventory = [], []
    for year in range(1990, 2026):
        path = source / ("ToE_compound_" + str(year) + ".nc")
        arrays, attrs = load_nc(path)
        assert attrs["Evaluation_year"] == year
        assert attrs["Full_period_fit_anchor_year"] == 2025
        assert attrs["Dataset_version"] == "v2.0"
        assert attrs["Export_complete"] == 1
        np.testing.assert_array_equal(arrays["lon"], lon)
        np.testing.assert_array_equal(arrays["lat"], lat)
        payload = bytearray(struct.pack("<4s6H", b"CCID", 1, 180, 360, 3, year, 0))
        year_record = {"year": year, "layers": {}}
        for layer in LAYERS:
            layer_arrays = [arrays[name + "_" + layer] for name in FIELDS]
            toe, category, significant, exposure, exposure_type = layer_arrays
            assert all(a.shape == mask.shape for a in layer_arrays)
            assert np.all(toe[np.isfinite(toe)] <= year)
            for a, allowed in zip(layer_arrays[1:], [
                range(10), [0, 1], [1, 2, 3], range(1, 7)
            ]):
                assert np.all(np.isin(a[np.isfinite(a)], list(allowed)))
            # 年份用无损uint16，其余分类用uint8；保留独立缺测哨兵。
            for index, a in enumerate(layer_arrays):
                dtype, missing = ("<u2", 65535) if index == 0 else ("u1", 255)
                finite = np.isfinite(a)
                assert np.all(a[finite] == np.floor(a[finite]))
                encoded = np.full(a.shape, missing, dtype=dtype)
                encoded[finite] = a[finite]
                payload.extend(encoded.tobytes(order="C"))
            valid = mask & np.isfinite(toe) & (significant == 1)
            values = {}
            for key, codes in SERIES.items():
                covered = valid & np.isin(category, codes)
                covered_area = float(area[covered].sum())
                values[key] = {
                    "percent": covered_area / denominator * 100,
                    "area_km2": covered_area,
                }
            assert values["TSDO"]["percent"] <= values["TS"]["percent"] + 1e-10
            assert values["TSDO"]["percent"] <= values["TDO"]["percent"] + 1e-10
            for pair, singles in [("TS", ("T", "S")), ("TDO", ("T", "DO"))]:
                assert all(values[pair]["percent"] <= values[s]["percent"] + 1e-10
                           for s in singles)
            year_record["layers"][layer] = values
        target = destination / "grid" / (str(year) + ".bin")
        target.write_bytes(payload)
        records.append(year_record)
        inventory.append({
            "year": year, "source_file": path.name, "source_sha256": sha256(path),
            "grid_file": "grid/" + target.name, "grid_sha256": sha256(target),
            "bytes": len(payload),
        })
        print("Exported", year, len(payload), "bytes")

    # 海岸背景沿用原发布源；只导出几何数据，不复制M_Map程序。
    coast = loadmat(coastline)
    vertices = coast["ncst"]
    breaks = coast["k"].ravel().astype(int)
    segments = []
    for index, signed_area in enumerate(coast["Area"].ravel()):
        points = vertices[breaks[index]: breaks[index + 1] - 1]
        points = points[np.isfinite(points).all(axis=1)]
        if len(points) >= 3 and signed_area != 0:
            segments.append({
                "water": bool(signed_area < 0),
                "points": np.round(points, 4).tolist(),
            })
    write_json(destination / "coastline.json", {
        "source": "M_Map private/m_coasts.mat",
        "source_sha256": sha256(coastline),
        "segments": segments,
    })
    write_json(destination / "statistics.json", {
        "years": list(range(1990, 2026)), "series": SERIES, "records": records,
        "denominator_area_km2": denominator,
    })
    manifest = {
        "format": "compound-cids-grid-v1", "dataset_version": "v2.0",
        "start_year": 1990, "end_year": 2025, "fit_anchor_year": 2025,
        "years": list(range(1990, 2026)), "layers": list(LAYERS),
        "grid": {"nx": 360, "ny": 180, "lon_start": 0.5, "lat_start": -89.5,
                 "step_degrees": 1, "order": "latitude-major, longitude-minor"},
        "encoding": {"endianness": "little", "header_bytes": 16,
                     "planes": ["toe:u16", "direction:u8", "significance:u8",
                                "exposure:u8", "exposure_type:u8"],
                     "missing_toe": 65535, "missing_category": 255},
        "domain": {
            "file": "domain.bin", "grid_cells": int(mask.sum()),
            "latitude_centres": [-69.5, 67.5],
            "area_km2": denominator, "earth_radius_km": EARTH_RADIUS_KM,
            "source": "finite Exposure_level_surface in the 1980 v2.0 release",
            "source_sha256": sha256(source / "ToE_compound_1980.nc"),
        },
        "statistics": {
            "series": SERIES, "require_significance": 1,
            "require_finite_toe": True,
            "meaning": "Overlapping coverage of displayed significant CID categories",
            "uncertainty_bands": False,
        },
        "citation": attrs["Data citation"],
        "article_url": "https://www.nature.com/articles/s41558-025-02484-x",
        "exposure_low_policy": attrs["Exposure_low_policy"],
        "annual_files": inventory,
    }
    write_json(destination / "manifest.json", manifest)
    with (destination / "annual_coverage.csv").open("w", newline="", encoding="utf-8") as out:
        writer = csv.writer(out)
        writer.writerow(["Year", "Layer", "Indicator", "Area_percent", "Area_km2",
                         "Denominator_area_km2"])
        for record in records:
            for layer in LAYERS:
                for key, values in record["layers"][layer].items():
                    writer.writerow([record["year"], layer, key, values["percent"],
                                     values["area_km2"], denominator])
    print("Fixed domain:", int(mask.sum()), "cells;", round(denominator, 3), "km²")


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                               allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--coastline", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "data")
    args = parser.parse_args()
    export(args.source, args.coastline, args.output)
