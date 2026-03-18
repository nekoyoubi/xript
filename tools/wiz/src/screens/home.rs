use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;

use crate::app::App;

struct CardDef {
    icon: &'static str,
    name: &'static str,
    description: &'static str,
}

const CARDS: &[CardDef] = &[
    CardDef {
        icon: "\u{2713}",
        name: "Validate",
        description: "Check a manifest against the xript spec",
    },
    CardDef {
        icon: "\u{26a1}",
        name: "Scaffold",
        description: "Create a new app or mod project",
    },
    CardDef {
        icon: "\u{2261}",
        name: "Sanitize",
        description: "Clean dangerous content from HTML fragments",
    },
    CardDef {
        icon: "\u{2715}",
        name: "Quit",
        description: "Exit the wizard",
    },
];

pub fn render(frame: &mut Frame, area: Rect, app: &App) {
    let card_height: u16 = 3;
    let gap: u16 = 1;
    let total_cards = CARDS.len() as u16;
    let total_height = total_cards * card_height + (total_cards - 1) * gap;

    let content_area = if area.height > total_height + 2 {
        let top_pad = (area.height - total_height) / 3;
        Rect {
            x: area.x,
            y: area.y + top_pad,
            width: area.width,
            height: total_height.min(area.height.saturating_sub(top_pad)),
        }
    } else {
        area
    };

    let card_width = 44.min(area.width.saturating_sub(4));
    let left_pad = (area.width.saturating_sub(card_width)) / 2;

    let mut constraints: Vec<Constraint> = Vec::new();
    for i in 0..CARDS.len() {
        constraints.push(Constraint::Length(card_height));
        if i < CARDS.len() - 1 {
            constraints.push(Constraint::Length(gap));
        }
    }
    if content_area.height > total_height {
        constraints.push(Constraint::Min(0));
    }

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(&constraints)
        .split(content_area);

    for (i, card_def) in CARDS.iter().enumerate() {
        let chunk_idx = i * 2;
        if chunk_idx >= chunks.len() {
            break;
        }

        let card_area = Rect {
            x: chunks[chunk_idx].x + left_pad,
            y: chunks[chunk_idx].y,
            width: card_width,
            height: card_height,
        };

        render_card(frame, card_area, card_def, i == app.selected);
    }
}

fn render_card(frame: &mut Frame, area: Rect, card: &CardDef, selected: bool) {
    if selected {
        let title_line = Line::from(vec![
            Span::styled(
                format!(" {} ", card.icon),
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                card.name,
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" ", Style::default()),
        ]);

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan))
            .title(title_line);

        let inner = block.inner(area);
        frame.render_widget(block, area);

        let desc = Paragraph::new(Line::from(Span::styled(
            card.description,
            Style::default().fg(Color::White),
        )));
        frame.render_widget(desc, inner);
    } else {
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray));

        let inner = block.inner(area);
        frame.render_widget(block, area);

        let line = Line::from(vec![
            Span::styled(
                format!(" {} ", card.icon),
                Style::default().fg(Color::DarkGray),
            ),
            Span::styled(
                card.name,
                Style::default()
                    .fg(Color::Gray)
                    .add_modifier(Modifier::BOLD),
            ),
        ]);
        let title_para = Paragraph::new(line);

        let title_area = Rect {
            x: inner.x,
            y: inner.y,
            width: inner.width,
            height: 1.min(inner.height),
        };
        frame.render_widget(title_para, title_area);
    }
}

pub fn menu_len() -> usize {
    CARDS.len()
}
