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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub base_url: String,
    pub model: String,
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
                },
            );
        }
        Self {
            firebase_project_id: String::new(),
            firebase_api_key: String::new(),
            api_key: String::new(),
            models,
            active_model: DEEPSEEK_MODEL.to_string(),
        }
    }
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
}

impl PublicConfig {
    pub fn from_parts(cfg: &AppConfig, user: &UserConfig) -> Self {
        Self {
            firebase_project_id: cfg.firebase_project_id.clone(),
            firebase_api_key: cfg.firebase_api_key.clone(),
            firebase_email: cfg.firebase_email.clone(),
            firebase_auth_set: cfg.firestore_auth().configured(),
            api_key_set: !user.api_key.is_empty(),
            models: user.models.keys().cloned().collect(),
            active_model: user.active_model.clone(),
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
