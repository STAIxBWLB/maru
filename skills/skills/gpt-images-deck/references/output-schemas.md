# GPT Images Deck Output Schemas

이 문서는 `gpt-images-deck`이 생성해야 하는 산출물의 정확한 구조를 정의한다. 실제 작업 시 필요한 단계의 섹션만 읽는다.

## DESIGN.md

`DESIGN.md`는 시각 시스템만 다룬다. 의미 요약이나 슬라이드 카피를 넣지 않는다.

```markdown
# Design System: [Concise style name]

## 1. Design Intent
- **Observed from reference or style file:**
- **Inferred but not directly visible:**
- **Overall impression:**
- **Appropriate use cases:**

## 2. Color System
- **Canvas / background:**
- **Primary text:**
- **Secondary text:**
- **Accent 1:**
- **Accent 2:**
- **Dividers / borders:**
- **Chart colors:**
- **Banned / avoid:**

## 3. Typography System
- **Title style:**
- **Section header style:**
- **Body style:**
- **Caption / source / footnote style:**
- **Numeric emphasis style:**
- **Observed casing rules:**
- **Observed line-length behavior:**

## 4. Layout Families
- **Cover / opener:**
- **Section divider:**
- **Insight / claim slide:**
- **Chart / data slide:**
- **Comparison slide:**
- **Process / timeline slide:**
- **Closing / CTA slide:**

## 5. Flow Architecture
- **Title page flow:**
- **Body page flow:**
- **End page flow:**
- **Header / body / footer structure:**
- **Header zone placement rules:**
- **Body zone placement rules:**
- **Footer zone placement rules:**

## 6. Grid, Alignment, and Spacing
- **Outer margins:**
- **Column behavior:**
- **Text alignment:**
- **Whitespace philosophy:**
- **Density level:**
- **Object anchoring rules:**

## 7. Components
- **Title block:**
- **Subtitle / kicker:**
- **Bullets / key points:**
- **Cards / callouts:**
- **Tables:**
- **Charts:**
- **Legends / labels:**
- **Icons / illustrations / photography:**
- **Icon placement and usage rules:**
- **Infographic cards / metric cards:**
- **Diagram / flow modules:**

## 8. Data Visualization Language
- **Preferred chart families:**
- **Axis / gridline treatment:**
- **Labeling style:**
- **Annotation style:**
- **When to avoid charts:**
- **Infographic composition style:**
- **Icon-led data communication:**
- **Diagram flow direction and connector behavior:**

## 9. Imagery and Graphic Treatment
- **Image crop / masking:**
- **Use of gradients / fills:**
- **Use of shapes / panels / bands:**
- **Use of texture / shadows:**

## 10. Slide-System Rules
- **What repeats across most slides:**
- **What should vary cautiously:**
- **Body-slide layout discipline:**
- **What must remain consistent across the deck:**
- **What stays consistent across title/body/end pages:**
- **How icons/infographics should repeat across the deck:**

## 11. Anti-Patterns
- [list]
```

## slide_plan.json

Return valid JSON only when producing this artifact.

```json
{
  "deck_meta": {
    "working_title": "",
    "deck_goal": "",
    "target_audience": "",
    "speaker_mode": "presented|read-only|hybrid",
    "tone": "",
    "target_length": {
      "slides": 0,
      "reasoning": ""
    }
  },
  "design_dependency": {
    "design_system_name": "",
    "body_slide_rule": "",
    "page_flow_rule": "",
    "allowed_layout_families": [],
    "consistency_notes": []
  },
  "content_inventory": [
    {
      "source_id": "",
      "source_type": "file|prompt|inference",
      "summary": "",
      "relevance": "high|medium|low",
      "usable_for": []
    }
  ],
  "story_arc": {
    "narrative_shape": "",
    "why_this_order_is_persuasive": ""
  },
  "slides": [
    {
      "slide_number": 1,
      "slide_role": "cover|context|problem|insight|evidence|comparison|solution|roadmap|summary|cta|appendix",
      "page_family": "title|body|end|appendix",
      "topic_group": "",
      "continuation_of": null,
      "working_title": "",
      "core_message": "",
      "audience_takeaway": "",
      "header_body_footer_plan": {
        "header": "",
        "body": "",
        "footer": ""
      },
      "layout_placement_notes": [],
      "infographic_strategy": "",
      "icon_strategy": "",
      "table_strategy": "",
      "chart_strategy": "",
      "supporting_context": [],
      "evidence_sources": [],
      "recommended_layout_family": "",
      "why_here": "",
      "must_include": [],
      "can_exclude": [],
      "priority": "must|should|could"
    }
  ],
  "ordering_notes": {
    "page_flow": {
      "title_page_strategy": "",
      "body_page_strategy": "",
      "end_page_strategy": ""
    },
    "split_topics": [],
    "merged_topics": [],
    "deferred_topics": [],
    "appendix_candidates": []
  }
}
```

