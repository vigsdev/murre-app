//! A preview for a link card on a reference board: the page's title and the picture it offers for sharing
//! (`og:image`, the one chat apps show), saved into the board's media folder so the card works offline after that.
//!
//! The page is fetched once, when the link is added, and only that page and its picture. Limits keep a slow or huge
//! page from hanging the board.

use crate::error::{AppError, AppResult};
use crate::references;
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TEXT: usize = 200;

/// What was found. Everything is optional: plenty of pages offer no picture.
#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub title: Option<String>,
    /// The site's own name ("Pinterest"), when it gives one.
    pub site: Option<String>,
    /// The picture, saved in the board's media folder.
    pub file: Option<String>,
}

/// The preview tags of a page.
#[derive(Debug, Default, PartialEq)]
pub struct Meta {
    pub title: Option<String>,
    pub site: Option<String>,
    pub image: Option<String>,
}

/// Fetches `url`'s preview and saves its picture under `root` (a project folder, or the app's global one).
pub async fn fetch(root: &Path, url: &str) -> AppResult<LinkPreview> {
    let page = reqwest::Url::parse(url).map_err(|_| AppError::Invalid("That isn't a web address.".into()))?;
    if !matches!(page.scheme(), "http" | "https") {
        return Err(AppError::Invalid("Only web links get a preview.".into()));
    }
    // reqwest is built without its own TLS provider here (the updater brings ring); make sure one is set.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        // A plain browser name: some sites only send their preview tags to browsers.
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Murre")
        .build()
        .map_err(|e| AppError::Invalid(format!("Couldn’t get a preview: {e}")))?;

    let res = client.get(page.clone()).send().await.map_err(offline)?;
    let final_url = res.url().clone();
    let html = read_limited(res, MAX_PAGE_BYTES).await?;
    let meta = parse_meta(&String::from_utf8_lossy(&html));

    let mut out = LinkPreview { title: meta.title, site: meta.site, file: None };
    if let Some(image) = meta.image.and_then(|i| final_url.join(&i).ok()).filter(|u| matches!(u.scheme(), "http" | "https")) {
        // A missing or odd picture just means a card without one.
        if let Ok(res) = client.get(image).send().await
            && let Ok(bytes) = read_limited(res, MAX_IMAGE_BYTES).await
            && let Ok(media) = references::import_media(root, &bytes)
        {
            if media.media_type == references::MediaType::Image {
                out.file = Some(media.file);
            } else if let Ok(path) = references::media_path(root, &media.file) {
                // A video or PDF isn't a preview picture: don't leave it behind unused.
                let _ = std::fs::remove_file(path);
            }
        }
    }
    Ok(out)
}

fn offline(e: reqwest::Error) -> AppError {
    if e.is_timeout() {
        AppError::Invalid("The page took too long to answer, so the card has no preview.".into())
    } else {
        AppError::Invalid("Couldn’t reach that page, so the card has no preview.".into())
    }
}

