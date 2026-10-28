/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import type { LogConfig, RFRegion } from "@zwave-js/core";
import type {
	ZWaveSerialBindingFactory,
	ZWaveSerialPortImplementation,
} from "@zwave-js/serial";
import type { DatabaseOptions } from "@zwave-js/shared/bindings";

import type { SuphacapControllerOptions } from "../driver/ControllerOptions.js";
import type { ZWaveOptions } from "../driver/ZWaveOptions.js";

export interface SuphacapDriverBackendOptions {
	port: string | ZWaveSerialPortImplementation | ZWaveSerialBindingFactory;
	controller: SuphacapControllerOptions;
	region: RFRegion;
	cacheDir: string;
	databaseOptions?: DatabaseOptions<unknown>;
	logConfig?: Partial<LogConfig>;
	host?: ZWaveOptions["host"];
	onError: (error: unknown) => void;
	onDiagnostic?: (message: string) => void;
}
