# Suphacap firmware-MAC controller

The Suphacap backend connects a normal `Driver` directly to a Suphacap V2
running the dedicated `rcp-controller` firmware. It uses the RCP serial
protocol at 460800 baud. Link acknowledgements, ACK matching, retries, and
the supported wake-up beam transactions execute in the radio firmware.

This backend runs in Node.js and uses the shared software controller. It
stores controller state through the Driver's existing database bindings in
the configured cache directory. Browser builds do not provide this backend.

The Driver retains its existing high-level controller and node APIs through
an internal Serial API compatibility layer. There is no TCP Serial API
listener or separate bridge process. This is a Suphacap-specific backend,
not a complete generic RCP replacement for the controller implementation.

## Configuration

```ts
import { Driver, RFRegion } from "zwave-js";

const driver = new Driver("/dev/serial/by-id/my-suphacap-controller", {
	controller: {
		type: "suphacap",
	},
	rf: {
		region: RFRegion.Europe,
	},
	storage: {
		cacheDir: "./cache/suphacap-controller",
	},
});

driver.on("error", (error) => console.error(error));
driver.on("driver ready", () => console.log("Suphacap controller ready"));
await driver.start();
```

Configure `securityKeys` in the application as needed for secure devices.
Always call `driver.destroy()` during orderly shutdown so that MAC assist is
disabled, pending state changes finish, and the database lock is released.

Omitting `controller`, or selecting `{ type: "serial-api" }`, uses the
ordinary Serial API backend. Changing the backend requires a new Driver
instance.

| Suphacap option    | Meaning                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `homeId`           | Optional first-run Home ID seed, an integer from `1` through `0xfffffffe`.                                             |
| `ownNodeId`        | Optional first-run controller node ID seed, an integer from `1` through `232`.                                         |
| `transmitChannel`  | Optional logical RCP transmit channel, from `0` through `255`; the firmware's regional channel table must contain it.  |
| `inclusionChannel` | Optional logical RCP inclusion channel, from `0` through `255`; it must be a Classic channel in the configured region. |

The Home ID and own node ID seeds apply only when no saved controller state
exists. Saved state remains authoritative across restarts. A Home ID seed
does not perform inclusion or reconstruct a network's node allocation,
routes, or security keys.

The RF region uses the existing `rf.region` option and defaults to Europe.
Logical RCP channels are distinct from physical radio slots and data rates.
For Europe, channel 0 is 100 kbit/s at 869.85 MHz, channel 1 is 40 kbit/s at
868.40 MHz, and channel 2 is 9.6 kbit/s at 868.42 MHz. The default transmit
channel is 0. Inclusion and replication can temporarily select other
channels; the backend owns those receive windows.

Inclusion defaults to a fixed 9.6 kbit/s receive window. For a joining
controller that uses 40 kbit/s, select `controller.inclusionChannel: 1` in
Europe. This selects the initial transfer announcement and receive window;
subsequent replication still follows the observed response channels. Changing
this option requires a new Driver instance.

Serial API soft reset, unresponsive-controller recovery, and hardware
watchdog operation are disabled by default for this backend. Explicitly
enabling `features.softReset`, `features.unresponsiveControllerRecovery`,
or `features.watchdog` is rejected instead of attempting unsupported
controller operations.

## Persistent state and ownership

Use a dedicated `storage.cacheDir` for each Suphacap controller network. The
backend stores Home ID, node allocation, protocol information, topology
observations, and routes on the host because the radio's MAC configuration
is volatile. A complete versioned snapshot is stored in `controller.jsonl`,
using the same database factory and locking implementation as the other
Driver caches. The existing `storage.lockDir` setting also applies.
Preserve the complete cache directory when moving a network to another host.

A Driver holds the database lock for its lifetime. A second Driver cannot
open that same store. State changes require an awaited durable flush before
reporting a committed network change; ordinary cache throttling cannot delay
that acknowledgment. Custom database bindings must implement the optional
`flush()` contract or startup is rejected before opening the radio. Corrupt
state is an error and must never be treated as an empty network.

Lock recovery follows the existing database implementation. After a crash
or storage error, stop all processes using the controller or its cache
directory and back up the complete directory before recovering the lock or
restoring state. Do not delete `controller.jsonl` to bypass a startup error.

Hard reset creates and durably commits a fresh Home ID and empty controller
topology, then the Driver opens the new network's cache. Application-owned
`securityKeys` remain unchanged, consistent with the normal Driver reset
API. Starting a new security domain with fresh keys requires a separate,
deliberate application configuration change. Old Home-ID-named cache files
may remain as history; they are not the active controller state.

## Firmware capabilities and supported scope

The backend requires MAC-assist version 1 and capability mask `0x33`:
inbound auto-ACK, firmware-local transmit/ACK status, target-side Explorer
replies, and terminal status for routed DATA without ACK Request. Explorer
transmit (`0x04`) and Classic R2 beam transmit (`0x08`) are negotiated
separately. Generic `rcp` firmware does not satisfy this contract and is
rejected.

The initial supported controller paths include direct Classic
inclusion/exclusion, application traffic, explicit routed traffic, and
topology based on actual link observations. Direct inclusion requires the
device to be within radio range of the controller. The backend reports an
unknown SDK version because it does not run a Silicon Labs Z-Wave SDK.
An unsupported capability is not advertised as a Serial API function.
SmartStart, Network Wide Inclusion, Long Range, multicast transmission,
transmit abort, and controller firmware updates over the wire are not
implemented by this backend.

Initial EU validation used a 500-series Z-Wave.Me UZB on application firmware
5.39 as a joining controller, with `inclusionChannel: 1`. The native Driver
completed no-security inclusion and controller replication; both controllers
reported the same Home ID and assigned node ID. A subsequent NIF request
matched the UZB's own Serial API device classes, and a NOP received a link
acknowledgment. A separate Zniffer captured the RF exchange. This validates
that specific controller path; it does not establish end-device Command
Class interview coverage or secure inclusion.

Successful startup and software tests establish API compatibility, not RF
qualification. They do not establish certification, calibrated radio power
or sensitivity, worst-case ACK timing, all-region coverage, or support for
other firmware contracts.

## Z-Wave JS UI

A UI build must use a Z-Wave JS version containing this backend. Configure
the controller's real serial device path, not a local TCP bridge endpoint.
The additional Driver options passed by the UI can select the backend with
this JSON object:

```json
{
	"controller": {
		"type": "suphacap"
	}
}
```

Use the UI's existing RF-region, security-key, and storage settings for the
rest of the Driver configuration. The UI continues to own the Driver; do
not start a separate controller process for the same radio.
