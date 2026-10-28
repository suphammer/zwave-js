/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { BasicDeviceClass, CommandClasses, NodeType } from "@zwave-js/core";
import { Bytes } from "@zwave-js/shared";
import { test } from "vitest";

import {
	isNodeInformationFrameForController,
	parseOverAirNodeInformationFrame,
} from "./NodeInformation.js";

test("recognizes direct and broadcast NIFs for this controller", (t) => {
	const nif = Bytes.from([0x01, 0x01, 0xd3, 0x16, 0x01, 0x02, 0x02, 0x01]);
	t.expect(isNodeInformationFrameForController(nif, 7, 7)).toBe(true);
	t.expect(isNodeInformationFrameForController(nif, 0xff, 7)).toBe(true);
	for (const destination of [undefined, 0, 1, 6, 8, 0xef]) {
		t.expect(isNodeInformationFrameForController(nif, destination, 7)).toBe(
			false,
		);
	}
});

test("does not classify truncated headers or other Protocol commands as a NIF", (t) => {
	for (const command of [[], [0x01], [0x01, 0x02], [0x20, 0x01]]) {
		t.expect(
			isNodeInformationFrameForController(Bytes.from(command), 1, 1),
		).toBe(false);
	}
});

test("parses a captured UZB controller NIF without shifting the CC list", (t) => {
	// EU 9.6 kbit/s capture from UZB Static Controller 5.39. Its live Serial API
	// GetNodeProtocolInfo independently confirmed Basic/Generic/Specific 2/2/1.
	const info = parseOverAirNodeInformationFrame(
		Bytes.from([
			0xd3, 0x16, 0x01, 0x02, 0x02, 0x01, 0x5e, 0x98, 0x9f, 0x55, 0x6c,
			0x56, 0x8f, 0x74,
		]),
	);
	t.expect(info.nodeType).toBe(NodeType.Controller);
	t.expect(info.basicDeviceClass).toBe(BasicDeviceClass["Static Controller"]);
	t.expect(info.genericDeviceClass).toBe(0x02);
	t.expect(info.specificDeviceClass).toBe(0x01);
	t.expect(info.supportedCCs).toStrictEqual([
		0x5e, 0x98, 0x9f, 0x55, 0x6c, 0x56, 0x8f, 0x74,
	]);
});

test("retains the controller's explicit Basic device class", (t) => {
	const info = parseOverAirNodeInformationFrame(
		Bytes.from([0xd3, 0x86, 0x01, 0x01, 0x01, 0x00, CommandClasses.Basic]),
	);
	t.expect(info.basicDeviceClass).toBe(BasicDeviceClass.Controller);
	t.expect(info.genericDeviceClass).toBe(0x01);
	t.expect(info.specificDeviceClass).toBe(0x00);
	t.expect(info.supportedCCs).toStrictEqual([CommandClasses.Basic]);
});

test("infers the Basic device class of a non-routing end node", (t) => {
	const info = parseOverAirNodeInformationFrame(
		Bytes.from([0x8b, 0x8c, 0x00, 0x10, 0x01, CommandClasses.Basic]),
	);
	t.expect(info.basicDeviceClass).toBe(BasicDeviceClass["End Node"]);
	t.expect(info.genericDeviceClass).toBe(0x10);
	t.expect(info.specificDeviceClass).toBe(0x01);
	t.expect(info.supportedCCs).toStrictEqual([CommandClasses.Basic]);
});

test("parses a routing end-node NIF and retains supported and controlled CCs", (t) => {
	const info = parseOverAirNodeInformationFrame(
		Bytes.from([
			0xdb,
			0x8c,
			0x01,
			0x10,
			0x01,
			CommandClasses.Basic,
			0xef,
			CommandClasses["Binary Switch"],
		]),
	);
	t.expect(info.nodeType).toBe(NodeType["End Node"]);
	t.expect(info.basicDeviceClass).toBe(BasicDeviceClass["Routing End Node"]);
	t.expect(info.genericDeviceClass).toBe(0x10);
	t.expect(info.specificDeviceClass).toBe(0x01);
	t.expect(info.supportedCCs).toStrictEqual([CommandClasses.Basic]);
	t.expect(info.controlledCCs).toStrictEqual([
		CommandClasses["Binary Switch"],
	]);
});

test("rejects truncated over-air node information", (t) => {
	for (const bytes of [
		[],
		[0xd3],
		[0xd3, 0x86],
		[0xd3, 0x86, 0x01],
		[0xd3, 0x86, 0x01, 0x02],
		[0xd3, 0x86, 0x01, 0x02, 0x02],
	]) {
		t.expect(() =>
			parseOverAirNodeInformationFrame(Bytes.from(bytes)),
		).toThrow();
	}
});
