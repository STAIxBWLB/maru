SKILL.md is the instruction source for this skill. This file is background for maintainers; it holds no directives.

# Gaejosik background

## Why the markdown source rules exist

The markdown source rules (symbol ladder, line breaks, heading numbers) aim for the same visible result whether a document is rendered as HTML, converted with md2docx, or converted to HWPX.

- Line breaks: markdown renderers and md2docx merge a single line break into a space and join the lines into one paragraph, while the released `hwp` conversion keeps the paragraph structure. Meaning carried by a single line break therefore breaks on at least one path, which is why each `□` and `○` line stands as its own paragraph.
- Heading numbers: a literal number in the markdown source is the only form that survives rendering, conversion, and manual copy and paste alike.

## Surplus length examples

SKILL.md keeps one long example for the rule that 개조식 is not limited to short sentences. The original set, by length:

- Short: `2025년 8월 착수`, `예산 30억 원 규모`, `3개 기관 공동 참여`
- Medium: `Saltlux, 연세대, KAIST와 공동으로 AI Professor System 개발 추진 중`, `regional innovation 사업을 통한 지역 AI 혁신 생태계 구축이 핵심 목표`
- Long (second example): `우즈베키스탄 타슈켄트에 AI 교육센터를 설립하여 Microsoft Azure 인증 과정 포함 16주 커리큘럼을 운영하고, IT 전공 학생 20명을 대상으로 첫 코호트 런칭 예정`
