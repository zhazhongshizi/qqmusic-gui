use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};

use url::{Host, Url};

const MAX_REMOTE_URL_BYTES: usize = 2_048;
const MEDIA_HOSTS: &[&str] = &[
    "dl.stream.qqmusic.qq.com",
    "isure.stream.qqmusic.qq.com",
    "isure6.stream.qqmusic.qq.com",
    "ws.stream.qqmusic.qq.com",
];
const MV_HOSTS: &[&str] = &["mv.music.tc.qq.com", "mv6.music.tc.qq.com"];
const COVER_HOSTS: &[&str] = &[
    "y.gtimg.cn",
    "qpic.y.qq.com",
    "thirdqq.qlogo.cn",
    "thirdwx.qlogo.cn",
    "wx.qlogo.cn",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteUrlPurpose {
    Media,
    MvMedia,
    Cover,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteUrlError {
    Invalid,
    HostNotAllowed,
    ResolutionFailed,
    NonPublicAddress,
}

pub trait DnsResolver: Send + Sync {
    fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, RemoteUrlError>;
}

#[derive(Debug, Default)]
pub struct SystemDnsResolver;

impl DnsResolver for SystemDnsResolver {
    fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, RemoteUrlError> {
        let mut addresses = (host, port)
            .to_socket_addrs()
            .map_err(|_| RemoteUrlError::ResolutionFailed)?
            .map(|address| address.ip())
            .collect::<Vec<_>>();
        addresses.sort_unstable();
        addresses.dedup();
        if addresses.is_empty() {
            return Err(RemoteUrlError::ResolutionFailed);
        }
        Ok(addresses)
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct TrustedRemoteUrl(Url);

impl TrustedRemoteUrl {
    pub fn validate(
        value: &str,
        purpose: RemoteUrlPurpose,
        resolver: &dyn DnsResolver,
    ) -> Result<Self, RemoteUrlError> {
        if value.len() > MAX_REMOTE_URL_BYTES {
            return Err(RemoteUrlError::Invalid);
        }
        let parsed = Url::parse(value).map_err(|_| RemoteUrlError::Invalid)?;
        if parsed.scheme() != "https"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.fragment().is_some()
        {
            return Err(RemoteUrlError::Invalid);
        }
        let host = match parsed.host() {
            Some(Host::Domain(host)) => host.to_ascii_lowercase(),
            Some(Host::Ipv4(_) | Host::Ipv6(_)) | None => return Err(RemoteUrlError::Invalid),
        };
        if !allowed_hosts(purpose)
            .iter()
            .any(|allowed| host.eq_ignore_ascii_case(allowed))
        {
            return Err(RemoteUrlError::HostNotAllowed);
        }

        let port = parsed
            .port_or_known_default()
            .ok_or(RemoteUrlError::Invalid)?;
        let addresses = resolver.resolve(&host, port)?;
        if addresses
            .iter()
            .any(|address| !is_allowed_resolved_address(*address, purpose))
        {
            return Err(RemoteUrlError::NonPublicAddress);
        }
        Ok(Self(parsed))
    }

    /// The caller must validate every redirect target with this same policy.
    pub fn expose_to_trusted_backend(&self) -> &Url {
        &self.0
    }
}

impl fmt::Debug for TrustedRemoteUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TrustedRemoteUrl([REDACTED])")
    }
}

fn allowed_hosts(purpose: RemoteUrlPurpose) -> &'static [&'static str] {
    match purpose {
        RemoteUrlPurpose::Media => MEDIA_HOSTS,
        RemoteUrlPurpose::MvMedia => MV_HOSTS,
        RemoteUrlPurpose::Cover => COVER_HOSTS,
    }
}

fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_allowed_resolved_address(address: IpAddr, purpose: RemoteUrlPurpose) -> bool {
    is_public_address(address)
        || matches!(
            purpose,
            RemoteUrlPurpose::Media | RemoteUrlPurpose::MvMedia | RemoteUrlPurpose::Cover
        ) && matches!(address, IpAddr::V4(address) if is_fake_ip_address(address))
}

fn is_fake_ip_address(address: Ipv4Addr) -> bool {
    let [a, b, _, _] = address.octets();
    a == 198 && (18..=19).contains(&b)
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    if address.is_unspecified()
        || address.is_loopback()
        || address.is_private()
        || address.is_link_local()
        || address.is_multicast()
        || address.is_broadcast()
        || address.is_documentation()
    {
        return false;
    }
    if a == 0
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (18..=19).contains(&b))
        || a >= 240
    {
        return false;
    }
    true
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    if address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || address.segments()[0] & 0xfe00 == 0xfc00
        || address.segments()[0] & 0xffc0 == 0xfe80
    {
        return false;
    }
    let segments = address.segments();
    if segments[0] == 0x2001 && segments[1] == 0x0db8 {
        return false;
    }
    segments[0] & 0xe000 == 0x2000
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeResolver {
        addresses: Vec<IpAddr>,
    }

    impl FakeResolver {
        fn public() -> Self {
            Self {
                addresses: vec![IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))],
            }
        }
    }

    impl DnsResolver for FakeResolver {
        fn resolve(&self, _host: &str, _port: u16) -> Result<Vec<IpAddr>, RemoteUrlError> {
            Ok(self.addresses.clone())
        }
    }

    #[test]
    fn accepts_only_reviewed_https_hosts_and_redacts_debug() {
        let resolver = FakeResolver::public();
        let media = TrustedRemoteUrl::validate(
            "https://dl.stream.qqmusic.qq.com/C400fixture.m4a?vkey=SENTINEL",
            RemoteUrlPurpose::Media,
            &resolver,
        )
        .expect("reviewed media URL");
        assert_eq!(format!("{media:?}"), "TrustedRemoteUrl([REDACTED])");
        assert!(!format!("{media:?}").contains("SENTINEL"));
        assert_eq!(media.expose_to_trusted_backend().scheme(), "https");

        TrustedRemoteUrl::validate(
            "https://y.gtimg.cn/music/photo_new/T002R300x300M000fixture.jpg",
            RemoteUrlPurpose::Cover,
            &resolver,
        )
        .expect("reviewed cover URL");
    }

    #[test]
    fn rejects_scheme_credentials_fragments_ip_literals_and_host_confusion() {
        let resolver = FakeResolver::public();
        for value in [
            "http://dl.stream.qqmusic.qq.com/audio.m4a",
            "https://user:secret@dl.stream.qqmusic.qq.com/audio.m4a",
            "https://dl.stream.qqmusic.qq.com/audio.m4a#fragment",
            "https://127.0.0.1/audio.m4a",
            "https://dl.stream.qqmusic.qq.com.attacker.example/audio.m4a",
            "https://qqmusic.qq.com/audio.m4a",
        ] {
            assert!(TrustedRemoteUrl::validate(value, RemoteUrlPurpose::Media, &resolver).is_err());
        }
    }

    #[test]
    fn rejects_any_private_or_reserved_dns_answer() {
        let cases = [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1)),
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)),
            IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            "fc00::1".parse().expect("unique-local IPv6"),
            "fe80::1".parse().expect("link-local IPv6"),
            "2001:db8::1".parse().expect("documentation IPv6"),
        ];
        for address in cases {
            let resolver = FakeResolver {
                addresses: vec![IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)), address],
            };
            assert_eq!(
                TrustedRemoteUrl::validate(
                    "https://dl.stream.qqmusic.qq.com/audio.m4a",
                    RemoteUrlPurpose::Media,
                    &resolver,
                ),
                Err(RemoteUrlError::NonPublicAddress)
            );
        }
    }

    #[test]
    fn accepts_fake_ip_for_reviewed_media_and_cover_hosts() {
        let fake_ip = IpAddr::V4(Ipv4Addr::new(198, 18, 1, 191));
        let resolver = FakeResolver {
            addresses: vec![fake_ip],
        };
        TrustedRemoteUrl::validate(
            "https://isure.stream.qqmusic.qq.com/M500fixture.mp3?vkey=SENTINEL",
            RemoteUrlPurpose::Media,
            &resolver,
        )
        .expect("reviewed media host may use a transparent proxy fake IP");

        TrustedRemoteUrl::validate(
            "https://y.gtimg.cn/music/photo_new/T002R300x300M000fixture.jpg",
            RemoteUrlPurpose::Cover,
            &resolver,
        )
        .expect("reviewed cover host may use a transparent proxy fake IP");
    }

    #[test]
    fn fake_ip_exception_does_not_allow_other_reserved_answers() {
        for address in [
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(192, 0, 0, 1)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ] {
            let resolver = FakeResolver {
                addresses: vec![address],
            };
            assert_eq!(
                TrustedRemoteUrl::validate(
                    "https://isure.stream.qqmusic.qq.com/M500fixture.mp3",
                    RemoteUrlPurpose::Media,
                    &resolver,
                ),
                Err(RemoteUrlError::NonPublicAddress)
            );
        }
    }

    #[test]
    fn redirect_targets_are_checked_with_the_same_policy() {
        let resolver = FakeResolver::public();
        let initial = TrustedRemoteUrl::validate(
            "https://dl.stream.qqmusic.qq.com/audio.m4a",
            RemoteUrlPurpose::Media,
            &resolver,
        )
        .expect("initial URL");
        assert_eq!(
            initial.expose_to_trusted_backend().host_str(),
            Some("dl.stream.qqmusic.qq.com")
        );
        assert_eq!(
            TrustedRemoteUrl::validate(
                "https://example.com/redirected.m4a",
                RemoteUrlPurpose::Media,
                &resolver,
            ),
            Err(RemoteUrlError::HostNotAllowed)
        );
    }
}
