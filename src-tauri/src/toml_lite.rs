//! 极简 TOML 子集解析器：只服务「从 Codex `~/.codex/config.toml` 导入 MCP」。
//!
//! 支持的形式：顶层/`[table]`/`[a.b]` 键值对、字符串、整数/浮点、布尔、
//! 数组（含多行尾逗号）、行内表 `{ k = v }`、基础注释。对更深特性（多行字符串、
//! 日期、数组表）直接报错——导入场景宁可失败也不要错误数据。

use serde_json::{Map, Value};

/// 解析 TOML 文本为 JSON 值；失败返回可读错误（含行号）。
pub fn parse_toml(raw: &str) -> Result<Value, String> {
    let mut root = Map::<String, Value>::new();
    let mut path: Vec<String> = Vec::new();
    let mut pending: Option<PendingArray> = None;

    for (index, raw_line) in raw.lines().enumerate() {
        let line_no = index + 1;
        let line = strip_comment(raw_line).trim().to_owned();
        if line.is_empty() {
            continue;
        }
        // 正在收集多行数组：先把当前行喂给数组，闭合后立即落盘。
        if let Some(slot) = pending.as_mut() {
            if slot.open {
                consume_array_line(&line_no, slot, &line)?;
                if slot.open {
                    continue;
                }
                let finished = pending.take().expect("刚刚还在收集");
                insert_dotted(&mut root, &finished.table_path, &finished.key, Value::Array(finished.items), line_no)?;
                continue;
            }
        }
        if line.starts_with('[') {
            let (header, is_array) = parse_table_header(&line_no, &line)?;
            if is_array {
                return Err(format!("第 {line_no} 行：不支持数组表 [[...]]"));
            }
            path = header;
            ensure_table(&mut root, &path, line_no)?;
            continue;
        }
        let Some(eq) = find_assignment(&line) else {
            return Err(format!("第 {line_no} 行：无法解析「{line}」"));
        };
        let key = line[..eq].trim().to_owned();
        let value_text = line[eq + 1..].trim();
        if key.is_empty() {
            return Err(format!("第 {line_no} 行：键名为空"));
        }
        match classify_array(&line_no, value_text)? {
            ArrayStartKind::NotArray => {
                let value = parse_value(&line_no, value_text)?;
                insert_dotted(&mut root, &path, &key, value, line_no)?;
            }
            ArrayStartKind::Inline(items) => {
                insert_dotted(&mut root, &path, &key, Value::Array(items), line_no)?;
            }
            ArrayStartKind::Multiline(items) => {
                pending = Some(PendingArray { table_path: path.clone(), key, items, open: true });
            }
        }
    }
    if let Some(finished) = pending.take() {
        return Err(format!("文件末尾：数组「{}」未闭合", finished.key));
    }
    Ok(Value::Object(root))
}

struct PendingArray {
    table_path: Vec<String>,
    key: String,
    items: Vec<Value>,
    open: bool,
}

fn strip_comment(line: &str) -> &str {
    let mut in_string: Option<char> = None;
    for (index, ch) in line.char_indices() {
        match (in_string, ch) {
            (None, '#') => return &line[..index],
            (None, '"' | '\'') => in_string = Some(ch),
            (Some(quote), c) if c == quote => in_string = None,
            _ => {}
        }
    }
    line
}

fn parse_table_header(line_no: &usize, line: &str) -> Result<(Vec<String>, bool), String> {
    let trimmed = line.trim();
    let is_array = trimmed.starts_with("[[");
    let end_marker = if is_array { "]]" } else { "]" };
    let Some(end) = trimmed.find(end_marker) else {
        return Err(format!("第 {line_no} 行：表头缺少闭合"));
    };
    let body = &trimmed[if is_array { 2 } else { 1 }..end];
    let parts: Vec<String> = body
        .split('.')
        .map(|part| part.trim().trim_matches('"').trim_matches('\'').to_owned())
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        return Err(format!("第 {line_no} 行：表头为空"));
    }
    Ok((parts, is_array))
}

