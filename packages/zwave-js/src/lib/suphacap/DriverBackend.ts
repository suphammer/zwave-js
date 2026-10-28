/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import type { NativeControllerBackend } from "../driver/NativeControllerBackend.js";
import { createSoftwareControllerDriverBackend } from "../softcontroller/DriverBackend.js";

import type { SuphacapDriverBackendOptions } from "./DriverBackendTypes.js";
import { SuphacapMacRadio } from "./SuphacapMacRadio.js";

/** Connects the Suphacap firmware MAC to the shared software controller. */
export function createSuphacapDriverBackend(
	options: SuphacapDriverBackendOptions,
): Promise<NativeControllerBackend> {
	return createSoftwareControllerDriverBackend({
		region: options.region,
		cacheDir: options.cacheDir,
		databaseOptions: options.databaseOptions,
		homeId: options.controller.homeId,
		ownNodeId: options.controller.ownNodeId,
		transmitChannel: options.controller.transmitChannel,
		inclusionChannel: options.controller.inclusionChannel,
		host: options.host,
		radioFactory: () =>
			new SuphacapMacRadio({
				port: options.port,
				region: options.region,
				host: options.host,
				logConfig: options.logConfig,
				onDiagnostic: options.onDiagnostic,
			}),
		onError: options.onError,
		onDiagnostic: options.onDiagnostic,
	});
}
