import dashboard from "./workbench-examples/dashboard.json";
import game from "./workbench-examples/game.json";

export interface SampleFragment {
	name: string;
	html: string;
	/** The same fragment as J5ML, when the sample has one. */
	j5ml?: string;
}

export interface WorkbenchExample {
	label: string;
	manifest: Record<string, unknown>;
	samples: SampleFragment[];
}

export const EXAMPLES: Record<string, WorkbenchExample> = {
	dashboard: {
		label: "Dashboard App",
		manifest: dashboard,
		samples: [
			{
				name: "Health Bar",
				html: '<div class="health-bar">\n\t<div class="bar-label">Health</div>\n\t<div class="bar-track">\n\t\t<span data-bind="health">0</span> / <span data-bind="maxHealth">0</span>\n\t</div>\n</div>',
				j5ml: '["div", {"class": "health-bar"},\n\t["div", {"class": "bar-label"}, "Health"],\n\t["div", {"class": "bar-track"},\n\t\t["span", {"data-bind": "health"}, "0"],\n\t\t" / ",\n\t\t["span", {"data-bind": "maxHealth"}, "0"]\n\t]\n]',
			},
			{
				name: "Player Card",
				html: '<div class="player-card">\n\t<div class="card-name" data-bind="name">Player</div>\n\t<div class="card-stat">HP: <span data-bind="health">0</span>/<span data-bind="maxHealth">0</span></div>\n\t<div class="card-stat">Level: <span data-bind="level">1</span></div>\n\t<div data-if="health < 30" class="card-danger">In danger!</div>\n</div>',
			},
			{
				name: "Low Health Warning",
				html: '<div class="warnings">\n\t<div data-if="health < 50" class="warning">Low health!</div>\n\t<div data-if="health < 20" class="critical">Critical!</div>\n\t<div data-if="health >= 50" class="safe">Health OK</div>\n</div>',
			},
			{
				name: "Party List",
				html: '<ul class="party">\n\t<li data-each="(member, i) in party" data-key="member">{{ i + 1 }}. {{ member }}</li>\n</ul>\n<div data-if="len(party) == 0">Travelling alone.</div>',
				j5ml: '["ul", {"class": "party"},\n\t["li", {"data-each": "(member, i) in party", "data-key": "member"}, "{{ i + 1 }}. {{ member }}"]\n]',
			},
			{
				name: "Inventory",
				html: '<div class="inventory">\n\t<div class="bar-label"><span data-bind="name">Player</span>\'s pack</div>\n\t<ul>\n\t\t<li data-each="item in inventory" data-key="item.name">{{ item.name }} (x{{ item.count }})</li>\n\t</ul>\n\t<div data-if="len(inventory) == 0" class="safe">Nothing carried.</div>\n</div>',
				j5ml: '["div", {"class": "inventory"},\n\t["ul", {},\n\t\t["li", {"data-each": "item in inventory", "data-key": "item.name"}, "{{ item.name }} (x{{ item.count }})"]\n\t],\n\t["div", {"data-if": "len(inventory) == 0", "class": "safe"}, "Nothing carried."]\n]',
			},
			{
				name: "Sanitizer Test",
				html: '<div class="safe-content"><p>This is safe.</p></div>\n<script>alert("XSS!")<\/script>\n<div onclick="steal()">Click me</div>\n<iframe src="https://example.com"></iframe>',
			},
		],
	},
	game: {
		label: "Game HUD",
		manifest: game,
		samples: [
			{
				name: "World Info",
				html: '<div class="world-info">\n\t<div>Time: <span data-bind="time">--:--</span></div>\n\t<div>Weather: <span data-bind="weather">clear</span></div>\n\t<div>Biome: <span data-bind="biome">plains</span></div>\n</div>',
			},
			{
				name: "Combat HUD",
				html: '<div class="combat-hud">\n\t<div data-if="inCombat" class="combat-active">IN COMBAT</div>\n\t<div data-if="!inCombat" class="combat-idle">Safe</div>\n\t<div>Enemies: <span data-bind="enemyCount">0</span></div>\n</div>',
			},
			{
				name: "Enemy List",
				html: '<ul class="combat-hud">\n\t<li data-each="enemy in enemies" data-key="enemy.name" data-if="enemy.health > 0">{{ enemy.name }}: {{ enemy.health }} HP</li>\n</ul>',
				j5ml: '["ul", {"class": "combat-hud"},\n\t["li", {"data-each": "enemy in enemies", "data-key": "enemy.name", "data-if": "enemy.health > 0"}, "{{ enemy.name }}: {{ enemy.health }} HP"]\n]',
			},
		],
	},
};

export const CUSTOM_MANIFEST = {
	$schema: "https://xript.dev/schema/manifest/v0.9.json",
	xript: "0.9",
	name: "my-app",
	version: "1.0.0",
	slots: [{ id: "main", description: "The main content area.", accepts: ["text/html", "application/j5ml+json"] }],
};
