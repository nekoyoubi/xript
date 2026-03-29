pub mod audit;
pub mod common;
pub mod diff;
pub mod home;
pub mod sanitize;
pub mod scaffold;
pub mod validate;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Home,
    Validate,
    Scaffold,
    Sanitize,
    Audit,
    Diff,
}

impl Screen {
    pub fn title(&self) -> &'static str {
        match self {
            Screen::Home => "Home",
            Screen::Validate => "Validate Manifest",
            Screen::Scaffold => "Scaffold Project",
            Screen::Sanitize => "Sanitize Fragment",
            Screen::Audit => "Audit Manifest",
            Screen::Diff => "Diff Manifest",
        }
    }
}
