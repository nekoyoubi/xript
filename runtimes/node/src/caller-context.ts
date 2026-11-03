import { AsyncLocalStorage } from "node:async_hooks";

interface CallerFrame {
	readonly modId: string | null;
}

/** One logical call's frames. An async call gets its own lane, so its awaits cannot see another's. */
interface Lane {
	readonly frames: CallerFrame[];
}

/**
 * Which mod is running right now. One per sandbox, and the single source of that answer: a
 * frame is pushed while a mod's entry runs, while an export it owns is invoked, while one of
 * its hook or event handlers is dispatched, and while one of its retained callbacks is called.
 * `null` means code the host ran directly, on behalf of no mod.
 *
 * An async call runs in a lane of its own that follows its continuations, so a call resumed
 * after another started is still credited to its own mod. Once the call settles its lane is
 * emptied, and a continuation that outlives it runs on behalf of no mod.
 */
export class CallerContext {
	private readonly root: Lane = { frames: [] };
	private readonly lanes = new AsyncLocalStorage<Lane>();

	current(): string | null {
		const frames = this.lane().frames;
		return frames.length === 0 ? null : frames[frames.length - 1].modId;
	}

	/** Pushes a frame; pair with `leave`. For dispatch that cannot wrap its work in `run`. */
	enter(modId: string | null): void {
		this.lane().frames.push({ modId });
	}

	/** Pops the frame the matching `enter` pushed. */
	leave(): void {
		this.lane().frames.pop();
	}

	run<T>(modId: string | null, fn: () => T): T {
		const frames = this.lane().frames;
		const frame: CallerFrame = { modId };
		frames.push(frame);
		try {
			return fn();
		} finally {
			const index = frames.lastIndexOf(frame);
			if (index !== -1) frames.splice(index, 1);
		}
	}

	async runAsync<T>(modId: string | null, fn: () => Promise<T>): Promise<T> {
		const lane: Lane = { frames: [{ modId }] };
		try {
			return await this.lanes.run(lane, fn);
		} finally {
			lane.frames.length = 0;
		}
	}

	/** How many frames are open, for `unwindTo`. */
	get depth(): number {
		return this.lane().frames.length;
	}

	/**
	 * Drops every frame above `depth`. A script stopped by its deadline is terminated without
	 * running the `finally` blocks of host code it was inside, so the outermost caller restores
	 * the stack to where it stood before the call.
	 */
	unwindTo(depth: number): void {
		const frames = this.lane().frames;
		if (frames.length > depth) frames.length = depth;
	}

	private lane(): Lane {
		return this.lanes.getStore() ?? this.root;
	}
}
