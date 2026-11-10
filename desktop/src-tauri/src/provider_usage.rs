//! Account-scoped inventory of connections explicitly configured in OpenBot.
//! Metadata only: no credential-store access, vendor CLI probes, inference, or global cache.
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    pub reset_at: Option<u64>,
    pub window_duration_mins: Option<u64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceUsage {
    pub id: String,
    pub account_url: Option<String>,
    pub provider: String,
    pub display_name: String,
    pub status: String,
    pub source: String,
    pub account_name: Option<String>,
    pub windows: Vec<UsageWindow>,
    pub message: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceUsageSnapshot {
    pub observed_at: u64,
    pub services: Vec<ServiceUsage>,
}
fn label(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.trim().is_empty() && s.len() <= 254 && !s.chars().any(char::is_control))
}
/// The trusted server verdict controls whether installation-wide configuration is read at all.
/// The coding loader must independently filter its registration snapshot by the verified owner.
pub fn read_metadata(
    installation_visible: bool,
    installation: impl FnOnce() -> Option<crate::saved_intent::ModelIntent>,
    coding: impl FnOnce() -> Result<Option<crate::computer_auth::AuthStatus>, String>,
) -> Result<ServiceUsageSnapshot, String> {
    let kind = if installation_visible {
        installation()
    } else {
        None
    };
    Ok(inventory(kind, coding()?))
}
/// Call only after native verification of the one-use current-actor usage proof. Arguments
/// are already owner-filtered; the renderer has no access to any filesystem or credential store.
pub fn inventory(
    installation: Option<crate::saved_intent::ModelIntent>,
    coding_account: Option<crate::computer_auth::AuthStatus>,
) -> ServiceUsageSnapshot {
    use crate::saved_intent::ModelIntent;
    let mut services = Vec::new();
    if let Some(kind) = installation {
        let (provider, name) = match kind {
            ModelIntent::OpenAiApiKey => ("openai", "OpenAI API"),
            ModelIntent::AnthropicApiKey => ("anthropic", "Anthropic API"),
            ModelIntent::ClaudePlan => ("claude", "Claude plan"),
            ModelIntent::ChatGptPlan => ("chatgpt", "ChatGPT plan"),
            ModelIntent::CompatibleEndpoint => ("custom", "Custom model provider"),
            ModelIntent::GoogleOauth => ("google", "Google"),
            ModelIntent::XaiOauth => ("xai", "xAI"),
        };
        services.push(ServiceUsage {id:"installation-ai".into(),account_url:match kind {ModelIntent::ChatGptPlan=>Some("https://chatgpt.com/settings/usage".into()),ModelIntent::ClaudePlan=>Some("https://claude.ai/settings/usage".into()),_=>None},provider:provider.into(),display_name:name.into(),status:"not-reported".into(),source:"OpenBot AI".into(),account_name:None,windows:vec![],message:Some("Configured for OpenBot. This connection does not provide a supported quota report.".into())});
    }
    if let Some(account) = coding_account.filter(|account| account.connected) {
        services.push(ServiceUsage {id:"coding-chatgpt".into(),account_url:Some("https://chatgpt.com/settings/usage".into()),provider:"chatgpt".into(),display_name:"ChatGPT".into(),status:"not-reported".into(),source:"Coding Bots".into(),account_name:label(account.email).or_else(||label(account.account_name)),windows:vec![],message:Some("Saved ChatGPT sign-in for your OpenBot account. Quota is not provided by this connection; manage usage in ChatGPT settings.".into())});
    }
    ServiceUsageSnapshot {
        observed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        services,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_descriptor_is_not_read_for_non_admin_actor() {
        let snapshot = read_metadata(
            false,
            || panic!("installation metadata must remain masked"),
            || Ok(None),
        )
        .unwrap();
        assert!(snapshot.services.is_empty());
        let snapshot = read_metadata(
            true,
            || Some(crate::saved_intent::ModelIntent::OpenAiApiKey),
            || Ok(None),
        )
        .unwrap();
        assert_eq!(snapshot.services.len(), 1);
        assert_eq!(snapshot.services[0].provider, "openai");
    }
    #[test]
    fn known_connections_remain_distinct_and_never_invent_quota() {
        let snapshot = inventory(
            Some(crate::saved_intent::ModelIntent::ChatGptPlan),
            Some(crate::computer_auth::AuthStatus {
                connected: true,
                email: Some("owner@example.test".into()),
                ..Default::default()
            }),
        );
        assert_eq!(snapshot.services.len(), 2);
        let mut serialized = serde_json::to_value(&snapshot).unwrap();
        serialized["observedAt"] = serde_json::json!(100);
        assert_eq!(
            serialized,
            serde_json::json!({"observedAt":100,"services":[
                {"id":"installation-ai","accountUrl":"https://chatgpt.com/settings/usage","provider":"chatgpt","displayName":"ChatGPT plan","status":"not-reported","source":"OpenBot AI","accountName":null,"windows":[],"message":"Configured for OpenBot. This connection does not provide a supported quota report."},
                {"id":"coding-chatgpt","accountUrl":"https://chatgpt.com/settings/usage","provider":"chatgpt","displayName":"ChatGPT","status":"not-reported","source":"Coding Bots","accountName":"owner@example.test","windows":[],"message":"Saved ChatGPT sign-in for your OpenBot account. Quota is not provided by this connection; manage usage in ChatGPT settings."}
            ]})
        );
        assert_ne!(snapshot.services[0].id, snapshot.services[1].id);
        assert!(snapshot
            .services
            .iter()
            .all(|s| s.account_url.as_deref() == Some("https://chatgpt.com/settings/usage")));
        assert_ne!(snapshot.services[0].source, snapshot.services[1].source);
        assert!(snapshot
            .services
            .iter()
            .all(|s| s.windows.is_empty() && s.status == "not-reported"));
        assert_eq!(
            snapshot.services[1].account_name.as_deref(),
            Some("owner@example.test")
        );
    }
    #[test]
    fn unknown_disconnected_and_unsafe_identity_are_not_fabricated() {
        assert!(inventory(None, None).services.is_empty());
        assert!(inventory(None, Some(Default::default()))
            .services
            .is_empty());
        let snapshot = inventory(
            None,
            Some(crate::computer_auth::AuthStatus {
                connected: true,
                email: Some("unsafe\nvalue".into()),
                account_name: Some("Owner".into()),
                ..Default::default()
            }),
        );
        assert_eq!(snapshot.services[0].account_name.as_deref(), Some("Owner"));
        assert!(snapshot.services[0].windows.is_empty());
    }
    #[test]
    fn inventory_has_no_process_credential_or_global_cache_access() {
        let implementation = include_str!("provider_usage.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for forbidden in [
            "std::process",
            "Command::",
            "keyring::",
            "OnceLock",
            "codex_usage",
            "std::fs",
        ] {
            assert!(!implementation.contains(forbidden), "{forbidden}");
        }
    }
}
