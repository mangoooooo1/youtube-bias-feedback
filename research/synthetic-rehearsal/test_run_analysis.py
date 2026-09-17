"""
코드리뷰 회귀: pd.read_csv()가 빈 셀을 NaN(float)으로 읽는데, metrics.py로 포팅한
프로덕션 로직은 파이썬 None만 결측으로 인식한다. load_data()가 이 경계에서 NaN을
None으로 정규화하는지, 그리고 그 결과로 compute_period_diversity가 실제
isValidWatch/calculateDistribution의 프로덕션 규칙(계측 실패 시 보수적으로 유효
처리, null 카테고리 제외)을 그대로 따르는지 확인한다.

실행: python -m unittest test_run_analysis -v
"""

import os
import shutil
import tempfile
import unittest

import pandas as pd

from run_analysis import compute_period_diversity, load_data


def write_csv(path, rows, columns):
    pd.DataFrame(rows, columns=columns).to_csv(path, index=False)


class TestLoadDataNaNNormalization(unittest.TestCase):
    """pd.read_csv가 만든 NaN이 load_data를 거치면 None이 되는지 직접 확인."""

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_missing_cells_become_python_none(self):
        write_csv(
            os.path.join(self.tmp_dir, "participants.csv"),
            [{"anonymousId": "p1", "group": "EXP", "installDate": "2026-01-01"}],
            ["anonymousId", "group", "installDate"],
        )
        write_csv(
            os.path.join(self.tmp_dir, "video_events.csv"),
            [
                {
                    "anonymousId": "p1",
                    "group": "EXP",
                    "periodIndex": 1,
                    "categoryId": "",  # 빈 셀 -> pandas가 NaN으로 읽음
                    "durationSeconds": "",
                    "watchedSeconds": "",
                }
            ],
            [
                "anonymousId",
                "group",
                "periodIndex",
                "categoryId",
                "durationSeconds",
                "watchedSeconds",
            ],
        )
        write_csv(
            os.path.join(self.tmp_dir, "survey_responses.csv"),
            [],
            ["anonymousId", "group", "construct", "timepoint", "item", "response"],
        )

        _, video_events, _ = load_data(self.tmp_dir)
        row = video_events.iloc[0]
        self.assertIsNone(row["watchedSeconds"])
        self.assertIsNone(row["durationSeconds"])
        self.assertIsNone(row["categoryId"])


class TestComputePeriodDiversityWithMissingFields(unittest.TestCase):
    """load_data가 정규화한 None이 실제로 프로덕션과 동일한 판정으로 이어지는지 확인."""

    def test_missing_watched_seconds_is_conservatively_valid_like_production(self):
        # watchedSeconds가 없으면(계측 실패) isValidWatch가 true를 반환하는 프로덕션
        # 규칙과 동일해야 한다 — NaN이면 모든 비교가 False가 돼 반대로(무효) 판정된다.
        video_events = pd.DataFrame(
            [
                {
                    "anonymousId": "p1",
                    "group": "EXP",
                    "periodIndex": 1,
                    "categoryId": 10,
                    "durationSeconds": 600,
                    "watchedSeconds": None,
                }
            ]
        )
        result = compute_period_diversity(video_events)
        self.assertEqual(result.iloc[0]["validVideoCount"], 1)

    def test_missing_category_id_excluded_from_distribution_like_production(self):
        # categoryId가 없는 행은 calculateDistribution(JS)이 제외하는 것과 동일하게
        # 제외돼야 한다 — NaN이면 `is not None`을 통과해 분포에 잘못 섞여 들어간다.
        # pandas는 숫자·None이 섞인 컬럼을 DataFrame 생성 시점에 곧바로 float64로 바꿔
        # None을 NaN으로 흡수해버린다(리스트-of-dict 생성자 자체의 타입 추론). 그 뒤
        # astype(object)만 해서는 그 NaN이 다시 None으로 돌아오지 않는다 — load_data가
        # 실제로 쓰는 것과 동일하게 astype(object).where(notna(), None)까지 해야 진짜
        # 파이썬 None이 들어간, 프로덕션에서 재현하려는 그 상태가 된다.
        video_events = pd.DataFrame(
            [
                {
                    "anonymousId": "p1",
                    "group": "EXP",
                    "periodIndex": 1,
                    "categoryId": 10,
                    "durationSeconds": 600,
                    "watchedSeconds": 60,
                },
                {
                    "anonymousId": "p1",
                    "group": "EXP",
                    "periodIndex": 1,
                    "categoryId": None,
                    "durationSeconds": 600,
                    "watchedSeconds": 60,
                },
            ]
        )
        video_events["categoryId"] = (
            video_events["categoryId"]
            .astype(object)
            .where(video_events["categoryId"].notna(), None)
        )
        self.assertIsNone(video_events.iloc[1]["categoryId"])  # 재현 전제 자체를 확인
        result = compute_period_diversity(video_events)
        # categoryId가 없는 행이 제외돼 유효한 카테고리 1종류(10)만 남으면 entropy는 0이다.
        self.assertEqual(result.iloc[0]["entropy"], 0)


if __name__ == "__main__":
    unittest.main()
