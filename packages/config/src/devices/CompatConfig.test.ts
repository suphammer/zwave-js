import { expect, test } from "vitest";

import { ConditionalCompatConfig } from "./CompatConfig.js";

test("Binary Switch idle-target normalization is opt-in and conditionally evaluated", () => {
	const deviceId = {
		manufacturerId: 0x0159,
		productType: 0x0002,
		productId: 0x0054,
	};
	const config = new ConditionalCompatConfig("test.json", {
		$if: "firmwareVersion === 2.1",
		normalizeBinarySwitchIdleTarget: true,
	});

	expect(
		config.evaluateCondition({ ...deviceId, firmwareVersion: "2.1" }),
	).toEqual({ normalizeBinarySwitchIdleTarget: true });
	expect(
		config.evaluateCondition({ ...deviceId, firmwareVersion: "2.1.0" }),
	).toEqual({ normalizeBinarySwitchIdleTarget: true });
	expect(
		config.evaluateCondition({ ...deviceId, firmwareVersion: "2.2" }),
	).toBeUndefined();
	expect(
		new ConditionalCompatConfig("test.json", {}).evaluateCondition(),
	).toEqual({});
});

test.each([false, 0, "true", [], {}])(
	"Binary Switch idle-target normalization rejects invalid flag %j",
	(value) => {
		expect(
			() =>
				new ConditionalCompatConfig("test.json", {
					normalizeBinarySwitchIdleTarget: value,
				}),
		).toThrow("normalizeBinarySwitchIdleTarget must be true or omitted");
	},
);
