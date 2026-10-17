use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// Preset DeepSeek, verificato su api-docs.deepseek.com (ottobre 2026).
pub const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
pub const DEEPSEEK_MODEL: &str = "deepseek-flash";
pub const DEEPSEEK_MODELS: &[&str] = &["deepseek-flash", "deepseek-v4-pro"];

/// Bootstrap Firebase pubblico e sessione locale rinnovabile.
/// La password legacy viene letta solo per migrare la sessione; non viene serializzata.
/// La key del LLM e la lista modelli stanno su Firestore (documento utente).
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub firebase_project_id: String,
    pub firebase_api_key: String,
    pub firebase_email: String,
    #[serde(skip_serializing)]
    pub firebase_password: String,
    pub refresh_token: String,
    pub uid: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            firebase_project_id: "auralisys-chat".into(),
            firebase_api_key: "AIzaSyC6x51zeYfRt7jVoTYUb03RfnZ7hwZzlms".into(),
            firebase_email: String::new(),
            firebase_password: String::new(),
            refresh_token: String::new(),
            uid: String::new(),
        }
    }
}

impl AppConfig {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("config.json");
        match std::fs::read_to_string(path) {
            Ok(text) => {
                let mut cfg: Self = serde_json::from_str(&text).unwrap_or_default();
                let defaults = Self::default();
                if cfg.firebase_project_id.is_empty() { cfg.firebase_project_id = defaults.firebase_project_id; }
                if cfg.firebase_api_key.is_empty() { cfg.firebase_api_key = defaults.firebase_api_key; }
                cfg
            },
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("config dir: {e}"))?;
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| format!("serializza config: {e}"))?;
        std::fs::write(dir.join("config.json"), text)
            .map_err(|e| format!("scrivi config: {e}"))?;
        Ok(())
    }

    pub fn firestore_auth(&self) -> FirestoreAuth {
        FirestoreAuth {
            project_id: self.firebase_project_id.clone(),
            api_key: self.firebase_api_key.clone(),
            email: self.firebase_email.clone(),
            password: self.firebase_password.clone(),
            refresh_token: self.refresh_token.clone(),
            uid: self.uid.clone(),
        }
    }
}

/// Contesto di autenticazione Firestore, derivato dalla config locale.
#[derive(Clone)]
pub struct FirestoreAuth {
    pub project_id: String,
    pub api_key: String,
    pub email: String,
    pub password: String,
    pub refresh_token: String,
    pub uid: String,
}

impl FirestoreAuth {
    pub fn configured(&self) -> bool {
        !self.project_id.is_empty()
            && !self.api_key.is_empty()
            && !self.email.is_empty()
            && (!self.password.is_empty() || (!self.refresh_token.is_empty() && !self.uid.is_empty()))
    }
}

/// Configurazione utente su Firestore (`users/{uid}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserConfig {
    #[serde(default)]
    pub firebase_project_id: String,
    #[serde(default)]
    pub firebase_api_key: String,
    pub api_key: String,
    pub models: BTreeMap<String, ModelConfig>,
    pub active_model: String,
    #[serde(default)]
    pub providers: BTreeMap<String, ProviderConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub name: String,
    pub kind: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub provider_id: String,
}

impl Default for UserConfig {
    fn default() -> Self {
        let mut models = BTreeMap::new();
        for name in DEEPSEEK_MODELS {
            models.insert(
                name.to_string(),
                ModelConfig {
                    base_url: DEEPSEEK_BASE_URL.to_string(),
                    model: name.to_string(),
                    provider_id: String::new(),
                },
            );
        }
        Self {
            firebase_project_id: String::new(),
            firebase_api_key: String::new(),
            api_key: String::new(),
            models,
            active_model: DEEPSEEK_MODEL.to_string(),
            providers: BTreeMap::new(),
        }
    }
}

impl UserConfig {
    // Legacy model IDs and endpoints survive migration, including custom configurations.
    pub fn migrate_providers(&mut self) {
        let mut legacy = BTreeMap::new();
        for model in self.models.values_mut().filter(|m| m.provider_id.is_empty()) {
            let next = legacy.len();
            let id = legacy.entry(model.base_url.clone()).or_insert_with(|| format!("legacy-{next}"));
            model.provider_id = id.clone();
            self.providers.entry(id.clone()).or_insert_with(|| {
                let deepseek = model.base_url.trim_end_matches('/') == DEEPSEEK_BASE_URL;
                ProviderConfig { name: if deepseek { "DeepSeek" } else { "Custom" }.into(),
                    kind: if deepseek { "deepseek" } else { "custom" }.into(), api_key: self.api_key.clone() }
            });
        }
        self.api_key.clear();
    }

