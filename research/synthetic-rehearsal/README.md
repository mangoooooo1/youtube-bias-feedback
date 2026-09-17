# 합성 데이터 분석 리허설

지도교수 피드백("본 실험 전에 합성 데이터로 분석 전 과정을 리허설해보자")에 대응해 만든
1회성 검증 도구. **본실험 코드(extension/, server/ 프로덕션 파이프라인)는 전혀 건드리지
않으며, 실제 참여자 데이터도 전혀 쓰지 않는다.** 순수 합성 데이터로만 동작한다.

## 왜 Python인가

이 저장소의 프로덕션 코드(추출·서버)는 전부 Node.js지만, 이 리허설은 별도 디렉터리의
독립 실행 스크립트로 두고 Python(pandas/scipy/statsmodels/pingouin)을 썼다. 이유는
`docs/blog/연구방법론/IRB_IMPLEMENTATION_AUDIT.md` §13에 이미 적혀 있듯, 혼합분산분석·
Cronbach's alpha 같은 확증적 통계는 애초에 이 저장소가 아니라 "연구자 도구(R/Python 등)"
에서 실행될 것으로 예정돼 있었기 때문이다. 리허설을 실제 논문 분석에 쓸 도구로 해봐야
"어떤 분석 도구가 필요한지"(피드백 요청 사항 3)를 제대로 검증할 수 있어, 이 저장소의
기존 JS 스크립트 관례보다 실제 분석 도구를 그대로 시험해 보는 쪽을 택했다.

## 무엇을 재사용했는가

`metrics.py`는 `server/pipeline/category-diversity.js`의 `isValidWatch`·
`calculateDistribution`·`calculateWeightedDistribution`·`calculateEntropy`를 Python으로
그대로 옮긴 것이다(새 로직이 아니라 포팅). `test_metrics.py`가 실제 JS 테스트
(`category-diversity.test.js`)와 동일한 입출력으로 대조 검증한다. 이렇게 해야 이 리허설이
"이 리허설만의 통계"가 아니라 **실제 프로덕션 다양성 계산 파이프라인**을 검증하는 게 된다.

## 사용법

```bash
cd research/synthetic-rehearsal  # 아래 경로는 모두 이 디렉터리 기준 상대 경로다

python -m pip install -r requirements.txt

# 1) 합성 데이터 생성 (두 시나리오)
python generate_synthetic_data.py --scenario effect --seed 42 --out-dir output/effect
python generate_synthetic_data.py --scenario null   --seed 42 --out-dir output/null

# 2) 분석 실행 (신뢰도 → 확증분석 → 탐색적 혼합분산분석 → 엔트로피 추세 → 표/그림)
python run_analysis.py --scenario effect --data-dir output/effect --out-dir output/effect
python run_analysis.py --scenario null   --data-dir output/null   --out-dir output/null

# 3) 검증
python -m unittest test_metrics -v
```

각 시나리오 폴더에 `report.md`(표), `fig1_survey_means.png`, `fig2_entropy_trend.png`,
그리고 각 분석 단계의 원본 CSV가 생성된다. `output/`는 100% 재현 가능한 산출물이라
`.gitignore`로 커밋 대상에서 제외했다 — 필요하면 위 두 명령으로 즉시 재생성된다.

## 설계 (피드백 원문 그대로)

- 실험군 35명 / 대조군 35명 (N=70)
- 베이스라인 1주(기간 1) + 개입 2주(기간 2, 3)
- 시청 로그(video_events 스키마: categoryId·watchedSeconds·durationSeconds) + 사전/사후
  설문(6개 구성개념: BA·PD·AMCA·SRIS·SoAS·BI)

## 두 시나리오

- `effect`: 개입기 실험군의 시청 카테고리가 점차 균등해짐(엔트로피 상승) + 설문 중
  BA(편향 자각)·PD(지각된 다양성) 두 구성개념만 실험군 사후 점수 상승(d≈0.5, IRB §8
  문헌 기반 잠정 효과크기 기준). 나머지 4개 구성개념과 대조군은 변화 없음 — 분석이
  "진짜 있는 효과만" 집어내는지(특이도)까지 함께 확인하기 위함.
- `null`: 모든 구성개념·모든 시점·양 집단 모두 변화 없음(잡음만 존재).

## 발견 사항

`findings.md` 참고 — 로그 스키마 갭, 설문-분석 연결 이슈, 필요 도구, 그리고 이번 리허설
실행 과정에서 드러난 연구설계상 결정 필요 사항(사전/사후 설문 vs 현재 확정된 사후 1회
측정 설계의 충돌)을 정리했다.

## 한계 (이 리허설이 하지 않는 것)

- 합성 데이터의 효과크기·문항 로딩·오차분산은 전부 임의로 정한 값이다. 실제 파일럿
  데이터의 신뢰도·분산 구조를 반영하지 않았다 — "파이프라인이 굴러가는지"를 보는 용도지,
  검정력(power) 분석 대체가 아니다.
- 다중비교 보정(Bonferroni/FDR)을 적용하지 않았다 — 의도적으로 그대로 둬서, 보정 없이
  6개 구성개념을 검정하면 어떤 문제가 생기는지 실제로 보여주는 사례로 남겼다(findings.md
  참고).
- 그림은 초안 수준이다(Y축 범위·오차막대 없음). 실제 논문 Results에는 신뢰구간·변화량
  시각화 등으로 다듬어야 한다.