/// 找到键值分隔 `=`；跳过键里的引号段（如 `"weird key" = 1`）。
fn find_assignment(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let ch = bytes[index] as char;
        if ch == '"' || ch == '\'' {
            let quote = ch;
            index += 1;
            while index < bytes.len() && bytes[index] as char != quote {
                index += 1;
            }
            index += 1;
            continue;
        }
        if ch == '=' {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn ensure_table(root: &mut Map<String, Value>, path: &[String], line_no: usize) -> Result<(), String> {
    let mut cursor = root;
    for part in path {
        let entry = cursor
            .entry(part.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        match entry {
            Value::Object(map) => cursor = map,
            _ => return Err(format!("第 {line_no} 行：「{part}」已被占用为非表值")),
        }
    }
    Ok(())
}

fn resolve_table<'a>(root: &'a mut Map<String, Value>, path: &[String], line_no: usize) -> Result<&'a mut Map<String, Value>, String> {
    let mut cursor = root;
    for part in path {
        let entry = cursor
            .entry(part.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        match entry {
            Value::Object(map) => cursor = map,
            _ => return Err(format!("第 {line_no} 行：「{part}」不是表")),
        }
    }
    Ok(cursor)
}

/// 支持 `a.b.c = v` 的点分键（Codex 配置里偶有出现）。
fn insert_dotted(root: &mut Map<String, Value>, table_path: &[String], dotted_key: &str, value: Value, line_no: usize) -> Result<(), String> {
    let parts: Vec<&str> = dotted_key
        .split('.')
        .map(str::trim)
        .map(|part| part.trim_matches('"').trim_matches('\''))
        .collect();
    let mut cursor = resolve_table(root, table_path, line_no)?;
    for part in parts.iter().take(parts.len().saturating_sub(1)) {
        if part.is_empty() {
            return Err(format!("第 {line_no} 行：点分键含空段"));
        }
        let entry = cursor
            .entry(part.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        match entry {
            Value::Object(map) => cursor = map,
            _ => return Err(format!("第 {line_no} 行：「{part}」已被占用为非表值")),
        }
    }
    if let Some(last) = parts.last() {
        cursor.insert(last.to_string(), value);
    }
    Ok(())
}

enum ArrayStartKind {
    NotArray,
    Inline(Vec<Value>),
    Multiline(Vec<Value>),
}

fn classify_array(line_no: &usize, text: &str) -> Result<ArrayStartKind, String> {
    if !text.starts_with('[') {
        return Ok(ArrayStartKind::NotArray);
    }
    // 单行闭合（粗查）：最后一个字符是 `]` 且去掉首尾后不再有顶层 `]` 前的逗号缺失。
    let body = &text[1..];
    if let Some(closing) = body.rfind(']') {
        if body[closing + 1..].trim().is_empty() {
            let inner = &body[..closing];
            let mut items = Vec::new();
            for element in split_top_level(inner, ',') {
                let element = element.trim();
                if element.is_empty() {
                    continue;
                }
                items.push(parse_value(line_no, element)?);
            }
            return Ok(ArrayStartKind::Inline(items));
        }
    }
    // 多行数组：逐个取元素直到行尾。
    let mut items = Vec::new();
    let mut rest = body.to_owned();
    loop {
        let trimmed = rest.trim();
        if trimmed.is_empty() {
            return Ok(ArrayStartKind::Multiline(items));
        }
        match take_scalar_value(line_no, trimmed)? {
            Some((value, remainder)) => {
                items.push(value);
                let after = remainder.trim_start();
                if let Some(next) = after.strip_prefix(',') {
                    rest = next.to_owned();
                    if rest.trim().is_empty() {
                        return Ok(ArrayStartKind::Multiline(items));
                    }
                    continue;
                }
                return Err(format!("第 {line_no} 行：数组元素之间缺少逗号"));
            }
            None => return Ok(ArrayStartKind::Multiline(items)),
        }
    }
}

/// 从文本头部取一个「标量或嵌套值」：返回 (值, 剩余)。嵌套结构按配对括号截取。
fn take_scalar_value<'a>(line_no: &usize, text: &'a str) -> Result<Option<(Value, &'a str)>, String> {
    let text = text.trim_start();
    if text.is_empty() {
        return Ok(None);
    }
    let first = text.chars().next().expect("checked non-empty");
    if first == '"' || first == '\'' {
        let chars: Vec<char> = text.chars().collect();
        let mut end = 1;
        while end < chars.len() {
            if chars[end] == first && chars[end - 1] != '\\' {
                let literal: String = chars[..=end].iter().collect();
                let rest = &text[literal.len()..];
                return Ok(Some((parse_value(line_no, &literal)?, rest)));
            }
            end += 1;
        }
        return Err(format!("第 {line_no} 行：字符串未闭合"));
    }
    if first == '[' || first == '{' {
        let (open, close) = if first == '[' { ('[', ']') } else { ('{', '}') };
        let mut depth = 0usize;
        for (offset, ch) in text.char_indices() {
            if ch == open {
                depth += 1;
            } else if ch == close {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let literal = &text[..=offset];
                    return Ok(Some((parse_value(line_no, literal)?, &text[offset + 1..])));
                }
            }
        }
        return Err(format!("第 {line_no} 行：嵌套值未闭合"));
    }
    let end = text
        .find(|ch: char| ch == ',' || ch == ']' || ch == '}' || ch.is_whitespace())
        .unwrap_or(text.len());
    let (literal, rest) = text.split_at(end);
    Ok(Some((parse_value(line_no, literal)?, rest)))
}

fn consume_array_line(line_no: &usize, slot: &mut PendingArray, line: &str) -> Result<(), String> {
    let mut rest = line.to_owned();
    loop {
        let trimmed = rest.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        // 纯闭合行（`]` 或 `..., ]`）：标记数组结束，不再取元素。
        if trimmed == "]" {
            slot.open = false;
            return Ok(());
        }
        if let Some(without_comma) = trimmed.strip_suffix(',') {
            if without_comma.trim() == "]" {
                slot.open = false;
                return Ok(());
            }
        }
        let Some((value, remainder)) = take_scalar_value(line_no, trimmed)? else {
            return Ok(());
        };
        slot.items.push(value);
        let after = remainder.trim_start();
        if let Some(next) = after.strip_prefix(',') {
            rest = next.to_owned();
            continue;
        }
        if after.starts_with(']') {
            slot.open = false;
            return Ok(());
        }
        return Err(format!("第 {line_no} 行：数组元素之间缺少逗号"));
    }
}

fn parse_value(line_no: &usize, text: &str) -> Result<Value, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(format!("第 {line_no} 行：值为空"));
    }
    let first = trimmed.chars().next().expect("checked non-empty");
    if first == '"' || first == '\'' {
        if !trimmed.ends_with(first) || trimmed.len() < 2 {
            return Err(format!("第 {line_no} 行：字符串未闭合"));
        }
        let inner = &trimmed[1..trimmed.len() - 1];
        return Ok(Value::String(unescape(inner)));
    }
    if first == '[' {
        let body = trimmed
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
            .ok_or_else(|| format!("第 {line_no} 行：数组格式错误"))?;
        let mut items = Vec::new();
        for element in split_top_level(body, ',') {
            let element = element.trim();
            if element.is_empty() {
                continue;
            }
            items.push(parse_value(line_no, element)?);
        }
        return Ok(Value::Array(items));
    }
    if first == '{' {
        let body = trimmed
            .strip_prefix('{')
            .and_then(|rest| rest.strip_suffix('}'))
            .ok_or_else(|| format!("第 {line_no} 行：行内表格式错误"))?;
        let mut map = Map::new();
        for pair in split_top_level(body, ',') {
            let pair = pair.trim();
            if pair.is_empty() {
                continue;
            }
            let Some(eq) = find_assignment(pair) else {
                return Err(format!("第 {line_no} 行：行内表键值缺少「=」"));
            };
            let key = pair[..eq].trim().trim_matches('"').trim_matches('\'');
            let value = parse_value(line_no, &pair[eq + 1..])?;
            map.insert(key.to_owned(), value);
        }
        return Ok(Value::Object(map));
    }
    match trimmed {
        "true" => return Ok(Value::Bool(true)),
        "false" => return Ok(Value::Bool(false)),
        _ => {}
    }
    if let Ok(number) = trimmed.parse::<i64>() {
        return Ok(Value::Number(number.into()));
    }
    if let Ok(number) = trimmed.parse::<f64>() {
        if let Some(json_number) = serde_json::Number::from_f64(number) {
            return Ok(Value::Number(json_number));
        }
    }
    Err(format!("第 {line_no} 行：无法解析值「{trimmed}」"))
}

