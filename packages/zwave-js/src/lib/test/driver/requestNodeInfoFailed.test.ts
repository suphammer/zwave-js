import { MessagePriority, ZWaveErrorCodes } from "@zwave-js/core";
import {
	GetControllerVersionRequest,
	GetControllerVersionResponse,
	RequestNodeInfoRequest,
	RequestNodeInfoResponse,
} from "@zwave-js/serial/serialapi";
import { Bytes } from "@zwave-js/shared";
import { wait } from "alcalzone-shared/async";

import { integrationTest } from "../integrationTestSuite.js";

integrationTest.sequential(
	"a failed node information callback rejects the request and releases the serial queue",
	{
		additionalDriverOptions: {
			testingHooks: {
				skipNodeInterview: true,
			},
		},
		customSetup: async (_driver, controller) => {
			controller.defineBehavior({
				async onHostMessage(controller, message) {
					if (!(message instanceof RequestNodeInfoRequest)) return;
					await controller.sendMessageToHost(
						new RequestNodeInfoResponse({ wasSent: true }),
					);
					await controller.sendToHost(
						Bytes.from("010400498133", "hex"),
					);
					return true;
				},
			});
		},
		testBody: async (t, driver, node) => {
			const failed = node
				.requestNodeInfo({
					priority: MessagePriority.Immediate,
				})
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			const next = driver.sendMessage(new GetControllerVersionRequest(), {
				priority: MessagePriority.Immediate,
			});
			const result = await Promise.race([
				Promise.all([failed, next]),
				wait(5000).then(() => undefined),
			]);

			t.expect(result).toBeDefined();
			t.expect(result?.[0]).toMatchObject({
				code: ZWaveErrorCodes.Controller_CallbackNOK,
			});
			t.expect(result?.[1]).toBeInstanceOf(GetControllerVersionResponse);
		},
	},
);
