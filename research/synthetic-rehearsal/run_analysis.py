"""
합성 데이터 리허설 — 분석 파이프라인 본체.

generate_synthetic_data.py가 만든 participants.csv / video_events.csv /
survey_responses.csv를 읽어, 실제 논문 Results 절에 들어갈 골격을 그대로 만든다.

수행 순서:
  1. 신뢰도(Cronbach's alpha) — 구성개념 × 시점별
  2. [1차 확증분석 — 현재 IRB 확정 설계와 일치] 사후(post) 단일측정 EXP vs CON 독립표본 t검정
  3. [탐색적 — 현재 확정 설계와 불일치, 아래 findings.md 참고] 2×2(집단×시점) 혼합분산분석
  4. [2차 가설] video_events → (production과 동일한 isValidWatch/entropy 공식으로) 기간별
     entropy/weightedEntropy 산출 → 집단×기간 혼합분산분석(추세)
  5. 표(Markdown)와 그림(PNG) 저장

사용법: python run_analysis.py --scenario effect --data-dir output/effect --out-dir output/effect
"""

from __future__ import annotations

import argparse
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
import pingouin as pg

# 그림에 한글 라벨을 쓰므로, DejaVu Sans(기본값)가 아니라 한글이 지원되는 시스템 폰트를
# 지정한다. Windows 기준 "맑은 고딕"을 우선 사용 — 다른 OS에서 실행한다면 이 값을 그
# 환경에 설치된 한글 폰트(예: macOS "AppleGothic", Linux "NanumGothic")로 바꿔야 한다.
matplotlib.rcParams["font.family"] = "Malgun Gothic"
matplotlib.rcParams["axes.unicode_minus"] = False

from metrics import calculate_distribution, calculate_entropy, calculate_weighted_distribution, is_valid_watch


def load_data(data_dir: str):
    participants = pd.read_csv(os.path.join(data_dir, "participants.csv"))
    video_events = pd.read_csv(os.path.join(data_dir, "video_events.csv"))
    survey = pd.read_csv(os.path.join(data_dir, "survey_responses.csv"))
    return participants, video_events, survey


