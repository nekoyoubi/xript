# Mod zero: the application's own content is its first mod

The strongest test of an extensibility surface is whether the host's *own* features go through it. If the application's built-in content is authored as a mod against the same surface a third party would use, the surface is real. If the built-in content takes a private path the host keeps for itself, the surface is decoration.

## The principle

Build the framework in host code. Author the behavior and content in data and script. The first mod, "mod zero," is the application itself, loaded through the public surface. Third-party mods are then not a special case; they are more of the same.

## Why it holds the line

- **It proves the surface.** A slot that only the host can fill is untested as an extensibility point. A slot the host fills *as a mod* is exercised every time the app runs.
- **It prevents private back doors.** When the host's own features must go through bindings, hooks, slots, and capabilities, those surfaces stay complete. Gaps surface immediately, because the host hits them first.
- **It keeps the manifest honest.** If the built-in content is manifest-driven, the manifest stays the source of truth. Types, docs, and validation derived from it describe reality, not a subset of it.

## The failure mode it guards against

A renderer, panel, or behavior written directly in host code, with a manifest placed beside it, described as extensible. It is not. The manifest is documentation of a closed implementation. The test: delete the host code and reimplement that feature as an external mod through the declared surface. If that is impossible, the surface is not yet what it claims to be.

## Applying it

When adding a host feature, ask whether it *could* be authored as a mod against the existing surface. If yes, author it that way even though it ships with the app. If no, that gap is the signal: the surface is missing a binding, a slot, a hook, or a capability. Close the gap rather than routing around it with private host code.
