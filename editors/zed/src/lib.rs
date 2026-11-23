//! editors/zed — Nyra Zed 扩展的协议核（G-P0-3）。
//!
//! 与 VS Code / JetBrains host 共用同一 core（`src/editorBridge.ts` 的
//! JSON-lines 协议）。本文件只用 std 实现协议的编解码与校验，零依赖，
//! `cargo test` 可离线跑：
//!   - 出站消息编码：hello / snapshot / diagnostics / ask / preview / apply / ping。
//!   - 回复解码：answer_chunk / answer_done / diff / applied / error / hello / ack / pong。
//!   - 路径校验：只认工作区相对路径（与 editorBridge.ts 的 isWorkspaceRelPath 同款规则）。
//!
//! 注意：这只是协议核，不是完整 Zed 扩展。完整扩展须接 `zed_extension_api`
//!（register_extension、slash 命令、agent server），那个 crate 要从 crates.io
//! 拉——本机走代理时 crates.io 返回 403，拉不到，所以接线部分留给真机（见 README.md）。
//! 协议核本身不依赖那个 crate，编码结果与 Nyra 侧的 parseEditorMessage 对得上。

/// 协议版本：须与 `src/editorBridge.ts` 的 EDITOR_PROTOCOL_VERSION 一致。
pub const PROTOCOL_VERSION: u32 = 1;

/// JSON 字符串转义（编码器用；只处理协议里会出现的字符）。
pub fn escape_json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn json_str(s: &str) -> String {
    format!("\"{}\"", escape_json_string(s))
}

/// 工作区相对路径是否合法：不为空、非绝对、没有 `..` 越界段。
/// 与 `src/editorBridge.ts` 的 isWorkspaceRelPath 同款规则。
pub fn is_workspace_rel_path(p: &str) -> bool {
    if p.is_empty() {
        return false;
    }
    if p.starts_with('/') || p.starts_with('\\') {
        return false;
    }
    if p.len() >= 3
        && p.as_bytes()[1] == b':'
        && (p.as_bytes()[2] == b'/' || p.as_bytes()[2] == b'\\')
        && p.as_bytes()[0].is_ascii_alphabetic()
    {
        return false;
    }
    !p.replace('\\', "/").split('/').any(|seg| seg == "..")
}

/// 位置（0 基行列）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

/// 选区（text 可空；有选区文本时才带）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    pub start: Position,
    pub end: Position,
    pub text: Option<String>,
}

/// 一条诊断（与 LspDiagnostic 同形；severity 1=Error..4=Hint）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub severity: u32,
    pub message: String,
    pub source: Option<String>,
}

/// 编辑器快照（出站编码用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub workspace: String,
    pub active_file: Option<String>,
    pub cursor: Option<Position>,
    pub selection: Option<Selection>,
    /// (path, language, dirty)
    pub open_files: Vec<(String, Option<String>, bool)>,
    pub diagnostics: Vec<Diagnostic>,
    pub received_at: String,
    pub host: String,
}

fn encode_position(p: &Position) -> String {
    format!("{{\"line\":{},\"column\":{}}}", p.line, p.column)
}

fn encode_diagnostic(d: &Diagnostic) -> String {
    let mut s = format!(
        "{{\"file\":{},\"line\":{},\"column\":{},\"severity\":{},\"message\":{}}}",
        json_str(&d.file),
        d.line,
        d.column,
        d.severity,
        json_str(&d.message)
    );
    if let Some(source) = &d.source {
        s = format!(
            "{{\"file\":{},\"line\":{},\"column\":{},\"severity\":{},\"message\":{},\"source\":{}}}",
            json_str(&d.file),
            d.line,
            d.column,
            d.severity,
            json_str(&d.message),
            json_str(source)
        );
    }
    s
}

/// 编一条 hello 消息。
pub fn encode_hello(host: &str) -> String {
    format!(
        "{{\"type\":\"hello\",\"host\":{},\"version\":{}}}",
        json_str(host),
        PROTOCOL_VERSION
    )
}

