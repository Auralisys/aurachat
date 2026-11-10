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
    /// Prezzo scelto dall'utente; assente = prezzo di listino noto (`default_pricing`), se esiste.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ModelPricing>,
}

/// Prezzi in USD per milione di token, alla tariffa piena.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ModelPricing {
    pub input_cache_hit: f64,
    pub input_cache_miss: f64,
    pub output: f64,
}

/// Sconto della fascia notturna DeepSeek (metà prezzo su ingresso e uscita).
pub const DEEPSEEK_OFF_PEAK_FACTOR: f64 = 0.5;

impl ModelPricing {
    pub fn cost(&self, row: &crate::llm::ModelUsage) -> f64 {
        let full = (row.cache_hit_tokens as f64 * self.input_cache_hit
            + row.cache_miss_tokens as f64 * self.input_cache_miss
            + row.completion_tokens as f64 * self.output) / 1_000_000.0;
        if row.off_peak { full * DEEPSEEK_OFF_PEAK_FACTOR } else { full }
    }

    fn valid(&self) -> bool {
        [self.input_cache_hit, self.input_cache_miss, self.output].iter().all(|v| v.is_finite() && *v >= 0.0 && *v <= 10_000.0)
    }
}

fn deepseek_endpoint(url: &str) -> bool {
    reqwest::Url::parse(url.trim()).ok().is_some_and(|url| url.host_str() == Some(DEEPSEEK_HOST))
}

const DEEPSEEK_HOST: &str = "api.deepseek.com";
const DEEPSEEK_FLASH_PRICE: ModelPricing = ModelPricing { input_cache_hit: 0.006, input_cache_miss: 0.30, output: 1.20 };
/// Listino ufficiale (api-docs.deepseek.com/quick_start/pricing), valido solo sull'endpoint ufficiale.
/// I nomi legacy di Flash sono serviti e fatturati come deepseek-flash.
const DEEPSEEK_PRICES: &[(&str, ModelPricing)] = &[
    ("deepseek-flash", DEEPSEEK_FLASH_PRICE),
    ("deepseek-v4-flash", DEEPSEEK_FLASH_PRICE),
    ("deepseek-v4-flash-vision-exp", DEEPSEEK_FLASH_PRICE),
    ("deepseek-v4-pro", ModelPricing { input_cache_hit: 0.044, input_cache_miss: 1.32, output: 3.96 }),
];

pub fn default_pricing(base_url: &str, model: &str) -> Option<ModelPricing> {
    if !deepseek_endpoint(base_url) { return None; }
    let model = model.trim().to_ascii_lowercase();
    DEEPSEEK_PRICES.iter().find(|(name, _)| *name == model).map(|(_, pricing)| *pricing)
}