# ── 1. 신뢰도 ────────────────────────────────────────────────────────────
def compute_reliability(survey: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for (construct, timepoint), grp in survey.groupby(["construct", "timepoint"]):
        wide = grp.pivot(index="anonymousId", columns="item", values="response")
        alpha, ci = pg.cronbach_alpha(data=wide)
        rows.append(
            {
                "construct": construct,
                "timepoint": timepoint,
                "n_items": wide.shape[1],
                "cronbach_alpha": round(alpha, 3),
                "ci_low": round(ci[0], 3),
                "ci_high": round(ci[1], 3),
            }
        )
    return pd.DataFrame(rows).sort_values(["construct", "timepoint"])


# ── 2/3. 설문 구성개념 점수(문항 평균) → 확증/탐색 검정 ──────────────────
def construct_scores(survey: pd.DataFrame) -> pd.DataFrame:
    return (
        survey.groupby(["anonymousId", "group", "construct", "timepoint"])["response"]
        .mean()
        .reset_index(name="score")
    )


def confirmatory_post_only_ttest(scores: pd.DataFrame) -> pd.DataFrame:
    """[1차 확증분석] 현재 확정 설계(사후 1회 측정)와 동일 — EXP vs CON, post 시점만."""
    rows = []
    post = scores[scores.timepoint == "post"]
    for construct, grp in post.groupby("construct"):
        exp = grp[grp.group == "EXP"]["score"]
        con = grp[grp.group == "CON"]["score"]
        res = pg.ttest(exp, con, paired=False)
        rows.append(
            {
                "construct": construct,
                "exp_mean": round(exp.mean(), 3),
                "con_mean": round(con.mean(), 3),
                "t": round(res["T"].iloc[0], 3),
                "dof": round(res["dof"].iloc[0], 1),
                "p_unc": round(res["p_val"].iloc[0], 4),
                "cohens_d": round(res["cohen_d"].iloc[0], 3),
            }
        )
    return pd.DataFrame(rows).sort_values("construct")


def exploratory_mixed_anova(scores: pd.DataFrame) -> pd.DataFrame:
    """[탐색적] 2(집단)×2(사전/사후) 혼합분산분석 — pre 데이터가 있어야 성립.
    findings.md에 적었듯 현재 확정 설계(사후 1회)와 전제가 다르므로 '탐색적'으로만 쓴다.
    """
    rows = []
    for construct, grp in scores.groupby("construct"):
        aov = pg.mixed_anova(
            data=grp, dv="score", within="timepoint", between="group", subject="anonymousId"
        )
        aov.insert(0, "construct", construct)
        rows.append(aov)
    return pd.concat(rows, ignore_index=True)


# ── 4. 시청 로그 → 기간별 entropy/weightedEntropy(2차 가설) ──────────────
def compute_period_diversity(video_events: pd.DataFrame) -> pd.DataFrame:
    """production의 isValidWatch → calculateDistribution/calculateWeightedDistribution →
    calculateEntropy 파이프라인을 참여자×기간 단위로 그대로 재현한다."""
    rows = []
    for (anon_id, group, period), grp in video_events.groupby(
        ["anonymousId", "group", "periodIndex"]
    ):
        valid = grp[
            grp.apply(
                lambda r: is_valid_watch(r["watchedSeconds"], r["durationSeconds"]), axis=1
            )
        ]
        category_dist = calculate_distribution(valid["categoryId"].tolist())
        entropy = calculate_entropy(category_dist)

        weighted_entries = [
            {"category_id": c, "weight": w}
            for c, w in zip(valid["categoryId"], valid["watchedSeconds"])
        ]
        weighted_dist = calculate_weighted_distribution(weighted_entries)
        weighted_entropy = calculate_entropy(weighted_dist) if weighted_dist else None

        rows.append(
            {
                "anonymousId": anon_id,
                "group": group,
                "periodIndex": period,
                "validVideoCount": len(valid),
                "entropy": entropy,
                "weightedEntropy": weighted_entropy,
            }
        )
    return pd.DataFrame(rows).sort_values(["anonymousId", "periodIndex"])


def entropy_trend_mixed_anova(period_diversity: pd.DataFrame, value_col: str) -> pd.DataFrame:
    """[2차 가설] 집단×기간(3수준) 혼합분산분석. 결측(weightedEntropy None) 참여자는
    pingouin이 처리 못 하므로 완전 사례(complete case)만 사용하고, 제외 수를 함께 보고한다.
    """
    complete_ids = (
        period_diversity.dropna(subset=[value_col])
        .groupby("anonymousId")
        .filter(lambda g: len(g) == 3)["anonymousId"]
        .unique()
    )
    excluded = period_diversity["anonymousId"].nunique() - len(complete_ids)
    data = period_diversity[period_diversity.anonymousId.isin(complete_ids)]
    aov = pg.mixed_anova(
        data=data,
        dv=value_col,
        within="periodIndex",
        between="group",
        subject="anonymousId",
    )
    return aov, excluded


# ── 5. 출력 ───────────────────────────────────────────────────────────────
def save_markdown_table(df: pd.DataFrame, path: str, title: str):
    with open(path, "a", encoding="utf-8") as f:
        f.write(f"\n## {title}\n\n")
        f.write(df.to_markdown(index=False))
        f.write("\n")


def save_figures(scores: pd.DataFrame, period_diversity: pd.DataFrame, out_dir: str):
    # 그림 1: 구성개념별 EXP/CON × pre/post 평균
    fig, ax = plt.subplots(figsize=(9, 4.5))
    summary = scores.groupby(["construct", "group", "timepoint"])["score"].mean().reset_index()
    pivot = summary.pivot_table(index=["construct"], columns=["group", "timepoint"], values="score")
    pivot.plot(kind="bar", ax=ax)
    ax.set_ylabel("구성개념 문항 평균 (1-7)")
    ax.set_title("설문 구성개념별 집단×시점 평균")
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, "fig1_survey_means.png"), dpi=120)
    plt.close(fig)

    # 그림 2: 기간별 weightedEntropy 추세
    fig, ax = plt.subplots(figsize=(6, 4.5))
    trend = period_diversity.groupby(["group", "periodIndex"])["weightedEntropy"].mean().reset_index()
    for group, style in (("EXP", "o-"), ("CON", "s--")):
        sub = trend[trend.group == group]
        ax.plot(sub.periodIndex, sub.weightedEntropy, style, label=group)
    ax.set_xlabel("기간(1=베이스라인, 2-3=개입)")
    ax.set_ylabel("시청시간 가중 엔트로피 평균")
    ax.set_title("기간별 시간 가중 다양성 추세")
    ax.legend()
    ax.set_xticks([1, 2, 3])
    fig.tight_layout()
    fig.savefig(os.path.join(out_dir, "fig2_entropy_trend.png"), dpi=120)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    participants, video_events, survey = load_data(args.data_dir)

    reliability = compute_reliability(survey)
    scores = construct_scores(survey)
    confirmatory = confirmatory_post_only_ttest(scores)
    exploratory_aov = exploratory_mixed_anova(scores)
    period_diversity = compute_period_diversity(video_events)
    entropy_aov, excluded_n = entropy_trend_mixed_anova(period_diversity, "weightedEntropy")
    entropy_aov_unweighted, excluded_n_unw = entropy_trend_mixed_anova(period_diversity, "entropy")

    report_path = os.path.join(args.out_dir, "report.md")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(f"# 합성 데이터 분석 리허설 결과 — 시나리오: {args.scenario}\n")
        f.write(f"\n참여자 {len(participants)}명, 시청 이벤트 {len(video_events)}건, ")
        f.write(f"설문 응답 {len(survey)}건.\n")

    save_markdown_table(reliability, report_path, "1. 신뢰도 (Cronbach's alpha, 구성개념×시점)")
    save_markdown_table(
        confirmatory,
        report_path,
        "2. [1차 확증분석 — 현재 확정 설계와 일치] 사후 단일측정 EXP vs CON 독립표본 t검정",
    )
    save_markdown_table(
        exploratory_aov[["construct", "Source", "F", "p_unc", "np2"]],
        report_path,
        "3. [탐색적 — 현재 확정 설계(사후 1회)와 전제가 다름] 2×2 혼합분산분석",
    )
    save_markdown_table(
        period_diversity.groupby(["group", "periodIndex"])[["entropy", "weightedEntropy", "validVideoCount"]]
        .mean()
        .round(3)
        .reset_index(),
        report_path,
        "4a. 기간별 다양성 지표 기술통계(집단 평균)",
    )
    with open(report_path, "a", encoding="utf-8") as f:
        f.write(
            f"\n완전사례(3개 기간 모두 weightedEntropy 있음): {len(participants) - excluded_n}"
            f"/{len(participants)}명 (제외 {excluded_n}명)\n"
        )
    save_markdown_table(
        entropy_aov[["Source", "F", "p_unc", "np2"]],
        report_path,
        "4b. [2차 가설] 집단×기간 혼합분산분석 — weightedEntropy(시간 가중, 오클릭 필터 적용)",
    )
    save_markdown_table(
        entropy_aov_unweighted[["Source", "F", "p_unc", "np2"]],
        report_path,
        "4c. 비교: 집단×기간 혼합분산분석 — entropy(1차 지표, 영상 개수 가중)",
    )

    save_figures(scores, period_diversity, args.out_dir)

    period_diversity.to_csv(os.path.join(args.out_dir, "period_diversity.csv"), index=False)
    confirmatory.to_csv(os.path.join(args.out_dir, "confirmatory_ttest.csv"), index=False)
    exploratory_aov.to_csv(os.path.join(args.out_dir, "exploratory_mixed_anova.csv"), index=False)
    entropy_aov.to_csv(os.path.join(args.out_dir, "entropy_trend_anova.csv"), index=False)

    print(f"[analyze] {args.scenario} -> {report_path}")


if __name__ == "__main__":
    main()
