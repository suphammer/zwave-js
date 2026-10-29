/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

/** Firmware and display identity reported by the local controller backend. */
export interface ControllerFirmwareInfo {
	readonly manufacturer: string;
	readonly product: string;
	readonly firmwareVersion: string;
	readonly firmwareLabel: string;
	readonly firmwareProfile?: string;
	/** Oldest firmware supported by this Driver backend. */
	readonly minimumVersion?: string;
	/** Firmware baseline recommended by this Driver, not an online release check. */
	readonly recommendedVersion?: string;
}
