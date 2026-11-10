//! Read-only account usage normalization. No authentication, network, credential store, or
//! host CLI discovery lives here. The current OpenBot Responses provider has no Codex-service
//! account, so it must report unsupported rather than fabricate subscription quota windows.
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

const MAX_REPLY: usize = 256 * 1024;
const MAX_LIMITS: usize = 32;
const MAX_DAYS: usize = 366;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const INVALID: &str = "The service returned an invalid usage response.";

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum UsageProvider {
    Codex,
    Claude,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum UsageState {
    Available,
    NotConnected,
    Unsupported,
    Unavailable,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum UsageReason {
    ExternalResponsesProvider,
    AccountRequired,
    UnsupportedAccount,
    RateLimitsUnavailable,
    InvalidResponse,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub id: String,
    pub label: String,
    /// Preserve reported overages; a display bar can clamp its width to 100% separately.
    pub used_percent: f64,
    pub remaining_percent: f64,
    pub window_duration_mins: Option<u64>,
    /// Unix seconds, not JavaScript milliseconds. A passed reset does not prove recovery.
    pub resets_at: Option<u64>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenActivity {
    pub lifetime_tokens: Option<u64>,
    pub peak_daily_tokens: Option<u64>,
    pub longest_running_turn_sec: Option<u64>,
    pub current_streak_days: Option<u64>,
    pub longest_streak_days: Option<u64>,
    /// None means unavailable; an empty list means the provider returned no daily buckets.
    pub daily_usage_buckets: Option<Vec<DailyUsage>>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    pub start_date: String,
    pub tokens: u64,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceUsage {
    pub provider: UsageProvider,
    pub state: UsageState,
    pub reason: Option<UsageReason>,
    pub checked_at_ms: u64,
    pub windows: Vec<UsageWindow>,
    pub activity: Option<TokenActivity>,
    /// Backend authorization metadata, never inferred from percentages or reset times.
    pub ordinary_usage_allowed: Option<bool>,
}
impl ServiceUsage {
    fn status(checked_at_ms: u64, state: UsageState, reason: Option<UsageReason>) -> Self {
        Self {
            provider: UsageProvider::Codex,
            state,
            reason,
            checked_at_ms,
            windows: Vec::new(),
            activity: None,
            ordinary_usage_allowed: None,
        }
    }
}

/// Plans only account reads. A caller must supply the already-initialized, correctly authenticated
/// app-server transport. In particular, this does not turn a Responses env_key token into an
/// internal Codex account, launch a login, or adopt any existing host credential.
#[derive(Clone, Debug)]
pub struct CodexUsageAdapter {
    status: ServiceUsage,
    supported: bool,
}
impl CodexUsageAdapter {
    pub fn responses_provider(checked_at_ms: u64) -> Self {
        Self {
            status: ServiceUsage::status(
                checked_at_ms,
                UsageState::Unsupported,
                Some(UsageReason::ExternalResponsesProvider),
            ),
            supported: false,
        }
    }
    /// Accept a complete JSON-RPC account/read reply; errors stay structured and never expose
    /// provider error messages or account identity fields in the normalized UI response.
    pub fn from_account_response(reply: &[u8], checked_at_ms: u64) -> Result<Self, String> {
        let reply = decode(reply)?;
        let Some(account) = rpc_result(&reply) else {
            return Ok(Self {
                status: ServiceUsage::status(
                    checked_at_ms,
                    UsageState::Unavailable,
                    Some(UsageReason::AccountRequired),
                ),
                supported: false,
            });
        };
        let requires_auth = account
            .get("requiresOpenaiAuth")
            .and_then(Value::as_bool)
            .ok_or(INVALID)?;
        let (supported, state, reason) = match account.get("account") {
            None | Some(Value::Null) if !requires_auth => (
                false,
                UsageState::Unsupported,
                Some(UsageReason::ExternalResponsesProvider),
            ),
            None | Some(Value::Null) => (
                false,
                UsageState::NotConnected,
                Some(UsageReason::AccountRequired),
            ),
            Some(value) => match value.get("type").and_then(Value::as_str) {
                Some("chatgpt") => (true, UsageState::Unavailable, None),
                Some(_) => (
                    false,
                    UsageState::Unsupported,
                    Some(UsageReason::UnsupportedAccount),
                ),
                None => return Err(INVALID.into()),
            },
        };
        Ok(Self {
            status: ServiceUsage::status(checked_at_ms, state, reason),
            supported,
        })
    }
    /// No request is offered when account quotas are unsupported for this authentication mode.
    pub fn methods(&self, include_activity: bool) -> Vec<&'static str> {
        if !self.supported {
            Vec::new()
        } else if include_activity {
            vec!["account/rateLimits/read", "account/usage/read"]
        } else {
            vec!["account/rateLimits/read"]
        }
    }
    pub fn status(&self) -> ServiceUsage {
        self.status.clone()
    }
    pub fn finish(&self, rate_reply: &[u8], usage_reply: Option<&[u8]>) -> ServiceUsage {
        // Do not trust quota data supplied against a different/unsupported auth plan.
        if !self.supported {
            return self.status();
        }
        let parsed = (|| {
            let rate = decode(rate_reply)?;
            let result = rpc_result(&rate).ok_or("unavailable")?;
            let windows = rate_windows(result)?;
            let ordinary_usage_allowed = optional_bool(result, "ordinaryUsageAllowed")?;
            let activity = usage_reply
                .and_then(|reply| decode(reply).ok())
                .and_then(|reply| {
                    rpc_result(&reply).and_then(|result| token_activity(result).ok())
                });
            Ok::<_, String>((windows, ordinary_usage_allowed, activity))
        })();
        match parsed {
            Ok((windows, ordinary_usage_allowed, activity)) => ServiceUsage {
                provider: UsageProvider::Codex,
                state: UsageState::Available,
                reason: None,
                checked_at_ms: self.status.checked_at_ms,
                windows,
                activity,
                ordinary_usage_allowed,
            },
            Err(error) => ServiceUsage::status(
                self.status.checked_at_ms,
                UsageState::Unavailable,
                Some(if error == "unavailable" {
                    UsageReason::RateLimitsUnavailable
                } else {
                    UsageReason::InvalidResponse
                }),
            ),
        }
    }
}
fn decode(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > MAX_REPLY {
        return Err(INVALID.into());
    }
    serde_json::from_slice(bytes).map_err(|_| INVALID.into())
}
fn rpc_result(reply: &Value) -> Option<&Value> {
    if reply.get("error").is_some() {
        return None;
    }
    reply.get("result").filter(|result| result.is_object())
}
fn optional_bool(value: &Value, key: &str) -> Result<Option<bool>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_bool().map(Some).ok_or(INVALID.into()),
    }
}
fn optional_integer(value: &Value, key: &str) -> Result<Option<u64>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => integer(value).map(Some),
    }
}
fn integer(value: &Value) -> Result<u64, String> {
    value
        .as_u64()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or(INVALID.into())
}
fn bounded_text(value: &Value, max: usize) -> Result<Option<&str>, String> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .map(Some)
        .ok_or(INVALID.into())
}
fn rate_windows(value: &Value) -> Result<Vec<UsageWindow>, String> {
    let legacy = value
        .get("rateLimits")
        .filter(|value| value.is_object())
        .ok_or(INVALID)?;
    let mut buckets = BTreeMap::new();
    match value.get("rateLimitsByLimitId") {
        None | Some(Value::Null) => (),
        Some(Value::Object(map)) => {
            if map.len() > MAX_LIMITS {
                return Err(INVALID.into());
            }
            for (id, snapshot) in map {
                if id.is_empty()
                    || id.len() > 128
                    || id.chars().any(char::is_control)
                    || !snapshot.is_object()
                {
                    return Err(INVALID.into());
                }
                buckets.insert(id.clone(), snapshot);
            }
        }
        _ => return Err(INVALID.into()),
    }
    if buckets.is_empty() {
        let id = bounded_text(&legacy["limitId"], 128)?.unwrap_or("codex");
        buckets.insert(id.into(), legacy);
    }
    let mut windows = Vec::new();
    for (id, snapshot) in buckets {
        let label = bounded_text(&snapshot["limitName"], 160)?.unwrap_or(&id);
        for (key, suffix) in [("primary", "Primary"), ("secondary", "Secondary")] {
            let Some(window) = snapshot.get(key).filter(|value| !value.is_null()) else {
                continue;
            };
            if !window.is_object() {
                return Err(INVALID.into());
            }
            let used_percent = window
                .get("usedPercent")
                .and_then(Value::as_f64)
                .filter(|p| p.is_finite() && *p >= 0.0 && *p <= 1_000_000.0)
                .ok_or(INVALID)?;
            let window_duration_mins = optional_integer(window, "windowDurationMins")?;
            if window_duration_mins == Some(0) {
                return Err(INVALID.into());
            }
            let resets_at = optional_integer(window, "resetsAt")?;
            // Keep reset epochs representable by JavaScript Date after seconds-to-ms conversion.
            if resets_at.is_some_and(|epoch| epoch > 8_640_000_000_000) {
                return Err(INVALID.into());
            }
            windows.push(UsageWindow {
                id: format!("{id}.{key}"),
                label: format!("{label} · {suffix}"),
                used_percent,
                remaining_percent: (100.0 - used_percent).clamp(0.0, 100.0),
                window_duration_mins,
                resets_at,
            });
        }
    }
    Ok(windows)
}
fn token_activity(value: &Value) -> Result<TokenActivity, String> {
    let summary = value
        .get("summary")
        .filter(|v| v.is_object())
        .ok_or(INVALID)?;
    let daily_usage_buckets = match value.get("dailyUsageBuckets") {
        None | Some(Value::Null) => None,
        Some(Value::Array(days)) => {
            if days.len() > MAX_DAYS {
                return Err(INVALID.into());
            }
            let mut result = Vec::new();
            for day in days {
                let date = day
                    .get("startDate")
                    .and_then(Value::as_str)
                    .filter(|date| valid_date(date))
                    .ok_or(INVALID)?;
                result.push(DailyUsage {
                    start_date: date.into(),
                    tokens: integer(day.get("tokens").ok_or(INVALID)?)?,
                });
            }
            Some(result)
        }
        _ => return Err(INVALID.into()),
    };
    Ok(TokenActivity {
        lifetime_tokens: optional_integer(summary, "lifetimeTokens")?,
        peak_daily_tokens: optional_integer(summary, "peakDailyTokens")?,
        longest_running_turn_sec: optional_integer(summary, "longestRunningTurnSec")?,
        current_streak_days: optional_integer(summary, "currentStreakDays")?,
        longest_streak_days: optional_integer(summary, "longestStreakDays")?,
        daily_usage_buckets,
    })
}
fn valid_date(date: &str) -> bool {
    if date.len() != 10
        || !date.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
    {
        return false;
    }
    let year = date[..4].parse::<u32>().unwrap_or(0);
    let month = date[5..7].parse::<usize>().unwrap_or(0);
    let day = date[8..].parse::<u32>().unwrap_or(0);
    if year == 0 || !(1..=12).contains(&month) {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let length = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ][month - 1];
    day > 0 && day <= length
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn bytes(value: Value) -> Vec<u8> {
        serde_json::to_vec(&value).unwrap()
    }
    fn supported() -> CodexUsageAdapter {
        CodexUsageAdapter::from_account_response(&bytes(json!({"id":1,"result":{"requiresOpenaiAuth":true,"account":{"type":"chatgpt","email":"never-forward@example.test","planType":"plus"}}})),1234).unwrap()
    }
    fn rate() -> Value {
        json!({"id":2,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1794320000},"secondary":{"usedPercent":75,"windowDurationMins":10080,"resetsAt":1794900000}},"ordinaryUsageAllowed":false}})
    }
    #[test]
    fn custom_provider_and_disconnected_accounts_never_plan_quota_reads_or_adopt_data() {
        for reply in [
            json!({"result":{"account":null,"requiresOpenaiAuth":false}}),
            json!({"result":{"account":{"type":"apiKey"},"requiresOpenaiAuth":true}}),
            json!({"result":{"account":{"type":"amazonBedrock"},"requiresOpenaiAuth":false}}),
        ] {
            let adapter = CodexUsageAdapter::from_account_response(&bytes(reply), 10).unwrap();
            assert_eq!(adapter.status().state, UsageState::Unsupported);
            assert!(adapter.methods(true).is_empty());
            assert!(adapter.finish(&bytes(rate()), None).windows.is_empty());
        }
        let external = CodexUsageAdapter::responses_provider(11);
        assert_eq!(
            external.status().reason,
            Some(UsageReason::ExternalResponsesProvider)
        );
        assert!(external.methods(false).is_empty());
        let disconnected = CodexUsageAdapter::from_account_response(
            &bytes(json!({"result":{"account":null,"requiresOpenaiAuth":true}})),
            12,
        )
        .unwrap();
        assert_eq!(disconnected.status().state, UsageState::NotConnected);
        assert!(disconnected.methods(true).is_empty());
    }
    #[test]
    fn real_windows_keep_durations_reset_seconds_and_explicit_backend_authorization() {
        let adapter = supported();
        assert_eq!(
            adapter.methods(true),
            ["account/rateLimits/read", "account/usage/read"]
        );
        let result = adapter.finish(&bytes(rate()), None);
        assert_eq!(result.state, UsageState::Available);
        assert_eq!(result.windows.len(), 2);
        assert_eq!(result.windows[0].used_percent, 25.0);
        assert_eq!(result.windows[0].remaining_percent, 75.0);
        assert_eq!(result.windows[0].window_duration_mins, Some(300));
        assert_eq!(result.windows[1].window_duration_mins, Some(10080));
        assert_eq!(result.windows[0].resets_at, Some(1794320000));
        assert_eq!(result.ordinary_usage_allowed, Some(false));
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("never-forward"));
    }
    #[test]
    fn multi_bucket_view_deduplicates_legacy_and_unknown_is_not_zero() {
        let mut input = rate();
        input["result"]["rateLimitsByLimitId"] = json!({"codex":{"primary":{"usedPercent":25}},"review":{"limitName":"Code review","secondary":{"usedPercent":120,"windowDurationMins":null,"resetsAt":null}}});
        let result = supported().finish(&bytes(input), None);
        assert_eq!(result.windows.len(), 2);
        assert_eq!(result.windows[0].window_duration_mins, None);
        assert_eq!(result.windows[0].resets_at, None);
        assert_eq!(result.windows[1].used_percent, 120.0);
        assert_eq!(result.windows[1].remaining_percent, 0.0);
        let unknown = supported().finish(
            &bytes(json!({"result":{"rateLimits":{"primary":null,"secondary":null}}})),
            None,
        );
        assert_eq!(unknown.state, UsageState::Available);
        assert!(unknown.windows.is_empty());
        assert_eq!(unknown.ordinary_usage_allowed, None);
    }
    #[test]
    fn activity_is_separate_from_quota_and_optional_failures_do_not_hide_real_windows() {
        let activity = bytes(
            json!({"result":{"summary":{"lifetimeTokens":500,"peakDailyTokens":null,"longestStreakDays":7},"dailyUsageBuckets":[{"startDate":"2024-02-29","tokens":100}]}}),
        );
        let result = supported().finish(&bytes(rate()), Some(&activity));
        let activity = result.activity.unwrap();
        assert_eq!(activity.lifetime_tokens, Some(500));
        assert_eq!(activity.peak_daily_tokens, None);
        assert_eq!(activity.daily_usage_buckets.unwrap()[0].tokens, 100);
        for optional in [
            bytes(json!({"error":{"code":-32601,"message":"secret-provider-message"}})),
            bytes(
                json!({"result":{"summary":{},"dailyUsageBuckets":[{"startDate":"2025-02-29","tokens":100}]}}),
            ),
        ] {
            let result = supported().finish(&bytes(rate()), Some(&optional));
            assert_eq!(result.state, UsageState::Available);
            assert!(result.activity.is_none());
            assert_eq!(result.windows.len(), 2);
        }
    }
    #[test]
    fn invalid_and_excessive_data_are_bounded_and_provider_errors_are_redacted() {
        let adapter = supported();
        let error = adapter.finish(
            &bytes(json!({"error":{"code":-32600,"message":"private-token-do-not-echo"}})),
            None,
        );
        assert_eq!(error.state, UsageState::Unavailable);
        assert_eq!(error.reason, Some(UsageReason::RateLimitsUnavailable));
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("private-token"));
        for window in [
            json!({"usedPercent":-1}),
            json!({"usedPercent":"25"}),
            json!({"usedPercent":20,"windowDurationMins":0}),
            json!({"usedPercent":20,"resetsAt":-1}),
        ] {
            let mut input = rate();
            input["result"]["rateLimits"]["primary"] = window;
            assert_eq!(
                adapter.finish(&bytes(input), None).reason,
                Some(UsageReason::InvalidResponse)
            );
        }
        assert_eq!(
            adapter.finish(&vec![b' '; MAX_REPLY + 1], None).reason,
            Some(UsageReason::InvalidResponse)
        );
        assert!(CodexUsageAdapter::from_account_response(b"not json", 1).is_err());
        let mut input = rate();
        input["result"]["rateLimitsByLimitId"] = Value::Object(
            (0..MAX_LIMITS + 1)
                .map(|i| (format!("limit{i}"), json!({})))
                .collect(),
        );
        assert_eq!(
            adapter.finish(&bytes(input), None).reason,
            Some(UsageReason::InvalidResponse)
        );
    }
}
