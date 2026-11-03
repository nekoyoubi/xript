interface CallerFrame {
	readonly modId: string | null;
}

/** One logical call's frames. An async call gets its own, so its resumptions cannot see another's. */
export interface CallerLane {
	readonly frames: CallerFrame[];
}

/**
 * Which mod is running right now. One per sandbox, and the single source of that answer: a
 * frame is pushed while a mod's entry runs, while an export it owns is invoked, while one of
 * its hook or event handlers is dispatched, and while one of its retained callbacks is called.
 * `null` means code the host ran directly, on behalf of no mod.
 *
 * An async call runs in a lane of its own. The engine only runs a call's code when the host
 * enters it: the call's synchronous start, the resumption after an async binding settles, and
 * each drain of the job queue that follows. Each of those enters the call's lane with
 * `within`, so a call resumed after another started is still credited to its own mod. Once the
 * call settles its lane is emptied, and a continuation that outlives it runs on behalf of no mod.
 */
export class CallerContext {
	private readonly root: CallerLane = { frames: [] };
	private active: CallerLane = this.root;

	current(): string | null {
		const frames = this.active.frames;
		return frames.length === 0 ? null : frames[frames.length - 1].modId;
	}

	/** Pushes a frame; pair with `leave`. For dispatch that cannot wrap its work in `run`. */
	enter(modId: string | null): void {
		this.active.frames.push({ modId });
	}

	/** Pops the frame the matching `enter` pushed. */
	leave(): void {
		this.active.frames.pop();
	}

	run<T>(modId: string | null, fn: () => T): T {
		const frames = this.active.frames;
		const frame: CallerFrame = { modId };
		frames.push(frame);
		try {
			return fn();
		} finally {
			const index = frames.lastIndexOf(frame);
			if (index !== -1) frames.splice(index, 1);
		}
	}

	/** Runs `fn` as `modId` in a lane of its own, for as long as the call it starts lasts. */
	async runAsync<T>(modId: string | null, fn: () => Promise<T>): Promise<T> {
		const lane: CallerLane = { frames: [{ modId }] };
		try {
			return await this.within(lane, fn);
		} finally {
			lane.frames.length = 0;
		}
	}

	/** The lane in force right now, to re-enter with `within` when the call it belongs to resumes. */
	lane(): CallerLane {
		return this.active;
	}

	/** Runs `fn` in `lane`, restoring the lane that was in force afterwards. */
	within<T>(lane: CallerLane, fn: () => T): T {
		const previous = this.active;
		this.active = lane;
		try {
			return fn();
		} finally {
			this.active = previous;
		}
	}

	/** How many frames are open, for `unwindTo`. */
	get depth(): number {
		return this.active.frames.length;
	}

	/**
	 * Drops every frame above `depth`. A script stopped by its deadline is terminated without
	 * running the `finally` blocks of host code it was inside, so the outermost caller restores
	 * the stack to where it stood before the call.
	 */
	unwindTo(depth: number): void {
		const frames = this.active.frames;
		if (frames.length > depth) frames.length = depth;
	}
}
