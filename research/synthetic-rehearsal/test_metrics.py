"""
metrics.py가 실제 프로덕션 JS 구현(server/pipeline/category-diversity.js)의 결과와
정확히 일치하는지 검증한다. 아래 기대값은 이 저장소의 실제 통과 중인 JS 단위테스트
(server/test/pipeline/category-diversity.test.js)에 있는 것과 동일한 입력·출력이다.
포팅 과정에서 새 버그를 만들지 않았는지 확인하는 것이 목적이므로, 새 기대값을 만들지
않고 반드시 기존 JS 테스트와 대조한다.

실행: python -m unittest research/synthetic-rehearsal/test_metrics.py -v
"""

import unittest

from metrics import (
    calculate_distribution,
    calculate_entropy,
    calculate_weighted_distribution,
    is_valid_watch,
)

MUSIC, GAME = 10, 20  # category-diversity.js CATEGORY_NAMES: 10=음악, 20=게임


class TestCalculateDistribution(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(calculate_distribution([]), {})

    def test_excludes_none(self):
        self.assertEqual(calculate_distribution([MUSIC, None, MUSIC]), {MUSIC: 1})

    def test_rounds_to_three_decimals(self):
        self.assertEqual(
            calculate_distribution([MUSIC, MUSIC, GAME]),
            {MUSIC: 0.667, GAME: 0.333},
        )


class TestCalculateEntropy(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(calculate_entropy({}), 0)

    def test_single_category(self):
        self.assertEqual(calculate_entropy({MUSIC: 1}), 0)

    def test_two_way_even_split(self):
        self.assertEqual(calculate_entropy({MUSIC: 0.5, GAME: 0.5}), 1)

    def test_four_way_even_split(self):
        self.assertEqual(
            calculate_entropy({"a": 0.25, "b": 0.25, "c": 0.25, "d": 0.25}), 2
        )

    def test_uneven_split_rounds_to_two_decimals(self):
        self.assertEqual(calculate_entropy({MUSIC: 0.25, GAME: 0.75}), 0.81)


class TestIsValidWatch(unittest.TestCase):
    def test_unknown_watch_time_is_conservatively_valid(self):
        self.assertTrue(is_valid_watch(None, 600))

    def test_absolute_threshold(self):
        self.assertTrue(is_valid_watch(30, 3600))
        self.assertTrue(is_valid_watch(45, None))

    def test_relative_threshold_favors_shorts(self):
        self.assertTrue(is_valid_watch(4, 15))  # 15초 쇼츠의 25% = 3.75초

    def test_fails_both_thresholds(self):
        self.assertFalse(is_valid_watch(2, 15))
        self.assertFalse(is_valid_watch(5, 600))

    def test_zero_or_missing_duration_uses_absolute_only(self):
        self.assertFalse(is_valid_watch(5, 0))
        self.assertFalse(is_valid_watch(5, None))


class TestCalculateWeightedDistribution(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(calculate_weighted_distribution([]), {})

    def test_excludes_zero_negative_null_weight(self):
        result = calculate_weighted_distribution(
            [
                {"category_id": MUSIC, "weight": 100},
                {"category_id": GAME, "weight": 0},
                {"category_id": GAME, "weight": -5},
            ]
        )
        self.assertEqual(result, {MUSIC: 1})

    def test_weights_by_watch_time_not_count(self):
        # 음악 1개(600초) vs 게임 3개(각 100초, 합 300초) — 개수는 1:3, 시청시간은 600:300(2:1)
        result = calculate_weighted_distribution(
            [
                {"category_id": MUSIC, "weight": 600},
                {"category_id": GAME, "weight": 100},
                {"category_id": GAME, "weight": 100},
                {"category_id": GAME, "weight": 100},
            ]
        )
        self.assertEqual(result, {MUSIC: 0.667, GAME: 0.333})

    def test_overflow_guard_matches_js_regression_test(self):
        # server/test/pipeline/category-diversity.test.js의 "1e308 두 개" 회귀 테스트와 동일
        result = calculate_weighted_distribution(
            [
                {"category_id": MUSIC, "weight": 1e308},
                {"category_id": GAME, "weight": 1e308},
            ]
        )
        self.assertEqual(result, {MUSIC: 0.5, GAME: 0.5})


if __name__ == "__main__":
    unittest.main()