fn split_top_level(text: &str, separator: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut in_string: Option<char> = None;
    let mut current = String::new();
    for ch in text.chars() {
        match (in_string, ch) {
            (None, '"' | '\'') if depth == 0 => {
                in_string = Some(ch);
                current.push(ch);
            }
            (Some(quote), c) if c == quote => {
                in_string = None;
                current.push(ch);
            }
            (None, '[' | '{') => {
                depth += 1;
                current.push(ch);
            }
            (None, ']' | '}') => {
                depth = depth.saturating_sub(1);
                current.push(ch);
            }
            (None, c) if c == separator && depth == 0 => {
                parts.push(current.clone());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    parts.push(current);
    parts
}

fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_codex_style_mcp_servers() {
        let raw = r#"
# Codex 配置
model = "gpt-5"
[mcp_servers.fetch]
command = "npx"
args = ["-y", "fetch-mcp"]
enabled = true
timeout = 30

[mcp_servers.search]
url = "https://example.com/mcp"
"#;
        let parsed = parse_toml(raw).expect("parse ok");
        assert_eq!(parsed["model"], json!("gpt-5"));
        assert_eq!(parsed["mcp_servers"]["fetch"]["command"], json!("npx"));
        assert_eq!(parsed["mcp_servers"]["fetch"]["args"], json!(["-y", "fetch-mcp"]));
        assert_eq!(parsed["mcp_servers"]["fetch"]["enabled"], json!(true));
        assert_eq!(parsed["mcp_servers"]["fetch"]["timeout"], json!(30));
        assert_eq!(parsed["mcp_servers"]["search"]["url"], json!("https://example.com/mcp"));
    }

    #[test]
    fn parses_inline_tables_and_multiline_arrays() {
        let raw = r#"
[a]
value = { x = "1", y = 2 }
list = [
  "one",
  "two",
]
"#;
        let parsed = parse_toml(raw).expect("parse ok");
        assert_eq!(parsed["a"]["value"]["x"], json!("1"));
        assert_eq!(parsed["a"]["value"]["y"], json!(2));
        assert_eq!(parsed["a"]["list"], json!(["one", "two"]));
    }

    #[test]
    fn rejects_array_tables() {
        assert!(parse_toml("[[bad]]\nx = 1").is_err());
    }
}
