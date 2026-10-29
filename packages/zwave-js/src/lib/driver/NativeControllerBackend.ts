import type { ZWaveSerialBindingFactory } from "@zwave-js/serial";

import type { ControllerFirmwareInfo } from "./ControllerFirmwareInfo.js";

/** Capabilities of an in-process controller implementation. */
export interface ControllerBackendCapabilities {
	readonly networkWideInclusion: boolean;
	readonly highPower: boolean;
	readonly smartStart: boolean;
	readonly transmitAbort: boolean;
}

/** @internal */
export interface NativeControllerBackend {
	readonly binding: ZWaveSerialBindingFactory;
	readonly capabilities: ControllerBackendCapabilities;
	readonly firmwareInfo?: ControllerFirmwareInfo;
	destroy(): Promise<void>;
}
