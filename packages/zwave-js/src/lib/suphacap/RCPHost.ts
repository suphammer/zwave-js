/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import type {
	ZWaveSerialBindingFactory,
	ZWaveSerialPortImplementation,
} from "@zwave-js/serial";

import { RCPHost } from "../rcp/RCPHost.js";

const MACOS_SERIAL_WAKE_INTERVAL_MS = 10;

type RCPPort =
	| string
	| ZWaveSerialPortImplementation
	| ZWaveSerialBindingFactory;

/**
 * node-serialport 13 on macOS may leave a USB CDC read sleeping until libuv's
 * next timer wake-up. RCP ACKs then lose a race against zwave-js's ACK timeout.
 * Keep the event loop ticking only while a physical macOS device is open.
 */
function needsMacOSSerialWakeGuard(
	platform: NodeJS.Platform | undefined,
	port: RCPPort,
): boolean {
	return (
		platform === "darwin"
		&& typeof port === "string"
		&& port.startsWith("/dev/")
	);
}

/**
 * Keep the physical macOS serial wake guard around upstream's RCP host.
 * Upstream owns transmit encoding, capability checks and transaction status.
 */
export class SuphacapRCPHost extends RCPHost {
	readonly #needsSerialWakeGuard: boolean;
	#serialWakeTimer: NodeJS.Timeout | undefined;

	public constructor(
		port: RCPPort,
		options: ConstructorParameters<typeof RCPHost>[1] = {},
	) {
		super(port, options);
		this.#needsSerialWakeGuard = needsMacOSSerialWakeGuard(
			typeof process === "undefined" ? undefined : process.platform,
			port,
		);
	}

	public override async start(): Promise<void> {
		if (this.#needsSerialWakeGuard && !this.#serialWakeTimer) {
			this.#serialWakeTimer = setInterval(
				() => undefined,
				MACOS_SERIAL_WAKE_INTERVAL_MS,
			);
		}
		try {
			await super.start();
		} catch (error) {
			this.#stopSerialWakeGuard();
			throw error;
		}
	}

	public override async destroy(): Promise<void> {
		try {
			await super.destroy();
		} finally {
			this.#stopSerialWakeGuard();
		}
	}

	#stopSerialWakeGuard(): void {
		if (!this.#serialWakeTimer) return;
		clearInterval(this.#serialWakeTimer);
		this.#serialWakeTimer = undefined;
	}
}
