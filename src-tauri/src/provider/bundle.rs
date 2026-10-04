use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, BufReader, Read},
    path::{Component, Path, PathBuf},
};

use sha2::{Digest, Sha256};

use crate::device_identity::ProviderDevicePath;

use super::{ProviderError, ProviderLaunch};

const MANIFEST_NAME: &str = "manifest.sha256";
const EXECUTABLE_NAME: &str = "qqmusic-provider.exe";
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_BUNDLE_FILES: usize = 16_384;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderBundleError {
    InvalidRoot,
    MissingManifest,
    InvalidManifest,
    UnsafePath,
    MissingFile,
    UnexpectedFile,
    HashMismatch,
    MissingExecutable,
    Io,
}

impl ProviderBundleError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRoot => "provider_bundle_invalid_root",
            Self::MissingManifest => "provider_bundle_missing_manifest",
            Self::InvalidManifest => "provider_bundle_invalid_manifest",
            Self::UnsafePath => "provider_bundle_unsafe_path",
            Self::MissingFile => "provider_bundle_missing_file",
            Self::UnexpectedFile => "provider_bundle_unexpected_file",
            Self::HashMismatch => "provider_bundle_hash_mismatch",
            Self::MissingExecutable => "provider_bundle_missing_executable",
            Self::Io => "provider_bundle_io_failed",
        }
    }
}

impl std::fmt::Display for ProviderBundleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ProviderBundleError {}

#[derive(Debug, Clone)]
pub struct VerifiedProviderBundle {
    root: PathBuf,
    executable: PathBuf,
}

impl VerifiedProviderBundle {
    pub fn verify(root: impl Into<PathBuf>) -> Result<Self, ProviderBundleError> {
        let root = root.into();
        if !root.is_absolute() || !root.is_dir() {
            return Err(ProviderBundleError::InvalidRoot);
        }
        let canonical_root = root
            .canonicalize()
            .map_err(|_| ProviderBundleError::InvalidRoot)?;
        let manifest_path = canonical_root.join(MANIFEST_NAME);
        let manifest_metadata = manifest_path
            .metadata()
            .map_err(|error| match error.kind() {
                io::ErrorKind::NotFound => ProviderBundleError::MissingManifest,
                _ => ProviderBundleError::Io,
            })?;
        if !manifest_metadata.is_file() || manifest_metadata.len() > MAX_MANIFEST_BYTES {
            return Err(ProviderBundleError::InvalidManifest);
        }
        let manifest =
            fs::read_to_string(&manifest_path).map_err(|_| ProviderBundleError::InvalidManifest)?;
        let expected = parse_manifest(&canonical_root, &manifest)?;
        let actual = collect_bundle_files(&canonical_root)?;
        if actual != expected.keys {
            return if expected.keys.is_subset(&actual) {
                Err(ProviderBundleError::UnexpectedFile)
            } else {
                Err(ProviderBundleError::MissingFile)
            };
        }
        for entry in expected.entries {
            if sha256_file(&entry.path)? != entry.hash {
                return Err(ProviderBundleError::HashMismatch);
            }
        }

        let executable = canonical_root.join(EXECUTABLE_NAME);
        if !executable.is_file()
            || !expected
                .keys
                .contains(&normalize_relative(Path::new(EXECUTABLE_NAME)))
        {
            return Err(ProviderBundleError::MissingExecutable);
        }
        Ok(Self {
            root: canonical_root,
            executable,
        })
    }

    pub fn launch(&self) -> Result<ProviderLaunch, ProviderError> {
        ProviderLaunch::new(self.executable.clone())?.current_dir(self.root.clone())
    }

    /// Builds a launch command whose only mutable state path is the validated
    /// qqmusic-api device file. The Provider owns the file contents.
    pub fn launch_with_device_path(
        &self,
        device_path: &ProviderDevicePath,
    ) -> Result<ProviderLaunch, ProviderError> {
        Ok(self.launch()?.args(device_path.provider_arguments()))
    }
}

struct ManifestEntry {
    hash: [u8; 32],
    path: PathBuf,
}

struct ParsedManifest {
    entries: Vec<ManifestEntry>,
    keys: HashSet<String>,
}

fn parse_manifest(root: &Path, manifest: &str) -> Result<ParsedManifest, ProviderBundleError> {
    let mut entries = Vec::new();
    let mut keys = HashSet::new();
    for line in manifest.lines() {
        if line.is_empty() || entries.len() >= MAX_BUNDLE_FILES {
            return Err(ProviderBundleError::InvalidManifest);
        }
        let (hash_text, relative_text) = line
            .split_once("  ")
            .ok_or(ProviderBundleError::InvalidManifest)?;
        if hash_text.len() != 64
            || !hash_text.bytes().all(|byte| byte.is_ascii_hexdigit())
            || relative_text.contains('\\')
        {
            return Err(ProviderBundleError::InvalidManifest);
        }
        let relative = Path::new(relative_text);
        if relative_text == MANIFEST_NAME
            || relative_text.is_empty()
            || relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(ProviderBundleError::UnsafePath);
        }
        let key = normalize_relative(relative);
        if !keys.insert(key) {
            return Err(ProviderBundleError::InvalidManifest);
        }
        let path = root.join(relative);
        let canonical_path = path.canonicalize().map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => ProviderBundleError::MissingFile,
            _ => ProviderBundleError::Io,
        })?;
        if !canonical_path.starts_with(root) || !canonical_path.is_file() {
            return Err(ProviderBundleError::UnsafePath);
        }
        entries.push(ManifestEntry {
            hash: decode_hash(hash_text)?,
            path: canonical_path,
        });
    }
    if entries.is_empty() {
        return Err(ProviderBundleError::InvalidManifest);
    }
    Ok(ParsedManifest { entries, keys })
}