/// 编一条 snapshot 消息。路径不合法时返回 Err（fail-closed，不发坏消息）。
pub fn encode_snapshot(s: &Snapshot) -> Result<String, String> {
    if let Some(f) = &s.active_file {
        if !is_workspace_rel_path(f) {
            return Err(format!("active_file 不是工作区相对路径：{f}"));
        }
    }
    for (path, _, _) in &s.open_files {
        if !is_workspace_rel_path(path) {
            return Err(format!("open_files 里的 path 不是工作区相对路径：{path}"));
        }
    }
    for d in &s.diagnostics {
        if !is_workspace_rel_path(&d.file) {
            return Err(format!("diagnostics 里的 file 不是工作区相对路径：{}", d.file));
        }
    }
    let open_files: Vec<String> = s
        .open_files
        .iter()
        .map(|(path, lang, dirty)| {
            let mut o = format!("{{\"path\":{}", json_str(path));
            if let Some(lang) = lang {
                o.push_str(&format!(",\"language\":{}", json_str(lang)));
            }
            if *dirty {
                o.push_str(",\"dirty\":true");
            }
            o.push('}');
            o
        })
        .collect();
    let diagnostics: Vec<String> = s.diagnostics.iter().map(encode_diagnostic).collect();
    let mut snap = format!(
        "{{\"workspace\":{},\"activeFile\":{},\"cursor\":{},\"selection\":{},\"openFiles\":[{}],\"diagnostics\":[{}],\"receivedAt\":{},\"host\":{}}}",
        json_str(&s.workspace),
        match &s.active_file {
            Some(f) => json_str(f),
            None => "null".to_string(),
        },
        match &s.cursor {
            Some(p) => encode_position(p),
            None => "null".to_string(),
        },
        match &s.selection {
            Some(sel) => {
                let mut o = format!(
                    "{{\"start\":{},\"end\":{}",
                    encode_position(&sel.start),
                    encode_position(&sel.end)
                );
                if let Some(text) = &sel.text {
                    o.push_str(&format!(",\"text\":{}", json_str(text)));
                }
                o.push('}');
                o
            }
            None => "null".to_string(),
        },
        open_files.join(","),
        diagnostics.join(","),
        json_str(&s.received_at),
        json_str(&s.host),
    );
    snap = format!("{{\"type\":\"snapshot\",\"snapshot\":{snap}}}");
    Ok(snap)
}

/// 编一条 ask 消息。
pub fn encode_ask(id: &str, question: &str) -> String {
    format!(
        "{{\"type\":\"ask\",\"id\":{},\"question\":{}}}",
        json_str(id),
        json_str(question)
    )
}

/// 编一条 preview 消息。
pub fn encode_preview(id: &str, file: &str, new_text: &str) -> Result<String, String> {
    if !is_workspace_rel_path(file) {
        return Err(format!("preview.file 不是工作区相对路径：{file}"));
    }
    Ok(format!(
        "{{\"type\":\"preview\",\"id\":{},\"file\":{},\"newText\":{}}}",
        json_str(id),
        json_str(file),
        json_str(new_text)
    ))
}

/// 编一条 apply 消息（approved 固定 true：调用方须先经用户确认）。
pub fn encode_apply(id: &str, preview_id: &str) -> String {
    format!(
        "{{\"type\":\"apply\",\"id\":{},\"previewId\":{},\"approved\":true}}",
        json_str(id),
        json_str(preview_id)
    )
}

/// 编一条 ping 消息。
pub fn encode_ping(id: &str) -> String {
    format!("{{\"type\":\"ping\",\"id\":{}}}", json_str(id))
}

/// 服务端回来的回复（只取协议用到的字段；未知字段忽略）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Hello { version: u32 },
    Ack { id: Option<String> },
    Pong { id: Option<String> },
    Diff { id: String, file: String, diff: String, additions: u32, deletions: u32, preview_id: String },
    Applied { id: String, file: String, additions: u32, deletions: u32 },
    AnswerChunk { id: String, text: String },
    AnswerDone { id: String, exit_code: i32 },
    Error { id: Option<String>, error: String },
}

