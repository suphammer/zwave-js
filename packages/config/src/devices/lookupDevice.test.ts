import { expect, test } from "vitest";

import { ConfigManager } from "../ConfigManager.js";

test("Z-TRM3 with commandClasses.add compat should work", async (t) => {
	const configManager = new ConfigManager();
	const config = await configManager.lookupDevice(
		0x019b,
		0x0003,
		0x0203,
		"4.0",
	);
	t.expect(config).toBeDefined();
	t.expect(config?.compat?.addCCs?.get(49)?.endpoints.size).toBe(3);
}, 60000); // This test might take a while

test.each([
	["2.0", [11, 12, 30, 40, 42, 50, 51, 52, 70, 71, 72, 73, 74]],
	["2.1", [10, 11, 12, 15, 30, 40, 42, 50, 51, 52, 70, 249]],
	["2.1.0", [10, 11, 12, 15, 30, 40, 42, 50, 51, 52, 70, 249]],
	["2.1.1", [11, 12, 30, 40, 42, 50, 51, 52, 70, 71, 72, 73, 74]],
	["2.2", [11, 12, 30, 40, 42, 50, 51, 52, 70, 71, 72, 73, 74]],
	["3.0", [11, 12, 30, 40, 42, 50, 51, 52, 70, 71, 72, 73, 74]],
] as const)(
	"Qubino Smart Plug 16A firmware %s configuration",
	async (firmwareVersion, parameters) => {
		const configManager = new ConfigManager();
		const config = await configManager.lookupDevice(
			0x0159,
			0x0002,
			0x0054,
			firmwareVersion,
		);

		expect(config).toBeDefined();
		expect(config?.firmwareVersion).toEqual({ min: "0.0", max: "255.255" });
		expect(config?.compat?.normalizeBinarySwitchIdleTarget).toBe(
			firmwareVersion === "2.1" || firmwareVersion === "2.1.0"
				? true
				: undefined,
		);
		expect(
			[...config!.paramInformation!.keys()].map(
				({ parameter }) => parameter,
			),
		).toEqual(parameters);

		if (firmwareVersion === "2.1") {
			const info = config!.paramInformation!;
			expect(info.get({ parameter: 10 })).toMatchObject({
				valueSize: 2,
				defaultValue: 255,
				allowManualEntry: false,
				options: [
					{ value: 0 },
					{ value: 1 },
					{ value: 2 },
					{ value: 255 },
				],
			});
			expect(info.get({ parameter: 15 })).toMatchObject({
				valueSize: 1,
				defaultValue: 0,
				allowManualEntry: false,
				options: [
					{ label: "Seconds", value: 0 },
					{ label: "Milliseconds", value: 1 },
				],
			});
			expect(info.get({ parameter: 249 })).toMatchObject({
				valueSize: 1,
				defaultValue: 1,
				allowManualEntry: false,
				options: [{ value: 0 }, { value: 1 }],
			});
		}
	},
	60000,
);

test("Associations on endpoints should work - including imports", async (t) => {
	// Logic Group ZDB5100

	const configManager = new ConfigManager();
	const config = await configManager.lookupDevice(
		0x0234,
		0x0003,
		0x0121,
		"0.0",
	);
	t.expect(config).toBeDefined();
	t.expect(config?.endpoints?.get(0)?.associations?.get(2)).toMatchObject({
		label: "Button 1 (Basic Report)",
		maxNodes: 5,
	});
	t.expect(config?.endpoints?.get(1)?.associations?.get(1)).toMatchObject({
		label: "Lifeline",
		maxNodes: 5,
		isLifeline: false,
	});
	t.expect(config?.endpoints?.get(4)?.associations?.get(3)).toMatchObject({
		label: "Button 4 (Binary Switch Set)",
		maxNodes: 5,
	});
}, 60000); // This test might take a while
