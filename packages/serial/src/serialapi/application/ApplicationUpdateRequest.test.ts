import {
	type MessageEncodingContext,
	type MessageParsingContext,
	Message,
} from "@zwave-js/serial";
import { Bytes } from "@zwave-js/shared";
import { test } from "vitest";

import { RequestNodeInfoRequest } from "../network-mgmt/RequestNodeInfoMessages.js";

import {
	ApplicationUpdateRequestNodeInfoRequestFailed,
	ApplicationUpdateTypes,
} from "./ApplicationUpdateRequest.js";

test("a NodeInfo_RequestFailed wire frame is an unsuccessful RequestNodeInfo callback", async (t) => {
	const frame = Bytes.from("010400498133", "hex");
	const context = {} as MessageParsingContext;
	const parsed = Message.parse(frame, context);

	t.expect(parsed).toBeInstanceOf(
		ApplicationUpdateRequestNodeInfoRequestFailed,
	);
	const failure = parsed as ApplicationUpdateRequestNodeInfoRequestFailed;
	t.expect(failure.updateType).toBe(
		ApplicationUpdateTypes.NodeInfo_RequestFailed,
	);
	t.expect(failure.isOK()).toBe(false);
	t.expect(
		new RequestNodeInfoRequest({ nodeId: 2 }).isExpectedCallback(failure),
	).toBe(true);
	t.expect(
		await failure.serialize({} as MessageEncodingContext),
	).toStrictEqual(frame);
});
