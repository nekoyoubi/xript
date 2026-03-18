hooks.fragment.update("health-display", function (bindings, fragment) {
	var pct = (bindings.health / bindings.maxHealth) * 100;
	var color = pct > 60 ? "green" : pct > 30 ? "yellow" : "red";
	fragment.setAttr(".health-bar", "data-color", color);
	fragment.toggle(".warning", bindings.health < 50);
	fragment.toggle(".critical", bindings.health < 20);
});
