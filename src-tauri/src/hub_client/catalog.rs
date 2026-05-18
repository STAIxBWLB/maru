// Hub catalog types — templates, guidelines, glossary.
// Spec: ~/workspace/work/_sys/rules/hub-sync.md §4.1

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HubCatalog {
    pub fetched_at: String,
    pub business_units: Vec<HubBusinessUnit>,
    pub document_types: Vec<HubDocumentType>,
    pub templates: Vec<HubTemplateSummary>,
    pub guidelines: Vec<HubGuidelineSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubBusinessUnit {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub kind: String,
    pub deployment_scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubDocumentType {
    pub id: String,
    pub code: String,
    pub label_ko: String,
    pub label_en: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubTemplateSummary {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub document_type_code: String,
    pub business_unit_slug: Option<String>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubTemplate {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub body_markdown: String,
    pub frontmatter_schema: serde_json::Value,
    pub assets: Vec<HubTemplateAsset>,
    pub hwpx_template_key: Option<String>,
    pub version: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubTemplateAsset {
    pub role: String,
    pub filename: String,
    pub sha256: String,
    pub uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubGuidelineSummary {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub scope: String,
    pub applies_to_categories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubGuideline {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub body_markdown: String,
    pub scope: String,
    pub business_unit_slug: Option<String>,
    pub document_type_code: Option<String>,
    pub applies_to_categories: Vec<String>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubGlossaryTerm {
    pub id: String,
    pub term_ko: String,
    pub term_en: Option<String>,
    pub definition_ko: Option<String>,
    pub definition_en: Option<String>,
    pub synonyms: Vec<String>,
    pub business_unit_slug: Option<String>,
    pub replace_for_public: Option<String>,
    pub is_sensitive: bool,
}
