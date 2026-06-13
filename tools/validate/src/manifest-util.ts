interface CapabilityGated {
	capability?: string;
	members?: Record<string, unknown>;
}

/**
 * Every capability a host manifest references through its own surface: slot gates,
 * binding gates (recursively through namespace members), hook gates, and library
 * gates. This is the host side of "is a declared capability actually used" — the
 * mod side is the mods' requested capabilities.
 */
export function gateCapabilities(host: unknown): Set<string> {
	const refs = new Set<string>();
	const h = (host ?? {}) as {
		slots?: Array<{ capability?: string }>;
		bindings?: Record<string, unknown>;
		hooks?: Record<string, unknown>;
		libraries?: Record<string, { capability?: string }>;
	};

	for (const slot of h.slots ?? []) if (slot.capability) refs.add(slot.capability);

	for (const library of Object.values(h.libraries ?? {})) {
		if (library?.capability) refs.add(library.capability);
	}

	for (const hook of Object.values(h.hooks ?? {})) {
		const cap = (hook as CapabilityGated)?.capability;
		if (cap) refs.add(cap);
	}

	const walk = (binding: unknown): void => {
		if (!binding || typeof binding !== "object") return;
		const b = binding as CapabilityGated;
		if (b.capability) refs.add(b.capability);
		if (b.members) for (const member of Object.values(b.members)) walk(member);
	};
	for (const binding of Object.values(h.bindings ?? {})) walk(binding);

	return refs;
}
