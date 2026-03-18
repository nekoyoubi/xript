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
}

impl Screen {
    pub fn title(&self) -> &'static str {
        match self {
            Screen::Home => "Home",
            Screen::Validate => "Validate Manifest",
            Screen::Scaffold => "Scaffold Project",
            Screen::Sanitize => "Sanitize Fragment",
        }
    }
}