/// Reads at most `max` bytes of a response; anything bigger is refused.
async fn read_limited(mut res: reqwest::Response, max: usize) -> AppResult<Vec<u8>> {
    if !res.status().is_success() {
        return Err(AppError::Invalid("That page didn’t send a preview.".into()));
    }
    let mut out = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(offline)? {
        if out.len() + chunk.len() > max {
            return Err(AppError::Invalid("That page is too big to preview.".into()));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Reads the preview tags from a page's HTML: Open Graph first, then Twitter's, then the `<title>`. A simple scan of
/// `<meta>` tags is enough. The whole page is read, because some sites (Pinterest) put them in the body; the first
/// one found wins.
pub fn parse_meta(html: &str) -> Meta {
    let head = html;
    let mut tags: Vec<(String, String)> = Vec::new();
    let lower = head.to_ascii_lowercase();
    let mut at = 0;
    while let Some(start) = lower[at..].find("<meta") {
        let start = at + start;
        let Some(len) = head[start..].find('>') else { break };
        let tag = &head[start..start + len];
        let key = attr(tag, "property").or_else(|| attr(tag, "name"));
        if let (Some(k), Some(v)) = (key, attr(tag, "content")) {
            tags.push((k.to_ascii_lowercase(), v));
        }
        at = start + len;
    }
    let first = |keys: &[&str]| keys.iter().find_map(|k| tags.iter().find(|(n, v)| n == k && !v.trim().is_empty()).map(|(_, v)| v.clone()));
    let title_tag = lower.find("<title").and_then(|s| {
        let open = s + head[s..].find('>')? + 1;
        let close = open + lower[open..].find("</title")?;
        Some(head[open..close].to_string())
    });
    Meta {
        title: first(&["og:title", "twitter:title"]).or(title_tag).map(|t| clean(&t)).filter(|t| !t.is_empty()),
        site: first(&["og:site_name", "application-name"]).map(|t| clean(&t)).filter(|t| !t.is_empty()),
        image: first(&["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"]).map(|u| decode(u.trim())),
    }
}

/// The value of `name="…"` (or single quotes) inside one tag.
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let i = from + i;
        from = i + name.len();
        // The whole attribute name, not the end of another one ("og:image" inside "content").
        let before_ok = i == 0 || lower.as_bytes()[i - 1].is_ascii_whitespace();
        let rest = tag[i + name.len()..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let rest = rest[1..].trim_start();
        let quote = rest.chars().next()?;
        if quote == '"' || quote == '\'' {
            let end = rest[1..].find(quote)?;
            return Some(rest[1..1 + end].to_string());
        }
        // Unquoted: up to the next space. A `/` that closes the tag (`<meta … content=x/>`) isn't part of it.
        let value = rest.split(char::is_whitespace).next().unwrap_or("");
        let value = if tag.trim_end().ends_with(value) { value.strip_suffix('/').unwrap_or(value) } else { value };
        return Some(value.to_string());
    }
    None
}

/// The few HTML entities that show up in titles and addresses.
fn decode(s: &str) -> String {
    let mut out = s.replace("&quot;", "\"").replace("&#39;", "'").replace("&#x27;", "'").replace("&apos;", "'");
    out = out.replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ");
    out.replace("&amp;", "&")
}

/// Decoded, on one line, and not too long for a card.
fn clean(s: &str) -> String {
    let one_line = decode(s).split_whitespace().collect::<Vec<_>>().join(" ");
    one_line.chars().take(MAX_TEXT).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_graph_tags_win() {
        let html = r#"<html><head>
            <title>Fallback</title>
            <meta property="og:title" content="Neon city &amp; rain">
            <meta property='og:site_name' content='Pinterest' />
            <meta name="twitter:image" content="https://i.example.com/t.jpg">
            <meta content="https://i.pinimg.com/736x/ab.jpg" property="og:image">
        </head><body><meta property="og:image" content="https://later.example/x.jpg"></body></html>"#;
        assert_eq!(
            parse_meta(html),
            Meta {
                title: Some("Neon city & rain".into()),
                site: Some("Pinterest".into()),
                image: Some("https://i.pinimg.com/736x/ab.jpg".into()),
            }
        );
    }

    #[test]
    fn falls_back_to_twitter_tags_and_the_page_title() {
        let html = "<head><TITLE>\n  A   page \n</TITLE><meta name=twitter:image content=/img/p.png></head>";
        let m = parse_meta(html);
        assert_eq!(m.title.as_deref(), Some("A page"));
        assert_eq!(m.image.as_deref(), Some("/img/p.png"));
        assert_eq!(m.site, None);
    }

    #[test]
    fn tags_in_the_body_count_too() {
        let html = r#"<head><title>Pin</title></head><body><meta content="https://i.pinimg.com/a.jpg" data-app="true" name="og:image" property="og:image"/></body>"#;
        assert_eq!(parse_meta(html).image.as_deref(), Some("https://i.pinimg.com/a.jpg"));
    }

    #[test]
    fn a_page_without_tags_gives_nothing() {
        assert_eq!(parse_meta("<p>hello</p>"), Meta::default());
        assert_eq!(parse_meta(r#"<meta property="og:image" content="  ">"#).image, None);
    }

    #[test]
    fn attribute_names_must_match_whole() {
        assert_eq!(attr(r#"<meta data-content="no" content="yes""#, "content").as_deref(), Some("yes"));
    }
}

#[cfg(test)]
mod live {
    /// Reaches the internet, so it only runs when asked: `cargo test --lib link_preview::live -- --ignored`.
    #[test]
    #[ignore]
    fn a_real_page() {
        let d = tempfile::tempdir().unwrap();
        let url = std::env::var("MURRE_PREVIEW_URL").unwrap_or_else(|_| "https://github.com/tauri-apps/tauri".into());
        let p = tauri::async_runtime::block_on(super::fetch(d.path(), &url)).unwrap();
        println!("{p:?}");
        assert!(p.title.is_some());
    }
}
