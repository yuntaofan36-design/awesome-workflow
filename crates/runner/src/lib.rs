use std::{collections::HashSet, ffi::OsString};

const ALLOWED_ENVIRONMENT: &[&str] = &[
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
];

pub fn filtered_environment(
    source: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let allowed = ALLOWED_ENVIRONMENT.iter().copied().collect::<HashSet<_>>();
    source
        .into_iter()
        .filter(|(key, _)| key.to_str().is_some_and(|value| allowed.contains(value)))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;

    #[test]
    fn environment_allowlist_never_forwards_platform_tokens() {
        let filtered = filtered_environment([
            (OsString::from("SystemRoot"), OsString::from("C:\\Windows")),
            (OsString::from("WORKFLOW_TOKEN"), OsString::from("secret")),
            (
                OsString::from("AWS_SECRET_ACCESS_KEY"),
                OsString::from("secret"),
            ),
            (OsString::from("SESSION_SECRET"), OsString::from("secret")),
        ]);
        assert_eq!(
            filtered,
            vec![(OsString::from("SystemRoot"), OsString::from("C:\\Windows"))]
        );
    }
}
