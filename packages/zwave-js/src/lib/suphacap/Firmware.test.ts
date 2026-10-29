/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { expect, test } from "vitest";

import {
	getSuphacapControllerFirmwareInfo,
	SUPHACAP_RCP_MINIMUM_VERSION,
	SUPHACAP_RCP_RECOMMENDED_VERSION,
} from "./Firmware.js";

test("identifies live controller firmware separately from numeric Z-Wave identity and SDK", () => {
	const info = getSuphacapControllerFirmwareInfo("0.1.4");
	expect(JSON.parse(JSON.stringify(info))).toEqual({
		manufacturer: "Suphammer",
		product: "Suphacap 2",
		firmwareVersion: "0.1.4",
		firmwareLabel: "RCP controller",
		firmwareProfile: "rcp-controller",
		minimumVersion: SUPHACAP_RCP_MINIMUM_VERSION,
		recommendedVersion: SUPHACAP_RCP_RECOMMENDED_VERSION,
	});
});

test.each(["0.1.4", "0.1.5", "0.1.10", "0.2.0", "1.0.0"])(
	"accepts compatible firmware %s including versions newer than the baseline",
	(version) => {
		expect(getSuphacapControllerFirmwareInfo(version).firmwareVersion).toBe(
			version,
		);
	},
);

test.each(["0.0.255", "0.1.0", "0.1.3"])(
	"rejects old firmware %s with its observed and required versions",
	(version) => {
		expect(() => getSuphacapControllerFirmwareInfo(version)).toThrow(
			`Suphacap RCP firmware ${version} is too old; this Driver requires ${SUPHACAP_RCP_MINIMUM_VERSION} or newer`,
		);
	},
);

test.each([
	undefined,
	"",
	"0.1",
	"0.01.4",
	"v0.1.4",
	"0.1.4-rc.1",
	"0.1.4+build",
	"undefined.undefined.undefined",
])("rejects malformed firmware version %s", (version) => {
	expect(() => getSuphacapControllerFirmwareInfo(version)).toThrow(
		"valid x.y.z firmware version",
	);
});
