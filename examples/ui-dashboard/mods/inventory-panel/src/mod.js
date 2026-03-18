hooks.fragment.update("inventory-list", function (bindings, fragment) {
	var items = bindings.inventory || [];
	var html = items.map(function (item) {
		return "<li>" + item.name + " (x" + item.count + ")</li>";
	});
	fragment.replaceChildren(".item-list", html);
	fragment.toggle(".empty-message", items.length === 0);
});
