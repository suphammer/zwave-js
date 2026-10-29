import { Bytes } from "@zwave-js/shared";
import { describe, expect, test } from "vitest";

import { RCPFunctionType, RCPMessageType } from "../../message/Constants.js";
import { RCPMessage } from "../../message/RCPMessages.js";

import {
	GetFirmwareInfoResponse,
	RadioLibrary,
} from "./GetFirmwareInfoMessages.js";

/** Serializes a raw response with the given payload, then parses it back */
async function parseResponse(payload: Bytes): Promise<RCPMessage> {
	const frame = await new RCPMessage({
		type: RCPMessageType.Response,
		functionType: RCPFunctionType.GetFirmwareInfo,
		payload,
	}).serialize({});
	return RCPMessage.parse(frame, {});
}

// 1.2.3 | RAIL | 4.5.6 | 1 bitmask byte selecting function type 1
const validPayload = Bytes.from([1, 2, 3, RadioLibrary.RAIL, 4, 5, 6, 1, 0b1]);

describe("GetFirmwareInfoResponse", () => {
	test.each(Array.from({ length: 8 }, (_, length) => length))(
		"rejects a response with only %i fixed bytes",
		async (length) => {
			await expect(
				parseResponse(validPayload.subarray(0, length)),
			).rejects.toThrow();
		},
	);

	test("rejects a truncated supported-function bitmask", async () => {
		const payload = Bytes.from(validPayload);
		payload[7] = 2;
		await expect(parseResponse(payload)).rejects.toThrow();
	});

	test("accepts a complete multi-byte supported-function bitmask", async () => {
		const payload = Bytes.concat([validPayload, [1]]);
		payload[7] = 2;
		const msg = (await parseResponse(payload)) as GetFirmwareInfoResponse;
		expect(msg.supportedFunctionTypes).toStrictEqual([1, 9]);
	});
	test("parses both versions and the supported function types", async () => {
		const msg = (await parseResponse(
			validPayload,
		)) as GetFirmwareInfoResponse;

		expect(msg).toBeInstanceOf(GetFirmwareInfoResponse);
		expect(msg.rcpFirmwareVersion).toBe("1.2.3");
		expect(msg.radioLibrary).toBe(RadioLibrary.RAIL);
		expect(msg.radioLibraryVersion).toBe("4.5.6");
		expect(msg.supportedFunctionTypes).toStrictEqual([1]);
	});

	test("round-trips a three-part version", async () => {
		const original = new GetFirmwareInfoResponse({
			rcpFirmwareVersion: "10.20.30",
			radioLibrary: RadioLibrary.RAIL,
			radioLibraryVersion: "7.8.9",
			supportedFunctionTypes: [1, 3],
		});
		const parsed = RCPMessage.parse(
			await original.serialize({}),
			{},
		) as GetFirmwareInfoResponse;

		expect(parsed.rcpFirmwareVersion).toBe("10.20.30");
		expect(parsed.radioLibraryVersion).toBe("7.8.9");
		expect(parsed.supportedFunctionTypes).toStrictEqual([1, 3]);
	});
});
