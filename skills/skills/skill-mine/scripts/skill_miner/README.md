# skill_miner — 지식그래프 기반 프롬프트 패턴 감지 → 스킬 후보 (LLM-free)

Claude Code 세션 로그에서 반복되는 업무 지시를 감지하여 재사용 가능한 스킬 후보를 제안한다.

**특징**: `ANTHROPIC_API_KEY` 불필요 · 비용 $0 · 결정론적(seed=42) · 1~2초 실행.

## 구조

```
skill_miner/
├── extract.py         # JSONL → 순수 user prompt (stdlib only)
├── materialize.py     # prompt → virtual wiki note (PyYAML)
├── graph_build.py     # virtual vault → NetworkX graph (build-graph.py 재사용)
├── analyze.py         # community → candidate + Markdown 리포트
├── run.py             # 4단계 오케스트레이터 CLI
├── vocab/
│   ├── actions.yaml   # 한·영 동사 34종
│   └── objects.yaml   # 한·영 객체 40종
└── README.md
```

## 파이프라인

1. **Extract**: `~/.claude/projects/*.jsonl` 에서 순수 사용자 프롬프트만 추출. wrapper(`<local-command-…>`, `<system-reminder>`, tool_result), 인터럽트 마커, 길이 외(10~2000자) 모두 제외.

2. **Materialize**: 각 프롬프트를 wiki markdown note로 변환. `vocab/actions.yaml`, `vocab/objects.yaml`, `project-registry.yaml` (people/orgs/keywords/acronyms) 과 longest-match 매칭하여 `[[action:<verb>]]` / `[[object:<noun>]]` / `[[entity:<kind>:<slug>]]` wiki-link 삽입. PII 마스킹 (사람명→`[PERSON]`, 경로→`[PATH]`, 이메일→`[EMAIL]`).

3. **GraphBuild**: `~/.anchor/skills/_builtin/lib/build-graph.py` 의 `extract_wiki`, `build_graph`, `detect_communities` (Leiden seed=42 / Louvain fallback), `find_god_nodes`, `find_surprising_connections`, `compute_community_stats` 를 그대로 import 하여 재사용.

4. **Analyze**: 커뮤니티별 후보 생성:
   - 합격: prompt 멤버 ≥ 3 AND novelty ≥ 0.3
   - novelty = 1 − Jaccard(후보 triggers, 기존 스킬 카탈로그)
   - rank = `log₂(size) × (unique_days/day_span) × cohesion × novelty`
   - 출력: `_sys/reports/skill-candidates-YYMMDD.md`

## 사용법

```bash
cd <workspace-root>

# 최근 30일 corpus, 전체 파이프라인
~/.anchor/skills/skill-mine/scripts/run.sh \
  ~/.anchor/skills/skill-mine/scripts/skill_miner/run.py --days 30

# 단계별 실행
~/.anchor/skills/skill-mine/scripts/run.sh \
  ~/.anchor/skills/skill-mine/scripts/skill_miner/run.py --stage extract --days 7
~/.anchor/skills/skill-mine/scripts/run.sh \
  ~/.anchor/skills/skill-mine/scripts/skill_miner/run.py --stage materialize
~/.anchor/skills/skill-mine/scripts/run.sh \
  ~/.anchor/skills/skill-mine/scripts/skill_miner/run.py --stage graph
~/.anchor/skills/skill-mine/scripts/run.sh \
  ~/.anchor/skills/skill-mine/scripts/skill_miner/run.py --stage analyze

# 캐시 재사용
~/.anchor/skills/skill-mine/scripts/run.sh \
  ~/.anchor/skills/skill-mine/scripts/skill_miner/run.py --from-cache

# 임계치 조정 (짧은 corpus)
~/.anchor/skills/skill-mine/scripts/run.sh \
  ~/.anchor/skills/skill-mine/scripts/skill_miner/run.py --min-size 2 --min-novelty 0.2
```

## 출력

- `_sys/reports/.cache/prompts-YYMMDD.jsonl` — Extract 단계
- `_sys/reports/.cache/virtual-vault-YYMMDD/notes/*.md` — Materialize 단계 (프롬프트 + 사전 stub)
- `_sys/reports/.cache/prompts-graph-YYMMDD.json` — Graph (NetworkX node_link + 커뮤니티 + god nodes)
- `_sys/reports/skill-candidates-YYMMDD.md` — 최종 리포트

## 의존성

이미 설치됨 (`~/.anchor/skills/_builtin/envs/default/pyproject.toml`):
- `graphifyy>=0.4.18` — tree-sitter 기반 AST (code mode 전용; 이 스킬은 wiki mode라 직접 사용 안 함)
- `networkx` — 그래프 구조 + Leiden/Louvain 커뮤니티
- `graspologic` (try-except optional) — Leiden 구현
- `pyyaml` — 사전·레지스트리 로딩

## 사전 보강

god_nodes 에 기대하는 어휘가 안 보이거나 매칭 rate가 낮으면:

```yaml
# ~/.anchor/skills/skill-mine/scripts/skill_miner/vocab/actions.yaml
actions:
  - canon: archive          # 새 canonical action
    surface: [아카이브, archive, 보관]
```

```yaml
# ~/.anchor/skills/skill-mine/scripts/skill_miner/vocab/objects.yaml
objects:
  - canon: newsletter
    surface: [뉴스레터, newsletter]
```

`project-registry.yaml` 의 people/orgs/keywords/acronyms 도 자동 반영됨.

## 관련

- 이 파이프라인은 `vault-graph` 스킬과 동일한 `~/.anchor/skills/_builtin/lib/build-graph.py` primitives 를 사용한다. vault 그래프 분석 · skill 패턴 감지가 같은 파이프라인을 공유한다.
