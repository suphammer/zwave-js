/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import type { ControllerApplicationFrame } from "./ControllerBackend.js";

/** A bounded response waiter; the owner restores RX before publishing its result. */
export class NodeInformationRequest {
	public readonly response: Promise<ControllerApplicationFrame | undefined>;
	readonly #resolve: (frame: ControllerApplicationFrame | undefined) => void;
	readonly #timer: ReturnType<typeof setTimeout>;
	readonly #signal: AbortSignal | undefined;
	#settled = false;

	public constructor(
		public readonly nodeId: number,
		timeoutMs: number,
		signal?: AbortSignal,
	) {
		if (
			!Number.isInteger(timeoutMs)
			|| timeoutMs < 1
			|| timeoutMs > 5_000
		) {
			throw new RangeError("Node information timeout must be 1..5000 ms");
		}
		let resolve!: (frame: ControllerApplicationFrame | undefined) => void;
		this.response = new Promise((complete) => {
			resolve = complete;
		});
		this.#resolve = resolve;
		this.#signal = signal;
		this.#timer = setTimeout(this.cancel, timeoutMs);
		this.#timer.unref();
		signal?.addEventListener("abort", this.cancel, { once: true });
		if (signal?.aborted) this.cancel();
	}

	public accept(frame: ControllerApplicationFrame): boolean {
		if (
			frame.sourceNodeId !== this.nodeId
			|| frame.command.length < 2
			|| frame.command[0] !== 0x01
			|| frame.command[1] !== 0x01
		)
			return false;
		// Preserve the received bytes while the owner awaits radio cleanup.
		this.#complete({ ...frame, command: Uint8Array.from(frame.command) });
		return true;
	}

	public readonly cancel = (): void => {
		this.#complete(undefined);
	};

	#complete(frame: ControllerApplicationFrame | undefined): void {
		if (this.#settled) return;
		this.#settled = true;
		clearTimeout(this.#timer);
		this.#signal?.removeEventListener("abort", this.cancel);
		this.#resolve(frame);
	}
}
