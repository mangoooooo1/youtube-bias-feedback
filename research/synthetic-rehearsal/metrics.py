"""
ViewLens 실제 프로덕션 다양성 지표 계산을 Python으로 포팅한 모듈.

원본: server/pipeline/category-diversity.js (isValidWatch, calculateDistribution,
calculateEntropy, calculateWeightedDistribution). 이 리허설이 실제 분석 파이프라인의
수학을 검증하는 것이 목적이므로, 재구현이 아니라 "같은 공식을 그대로 옮긴 것"임을
test_metrics.py에서 JS 단위테스트(category-diversity.test.js)의 기존 통과 사례와
동일한 입출력으로 대조 검증한다.
"""

from __future__ import annotations

import math

MIN_ABSOLUTE_WATCH_SECONDS = 30
MIN_RELATIVE_WATCH_RATIO = 0.25


def is_valid_watch(watched_seconds, duration_seconds) -> bool:
    """server/pipeline/category-diversity.js isValidWatch 포팅."""
    if watched_seconds is None:
        return True
    if watched_seconds >= MIN_ABSOLUTE_WATCH_SECONDS:
        return True
    if duration_seconds and duration_seconds > 0:
        return (watched_seconds / duration_seconds) >= MIN_RELATIVE_WATCH_RATIO
    return False


def calculate_distribution(category_ids: list) -> dict:
    """calculateDistribution 포팅 — 영상 개수 가중 카테고리 비율."""
    valid_ids = [c for c in category_ids if c is not None]
    if not valid_ids:
        return {}
    counts: dict = {}
    for cid in valid_ids:
        counts[cid] = counts.get(cid, 0) + 1
    total = len(valid_ids)
    return {name: round((count / total) * 1000) / 1000 for name, count in counts.items()}


def calculate_weighted_distribution(entries: list) -> dict:
    """calculateWeightedDistribution 포팅 — 시청시간 가중, 오버플로 방어(최대값 정규화) 포함.
    entries: [{"category_id": ..., "weight": float}, ...]
    """
    valid = [
        e
        for e in entries
        if e.get("category_id") is not None
        and isinstance(e.get("weight"), (int, float))
        and math.isfinite(e["weight"])
        and e["weight"] > 0
    ]
    if not valid:
        return {}

    max_weight = max(e["weight"] for e in valid)
    weight_by_name: dict = {}
    for e in valid:
        weight_by_name[e["category_id"]] = (
            weight_by_name.get(e["category_id"], 0) + e["weight"] / max_weight
        )
    total_normalized = sum(weight_by_name.values())

    return {
        name: round((w / total_normalized) * 1000) / 1000
        for name, w in weight_by_name.items()
    }


def calculate_entropy(distribution: dict) -> float:
    """calculateEntropy 포팅 — Shannon entropy (log2), 소수점 2자리 반올림."""
    proportions = list(distribution.values())
    if not proportions:
        return 0.0
    h = -sum(p * math.log2(p) for p in proportions if p > 0)
    return round(h * 100) / 100 or 0.0