/// 从扁平 JSON 对象里取字符串字段（只够协议回复用；不是通用 JSON 解析器）。
fn get_str_field(obj: &str, field: &str) -> Option<String> {
    let key = format!("\"{field}\":");
    let start = obj.find(&key)? + key.len();
    let rest = obj[start..].trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    let mut out = String::new();
    let mut chars = rest[1..].chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                Some('u') => {
                    let hex: String = chars.by_ref().take(4).collect();
                    if let Ok(n) = u32::from_str_radix(&hex, 16) {
                        if let Some(ch) = char::from_u32(n) {
                            out.push(ch);
                        }
                    }
                }
                Some(other) => out.push(other),
                None => return None,
            },
            c => out.push(c),
        }
    }
    None
}

fn get_num_field(obj: &str, field: &str) -> Option<i64> {
    let key = format!("\"{field}\":");
    let start = obj.find(&key)? + key.len();
    let rest = obj[start..].trim_start();
    let mut end = 0;
    for (i, c) in rest.char_indices() {
        if c == '-' || c.is_ascii_digit() {
            end = i + 1;
        } else {
            break;
        }
    }
    if end == 0 {
        return None;
    }
    rest[..end].parse::<i64>().ok()
}

/// 解一条服务端回复行。格式不对返回 Err（调用方回 error、不崩循环）。
pub fn decode_reply(line: &str) -> Result<Reply, String> {
    let line = line.trim();
    if !line.starts_with('{') || !line.ends_with('}') {
        return Err("不是 JSON 对象".to_string());
    }
    let ty = get_str_field(line, "type").ok_or_else(|| "回复缺 type".to_string())?;
    let id = get_str_field(line, "id");
    match ty.as_str() {
        "hello" => Ok(Reply::Hello {
            version: get_num_field(line, "version").unwrap_or(0) as u32,
        }),
        "ack" => Ok(Reply::Ack { id }),
        "pong" => Ok(Reply::Pong { id }),
        "diff" => Ok(Reply::Diff {
            id: id.ok_or_else(|| "diff 缺 id".to_string())?,
            file: get_str_field(line, "file").ok_or_else(|| "diff 缺 file".to_string())?,
            diff: get_str_field(line, "diff").ok_or_else(|| "diff 缺 diff".to_string())?,
            additions: get_num_field(line, "additions").unwrap_or(0) as u32,
            deletions: get_num_field(line, "deletions").unwrap_or(0) as u32,
            preview_id: get_str_field(line, "previewId").ok_or_else(|| "diff 缺 previewId".to_string())?,
        }),
        "applied" => Ok(Reply::Applied {
            id: id.ok_or_else(|| "applied 缺 id".to_string())?,
            file: get_str_field(line, "file").ok_or_else(|| "applied 缺 file".to_string())?,
            additions: get_num_field(line, "additions").unwrap_or(0) as u32,
            deletions: get_num_field(line, "deletions").unwrap_or(0) as u32,
        }),
        "answer_chunk" => Ok(Reply::AnswerChunk {
            id: id.ok_or_else(|| "answer_chunk 缺 id".to_string())?,
            text: get_str_field(line, "text").unwrap_or_default(),
        }),
        "answer_done" => Ok(Reply::AnswerDone {
            id: id.ok_or_else(|| "answer_done 缺 id".to_string())?,
            exit_code: get_num_field(line, "exitCode").unwrap_or(0) as i32,
        }),
        "error" => Ok(Reply::Error {
            id,
            error: get_str_field(line, "error").unwrap_or_else(|| "未知错误".to_string()),
        }),
        other => Err(format!("未知的回复类型：{other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_snapshot() -> Snapshot {
        Snapshot {
            workspace: "/home/u/proj".to_string(),
            active_file: Some("src/main.rs".to_string()),
            cursor: Some(Position { line: 9, column: 4 }),
            selection: Some(Selection {
                start: Position { line: 9, column: 0 },
                end: Position { line: 11, column: 2 },
                text: Some("fn main() {}".to_string()),
            }),
            open_files: vec![("src/main.rs".to_string(), Some("rust".to_string()), false)],
            diagnostics: vec![Diagnostic {
                file: "src/main.rs".to_string(),
                line: 9,
                column: 4,
                severity: 1,
                message: "mismatched types".to_string(),
                source: Some("rustc".to_string()),
            }],
            received_at: "2026-11-23T00:00:00.000Z".to_string(),
            host: "zed".to_string(),
        }
    }

    #[test]
    fn hello_encodes_version_1() {
        assert_eq!(
            encode_hello("zed"),
            "{\"type\":\"hello\",\"host\":\"zed\",\"version\":1}"
        );
    }

    #[test]
    fn snapshot_round_trips_through_nyra_shape() {
        let line = encode_snapshot(&sample_snapshot()).expect("snapshot 应编出来");
        // Nyra 侧 parseEditorMessage 认的字段都在：type/snapshot/workspace/activeFile/…
        assert!(line.contains("\"type\":\"snapshot\""));
        assert!(line.contains("\"activeFile\":\"src/main.rs\""));
        assert!(line.contains("\"severity\":1"));
        assert!(line.contains("\"host\":\"zed\""));
    }

    #[test]
    fn snapshot_rejects_absolute_paths() {
        let mut s = sample_snapshot();
        s.active_file = Some("/etc/passwd".to_string());
        assert!(encode_snapshot(&s).is_err());
        let mut s2 = sample_snapshot();
        s2.open_files = vec![("../escape.rs".to_string(), None, false)];
        assert!(encode_snapshot(&s2).is_err());
    }

    #[test]
    fn preview_rejects_escaping_paths() {
        assert!(encode_preview("p1", "../x.rs", "fn x() {}").is_err());
        assert!(encode_preview("p1", "src/x.rs", "fn x() {}").is_ok());
    }

    #[test]
    fn apply_always_marks_approved() {
        assert!(encode_apply("a1", "prv_abc").contains("\"approved\":true"));
    }

    #[test]
    fn decode_diff_reply() {
        let line = "{\"type\":\"diff\",\"id\":\"prv_1\",\"file\":\"src/x.rs\",\"diff\":\"--- a/src/x.rs\\n\",\"additions\":2,\"deletions\":1,\"previewId\":\"prv_abc\"}";
        match decode_reply(line).expect("应解出来") {
            Reply::Diff { id, file, additions, deletions, preview_id, .. } => {
                assert_eq!(id, "prv_1");
                assert_eq!(file, "src/x.rs");
                assert_eq!(additions, 2);
                assert_eq!(deletions, 1);
                assert_eq!(preview_id, "prv_abc");
            }
            other => panic!("解错类型：{other:?}"),
        }
    }

    #[test]
    fn decode_answer_done_and_error() {
        match decode_reply("{\"type\":\"answer_done\",\"id\":\"ask_1\",\"exitCode\":0}").unwrap() {
            Reply::AnswerDone { id, exit_code } => {
                assert_eq!(id, "ask_1");
                assert_eq!(exit_code, 0);
            }
            other => panic!("解错类型：{other:?}"),
        }
        match decode_reply("{\"type\":\"error\",\"error\":\"坏消息\"}").unwrap() {
            Reply::Error { error, .. } => assert_eq!(error, "坏消息"),
            other => panic!("解错类型：{other:?}"),
        }
    }

    #[test]
    fn decode_rejects_garbage() {
        assert!(decode_reply("not json").is_err());
        assert!(decode_reply("{\"type\":\"nope\"}").is_err());
    }

    #[test]
    fn escape_round_trip() {
        let s = "a\"b\nc\\d";
        let enc = escape_json_string(s);
        assert_eq!(enc, "a\\\"b\\nc\\\\d");
        let line = format!("{{\"type\":\"answer_chunk\",\"id\":\"a\",\"text\":\"{enc}\"}}");
        match decode_reply(&line).unwrap() {
            Reply::AnswerChunk { text, .. } => assert_eq!(text, s),
            other => panic!("解错类型：{other:?}"),
        }
    }

    #[test]
    fn workspace_rel_path_rules() {
        assert!(is_workspace_rel_path("src/main.rs"));
        assert!(is_workspace_rel_path("a/b/c.txt"));
        assert!(!is_workspace_rel_path(""));
        assert!(!is_workspace_rel_path("/etc/passwd"));
        assert!(!is_workspace_rel_path("../escape.rs"));
        assert!(!is_workspace_rel_path("a/../../escape.rs"));
        assert!(!is_workspace_rel_path("C:\\Windows\\x.rs"));
    }
}
