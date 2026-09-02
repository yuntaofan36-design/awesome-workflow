use std::path::{Path, PathBuf};

use anyhow::{bail, Context};

use crate::{validate_name, LIFECYCLE_NAME_PREFIX};

const LAUNCH_DAEMONS_DIRECTORY: &str = "/Library/LaunchDaemons";
const LAUNCH_AGENTS_DIRECTORY: &str = "/Library/LaunchAgents";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchdJobKind {
    Service,
    AutoStart,
}

/// Returns the fixed system definition path for an allowlisted lifecycle job.
///
/// The caller cannot select a directory: service definitions always live in
/// `/Library/LaunchDaemons`, while login jobs always live in
/// `/Library/LaunchAgents`.
pub fn launchd_definition_path(label: &str, kind: LaunchdJobKind) -> anyhow::Result<PathBuf> {
    validate_name(label, LIFECYCLE_NAME_PREFIX)?;
    let directory = match kind {
        LaunchdJobKind::Service => LAUNCH_DAEMONS_DIRECTORY,
        LaunchdJobKind::AutoStart => LAUNCH_AGENTS_DIRECTORY,
    };
    Ok(Path::new(directory).join(format!("{label}.plist")))
}

/// Renders a launchd property list without touching the filesystem or running
/// a command, so the exact privileged payload can be tested on every platform.
pub fn render_launchd_plist(
    label: &str,
    executable: &Path,
    kind: LaunchdJobKind,
) -> anyhow::Result<String> {
    validate_name(label, LIFECYCLE_NAME_PREFIX)?;
    let executable = executable
        .to_str()
        .context("launchd executable path must be valid UTF-8")?;
    if executable.is_empty() {
        bail!("launchd executable path cannot be empty");
    }

    let label = escape_xml_text(label)?;
    let executable = escape_xml_text(executable)?;
    let (keep_alive, session_scope) = match kind {
        LaunchdJobKind::Service => ("<true/>", ""),
        LaunchdJobKind::AutoStart => (
            "<false/>",
            "  <key>LimitLoadToSessionType</key>\n  <string>Aqua</string>\n",
        ),
    };

    Ok(format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" ",
            "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
            "<plist version=\"1.0\">\n",
            "<dict>\n",
            "  <key>Label</key>\n",
            "  <string>{label}</string>\n",
            "  <key>ProgramArguments</key>\n",
            "  <array>\n",
            "    <string>{executable}</string>\n",
            "  </array>\n",
            "  <key>RunAtLoad</key>\n",
            "  <true/>\n",
            "  <key>KeepAlive</key>\n",
            "  {keep_alive}\n",
            "  <key>ProcessType</key>\n",
            "  <string>Background</string>\n",
            "{session_scope}",
            "</dict>\n",
            "</plist>\n",
        ),
        label = label,
        executable = executable,
        keep_alive = keep_alive,
        session_scope = session_scope,
    ))
}

fn escape_xml_text(value: &str) -> anyhow::Result<String> {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if !is_xml_1_0_character(character) {
            bail!("launchd property list value contains an invalid XML character");
        }
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '\"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(character),
        }
    }
    Ok(escaped)
}

fn is_xml_1_0_character(character: char) -> bool {
    matches!(
        character as u32,
        0x9 | 0xA | 0xD | 0x20..=0xD7FF | 0xE000..=0xFFFD | 0x10000..=0x10FFFF
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_escapes_executable_path_and_keeps_it_as_one_argument() {
        let plist = render_launchd_plist(
            "AwesomeWorkflow.Agent",
            Path::new("/Applications/Awesome & <Workflow>/agent\"'.bin"),
            LaunchdJobKind::Service,
        )
        .unwrap();

        assert!(plist.contains(
            "<string>/Applications/Awesome &amp; &lt;Workflow&gt;/agent&quot;&apos;.bin</string>"
        ));
        assert_eq!(plist.matches("<array>").count(), 1);
        assert_eq!(plist.matches("<string>/Applications/").count(), 1);
        assert!(plist.contains("<key>KeepAlive</key>\n  <true/>"));
        assert!(!plist.contains("LimitLoadToSessionType"));
    }

    #[test]
    fn login_job_is_scoped_to_aqua_and_never_kept_alive() {
        let plist = render_launchd_plist(
            "AwesomeWorkflow.LoginAgent",
            Path::new("/Applications/Awesome Workflow.app/Contents/MacOS/agent"),
            LaunchdJobKind::AutoStart,
        )
        .unwrap();

        assert!(plist.contains("<key>KeepAlive</key>\n  <false/>"));
        assert!(plist.contains("<key>LimitLoadToSessionType</key>\n  <string>Aqua</string>"));
    }

    #[test]
    fn definition_paths_and_labels_are_fixed_to_the_product_namespace() {
        assert_eq!(
            launchd_definition_path("AwesomeWorkflow.Agent", LaunchdJobKind::Service).unwrap(),
            PathBuf::from("/Library/LaunchDaemons/AwesomeWorkflow.Agent.plist")
        );
        assert_eq!(
            launchd_definition_path("AwesomeWorkflow.Agent", LaunchdJobKind::AutoStart).unwrap(),
            PathBuf::from("/Library/LaunchAgents/AwesomeWorkflow.Agent.plist")
        );
        assert!(launchd_definition_path("com.attacker.Agent", LaunchdJobKind::Service).is_err());
        assert!(render_launchd_plist(
            "AwesomeWorkflow.Agent&Injected",
            Path::new("/Applications/agent"),
            LaunchdJobKind::Service,
        )
        .is_err());
    }

    #[test]
    fn renderer_rejects_xml_control_characters() {
        assert!(render_launchd_plist(
            "AwesomeWorkflow.Agent",
            Path::new("/Applications/agent\u{0}"),
            LaunchdJobKind::Service,
        )
        .is_err());
    }
}