/// DeepSeek applica la tariffa piena lun-ven 01-04 e 06-10 UTC; ogni altra ora è scontata.
/// Le festività cinesi (anch'esse scontate) non sono note: in quei giorni la stima resta per eccesso.
pub fn deepseek_off_peak(url: &str, unix_secs: u64) -> bool {
    if !deepseek_endpoint(url) { return false; }
    let weekday = (unix_secs / 86_400 + 3) % 7; // 0 = lunedì: l'1/1/1970 era giovedì
    let hour = unix_secs % 86_400 / 3_600;
    !(weekday < 5 && matches!(hour, 1..=3 | 6..=9))
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
                    pricing: None,
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

    /// Prezzo effettivo di un modello servito da `base_url`: quello dell'utente, altrimenti il listino noto.
    pub fn pricing_for(&self, base_url: &str, model: &str) -> Option<ModelPricing> {
        let base = base_url.trim().trim_end_matches('/');
        self.models.values().filter(|m| m.base_url.trim_end_matches('/') == base && m.model == model).find_map(|m| m.pricing)
            .or_else(|| default_pricing(base, model))
    }

    /// Congela il costo stimato al momento della risposta, con i prezzi attuali.
    pub fn price_usage(&self, base_url: &str, usage: &mut crate::llm::Usage) {
        usage.price(|model| self.pricing_for(base_url, model));
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
            if let Some(pricing) = model.pricing {
                if !pricing.valid() { return Err("invalid_pricing".into()); }
                // Il listino resta implicito, così i suoi aggiornamenti arrivano anche ai modelli salvati.
                if default_pricing(&model.base_url, &model.model) == Some(pricing) { model.pricing = None; }
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
    /// Solo il prezzo personalizzato; il listino arriva da `PublicConfig::known_pricing`.
    pub pricing: Option<ModelPricing>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KnownPricing {
    pub host: &'static str,
    pub model: &'static str,
    pub pricing: ModelPricing,
    pub off_peak_factor: f64,
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
    pub known_pricing: Vec<KnownPricing>,
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
                    id: id.clone(), model: m.model.clone(), base_url: m.base_url.clone(), pricing: m.pricing
                }).collect(),
            }).collect(),
            known_pricing: DEEPSEEK_PRICES.iter().map(|(model, pricing)| KnownPricing {
                host: DEEPSEEK_HOST, model, pricing: *pricing, off_peak_factor: DEEPSEEK_OFF_PEAK_FACTOR
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
            models: vec![ModelConfig { model: model.into(), base_url: base.into(), provider_id: String::new(), pricing: None }] }
    }

    fn usage_row(model: &str, off_peak: bool, hit: u64, miss: u64, output: u64) -> crate::llm::ModelUsage {
        crate::llm::ModelUsage { model: model.into(), off_peak, requests: 1, prompt_tokens: hit + miss, completion_tokens: output,
            cache_hit_tokens: hit, cache_miss_tokens: miss, reasoning_tokens: 0, unpriced_tokens: 0, cost_usd: None }
    }

    #[test]
    fn deepseek_list_prices_apply_only_to_the_official_endpoint() {
        let flash = default_pricing(DEEPSEEK_BASE_URL, "deepseek-flash").unwrap();
        assert_eq!(flash, ModelPricing { input_cache_hit: 0.006, input_cache_miss: 0.30, output: 1.20 });
        assert_eq!(default_pricing("https://api.deepseek.com/v1/", "DeepSeek-V4-Flash"), Some(flash));
        assert_eq!(default_pricing(DEEPSEEK_BASE_URL, "deepseek-v4-pro").unwrap().output, 3.96);
        assert!(default_pricing("https://proxy.example/v1", "deepseek-flash").is_none());
        assert!(default_pricing(DEEPSEEK_BASE_URL, "unknown-model").is_none());
        // 1M token in ingresso senza cache + 1M in uscita.
        let peak = flash.cost(&usage_row("deepseek-flash", false, 0, 1_000_000, 1_000_000));
        assert!((peak - 1.50).abs() < 1e-9);
        assert!((flash.cost(&usage_row("deepseek-flash", true, 1_000_000, 0, 0)) - 0.003).abs() < 1e-12);
    }

    #[test]
    fn deepseek_peak_hours_follow_utc_weekdays() {
        let monday = 1_783_900_800; // lunedì 13/7/2026 00:00 UTC
        let at = |day: u64, hour: u64| monday + day * 86_400 + hour * 3_600;
        assert!(deepseek_off_peak(DEEPSEEK_BASE_URL, at(0, 0)));
        assert!(!deepseek_off_peak(DEEPSEEK_BASE_URL, at(0, 1)));
        assert!(!deepseek_off_peak(DEEPSEEK_BASE_URL, at(0, 3) + 3_599));
        assert!(deepseek_off_peak(DEEPSEEK_BASE_URL, at(0, 4)));
        assert!(!deepseek_off_peak(DEEPSEEK_BASE_URL, at(4, 9)));
        assert!(deepseek_off_peak(DEEPSEEK_BASE_URL, at(4, 10)));
        assert!(deepseek_off_peak(DEEPSEEK_BASE_URL, at(5, 7)));
        assert!(deepseek_off_peak(DEEPSEEK_BASE_URL, at(6, 2)));
        assert!(!deepseek_off_peak("https://other.example/v1", at(5, 7)));
    }

    #[test]
    fn custom_prices_are_validated_and_list_prices_stay_implicit() {
        let mut user = UserConfig::default(); user.migrate_providers();
        let mut input = provider_input("deepseek", Some("secret"), "deepseek-flash", DEEPSEEK_BASE_URL);
        input.models[0].pricing = default_pricing(DEEPSEEK_BASE_URL, "deepseek-flash");
        user.save_provider(input).unwrap();
        assert!(user.models["deepseek::deepseek-flash"].pricing.is_none());
        assert_eq!(user.pricing_for(DEEPSEEK_BASE_URL, "deepseek-flash"), default_pricing(DEEPSEEK_BASE_URL, "deepseek-flash"));
        let custom = ModelPricing { input_cache_hit: 0.1, input_cache_miss: 1.0, output: 2.0 };
        let mut input = provider_input("local", Some("secret"), "local-model", "http://localhost:1234/v1");
        input.models[0].pricing = Some(custom);
        user.save_provider(input).unwrap();
        assert_eq!(user.pricing_for("http://localhost:1234/v1/", "local-model"), Some(custom));
        assert!(user.pricing_for("http://localhost:1234/v1", "other-model").is_none());
        let before = serde_json::to_string(&user).unwrap();
        for bad in [-1.0, f64::NAN, f64::INFINITY, 10_001.0] {
            let mut input = provider_input("local", Some("secret"), "local-model", "http://localhost:1234/v1");
            input.models[0].pricing = Some(ModelPricing { output: bad, ..custom });
            assert_eq!(user.save_provider(input).unwrap_err(), "invalid_pricing");
            assert_eq!(serde_json::to_string(&user).unwrap(), before);
        }
        let public = PublicConfig::from_parts(&AppConfig::default(), &user);
        assert!(public.known_pricing.iter().any(|p| p.model == "deepseek-flash" && p.pricing.output == 1.20));
        let restored: UserConfig = serde_json::from_str(&before).unwrap();
        assert_eq!(restored.pricing_for("http://localhost:1234/v1", "local-model"), Some(custom));
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
