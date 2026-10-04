use std::{
    ffi::OsString,
    fmt, fs,
    path::{Path, PathBuf},
};

const PROVIDER_STATE_DIRECTORY: &str = "provider-state";
const QQ_DEVICE_FILE: &str = "qq-device.json";
const MAX_DEVICE_FILE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceIdentityError {
    Unavailable,
    UnsafePath,
    InvalidFile,
}

/// A validated, installation-stable path for qqmusic-api's complete device JSON.
///
/// The contents remain owned by the Provider. Rust only fixes and validates the
/// storage boundary so that Provider restarts reuse the same device profile.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderDevicePath {
    path: PathBuf,
}

impl ProviderDevicePath {
    pub fn prepare(app_data_root: &Path) -> Result<Self, DeviceIdentityError> {
        if !app_data_root.is_absolute() {
            return Err(DeviceIdentityError::UnsafePath);
        }

        fs::create_dir_all(app_data_root).map_err(|_| DeviceIdentityError::Unavailable)?;
        validate_directory(app_data_root)?;
        let canonical_root = app_data_root
            .canonicalize()
            .map_err(|_| DeviceIdentityError::Unavailable)?;

        let state_directory = app_data_root.join(PROVIDER_STATE_DIRECTORY);
        match fs::create_dir(&state_directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(DeviceIdentityError::Unavailable),
        }
        validate_directory(&state_directory)?;
        let canonical_state = state_directory
            .canonicalize()
            .map_err(|_| DeviceIdentityError::Unavailable)?;
        if canonical_state.parent() != Some(canonical_root.as_path()) {
            return Err(DeviceIdentityError::UnsafePath);
        }

        let path = canonical_state.join(QQ_DEVICE_FILE);
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if is_link_or_reparse_point(&metadata) {
                    return Err(DeviceIdentityError::UnsafePath);
                }
                if !metadata.file_type().is_file() || metadata.len() > MAX_DEVICE_FILE_BYTES {
                    return Err(DeviceIdentityError::InvalidFile);
                }
                let canonical_file = path
                    .canonicalize()
                    .map_err(|_| DeviceIdentityError::Unavailable)?;
                if canonical_file.parent() != Some(canonical_state.as_path()) {
                    return Err(DeviceIdentityError::UnsafePath);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(DeviceIdentityError::Unavailable),
        }

        Ok(Self { path })
    }

    pub(crate) fn provider_arguments(&self) -> [OsString; 2] {
        [
            OsString::from("--device-path"),
            self.path.as_os_str().to_owned(),
        ]
    }

    #[cfg(test)]
    fn path(&self) -> &Path {
        &self.path
    }
}

impl fmt::Debug for ProviderDevicePath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderDevicePath([REDACTED])")
    }
}

fn validate_directory(path: &Path) -> Result<(), DeviceIdentityError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| DeviceIdentityError::Unavailable)?;
    if is_link_or_reparse_point(&metadata) {
        return Err(DeviceIdentityError::UnsafePath);
    }
    if !metadata.file_type().is_dir() {
        return Err(DeviceIdentityError::InvalidFile);
    }
    Ok(())
}

#[cfg(windows)]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "qqmusic-gui-device-path-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&root).expect("create device test root");
            Self(root)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn path_is_fixed_stable_absolute_and_redacted() {
        let root = TestRoot::new();
        let first = ProviderDevicePath::prepare(&root.0).expect("prepare device path");
        fs::write(first.path(), br#"{"device":"fixture"}"#).expect("write device fixture");
        let second = ProviderDevicePath::prepare(&root.0).expect("revalidate device path");

        assert_eq!(first, second);
        assert!(first.path().is_absolute());
        assert_eq!(
            first.path(),
            root.0
                .canonicalize()
                .expect("canonical root")
                .join(PROVIDER_STATE_DIRECTORY)
                .join(QQ_DEVICE_FILE)
        );
        assert_eq!(format!("{first:?}"), "ProviderDevicePath([REDACTED])");
        assert!(!format!("{first:?}").contains("provider-state"));
    }

    #[test]
    fn relative_root_is_rejected() {
        assert_eq!(
            ProviderDevicePath::prepare(Path::new("relative-app-data")),
            Err(DeviceIdentityError::UnsafePath)
        );
    }

    #[test]
    fn existing_directory_or_oversized_device_target_is_rejected() {
        let directory_root = TestRoot::new();
        let target = directory_root
            .0
            .join(PROVIDER_STATE_DIRECTORY)
            .join(QQ_DEVICE_FILE);
        fs::create_dir_all(&target).expect("create directory target");
        assert_eq!(
            ProviderDevicePath::prepare(&directory_root.0),
            Err(DeviceIdentityError::InvalidFile)
        );

        let oversized_root = TestRoot::new();
        let state = oversized_root.0.join(PROVIDER_STATE_DIRECTORY);
        fs::create_dir(&state).expect("create provider state");
        let oversized = fs::File::create(state.join(QQ_DEVICE_FILE)).expect("create device file");
        oversized
            .set_len(MAX_DEVICE_FILE_BYTES + 1)
            .expect("extend device file");
        assert_eq!(
            ProviderDevicePath::prepare(&oversized_root.0),
            Err(DeviceIdentityError::InvalidFile)
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_state_symlink_is_rejected() {
        use std::os::unix::fs::symlink;

        let root = TestRoot::new();
        let outside = TestRoot::new();
        symlink(&outside.0, root.0.join(PROVIDER_STATE_DIRECTORY)).expect("create state symlink");
        assert_eq!(
            ProviderDevicePath::prepare(&root.0),
            Err(DeviceIdentityError::UnsafePath)
        );
    }
}
