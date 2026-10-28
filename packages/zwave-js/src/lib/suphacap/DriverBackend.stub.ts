import { ZWaveError, ZWaveErrorCodes } from "@zwave-js/core";

import type { NativeControllerBackend } from "../driver/NativeControllerBackend.js";

import type { SuphacapDriverBackendOptions } from "./DriverBackendTypes.js";

export async function createSuphacapDriverBackend(
	_options: SuphacapDriverBackendOptions,
): Promise<NativeControllerBackend> {
	throw new ZWaveError(
		"The Suphacap controller backend requires the native Node.js runtime",
		ZWaveErrorCodes.Driver_InvalidOptions,
	);
}
