use std::path::Path;

pub struct CompletionState {
    pub suggestions: Vec<String>,
    pub selected: usize,
}

impl CompletionState {
    pub fn new() -> Self {
        Self {
            suggestions: Vec::new(),
            selected: 0,
        }
    }

    pub fn update(&mut self, input: &str) {
        self.suggestions = complete_path(input);
        self.selected = 0;
    }

    pub fn current(&self) -> Option<&str> {
        self.suggestions.get(self.selected).map(String::as_str)
    }

    pub fn apply(&self, input: &str) -> Option<String> {
        let suggestion = self.current()?;

        let (dir_part, _) = split_input(input);
        if dir_part.is_empty() {
            Some(suggestion.to_string())
        } else {
            let base = if dir_part.ends_with('/') || dir_part.ends_with('\\') {
                dir_part.to_string()
            } else {
                let p = Path::new(dir_part);
                match p.parent() {
                    Some(parent) => {
                        let mut s = parent.to_string_lossy().to_string();
                        if !s.is_empty() && !s.ends_with('/') && !s.ends_with('\\') {
                            s.push('/');
                        }
                        s
                    }
                    None => String::new(),
                }
            };
            Some(format!("{}{}", base, suggestion))
        }
    }
}

fn split_input(input: &str) -> (&str, &str) {
    let path = Path::new(input);

    if input.ends_with('/') || input.ends_with('\\') {
        return (input, "");
    }

    match path.file_name() {
        Some(name) => {
            let name_str = name.to_str().unwrap_or("");
            let dir_end = input.len() - name_str.len();
            (&input[..dir_end], name_str)
        }
        None => (input, ""),
    }
}

pub fn complete_path(input: &str) -> Vec<String> {
    if input.is_empty() {
        return list_dir(".");
    }

    let path = Path::new(input);

    if (input.ends_with('/') || input.ends_with('\\')) && path.is_dir() {
        return list_dir(input);
    }

    if path.is_dir() && !input.ends_with('/') {
        return list_dir(input);
    }

    let (dir_part, prefix) = split_input(input);

    let search_dir = if dir_part.is_empty() { "." } else { dir_part };

    match std::fs::read_dir(search_dir) {
        Ok(entries) => {
            let prefix_lower = prefix.to_lowercase();
            let mut results: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.to_lowercase().starts_with(&prefix_lower) {
                        if e.file_type().ok()?.is_dir() {
                            Some(format!("{}/", name))
                        } else {
                            Some(name)
                        }
                    } else {
                        None
                    }
                })
                .collect();
            results.sort();
            results
        }
        Err(_) => Vec::new(),
    }
}

fn list_dir(dir: &str) -> Vec<String> {
    match std::fs::read_dir(dir) {
        Ok(entries) => {
            let mut results: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    if e.file_type().ok()?.is_dir() {
                        Some(format!("{}/", name))
                    } else {
                        Some(name)
                    }
                })
                .collect();
            results.sort();
            results
        }
        Err(_) => Vec::new(),
    }
}

pub fn path_exists(input: &str) -> bool {
    if input.is_empty() {
        return false;
    }
    Path::new(input.trim()).exists()
}

pub fn current_dir_display() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn empty_input_lists_current_dir() {
        let results = complete_path("");
        assert!(!results.is_empty());
    }

    #[test]
    fn nonexistent_prefix_returns_empty() {
        let results = complete_path("zzz_nonexistent_path_xyz_123/");
        assert!(results.is_empty());
    }

    #[test]
    fn completion_state_update_and_apply() {
        let mut state = CompletionState::new();
        state.update("sr");
        if !state.suggestions.is_empty() {
            let result = state.apply("sr");
            assert!(result.is_some());
        }
    }

    #[test]
    fn path_exists_detects_cargo_toml() {
        assert!(path_exists("Cargo.toml"));
    }

    #[test]
    fn path_exists_rejects_missing() {
        assert!(!path_exists("nonexistent_file_xyz.json"));
    }

    #[test]
    fn current_dir_display_returns_nonempty() {
        let dir = current_dir_display();
        assert!(!dir.is_empty());
    }

    #[test]
    fn directories_have_trailing_slash() {
        let results = complete_path("");
        for r in &results {
            let p = PathBuf::from(r.trim_end_matches('/'));
            if p.is_dir() {
                assert!(r.ends_with('/'), "directory entry should end with /: {}", r);
            }
        }
    }

    #[test]
    fn split_input_works() {
        let (dir, prefix) = split_input("src/main");
        assert_eq!(dir, "src/");
        assert_eq!(prefix, "main");

        let (dir2, prefix2) = split_input("foo");
        assert_eq!(dir2, "");
        assert_eq!(prefix2, "foo");
    }
}
