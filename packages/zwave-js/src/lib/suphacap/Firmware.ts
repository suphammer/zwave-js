/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import semverLt from "semver/functions/lt.js";
import semverValid from "semver/functions/valid.js";

import type { ControllerFirmwareInfo } from "../driver/ControllerFirmwareInfo.js";

// Raise the minimum only when the Driver depends on a newer firmware contract.
export const SUPHACAP_RCP_MINIMUM_VERSION = "0.1.4";
// This is the source baseline shipped with the Driver, not an online release check.
export const SUPHACAP_RCP_RECOMMENDED_VERSION = "0.1.5";

export function getSuphacapControllerFirmwareInfo(
	firmwareVersion: string | undefined,
): ControllerFirmwareInfo {
	if (
		!firmwareVersion
		|| !/^\d+\.\d+\.\d+$/.test(firmwareVersion)
		|| semverValid(firmwareVersion) !== firmwareVersion
	) {
		throw new Error(
			"Suphacap RCP did not report a valid x.y.z firmware version",
		);
	}
	if (semverLt(firmwareVersion, SUPHACAP_RCP_MINIMUM_VERSION)) {
		throw new Error(
			`Suphacap RCP firmware ${firmwareVersion} is too old; this Driver requires ${SUPHACAP_RCP_MINIMUM_VERSION} or newer`,
		);
	}
	return {
		manufacturer: "Suphammer",
		product: "Suphacap 2",
		firmwareVersion,
		firmwareLabel: "RCP controller",
		firmwareProfile: "rcp-controller",
		minimumVersion: SUPHACAP_RCP_MINIMUM_VERSION,
		recommendedVersion: SUPHACAP_RCP_RECOMMENDED_VERSION,
	};
}
