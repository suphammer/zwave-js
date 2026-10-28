import { ZWaveErrorCodes, assertZWaveError } from "@zwave-js/core";
import { expect, test } from "vitest";

import { Driver } from "./Driver.js";
import type { PartialZWaveOptions } from "./ZWaveOptions.js";

const port = "/unused/suphacap-controller";

test("Suphacap defaults disable unsupported Serial API recovery features", () => {
	const driver = new Driver(port, { controller: { type: "suphacap" } });
	expect(driver.options.features.softReset).toBe(false);
	expect(driver.options.features.unresponsiveControllerRecovery).toBe(false);
	expect(driver.options.features.watchdog).toBe(false);
});

test.each(["softReset", "unresponsiveControllerRecovery", "watchdog"] as const)(
	"Suphacap rejects explicitly enabled features.%s",
	(feature) => {
		const options: PartialZWaveOptions = {
			controller: { type: "suphacap" },
			features: { [feature]: true },
		};
		assertZWaveError(expect, () => new Driver(port, options), {
			errorCode: ZWaveErrorCodes.Driver_InvalidOptions,
			messageMatches: `features.${feature}`,
		});
	},
);

test("Suphacap feature validation applies after merging presets", () => {
	assertZWaveError(
		expect,
		() =>
			new Driver(
				port,
				{ controller: { type: "suphacap" } },
				{ features: { softReset: true } },
			),
		{
			errorCode: ZWaveErrorCodes.Driver_InvalidOptions,
		},
	);

	const driver = new Driver(
		port,
		{ features: { softReset: true } },
		{ controller: { type: "suphacap" }, features: { softReset: false } },
	);
	expect(driver.options.features.softReset).toBe(false);
});

test("Suphacap defaults do not change the standard Serial API defaults", () => {
	const before = new Driver(port).options.features;
	const native = new Driver(port, { controller: { type: "suphacap" } });
	expect(native.options.features.softReset).toBe(false);
	expect(new Driver(port).options.features).toEqual(before);
	expect(
		new Driver(port, {
			controller: { type: "serial-api" },
		}).options.features,
	).toEqual(before);
});

test("the standard Serial API retains explicitly enabled recovery features", () => {
	const driver = new Driver(port, {
		controller: { type: "serial-api" },
		features: {
			softReset: true,
			unresponsiveControllerRecovery: true,
			watchdog: true,
		},
	});
	expect(driver.options.features.softReset).toBe(true);
	expect(driver.options.features.unresponsiveControllerRecovery).toBe(true);
	expect(driver.options.features.watchdog).toBe(true);
});

test("Suphacap defaults do not modify the caller's controller options", () => {
	const options: PartialZWaveOptions = {
		controller: { type: "suphacap", homeId: 0xc123_4567, ownNodeId: 1 },
		features: { softReset: false },
	};
	const driver = new Driver(port, options);
	expect(driver.options.controller).toEqual(options.controller);
	expect(options).toEqual({
		controller: { type: "suphacap", homeId: 0xc123_4567, ownNodeId: 1 },
		features: { softReset: false },
	});
});