fn collect_bundle_files(root: &Path) -> Result<HashSet<String>, ProviderBundleError> {
    fn visit(
        root: &Path,
        directory: &Path,
        files: &mut HashSet<String>,
    ) -> Result<(), ProviderBundleError> {
        for entry in fs::read_dir(directory).map_err(|_| ProviderBundleError::Io)? {
            let entry = entry.map_err(|_| ProviderBundleError::Io)?;
            let file_type = entry.file_type().map_err(|_| ProviderBundleError::Io)?;
            if file_type.is_symlink() {
                return Err(ProviderBundleError::UnsafePath);
            }
            let path = entry.path();
            if file_type.is_dir() {
                visit(root, &path, files)?;
            } else if file_type.is_file() && path != root.join(MANIFEST_NAME) {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| ProviderBundleError::UnsafePath)?;
                files.insert(normalize_relative(relative));
                if files.len() > MAX_BUNDLE_FILES {
                    return Err(ProviderBundleError::InvalidManifest);
                }
            }
        }
        Ok(())
    }

    let mut files = HashSet::new();
    visit(root, root, &mut files)?;
    Ok(files)
}

fn normalize_relative(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn decode_hash(text: &str) -> Result<[u8; 32], ProviderBundleError> {
    let mut bytes = [0_u8; 32];
    for (index, pair) in text.as_bytes().chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(pair).map_err(|_| ProviderBundleError::InvalidManifest)?;
        bytes[index] =
            u8::from_str_radix(pair, 16).map_err(|_| ProviderBundleError::InvalidManifest)?;
    }
    Ok(bytes)
}

fn sha256_file(path: &Path) -> Result<[u8; 32], ProviderBundleError> {
    let file = File::open(path).map_err(|_| ProviderBundleError::Io)?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| ProviderBundleError::Io)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    struct TestBundle {
        root: PathBuf,
    }

    impl TestBundle {
        fn new() -> Self {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "qqmusic-gui-bundle-test-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(root.join("_internal")).expect("create test bundle");
            fs::write(root.join(EXECUTABLE_NAME), b"provider exe").expect("write executable");
            fs::write(root.join("_internal/runtime.bin"), b"runtime").expect("write runtime");
            Self { root }
        }

        fn write_manifest(&self, paths: &[&str]) {
            let lines = paths
                .iter()
                .map(|relative| {
                    let hash = sha256_file(&self.root.join(relative)).expect("hash fixture");
                    let hash_text = hash
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>();
                    format!("{hash_text}  {relative}")
                })
                .collect::<Vec<_>>()
                .join("\n");
            fs::write(self.root.join(MANIFEST_NAME), lines).expect("write manifest");
        }
    }

    impl Drop for TestBundle {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn verifies_an_exact_bundle() {
        let bundle = TestBundle::new();
        bundle.write_manifest(&[EXECUTABLE_NAME, "_internal/runtime.bin"]);

        assert!(VerifiedProviderBundle::verify(&bundle.root).is_ok());
    }

    #[test]
    fn verified_bundle_accepts_only_a_prepared_device_path_for_state_injection() {
        let bundle = TestBundle::new();
        bundle.write_manifest(&[EXECUTABLE_NAME, "_internal/runtime.bin"]);
        let verified = VerifiedProviderBundle::verify(&bundle.root).expect("verify bundle");
        let app_data = TestBundle::new();
        let device_path = ProviderDevicePath::prepare(&app_data.root).expect("prepare device path");

        assert!(verified.launch_with_device_path(&device_path).is_ok());
    }

    #[test]
    fn rejects_tampering_and_unexpected_files() {
        let bundle = TestBundle::new();
        bundle.write_manifest(&[EXECUTABLE_NAME, "_internal/runtime.bin"]);
        fs::write(bundle.root.join("_internal/runtime.bin"), b"changed").expect("tamper fixture");
        assert_eq!(
            VerifiedProviderBundle::verify(&bundle.root).unwrap_err(),
            ProviderBundleError::HashMismatch
        );

        bundle.write_manifest(&[EXECUTABLE_NAME, "_internal/runtime.bin"]);
        fs::write(bundle.root.join("unexpected.bin"), b"extra").expect("write extra file");
        assert_eq!(
            VerifiedProviderBundle::verify(&bundle.root).unwrap_err(),
            ProviderBundleError::UnexpectedFile
        );
    }
}
