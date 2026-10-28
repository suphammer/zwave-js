import { JsonlDB } from "@alcalzone/jsonl-db";
import type {
	Database,
	DatabaseFactory,
	DatabaseOptions,
} from "@zwave-js/shared/bindings";

class DurableJsonlDB<V> extends JsonlDB<V> {
	private flushUsed = false;
	private flushFailure: { error: unknown } | undefined;
	private pendingFlushes = new Set<Promise<void>>();
	private closingAfterFlush = false;
	private closeAfterFlushPromise: Promise<void> | undefined;

	public override async open(): Promise<void> {
		this.throwIfFlushFailed();
		if (!this.isOpen) {
			await this.closeAfterFlushPromise;
			this.throwIfFlushFailed();
			this.flushUsed = false;
			this.closingAfterFlush = false;
			this.closeAfterFlushPromise = undefined;
			this.pendingFlushes.clear();
		}
		await super.open();
	}

	public flush(): Promise<void> {
		this.flushUsed = true;
		const pending = this.flushInternal();
		this.pendingFlushes.add(pending);
		void pending.then(
			() => this.pendingFlushes.delete(pending),
			() => this.pendingFlushes.delete(pending),
		);
		return pending;
	}

	private async flushInternal(): Promise<void> {
		this.throwIfFlushFailed();
		if (!this.isOpen || this.closingAfterFlush) {
			throw new Error(
				"Cannot flush a database that is not open or is closing",
			);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// Compression drains and syncs both the journal and replacement while
			// retaining ownership. POSIX also syncs the directory before and after
			// renaming; jsonl-db skips directory sync on Windows.
			await Promise.race([
				this.compress(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						reject(
							new Error(
								"Database flush timed out after 30000 ms",
							),
						);
					}, 30_000);
				}),
			]);
			this.throwIfFlushFailed();
		} catch (error) {
			this.flushFailure ??= { error };
			throw this.flushFailure.error;
		} finally {
			clearTimeout(timer);
		}
	}

	private throwIfFlushFailed(): void {
		if (this.flushFailure) throw this.flushFailure.error;
	}

	public override close(): Promise<void> {
		// Preserve normal cache behavior when no durable flush was requested.
		if (!this.flushUsed) return super.close();
		return (this.closeAfterFlushPromise ??= (async () => {
			this.closingAfterFlush = true;
			await Promise.allSettled(this.pendingFlushes);
			// A failed commit has uncertain state. Retain ownership rather than
			// allowing another controller to open that state in this process.
			this.throwIfFlushFailed();
			await super.close();
		})());
	}
}

/** An implementation of the Database bindings for Node.js based on JsonlDB */
export const db: DatabaseFactory = {
	createInstance<V>(
		filename: string,
		options?: DatabaseOptions<V>,
	): Database<V> {
		return new DurableJsonlDB(filename, options);
	},
};
