/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import type { SoftwareControllerRadioCapabilities } from "./SoftwareControllerRadio.js";

export function canMatchAcknowledgementHomeId(
	homeId: number | undefined,
	capabilities: Pick<
		SoftwareControllerRadioCapabilities,
		"foreignHomeIdAcknowledgement"
	>,
	directAcknowledged: boolean,
	usesBeam: boolean,
): boolean {
	return (
		homeId === undefined
		|| (Number.isInteger(homeId)
			&& homeId > 0
			&& homeId < 0xffff_ffff
			&& capabilities.foreignHomeIdAcknowledgement === true
			&& directAcknowledged
			&& !usesBeam)
	);
}
