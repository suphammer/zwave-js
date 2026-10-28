import { ZWaveErrorCodes } from "@zwave-js/core";
import { createDeferredPromise } from "alcalzone-shared/deferred-promise";
import { expect, test, vi } from "vitest";

import { Driver } from "./Driver.js";
import type { NativeControllerBackend } from "./NativeControllerBackend.js";

function setBackend(
	driver: Driver,
	backend: Promise<NativeControllerBackend>,
): void {
	(driver as any).nativeControllerBackend = backend;
}

function createBackend(
	destroy = vi.fn(async () => {}),
): NativeControllerBackend {
	return {
		capabilities: {
			networkWideInclusion: false,
			highPower: false,
			smartStart: false,
			transmitAbort: false,
		},
		binding: () => {
			throw new Error(
				"The serial connection must not be opened in this test",
			);
		},
		destroy,
	};
}

test("destroy before start returns one shared promise and completes", async () => {
	const driver = new Driver("/unused/controller");
	const first = driver.destroy();
	expect(driver.destroy()).toBe(first);
	await expect(first).resolves.toBeUndefined();
	expect(driver.destroy()).toBe(first);
});

test("destroy waits for backend initialization before releasing it", async () => {
	const driver = new Driver("/unused/controller");
	const pendingBackend = createDeferredPromise<NativeControllerBackend>();
	setBackend(driver, pendingBackend);
	const backend = createBackend();
	let completed = false;
	const destroying = driver.destroy().then(() => {
		completed = true;
	});
	await Promise.resolve();
	expect(completed).toBe(false);
	pendingBackend.resolve(backend);
	await destroying;
	expect(backend.destroy).toHaveBeenCalledOnce();
});

test("scheduler failure still releases the backend and closes logging", async () => {
	const driver = new Driver("/unused/controller");
	const failure = new Error("Scheduler cleanup failed");
	vi.spyOn(driver.scheduler, "stop").mockRejectedValue(failure);
	const backend = createBackend();
	setBackend(driver, Promise.resolve(backend));
	const closeLogging = vi.fn();
	(driver as any)._logContainer = { destroy: closeLogging };

	const destroying = driver.destroy();
	await expect(destroying).rejects.toBe(failure);
	expect(backend.destroy).toHaveBeenCalledOnce();
	expect(closeLogging).toHaveBeenCalledOnce();
	expect(driver.destroy()).toBe(destroying);
});

test("backend cleanup failure does not skip controller and logger cleanup", async () => {
	const driver = new Driver("/unused/controller");
	const failure = new Error("State lease release failed");
	setBackend(
		driver,
		Promise.resolve(
			createBackend(
				vi.fn(async () => {
					throw failure;
				}),
			),
		),
	);
	const closeController = vi.spyOn(driver as any, "destroyController");
	const closeLogging = vi.fn();
	(driver as any)._logContainer = { destroy: closeLogging };

	const destroying = driver.destroy();
	await expect(destroying).rejects.toBe(failure);
	expect(closeController).toHaveBeenCalledOnce();
	expect(closeLogging).toHaveBeenCalledOnce();
	await expect(driver.destroy()).rejects.toBe(failure);
});

test("destroy reports all cleanup failures after attempting the remaining resources", async () => {
	const driver = new Driver("/unused/controller");
	const schedulerFailure = new Error("Scheduler cleanup failed");
	const backendFailure = new Error("Backend cleanup failed");
	const loggerFailure = new Error("Logger cleanup failed");
	vi.spyOn(driver.scheduler, "stop").mockRejectedValue(schedulerFailure);
	setBackend(
		driver,
		Promise.resolve(
			createBackend(
				vi.fn(async () => {
					throw backendFailure;
				}),
			),
		),
	);
	(driver as any)._logContainer = {
		destroy: () => {
			throw loggerFailure;
		},
	};

	await expect(driver.destroy()).rejects.toMatchObject({
		errors: [schedulerFailure, backendFailure, loggerFailure],
	});
});

test("failed backend initialization does not prevent other cleanup", async () => {
	const driver = new Driver("/unused/controller");
	setBackend(
		driver,
		Promise.reject(new Error("Backend initialization failed")),
	);
	const closeLogging = vi.fn();
	(driver as any)._logContainer = { destroy: closeLogging };
	await expect(driver.destroy()).resolves.toBeUndefined();
	expect(closeLogging).toHaveBeenCalledOnce();
});

test("a destroyed driver does not attempt another serial open", async () => {
	const driver = new Driver("/unused/controller");
	await driver.destroy();
	await expect((driver as any).openSerialport()).rejects.toMatchObject({
		code: ZWaveErrorCodes.Driver_Destroyed,
	});
	expect((driver as any)._isOpeningSerialPort).toBe(false);
});

test("error reporting failure does not prevent driver cleanup", async () => {
	const driver = new Driver("/unused/controller");
	const failure = new Error("Logger failed");
	(driver as any)._driverLog = {
		print: vi.fn().mockImplementationOnce(() => {
			throw failure;
		}),
	};
	const destroy = vi.spyOn(driver, "destroy");
	await expect((driver as any).destroyWithMessage("Failure")).rejects.toBe(
		failure,
	);
	expect(destroy).toHaveBeenCalledOnce();
	await expect(driver.destroy()).resolves.toBeUndefined();
});
