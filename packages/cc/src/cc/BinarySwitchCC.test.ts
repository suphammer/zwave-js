import { UNKNOWN_STATE } from "@zwave-js/core";
import { createTestingHost } from "@zwave-js/host";
import { Bytes } from "@zwave-js/shared";
import { expect, test } from "vitest";

import type { CCAPIHost } from "../lib/API.js";
import { CommandClass, InvalidCC } from "../lib/CommandClass.js";
import type { CCParsingContext } from "../lib/traits.js";

import {
	BinarySwitchCCAPI,
	BinarySwitchCCGet,
	BinarySwitchCCReport,
	BinarySwitchCCValues,
} from "./BinarySwitchCC.js";

async function parseReport(hex: string, enabled?: boolean) {
	const raw = Bytes.from(hex, "hex");
	const original = Bytes.from(raw);
	const report = await CommandClass.parse(raw, {
		sourceNodeId: 4,
		getDeviceConfig: () =>
			enabled === undefined
				? undefined
				: {
						compat: { normalizeBinarySwitchIdleTarget: enabled },
					},
	} as unknown as CCParsingContext);
	expect(report).toBeInstanceOf(BinarySwitchCCReport);
	expect(raw).toStrictEqual(original);
	return report as BinarySwitchCCReport;
}

test.each([
	{ hex: "2503ff0000", current: true },
	{ hex: "250300ff00", current: false },
])(
	"normalizes a configured contradictory idle target ($hex)",
	async ({ hex, current }) => {
		const report = await parseReport(hex, true);
		expect(report.currentValue).toBe(current);
		expect(report.targetValue).toBe(current);
		expect(report.duration?.toMilliseconds()).toBe(0);
	},
);

test.each([undefined, false])(
	"preserves the wire target without the compatibility option (%s)",
	async (enabled) => {
		const report = await parseReport("2503ff0000", enabled);
		expect(report.currentValue).toBe(true);
		expect(report.targetValue).toBe(false);
		expect(report.duration?.toMilliseconds()).toBe(0);
	},
);

test.each([
	{ hex: "2503ffff00", current: true, target: true, duration: 0 },
	{ hex: "2503000000", current: false, target: false, duration: 0 },
	{ hex: "2503ff0001", current: true, target: false, duration: 1_000 },
	{ hex: "250300ff80", current: false, target: true, duration: 60_000 },
	{ hex: "2503ff00fe", current: true, target: false, duration: undefined },
	{ hex: "2503ff00ff", current: true, target: false, duration: undefined },
	{ hex: "2503feff00", current: UNKNOWN_STATE, target: true, duration: 0 },
	{ hex: "25037fff00", current: undefined, target: true, duration: 0 },
	{ hex: "2503fffe00", current: true, target: UNKNOWN_STATE, duration: 0 },
	{ hex: "2503ff7f00", current: true, target: undefined, duration: 0 },
	{ hex: "2503ff", current: true, target: undefined, duration: undefined },
	{ hex: "2503ff00", current: true, target: undefined, duration: undefined },
])(
	"preserves valid, transitioning, unknown, or short report fields ($hex)",
	async ({ hex, current, target, duration }) => {
		const report = await parseReport(hex, true);
		expect(report.currentValue).toBe(current);
		expect(report.targetValue).toBe(target);
		expect(report.duration?.toMilliseconds()).toBe(duration);
	},
);

test("still marks a report missing its current-value byte as invalid", async () => {
	const report = await CommandClass.parse(Bytes.from("2503", "hex"), {
		sourceNodeId: 4,
	} as CCParsingContext);
	expect(report).toBeInstanceOf(InvalidCC);
});

test.each([true, undefined])(
	"parsed and persisted target values agree (configured=%s)",
	async (enabled) => {
		const report = await parseReport("2503ff0000", enabled);
		const host = createTestingHost();
		host.getSupportedCCVersion = () => 2;
		expect(report.persistValues(host)).toBe(true);
		const valueDB = host.getValueDB(4);
		expect(
			valueDB.getValue(BinarySwitchCCValues.currentValue.endpoint(0)),
		).toBe(true);
		expect(
			valueDB.getValue(BinarySwitchCCValues.targetValue.endpoint(0)),
		).toBe(enabled === true);
		expect(report.targetValue).toBe(
			valueDB.getValue(BinarySwitchCCValues.targetValue.endpoint(0)),
		);
	},
);

test("the public get API returns the same normalized state persisted from its report", async () => {
	const report = await parseReport("2503ff0000", true);
	const host = createTestingHost();
	host.getSupportedCCVersion = () => 2;
	let requests = 0;
	const api = new BinarySwitchCCAPI(
		{
			...host,
			sendCommand: async (command: CommandClass) => {
				requests++;
				expect(command).toBeInstanceOf(BinarySwitchCCGet);
				expect(command.nodeId).toBe(4);
				report.persistValues(host);
				return report;
			},
		} as unknown as CCAPIHost,
		{
			nodeId: 4,
			index: 0,
			virtual: false,
			supportsCC: () => true,
			controlsCC: () => false,
		},
	);
	const result = await api.get();
	expect(requests).toBe(1);
	expect(result).toEqual({
		currentValue: true,
		targetValue: true,
		duration: report.duration,
	});
	expect(result?.targetValue).toBe(
		host
			.getValueDB(4)
			.getValue(BinarySwitchCCValues.targetValue.endpoint(0)),
	);
});