    pub fn model_key(&self, model: &ModelConfig) -> &str {
        self.providers.get(&model.provider_id).map(|p| p.api_key.as_str()).unwrap_or(&self.api_key)
    }

    pub fn save_provider(&mut self, input: SaveProviderInput) -> Result<(), String> {
        if input.id.is_empty() || input.id.len() > 100 || !input.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            || input.name.trim().is_empty() || input.name.len() > 100
            || !matches!(input.kind.as_str(), "deepseek" | "openai" | "openrouter" | "custom")
            || input.models.is_empty() || input.models.len() > 100 {
            return Err("invalid_provider".into());
        }
        let key = input.api_key.filter(|k| !k.trim().is_empty())
            .or_else(|| self.providers.get(&input.id).map(|p| p.api_key.clone())).unwrap_or_default();
        if key.trim().is_empty() || key.len() > 8192 || key.chars().any(char::is_control) { return Err("no_api_key".into()); }
        let mut models = BTreeMap::new();
        for mut model in input.models {
            model.model = model.model.trim().to_string();
            model.base_url = model.base_url.trim().trim_end_matches('/').to_string();
            let url = reqwest::Url::parse(&model.base_url).map_err(|_| "invalid_endpoint")?;
            let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
            if !(url.scheme() == "https" || (url.scheme() == "http" && local)) || url.host_str().is_none()
                || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
                || model.model.is_empty() || model.model.len() > 200 || model.model.chars().any(char::is_control)
                || model.base_url.len() > 2048 || model.base_url.ends_with("/chat/completions") {
                return Err("invalid_endpoint".into());
            }
            let id = self.models.iter().find(|(_, m)| m.provider_id == input.id && m.model == model.model)
                .map(|(id, _)| id.clone()).unwrap_or_else(|| format!("{}::{}", input.id, model.model));
            model.provider_id = input.id.clone();
            if models.insert(id, model).is_some() { return Err("duplicate_model".into()); }
        }
        self.models.retain(|_, m| m.provider_id != input.id);
        self.models.extend(models);
        self.providers.insert(input.id, ProviderConfig { name: input.name.trim().into(), kind: input.kind, api_key: key.trim().into() });
        self.ensure_active_model();
        Ok(())
    }

    pub fn ensure_active_model(&mut self) {
        if !self.models.contains_key(&self.active_model) {
            self.active_model = self.models.keys().next().cloned().unwrap_or_default();
        }
    }
}

pub fn completions_url(base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.ends_with("/v1") { format!("{base}/chat/completions") }
    else { format!("{base}/v1/chat/completions") }
}

