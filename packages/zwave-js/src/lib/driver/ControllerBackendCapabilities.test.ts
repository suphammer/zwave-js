import { expect, test, vi } from "vitest";

import { ZWaveController } from "../controller/Controller.js";
import { ZWaveFeature } from "../controller/Features.js";

import { Driver } from "./Driver.js";
import type { ControllerBackendCapabilities } from "./NativeControllerBackend.js";

function createController(capabilities?: ControllerBackendCapabilities): {
	driver: Driver;
	controller: ZWaveController;
} {
	const driver = new Driver("/unused/controller");
	(driver as any)._controllerBackendCapabilities = capabilities;
	(driver as any)._driverLog = { print: () => {} };
	(driver as any)._controllerLog = { print: () => {} };
	return { driver, controller: new ZWaveController(driver) };
}

function capabilities(value: boolean): ControllerBackendCapabilities {
	return {
		networkWideInclusion: value,
		highPower: value,
		smartStart: value,
		transmitAbort: value,
	};
}

test.each([false, true])(
	"a native backend can explicitly declare SmartStart support as %s",
	(smartStart) => {
		const { controller } = createController(capabilities(smartStart));
		expect(controller.supportsFeature(ZWaveFeature.SmartStart)).toBe(
			smartStart,
		);
	},
);

test("ordinary Serial API SmartStart support still depends on the SDK version", () => {
	const { driver, controller } = createController();
	expect(driver.controllerBackendCapabilities).toBeUndefined();
	expect(controller.supportsFeature(ZWaveFeature.SmartStart)).toBeUndefined();
	(controller as any)._sdkVersion = "6.81";
	expect(controller.supportsFeature(ZWaveFeature.SmartStart)).toBe(true);
	(controller as any)._sdkVersion = "6.80";
	expect(controller.supportsFeature(ZWaveFeature.SmartStart)).toBe(false);
});

test.each([undefined, false, true])(
	"inclusion and exclusion stop flags follow backend capabilities (%s)",
	async (supported) => {
		const { driver, controller } = createController(
			supported === undefined ? undefined : capabilities(supported),
		);
		const send = vi
			.spyOn(driver, "sendMessage")
			.mockResolvedValue(undefined as never);
		await controller.stopInclusionNoCallback();
		await controller.stopExclusionNoCallback();
		expect(send).toHaveBeenCalledTimes(2);
		for (const [message] of send.mock.calls) {
			expect(message).toMatchObject({
				highPower: supported ?? true,
				networkWide: supported ?? true,
			});
		}
	},
);

test("a native backend without transmit abort does not encode or send an abort", async () => {
	const { driver } = createController(capabilities(false));
	const encode = vi.spyOn(driver as any, "getEncodingContext");
	const write = vi.spyOn(driver as any, "writeSerial");
	await (driver as any).abortSendData();
	expect(encode).not.toHaveBeenCalled();
	expect(write).not.toHaveBeenCalled();
});
