"""
합성 데이터 생성기  

설계(피드백 원문 그대로): 실험군 35명 / 대조군 35명, 베이스라인 1주 + 개입 2주(총 3주,
period 1/2/3, period 1=베이스라인), 시청 로그(video_events 스키마) + 사전/사후 설문.

두 시나리오를 만든다.
  - effect: 개입기 동안 실험군의 시청 카테고리 분포가 더 균등해지고(엔트로피 상승),
            설문 중 "편향 자각(BA)"·"지각된 다양성(PD)" 두 구성개념에서 실험군만
            사전→사후 상승. 대조군과 나머지 4개 구성개념은 변화 없음(특이도 확인용).
  - null:   두 집단 모두 어떤 시점에도 변화 없음(잡음만 존재).

시청 로그는 실제 video_events 스키마 필드명(anonymousId, categoryId, watchedSeconds,
durationSeconds)을 그대로 쓴다 — 이것이 이 리허설의 핵심 목적(로그 스키마 검증)이다.

사용법:
  python generate_synthetic_data.py --scenario effect --seed 42 --out-dir output/effect
  python generate_synthetic_data.py --scenario null   --seed 42 --out-dir output/null
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd

N_PER_GROUP = 35
DAYS_PER_PERIOD = 7
N_PERIODS = 3  # 1=베이스라인, 2=개입 1주차, 3=개입 2주차

# server/pipeline/category-diversity.js CATEGORY_NAMES에서 실사용 빈도가 높은 10개만 발췌.
CATEGORY_IDS = [1, 2, 10, 15, 17, 20, 22, 23, 24, 28]
BASELINE_CATEGORY_WEIGHTS = np.array(
    [0.05, 0.03, 0.25, 0.05, 0.10, 0.35, 0.05, 0.05, 0.04, 0.03]
)
UNIFORM_CATEGORY_WEIGHTS = np.full(len(CATEGORY_IDS), 1 / len(CATEGORY_IDS))

# 6개 구성개념 
# BA/PD는 "1차 결과변수"급(개입과 직접 관련), 나머지는 리허설에서 "효과 없어야 정상"인
# 대조 구성개념으로 둬서 분석 파이프라인이 실제로 있는 효과만 집어내는지(특이도) 함께 본다.
CONSTRUCTS = {
    "BA": 4,  # 편향 자각 (Bias Awareness) — 1차 결과변수
    "PD": 4,  # 지각된 다양성 (Perceived Diversity)
    "AMCA": 5,  # 알고리즘 인식
    "SRIS": 6,  # 비판적 성찰
    "SoAS": 5,  # 행위자성
    "BI": 3,  # 행동의도
}
AFFECTED_CONSTRUCTS = {"BA", "PD"}
LIKERT_MIN, LIKERT_MAX = 1, 7


def _clip_likert(x):
    return np.clip(np.round(x), LIKERT_MIN, LIKERT_MAX)


def make_participants(rng) -> pd.DataFrame:
    rows = []
    for group in ("EXP", "CON"):
        for i in range(1, N_PER_GROUP + 1):
            rows.append(
                {
                    "anonymousId": f"SYN-{group}-{i:02d}",
                    "group": group,
                    "installDate": "2026-01-01",
                }
            )
    return pd.DataFrame(rows)


def make_video_events(rng, participants: pd.DataFrame, scenario: str) -> pd.DataFrame:
    """참여자 × 기간별 시청 로그. 실제 video_events 스키마 필드명을 그대로 쓴다."""
    rows = []
    event_seq = 0
    for _, p in participants.iterrows():
        for period in (1, 2, 3):
            # effect 시나리오에서만, 개입기(period>=2)의 실험군이 균등 분포 쪽으로 이동한다.
            if scenario == "effect" and p["group"] == "EXP" and period >= 2:
                shift = 0.5 if period == 2 else 0.85  # 2주차에 더 뚜렷해짐(누적 추세 가정)
                weights = (
                    1 - shift
                ) * BASELINE_CATEGORY_WEIGHTS + shift * UNIFORM_CATEGORY_WEIGHTS
                weights = weights / weights.sum()
            else:
                weights = BASELINE_CATEGORY_WEIGHTS

            n_videos = rng.poisson(25)
            for _ in range(n_videos):
                category_id = rng.choice(CATEGORY_IDS, p=weights)
                duration = float(np.clip(rng.lognormal(mean=5.9, sigma=0.6), 20, 3600))
                # 85%는 "실제 시청"(비율 0.5~1.0), 15%는 "오클릭"(몇 초 만에 이탈)
                if rng.random() < 0.85:
                    watch_ratio = rng.uniform(0.5, 1.0)
                else:
                    watch_ratio = rng.uniform(0.0, 0.05)
                watched_seconds = round(duration * watch_ratio, 1)

                event_seq += 1
                rows.append(
                    {
                        "eventId": f"syn-evt-{event_seq}",
                        "anonymousId": p["anonymousId"],
                        "group": p["group"],
                        "periodIndex": period,
                        "isBaseline": 1 if period == 1 else 0,
                        "categoryId": int(category_id),
                        "durationSeconds": duration,
                        "watchedSeconds": watched_seconds,
                        "playbackRate": 1.0,
                        "wasBackgrounded": int(rng.random() < 0.1),
                    }
                )
    return pd.DataFrame(rows)


def make_survey_responses(rng, participants: pd.DataFrame, scenario: str) -> pd.DataFrame:
    """구성개념별 문항 단위 Likert 응답(사전/사후). 신뢰도(Cronbach's alpha) 산출용으로
    문항마다 공통요인(true score)에 로딩 + 문항 고유오차를 더하는 단일요인모형으로 생성한다.
    """
    rows = []
    for _, p in participants.iterrows():
        for construct, n_items in CONSTRUCTS.items():
            # 참여자×구성개념당 한 번만 뽑는다.
            # 같은 사람의 사전·사후 잠재점수는 공통 개인 성향을 공유해야 반복측정(개인 내 상관)이 성립한다. 
            # timepoint 루프 안에서 매번 새로 뽑으면 사전·사후가 서로 다른 사람처럼 독립적이 돼
            # 오차분산이 부풀고, 아래서 post에만 더하는 효과크기(d≈0.5)가 희석된다.
            baseline_true_score = rng.normal(4.0, 0.8)  # 7점 척도 중간값 근처 개인 성향
            for timepoint in ("pre", "post"):
                true_score = baseline_true_score
                if (
                    scenario == "effect"
                    and construct in AFFECTED_CONSTRUCTS
                    and p["group"] == "EXP"
                    and timepoint == "post"
                ):
                    # 문헌 기반 잠정 효과크기 d≈0.5에 맞춘 평균 상승.
                    # 개인차 SD(0.8)의 0.5배만큼 평균을 올린다.
                    true_score += 0.5 * 0.8
                for item_idx in range(1, n_items + 1):
                    loading = 0.8
                    item_score = (
                        4.0
                        + loading * (true_score - 4.0)
                        + rng.normal(0, 0.6)  # 문항 고유오차
                    )
                    rows.append(
                        {
                            "anonymousId": p["anonymousId"],
                            "group": p["group"],
                            "construct": construct,
                            "timepoint": timepoint,
                            "item": item_idx,
                            "response": int(_clip_likert(item_score)),
                        }
                    )
    return pd.DataFrame(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=["effect", "null"], required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out-dir", default=None)
    args = parser.parse_args()

    out_dir = args.out_dir or os.path.join("output", args.scenario)
    os.makedirs(out_dir, exist_ok=True)

    rng = np.random.default_rng(args.seed)

    participants = make_participants(rng)
    video_events = make_video_events(rng, participants, args.scenario)
    survey_responses = make_survey_responses(rng, participants, args.scenario)

    participants.to_csv(os.path.join(out_dir, "participants.csv"), index=False)
    video_events.to_csv(os.path.join(out_dir, "video_events.csv"), index=False)
    survey_responses.to_csv(os.path.join(out_dir, "survey_responses.csv"), index=False)

    print(f"[generate] scenario={args.scenario} seed={args.seed} -> {out_dir}")
    print(f"  participants: {len(participants)}")
    print(f"  video_events: {len(video_events)}")
    print(f"  survey_responses: {len(survey_responses)}")


if __name__ == "__main__":
    main()
