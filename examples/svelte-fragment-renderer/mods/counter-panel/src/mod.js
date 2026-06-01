hooks.fragment.update("counter-display", function (bindings, fragment) {
	fragment.setText(".counter-value", String(bindings.value));
	fragment.toggle(".milestone", bindings.value >= 5);
	fragment.addClass(".counter-panel", bindings.value >= 5 ? "celebrate" : "plain");
});

xript.exports.register("onIncrement", function () {
	var next = counter.increment();
	log("counter incremented to " + next);
	return next;
});