Planning checks:

- Slide numbers are sequential.
- Every slide has a reason to exist.
- The deck begins with orientation, advances the argument in the middle, and resolves with action, implication, or takeaway.
- Header, body, and footer logic is explicit for every page.
- Table-heavy and chart-heavy evidence is planned directly rather than hidden behind decorative layouts.

## slide_prompts.json

Return valid JSON only when producing this artifact.

```json
{
  "deck_prompt_meta": {
    "design_system_name": "",
    "global_theme_summary": "",
    "global_consistency_rules": [],
    "body_slide_system": "",
    "json_version": "1.0"
  },
  "slides": [
    {
      "slide_number": 1,
      "slide_role": "",
      "page_family": "title|body|end|appendix",
      "slide_title": "",
      "layout_family": "",
      "prompt": {
        "objective": "",
        "narrative_function": "",
        "visual_intent": "",
        "content_blocks": [
          {
            "block_type": "title|subtitle|summary|bullets|chart|table|callout|quote|timeline|comparison|image|footer_note|source_note|icon_group|metric_cards|infographic|diagram_flow",
            "purpose": "",
            "content_instruction": "",
            "placement_instruction": "",
            "style_instruction": ""
          }
        ],
        "layout_instructions": {
          "structure": "",
          "header_body_footer": {
            "header": "",
            "body": "",
            "footer": ""
          },
          "reading_order": [],
          "alignment": "",
          "spacing": "",
          "density": "",
          "body_slide_consistency": ""
        },
        "design_constraints": {
          "palette_rules": [],
          "typography_rules": [],
          "component_rules": [],
          "chart_rules": [],
          "table_rules": [],
          "icon_rules": [],
          "infographic_rules": [],
          "diagram_rules": [],
          "imagery_rules": [],
          "anti_patterns_to_avoid": []
        },
        "content_constraints": {
          "must_include": [],
          "must_not_include": [],
          "evidence_to_use": [],
          "evidence_to_avoid": []
        },
        "generator_notes": {
          "ppt_generation_note": "",
          "image_generation_note": "",
          "fallback_if_content_is_sparse": ""
        }
      }
    }
  ]
}
```

Prompt checks:

- Every slide prompt matches one planned slide.
- Numbering is sequential and complete.
- Body-slide consistency rules repeat where needed.
- Header, body, and footer placement is explicit.
- Icon, infographic, diagram, table, and chart usage is explicit where relevant.
- Anti-pattern bans include random icon spam, decorative shapes, overcrowded bullet dumps, inconsistent chart styling, generic four-card templates, fake analyst charts, and table dumps with unusably tiny text.

## Image Generation Contract

Generate slide images sequentially from `DESIGN.md` and `slide_prompts.json`.

Default final filenames:

```text
page_1.png
page_2.png
page_3.png
```

Per-slide verification before accepting:

1. Page number is correct.
2. Major composition matches the intended layout family.
3. Header, body, and footer zones are visible or intentionally sparse.
4. The slide follows the selected design system.
5. Icons are absent, minimal, or present according to the prompt.
6. Anti-patterns are avoided.
7. Text is legible enough for the intended use.

Do not mark the task complete until every requested page has been generated, visually checked, and saved into the workspace with the correct numbered filename.
