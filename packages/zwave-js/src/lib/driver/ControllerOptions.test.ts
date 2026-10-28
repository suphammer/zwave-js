import { ZWaveErrorCodes, assertZWaveError } from "@zwave-js/core";
import { expect, test } from "vitest";

import { validateControllerOptions } from "./ControllerOptions.js";

test.each([
	undefined,
	{ type: "serial-api" },
	{ type: "suphacap" },
	{ type: "suphacap", homeId: 1, ownNodeId: 1, transmitChannel: 0 },
	{ type: "suphacap", inclusionChannel: 0 },
	{ type: "suphacap", inclusionChannel: 255 },
	{
		type: "suphacap",
		homeId: 0xffff_fffe,
		ownNodeId: 232,
		transmitChannel: 255,
	},
	Object.freeze({ type: "suphacap", homeId: 0xc123_4567 }),
])("accepts a valid controller selection: %j", (value) => {
	expect(() => validateControllerOptions(value)).not.toThrow();
});

test.each([
	null,
	false,
	1,
	"suphacap",
	[],
	{},
	{ type: "rcp" },
	{ type: null },
	{ type: "serial-api", homeId: 1 },
	{ type: "suphacap", nodeId: 1 },
	{ type: "suphacap", homeId: 0 },
	{ type: "suphacap", homeId: 0xffff_ffff },
	{ type: "suphacap", homeId: 1.5 },
	{ type: "suphacap", homeId: "0xc1234567" },
	{ type: "suphacap", homeId: Number.NaN },
	{ type: "suphacap", homeId: Number.POSITIVE_INFINITY },
	{ type: "suphacap", ownNodeId: 0 },
	{ type: "suphacap", ownNodeId: 233 },
	{ type: "suphacap", ownNodeId: 1.5 },
	{ type: "suphacap", ownNodeId: "1" },
	{ type: "suphacap", transmitChannel: -1 },
	{ type: "suphacap", transmitChannel: 256 },
	{ type: "suphacap", transmitChannel: 0.5 },
	{ type: "suphacap", transmitChannel: false },
	{ type: "suphacap", inclusionChannel: -1 },
	{ type: "suphacap", inclusionChannel: 256 },
	{ type: "suphacap", inclusionChannel: 0.5 },
	{ type: "suphacap", inclusionChannel: false },
	{ type: "suphacap", inclusionChannel: Number.NaN },
])("rejects invalid controller options before serial I/O: %j", (value) => {
	assertZWaveError(expect, () => validateControllerOptions(value), {
		errorCode: ZWaveErrorCodes.Driver_InvalidOptions,
	});
});