#[derive(Debug, Deserialize)]
pub struct SaveProviderInput {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub api_key: Option<String>,
    pub models: Vec<ModelConfig>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicProvider {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub api_key_set: bool,
    pub models: Vec<PublicModel>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicModel {
    pub id: String,
    pub model: String,
    pub base_url: String,
}

/// Vista pubblica per la UI. La password Firebase e la key del LLM non sono
/// incluse; solo il fatto che siano state impostate.
#[derive(Debug, Clone, Serialize)]
pub struct PublicConfig {
    pub firebase_project_id: String,
    pub firebase_api_key: String,
    pub firebase_email: String,
    pub firebase_auth_set: bool,
    pub api_key_set: bool,
    pub models: Vec<String>,
    pub active_model: String,
    pub providers: Vec<PublicProvider>,
}

impl PublicConfig {
    pub fn from_parts(cfg: &AppConfig, user: &UserConfig) -> Self {
        Self {
            firebase_project_id: cfg.firebase_project_id.clone(),
            firebase_api_key: cfg.firebase_api_key.clone(),
            firebase_email: cfg.firebase_email.clone(),
            firebase_auth_set: cfg.firestore_auth().configured(),
            api_key_set: user.models.get(&user.active_model).is_some_and(|m| !user.model_key(m).is_empty()),
            models: user.models.keys().cloned().collect(),
            active_model: user.active_model.clone(),
            providers: user.providers.iter().map(|(id, provider)| PublicProvider {
                id: id.clone(), name: provider.name.clone(), kind: provider.kind.clone(), api_key_set: !provider.api_key.is_empty(),
                models: user.models.iter().filter(|(_, m)| &m.provider_id == id).map(|(id, m)| PublicModel {
                    id: id.clone(), model: m.model.clone(), base_url: m.base_url.clone()
                }).collect(),
            }).collect(),
        }
    }
}

/// Input di salvataggio dalla UI. `firebase_password` e `api_key` vuoti/None =
/// mantieni il valore attuale.
#[derive(Debug, Deserialize)]
pub struct SaveConfigInput {
    pub firebase_project_id: String,
    pub firebase_api_key: String,
    pub firebase_email: String,
    pub firebase_password: Option<String>,
    pub api_key: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn provider_input(id: &str, key: Option<&str>, model: &str, base: &str) -> SaveProviderInput {
        SaveProviderInput { id: id.into(), name: "Test provider".into(), kind: "custom".into(), api_key: key.map(str::to_string),
            models: vec![ModelConfig { model: model.into(), base_url: base.into(), provider_id: String::new() }] }
    }

    #[test]
    fn legacy_migration_preserves_ids_keys_and_custom_endpoints() {
        let mut user = UserConfig::default();
        user.api_key = "legacy-secret".into();
        user.models.get_mut(DEEPSEEK_MODEL).unwrap().base_url = "https://custom.example/api/v1".into();
        let active = user.active_model.clone();
        user.migrate_providers();
        user.migrate_providers();
        assert_eq!(user.providers.len(), 2);
        assert_eq!(user.active_model, active);
        for model in user.models.values() { assert_eq!(user.model_key(model), "legacy-secret"); }
        assert!(user.api_key.is_empty());
        assert_eq!(user.models[&active].base_url, "https://custom.example/api/v1");
        let public = serde_json::to_string(&PublicConfig::from_parts(&AppConfig::default(), &user)).unwrap();
        assert!(!public.contains("legacy-secret"));
        let restored: UserConfig = serde_json::from_str(&serde_json::to_string(&user).unwrap()).unwrap();
        assert_eq!(restored.model_key(&restored.models[&active]), "legacy-secret");
    }

    #[test]
    fn provider_keys_are_isolated_and_blank_keeps_existing_key() {
        let mut user = UserConfig::default(); user.migrate_providers();
        user.save_provider(provider_input("first", Some("first-secret"), "same-model", "https://one.example/v1")).unwrap();
        user.save_provider(provider_input("second", Some("second-secret"), "same-model", "https://two.example/v1")).unwrap();
        assert_eq!(user.model_key(&user.models["first::same-model"]), "first-secret");
        assert_eq!(user.model_key(&user.models["second::same-model"]), "second-secret");
        user.active_model = "first::same-model".into();
        user.save_provider(provider_input("first", None, "same-model", "https://one.example/api/v1")).unwrap();
        assert_eq!(user.active_model, "first::same-model");
        assert_eq!(user.model_key(&user.models[&user.active_model]), "first-secret");
        user.models.retain(|_, m| m.provider_id != "first"); user.ensure_active_model();
        assert!(user.models.contains_key(&user.active_model));
        let public = serde_json::to_string(&PublicConfig::from_parts(&AppConfig::default(), &user)).unwrap();
        assert!(!public.contains("first-secret") && !public.contains("second-secret"));
    }

    #[test]
    fn invalid_provider_updates_are_atomic_and_urls_are_normalized() {
        let mut user = UserConfig::default(); user.migrate_providers();
        let before = serde_json::to_string(&user).unwrap();
        for base in ["http://remote.example/v1", "https://name:secret@example.com", "file:///tmp/key", "https://example.com/v1?key=x", "https://example.com/v1/chat/completions"] {
            assert!(user.save_provider(provider_input("test", Some("secret"), "model", base)).is_err());
            assert_eq!(serde_json::to_string(&user).unwrap(), before);
        }
        let mut duplicate = provider_input("test", Some("secret"), "model", "https://example.com/v1");
        duplicate.models.push(duplicate.models[0].clone());
        assert!(user.save_provider(duplicate).is_err());
        assert_eq!(serde_json::to_string(&user).unwrap(), before);
        assert_eq!(completions_url("https://example.com/api/v1/"), "https://example.com/api/v1/chat/completions");
        assert_eq!(completions_url(DEEPSEEK_BASE_URL), "https://api.deepseek.com/v1/chat/completions");
        assert!(user.save_provider(provider_input("local", Some("local-token"), "local-model", "http://localhost:1234/v1")).is_ok());
    }
    #[test]
    fn session_survives_serialization_without_password() {
        let mut cfg = AppConfig::default();
        cfg.firebase_email = "test@example.com".into();
        cfg.firebase_password = "temporary-password".into();
        cfg.uid = "test-uid".into();
        cfg.refresh_token = "test-refresh".into();
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(!json.contains("temporary-password"));
        let restored: AppConfig = serde_json::from_str(&json).unwrap();
        assert!(restored.firestore_auth().configured());
        assert!(restored.firebase_password.is_empty());
    }
    #[test]
    fn legacy_and_partial_config_keep_defaults() {
        let cfg: AppConfig = serde_json::from_str(r#"{"firebase_email":"test@example.com","firebase_password":"legacy"}"#).unwrap();
        assert!(cfg.firestore_auth().configured());
        assert_eq!(cfg.firebase_project_id, "auralisys-chat");
        assert!(!AppConfig::default().firestore_auth().configured());
    }
}
