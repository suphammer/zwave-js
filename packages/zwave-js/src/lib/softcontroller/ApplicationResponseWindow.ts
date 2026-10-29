/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import type { BytesView } from "@zwave-js/shared";

export const APPLICATION_RESPONSE_WINDOW_MS = 1_000;

export function shouldHoldApplicationResponse(
	command: BytesView,
	directAcknowledged: boolean,
	usesBeam: boolean,
): boolean {
	return (
		directAcknowledged
		&& !usesBeam
		&& command.length >= 2
		// NOP and Protocol CC have their own controller transaction semantics.
		&& command[0] !== 0x00
		&& command[0] !== 0x01
	);
}

/** Bounds an idle receive lease; each new radio operation supersedes it. */
export class ApplicationResponseWindow {
	readonly #onExpire: () => void;
	#timer: ReturnType<typeof setTimeout> | undefined;

	public constructor(onExpire: () => void) {
		this.#onExpire = onExpire;
	}

	public retain(): void {
		this.cancel();
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#onExpire();
		}, APPLICATION_RESPONSE_WINDOW_MS);
		this.#timer.unref();
	}

	public cancel(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
